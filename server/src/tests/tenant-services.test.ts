import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { contentCipher, digest } from '../security/crypto.js';
import { csrfToken } from '../security/admin-auth.js';
import { signaturePayload } from '../security/device-signatures.js';
import { adminCommand } from '../services/admin-commands.js';
import { tenantSettings, tenantPlan } from '../services/tenant-services.js';
import { messageService } from '../services/messages.js';
import { deviceService } from '../services/devices.js';
import { createCampaign, dispatchCampaigns } from '../services/campaigns.js';
import { contactMutation, saveContacts } from '../services/contacts.js';
import { fcmOutbox } from '../workers/fcm-outbox.js';
import { createApp } from '../app.js';

const key='ab'.repeat(32),cipher=contentCipher(key),enabled={skip:!process.env.TEST_DATABASE_URL};
async function setup(){
 const fixture=await databaseFixture(),{db}=fixture;
 const tenant=randomUUID(),client=randomUUID(),device=randomUUID(),admin=randomUUID(),token='x'.repeat(43),apiKey='y'.repeat(43);
 const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenant,'Paid school']);
 await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[client,tenant,digest(apiKey),JSON.stringify(['sms:send','sms:read'])]);
 await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id,public_key,encrypted_fcm_token) VALUES (?,?,false,1,?,?)',[device,tenant,signing.publicKey.export({format:'pem',type:'spki'}).toString(),cipher.encrypt('test-fcm-token',`fcm:${device}`)]);
 await db.query("INSERT INTO cms_users (id,username,password_hash,totp_enabled,super_admin,all_tenants) VALUES (?,'root','unused',true,true,true)",[admin]);
 await db.query('INSERT INTO cms_sessions (token_hash,user_id,mfa_verified,expires_at) VALUES (?,?,true,CURRENT_TIMESTAMP(6)+INTERVAL 1 HOUR)',[digest(token),admin]);
 await db.query('UPDATE gateway_settings SET paused=false,cooldown_seconds=0,client_quota=100,device_quota=100,recipient_quota=100');
 const command=(command:unknown)=>adminCommand(db,admin,digest(token),{command,reasonReference:'TEST-PLAN'});
 const expiry=(expiresAt:string|null)=>command({action:'tenant-expiry-update',tenantId:tenant,expiresAt});
 const overrides=(overrides:Record<string,number>)=>command({action:'tenant-settings-update',tenantId:tenant,overrides});
 const send=(to='+923001234567',body='Attendance notice')=>messageService(db,cipher).create({id:client,tenant_id:tenant,scopes:['sms:send']},randomUUID(),{to,body,evidenceReference:'TEST-CONSENT'});
 const ready={subscriptionId:1,canSendSms:true,locallyPaused:false};
 function proof(path:string,input:unknown){const data={deviceId:device,method:'POST',path:`/v1/device${path}`,nonce:randomUUID(),timestamp:String(Math.floor(Date.now()/1000)),body:Buffer.from(JSON.stringify(input))};return {...data,signature:sign('sha256',Buffer.from(signaturePayload(data)),signing.privateKey).toString('base64')};}
 const service=deviceService(db,cipher),claim=()=>service.claim(proof('/jobs/claim',ready),ready);
 const authorize=(job:{jobId:string;leaseId:string})=>{const input={leaseId:job.leaseId,readiness:ready};return service.authorize(proof(`/jobs/${job.jobId}/authorize`,input),job.jobId,input);};
 const app=createApp(db,key),get=(path:string)=>request(app).get(`/admin/api${path}`).set('Cookie',`gateway_cms=${token}`);
 const post=(path:string,body:object)=>request(app).post(`/admin/api${path}`).set('Cookie',`gateway_cms=${token}`).set('X-CMS-Request','1').set('X-CSRF-Token',csrfToken(token,key)).send(body);
 return {...fixture,tenant,client,device,admin,token,apiKey,command,expiry,overrides,send,ready,proof,service,claim,authorize,app,get,post};
}
test('tenant defaults inherit for old and new tenants; overrides, reset and quota enforcement',enabled,async()=>{
 const f=await setup();try{
  assert.equal((await tenantSettings(f.db,f.tenant)).message_ttl_seconds,600);
  await f.overrides({client_quota:1,message_ttl_seconds:120,bulk_delay_seconds:7});
  const defaults=(await f.db.query('SELECT * FROM gateway_settings')).rows[0]!;
  const settings=Object.fromEntries(['recipient_quota','cooldown_seconds','client_quota','device_quota','message_ttl_seconds','replay_window_hours','confirmation_cooldown_seconds','bulk_delay_seconds'].map(k=>[k,Number(defaults[k])]));
  settings.message_ttl_seconds=180;settings.device_quota=70;
  await f.command({action:'settings-update',settings});
  const other=await f.command({action:'tenant-create',name:'New tenant'});
  assert.equal((await tenantSettings(f.db,other.resourceId!)).message_ttl_seconds,180);
  assert.equal((await tenantPlan(f.db,other.resourceId!)).expires_at,null);
  assert.equal((await tenantSettings(f.db,f.tenant)).message_ttl_seconds,120);
  assert.equal((await tenantSettings(f.db,f.tenant)).device_quota,70);
  const job=await f.send();
  const row=(await f.db.query('SELECT TIMESTAMPDIFF(SECOND,created_at,expires_at) AS lifetime FROM outbound_messages WHERE id=?',[job.jobId])).rows[0]!;
  assert.equal(Number(row.lifetime),120);
  await assert.rejects(f.send('+923001234568'),{code:'CLIENT_QUOTA'});
  await f.overrides({});await f.send('+923001234568');
  assert.equal((await tenantSettings(f.db,f.tenant)).message_ttl_seconds,180);
  const created=await f.command({action:'tenant-create',name:'Expired on creation',expiresAt:'2020-01-01T00:00:00Z'});
  assert.equal((await tenantPlan(f.db,created.resourceId!)).expired,true);
  await assert.rejects(f.command({action:'tenant-settings-update',tenantId:f.tenant,overrides:{paused:false}}));
 }finally{await f.dispose();}
});
test('expiry blocks API and signed sending, cancels unsent work, and renewal does not resurrect jobs',enabled,async()=>{
 const f=await setup();try{
  const queued=await f.send();const claimed=(await f.claim()).job!;
  await f.db.query("INSERT INTO tenant_plans (tenant_id,expires_at,settings_json) VALUES (?,CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND,'{}')",[f.tenant]);
  await f.db.query("UPDATE outbound_messages SET status='QUEUED' WHERE id=?",[queued.jobId]);
  let wakes=0;assert.equal(await fcmOutbox(f.db,cipher,{async send(){wakes++;}}).dispatchOne(),false);assert.equal(wakes,0);
  await f.expiry('2020-01-01T00:00:00Z');
  await assert.rejects(f.send('+923001234568'),{code:'TENANT_EXPIRED'});
  await assert.rejects(f.claim(),{code:'TENANT_EXPIRED'});
  await assert.rejects(f.authorize(claimed),{code:'TENANT_EXPIRED'});
  const api=await request(f.app).get('/v1/messages').set('Authorization',`Bearer ${f.apiKey}`).expect(403);assert.equal(api.body.code,'TENANT_EXPIRED');
  assert.equal((await f.service.heartbeat(f.proof('/heartbeat',f.ready),f.ready)).paused,true);
  assert.equal((await f.db.query('SELECT status FROM outbound_messages WHERE id=?',[queued.jobId])).rows[0]!.status,'CANCELLED');
  await f.expiry(null);assert.equal((await f.claim()).job,null);await f.send('+923001234568');
  // A naturally elapsed plan must be reconciled before renewal, even if no worker ran.
  await f.db.query('UPDATE tenant_plans SET expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE tenant_id=?',[f.tenant]);
  await f.expiry(null);assert.equal((await f.claim()).job,null);
  await f.send('+923001234569');assert.ok((await f.claim()).job);
 }finally{await f.dispose();}
});
test('authorization ends at subscription expiry; late delivery and STOP are recorded without new SMS',enabled,async()=>{
 const f=await setup();try{
  await f.send();const job=(await f.claim()).job!;
  await f.expiry(new Date(Date.now()+20000).toISOString());
  const grant=await f.authorize(job);assert.ok(grant.validForMs>0&&grant.validForMs<=20000);
  assert.equal(new Date(grant.validUntil).getTime(),new Date((await tenantPlan(f.db,f.tenant)).expires_at!).getTime());
  await f.expiry('2020-01-01T00:00:00Z');
  const event={eventId:randomUUID(),leaseId:job.leaseId,partIndex:0,type:'DELIVERED'};
  assert.equal((await f.service.event(f.proof(`/jobs/${job.jobId}/events`,event),job.jobId,event)).status,'DELIVERED');
  const stop={eventId:randomUUID(),from:'+923001234567',command:'STOP',subscriptionId:1,receivedAt:Date.now()};
  const result=await f.service.inbound(f.proof('/inbound',stop),stop);assert.equal(result.optedOut,true);assert.equal(result.confirmationJobId,null);
 }finally{await f.dispose();}
});
test('tenant scoped CMS cannot bypass expiry or change subscription limits; platform admin can renew',enabled,async()=>{
 const f=await setup();try{
  await f.send();await f.expiry('2020-01-01T00:00:00Z');
  await f.db.query("UPDATE cms_users SET super_admin=false,all_tenants=false,permissions_json=? WHERE id=?",[JSON.stringify({settings:'manage',clients:'manage',contacts:'manage',messages:'view',devices:'manage',bulk:'manage'}),f.admin]);
  await f.db.query('INSERT INTO cms_user_tenants VALUES (?,?)',[f.admin,f.tenant]);
  await assert.rejects(f.expiry(null),{code:'CMS_GLOBAL_ACCESS_REQUIRED'});
  await assert.rejects(f.overrides({client_quota:1000}),{code:'CMS_GLOBAL_ACCESS_REQUIRED'});
  const overview=await f.get('/overview').expect(200);assert.equal(overview.body.tenants[0].service_status,'EXPIRED');assert.equal(overview.body.devices.length,0);
  assert.equal((await f.get('/messages').expect(200)).body.messages.length,0);
  assert.equal((await f.get(`/contacts?tenantId=${f.tenant}`).expect(403)).body.code,'TENANT_EXPIRED');
  await f.post('/groups',{tenantId:f.tenant,name:'Blocked',reasonReference:'TEST-GROUP'}).expect(403);
  await f.db.query('UPDATE cms_users SET super_admin=true WHERE id=?',[f.admin]);await f.expiry(null);
  await f.post('/groups',{tenantId:f.tenant,name:'Renewed',reasonReference:'TEST-GROUP'}).expect(200);
 }finally{await f.dispose();}
});
test('bulk pacing uses tenant overrides and expired schedules are permanently cancelled',enabled,async()=>{
 const f=await setup();try{
  const admin={id:f.admin,token_hash:digest(f.token)};
  await contactMutation(f.db,admin,f.tenant,'TEST-CONTACTS','CONTACTS_IMPORTED',tx=>saveContacts(tx,f.tenant,[{name:'Parent one',mobile:'+923001234567'},{name:'Parent two',mobile:'+923001234568'}],undefined,false,'TEST-CONSENT'));
  const contactIds=(await f.db.query('SELECT id FROM contacts')).rows.map(r=>r.id);
  const id=randomUUID();await createCampaign(f.db,cipher,admin,{id,tenantId:f.tenant,clientId:f.client,name:'Test',body:'Attendance',contactIds,reasonReference:'TEST-BULK'});
  await f.overrides({bulk_delay_seconds:5});await dispatchCampaigns(f.db,cipher);
  await f.db.query("UPDATE outbound_messages SET status='CANCELLED'");
  await f.db.query('UPDATE gateway_settings SET bulk_last_activity_at=CURRENT_TIMESTAMP(6)-INTERVAL 2 SECOND');
  await dispatchCampaigns(f.db,cipher);assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length,1);
  await f.db.query('UPDATE gateway_settings SET bulk_last_activity_at=CURRENT_TIMESTAMP(6)-INTERVAL 6 SECOND');
  await dispatchCampaigns(f.db,cipher);assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length,2);
  const scheduled=randomUUID();await createCampaign(f.db,cipher,admin,{id:scheduled,tenantId:f.tenant,clientId:f.client,name:'Future',body:'Later notice',contactIds,scheduledAt:new Date(Date.now()+86400000).toISOString(),reasonReference:'TEST-SCHEDULE'});
  await f.expiry('2020-01-01T00:00:00Z');await f.expiry(null);
  assert.equal((await f.db.query('SELECT status FROM campaigns WHERE id=?',[scheduled])).rows[0]!.status,'CANCELLED');
  assert.equal((await f.db.query('SELECT last_error FROM campaign_recipients WHERE campaign_id=?',[scheduled])).rows[0]!.last_error,'TENANT_EXPIRED');
 }finally{await f.dispose();}
});
