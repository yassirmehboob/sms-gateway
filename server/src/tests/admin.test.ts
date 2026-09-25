import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { base32,totp,passwordHash,passwordMatches } from '../security/admin-auth.js';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { messageService } from '../services/messages.js';
import { contentCipher } from '../security/crypto.js';

test('CMS passwords are salted and TOTP matches RFC 6238 vectors',async()=>{
 const hash=await passwordHash('long-test-password');
 assert.notEqual(hash,await passwordHash('long-test-password'));
 assert.equal(await passwordMatches('long-test-password',hash),true);
 assert.equal(await passwordMatches('wrong',hash),false);
 const secret=base32(Buffer.from('12345678901234567890'));
 for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924']] as const)assert.equal(totp(secret,Math.floor(seconds/30),8),expected);
});

test('CMS login, MFA, CSRF, roles and audited policy controls', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const fixture=await databaseFixture(),{db}=fixture;
 try {
   const id=randomUUID(),password='test-admin-password-1234';
   await db.query('INSERT INTO cms_users (id,username,password_hash) VALUES (?,?,?)',[id,'admin',await passwordHash(password)]);
   const app=createApp(db,'ab'.repeat(32));const agent=request.agent(app);
   const post=(path:string,body:unknown,csrf='')=>agent.post(`/admin/api${path}`).set('X-CMS-Request','1').set('X-CSRF-Token',csrf).send(body as object);
   assert.equal((await agent.get('/admin/')).status,200);
   assert.equal((await agent.get('/admin/').set('Host','evil.example')).status,403);
   assert.equal((await agent.get('/admin/api/overview')).status,401);
   assert.equal((await post('/login',{username:'admin',password}).set('Origin','http://evil.example')).status,403);
   const login=await post('/login',{username:'admin',password});
   assert.equal(login.status,200);assert.equal(login.body.mfaRequired,true);
   assert.match(String(login.headers['set-cookie']),/HttpOnly/);
   assert.match(String(login.headers['set-cookie']),/SameSite=Strict/);
   let csrf=login.body.csrf;
   assert.equal((await agent.get('/admin/api/overview')).body.code,'MFA_REQUIRED');
   assert.equal((await post('/mfa/setup',{})).body.code,'CSRF_REQUIRED');
   const setup=await post('/mfa/setup',{},csrf);assert.equal(setup.status,200);
   const code=totp(setup.body.secret,Math.floor(Date.now()/30000));
   const confirmed=await post('/mfa/confirm',{code},csrf);assert.equal(confirmed.status,200);csrf=confirmed.body.csrf;
   assert.equal((await post('/mfa/setup',{},csrf)).body.code,'MFA_ALREADY_ENABLED');
   const overview=await agent.get('/admin/api/overview');assert.equal(overview.status,200);
   const settings={recipient_quota:1,cooldown_seconds:0,client_quota:20,device_quota:40,message_ttl_seconds:900,replay_window_hours:2,confirmation_cooldown_seconds:60};
   const command=(command:unknown)=>post('/command',{reasonReference:'CMS-TEST',command},csrf);
   assert.equal((await post('/command',{reasonReference:'TEST',command:{action:'global-pause',paused:false}})).status,403);
   assert.equal((await command({action:'settings-update',settings})).status,200);
   assert.equal((await command({action:'settings-update',settings:{...settings,recipient_quota:0}})).status,400);
   const tenantResult=await command({action:'tenant-create',name:'Test <script> tenant'});assert.equal(tenantResult.status,200);const tenant=tenantResult.body.resourceId;
   const createdClient=await command({action:'client-create',tenantId:tenant});assert.equal(createdClient.status,200);
   const client=createdClient.body.resourceId,apiKey=createdClient.body.apiKey;assert.equal(apiKey.length,43);
   const device=randomUUID();
   assert.equal((await command({action:'device-create',tenantId:tenant,deviceId:device,simId:1})).status,200);
   assert.equal((await command({action:'device-pause',tenantId:tenant,deviceId:device,paused:false})).status,200);
   assert.equal((await command({action:'global-pause',paused:false})).status,200);
   const number='+923001234567';
   assert.equal((await command({action:'consent-grant',tenantId:tenant,number,purpose:'transactional_notification',evidenceReference:'CONSENT-TEST'})).status,200);
   const messages=messageService(db,contentCipher('ab'.repeat(32))),actor={id:client,tenant_id:tenant,scopes:['sms:send']};
   await messages.create(actor,randomUUID(),{to:number,body:'First custom text'});
   await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Second custom text'}),{code:'RECIPIENT_QUOTA'});
   assert.equal((await command({action:'settings-update',settings:{...settings,recipient_quota:4}})).status,200);
   await messages.create(actor,randomUUID(),{to:number,body:'Second custom text'});
   assert.equal((await command({action:'recipient-preference',number,optedOut:true})).status,200);
   await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Blocked'}),{code:'RECIPIENT_OPTED_OUT'});
   assert.equal((await command({action:'recipient-preference',number,optedOut:false})).status,200);
   await messages.create(actor,randomUUID(),{to:number,body:'Restored'});
   assert.equal((await command({action:'recipient-suppression',number,suppressed:true})).status,200);
   assert.equal((await command({action:'recipient-preference',number,optedOut:false})).status,200);
   await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Still suppressed'}),{code:'RECIPIENT_SUPPRESSED'});
   for(const path of ['/overview','/recipients','/messages','/audit'])assert.equal((await agent.get(`/admin/api${path}`)).status,200,path);
   const audit=(await db.query("SELECT details_json FROM audit_logs WHERE action='settings-update' LIMIT 1")).rows[0]!;
   assert.ok(audit.details_json);
   // Policy writes and audit commit together; failure must restore previous limits.
   await db.query("CREATE TRIGGER reject_cms_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'");
   assert.equal((await command({action:'settings-update',settings:{...settings,recipient_quota:8}})).status,500);
   assert.equal((await db.query('SELECT recipient_quota FROM gateway_settings')).rows[0]!.recipient_quota,4);
   await db.query('DROP TRIGGER reject_cms_audit');
   // Role is reloaded for each request and rechecked inside the policy transaction.
   await db.query("UPDATE cms_users SET role='viewer' WHERE id=?",[id]);
   assert.equal((await command({action:'global-pause',paused:true})).status,403);
   assert.equal((await agent.get('/admin/api/overview')).status,200);
   await db.query("UPDATE cms_users SET role='admin' WHERE id=?",[id]);
   assert.equal((await post('/logout',{},csrf)).status,200);
   assert.equal((await agent.get('/admin/api/overview')).status,401);
   // A used authenticator code cannot open a second session.
   assert.equal((await post('/login',{username:'admin',password,code})).status,401);
   const nextCode=totp(setup.body.secret,Math.floor(Date.now()/30000)+1);
   const nextLogin=await post('/login',{username:'admin',password,code:nextCode});assert.equal(nextLogin.status,200);
   csrf=nextLogin.body.csrf;
   assert.equal((await post('/password',{currentPassword:password,newPassword:'replacement-password-1234'},csrf)).status,200);
   assert.equal((await agent.get('/admin/api/overview')).status,401);
 } finally {await fixture.dispose();}
});
