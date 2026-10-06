import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { contentCipher, digest } from '../security/crypto.js';
import { csrfToken, passwordMatches, totp } from '../security/admin-auth.js';
import { cmsSections, cmsMutationGuard } from '../security/cms-access.js';
import { manageCmsUser } from '../services/cms-users.js';
import { createCampaign, dispatchCampaigns } from '../services/campaigns.js';
import { messageService } from '../services/messages.js';
import { migrate } from '../db/migrations.js';

const encryptionKey='ab'.repeat(32),cipher=contentCipher(encryptionKey);
const enabled=Boolean(process.env.TEST_DATABASE_URL);
const reference='TEST-CMS-ACCESS';
function rights(level:'view'|'manage'|'none'='manage') {return Object.fromEntries(cmsSections.map(section=>[section,level]));}
function assigned(tenantIds:string[], permissions:Record<string,string>=rights()) {
  return {role:'admin',superAdmin:false,allTenants:false,tenantIds,permissions:{...permissions,dashboard:'view',settings:'view'},enabled:true};
}
async function fixture() {
  const f=await databaseFixture(),{db}=f;
  const rootId=randomUUID(),tenantA=randomUUID(),tenantB=randomUUID(),clientA=randomUUID(),clientB=randomUUID(),deviceA=randomUUID(),deviceB=randomUUID();
  await db.query("INSERT INTO cms_users (id,username,password_hash,super_admin,all_tenants,totp_enabled) VALUES (?,'root','unused',true,true,true)",[rootId]);
  for(const [tenant,client,device,name] of [[tenantA,clientA,deviceA,'School A'],[tenantB,clientB,deviceB,'School B']]) {
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenant,name]);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[client,tenant,digest(randomUUID()),JSON.stringify(['sms:send','sms:read'])]);
    await db.query('INSERT INTO devices (id,tenant_id,allowed_sim_id,paused) VALUES (?,?,1,false)',[device,tenant]);
  }
  await db.query('UPDATE gateway_settings SET paused=false,cooldown_seconds=0,client_quota=100,device_quota=100,recipient_quota=100');
  const app=createApp(db,encryptionKey);
  async function session(id:string) {
    const token=randomBytes(32).toString('base64url'),token_hash=digest(token);
    await db.query('INSERT INTO cms_sessions (token_hash,user_id,mfa_verified,expires_at) VALUES (?,?,true,CURRENT_TIMESTAMP(6)+INTERVAL 1 HOUR)',[token_hash,id]);
    const post=(path:string,body:unknown)=>request(app).post(`/admin/api${path}`).set('Cookie',`gateway_cms=${token}`).set('X-CMS-Request','1').set('X-CSRF-Token',csrfToken(token,encryptionKey)).send(body as object);
    const get=(path:string)=>request(app).get(`/admin/api${path}`).set('Cookie',`gateway_cms=${token}`);
    return {id,token_hash,post,get};
  }
  const root=await session(rootId);
  const create=async(username:string,access:ReturnType<typeof assigned>)=>{
    const response=await root.post('/users',{action:'create',username,access,reasonReference:reference});
    assert.equal(response.status,200,JSON.stringify(response.body));
    return response.body as {id:string;username:string;password:string};
  };
  const command=(actor:typeof root,command:unknown)=>actor.post('/command',{command,reasonReference:reference});
  const addContact=async(tenantId:string,name:string,mobile:string)=>{
    const result=await root.post('/contacts',{tenantId,contact:{name,mobile},evidenceReference:reference,reasonReference:reference});
    assert.equal(result.status,200);
    return (await db.query('SELECT id FROM contacts WHERE tenant_id=? AND name=?',[tenantId,name])).rows[0]!.id as string;
  };
  return {...f,root,app,tenantA,tenantB,clientA,clientB,deviceA,deviceB,session,create,command,addContact};
}

test('migration preserves existing admin/viewer access without promoting future accounts', {skip:!enabled},async()=>{
  const f=await databaseFixture();
  try {
    await f.db.query('DROP TABLE cms_user_tenants');
    await f.db.query('ALTER TABLE cms_users DROP COLUMN super_admin,DROP COLUMN all_tenants,DROP COLUMN permissions_json');
    await f.db.query("DELETE FROM schema_migrations WHERE version='008_cms_access'");
    await f.db.query("INSERT INTO cms_users (id,username,password_hash,role) VALUES (?,'old-admin','unused','admin'),(?,'old-viewer','unused','viewer')",[randomUUID(),randomUUID()]);
    await migrate(f.db);
    const rows=(await f.db.query('SELECT username,super_admin,all_tenants FROM cms_users ORDER BY username')).rows;
    assert.equal(Number(rows[0]!.super_admin),1);assert.equal(Number(rows[1]!.super_admin),0);
    assert.ok(rows.every(row=>Number(row.all_tenants)===1));
    await f.db.query("INSERT INTO cms_users (id,username,password_hash) VALUES (?,'new-admin','unused')",[randomUUID()]);
    await migrate(f.db);
    assert.equal(Number((await f.db.query("SELECT super_admin FROM cms_users WHERE username='new-admin'")).rows[0]!.super_admin),0);
  }finally{await f.dispose();}
});

test('super admin creates CMS accounts with hashed generated passwords and mandatory MFA', {skip:!enabled},async()=>{
  const f=await fixture();
  try {
    const created=await f.create('school-admin',assigned([f.tenantA],rights('view')));
    const stored=(await f.db.query('SELECT password_hash,totp_enabled FROM cms_users WHERE id=?',[created.id])).rows[0]!;
    assert.ok(await passwordMatches(created.password,stored.password_hash));assert.equal(Number(stored.totp_enabled),0);
    const listed=await f.root.get('/users');assert.equal(listed.status,200);assert.ok(!JSON.stringify(listed.body).includes(created.password));assert.ok(!JSON.stringify(listed.body).includes('password_hash'));
    const agent=request.agent(f.app);
    const login=await agent.post('/admin/api/login').set('X-CMS-Request','1').send({username:created.username,password:created.password});
    assert.equal(login.status,200);assert.equal(login.body.mfaRequired,true);assert.deepEqual(login.body.access.tenantIds,[f.tenantA]);
    assert.equal((await agent.get('/admin/api/overview')).body.code,'MFA_REQUIRED');
    const setup=await agent.post('/admin/api/mfa/setup').set('X-CMS-Request','1').set('X-CSRF-Token',login.body.csrf).send({});
    const confirm=await agent.post('/admin/api/mfa/confirm').set('X-CMS-Request','1').set('X-CSRF-Token',login.body.csrf).send({code:totp(setup.body.secret,Math.floor(Date.now()/30000))});
    assert.equal(confirm.status,200);
    assert.equal((await agent.get('/admin/api/session')).body.access.superAdmin,false);
    assert.equal((await agent.get('/admin/api/users')).status,403);
    const duplicate=await f.root.post('/users',{action:'create',username:'school-admin',access:assigned([f.tenantA]),reasonReference:reference});
    assert.equal(duplicate.body.code,'CMS_USERNAME_EXISTS');
    assert.equal((await f.root.post('/users',{action:'update',userId:f.root.id,access:assigned([]),reasonReference:reference})).body.code,'CMS_CANNOT_EDIT_SELF');
  }finally{await f.dispose();}
});

test('tenant restrictions filter overview, contacts, recipients, messages and audit and protect writes', {skip:!enabled},async()=>{
  const f=await fixture();
  try {
    const contactA=await f.addContact(f.tenantA,'Parent A','03001234567');
    const contactB=await f.addContact(f.tenantB,'Parent B','03001234568');
    await messageService(f.db,cipher).create({id:f.clientA,tenant_id:f.tenantA,scopes:['sms:send']},randomUUID(),{to:'03001234567',body:'School A notice'});
    await messageService(f.db,cipher).create({id:f.clientB,tenant_id:f.tenantB,scopes:['sms:send']},randomUUID(),{to:'03001234568',body:'School B notice'});
    const created=await f.create('limited',assigned([f.tenantA]));
    await f.db.query('UPDATE cms_users SET totp_enabled=true WHERE id=?',[created.id]);const actor=await f.session(created.id);
    const overview=(await actor.get('/overview')).body;
    assert.deepEqual(overview.tenants.map((row:any)=>row.id),[f.tenantA]);
    assert.deepEqual(overview.devices.map((row:any)=>row.id),[f.deviceA]);
    assert.deepEqual(overview.clients.map((row:any)=>row.id),[f.clientA]);assert.equal(overview.counts[0].count,1);assert.deepEqual(overview.configuration,{});
    assert.equal((await actor.get(`/contacts?tenantId=${f.tenantA}`)).body.total,1);
    for(const path of [`/contacts?tenantId=${f.tenantB}`,`/groups?tenantId=${f.tenantB}`,`/campaigns?tenantId=${f.tenantB}`,`/campaigns/${randomUUID()}/recipients?tenantId=${f.tenantB}`])assert.equal((await actor.get(path)).status,403,path);
    assert.deepEqual((await actor.get('/recipients')).body.recipients.map((row:any)=>row.normalized_e164),['+923001234567']);
    assert.equal((await actor.get('/messages')).body.messages.length,1);
    const audit=(await actor.get('/audit')).body.audit;
    assert.ok(audit.every((row:any)=>row.action!=='CMS_USER_CREATE'));
    assert.equal((await actor.post('/contacts',{tenantId:f.tenantB,contact:{name:'Wrong',mobile:'03001234569'},reasonReference:reference})).status,403);
    assert.equal((await f.command(actor,{action:'client-create',tenantId:f.tenantA})).status,200);
    assert.equal((await f.command(actor,{action:'client-create',tenantId:f.tenantB})).status,403);
    assert.equal((await f.command(actor,{action:'device-pause',tenantId:f.tenantB,deviceId:f.deviceB,paused:true})).status,403);
    assert.equal((await f.command(actor,{action:'device-pause',tenantId:f.tenantA,deviceId:f.deviceB,paused:true})).status,404);
    for(const command of [{action:'global-pause',paused:true},{action:'tenant-create',name:'Forbidden'},{action:'recipient-preference',number:'03001234567',optedOut:false}])assert.equal((await f.command(actor,command)).status,403);
    assert.equal((await f.command(actor,{action:'consent-grant',tenantId:f.tenantB,number:'03001234568',purpose:'transactional_notification',evidenceReference:reference})).status,403);
    assert.equal((await actor.post('/campaigns',{id:randomUUID(),tenantId:f.tenantA,clientId:f.clientA,name:'Cross contact',body:'Notice',contactIds:[contactB],reasonReference:reference})).status,404);
    assert.equal((await actor.post('/campaigns',{id:randomUUID(),tenantId:f.tenantA,clientId:f.clientA,name:'Own contact',body:'Notice',contactIds:[contactA],reasonReference:reference})).status,201);
  }finally{await f.dispose();}
});

test('section rights deny hidden endpoints, consent escalation, user creation and global changes', {skip:!enabled},async()=>{
  const f=await fixture();
  try {
    const access=assigned([f.tenantA],{...rights('none'),contacts:'manage'});access.permissions.dashboard='none';access.permissions.settings='none';
    const user=await f.create('contacts-only',access);await f.db.query('UPDATE cms_users SET totp_enabled=true WHERE id=?',[user.id]);const actor=await f.session(user.id);
    for(const path of ['/messages','/audit','/recipients','/users',`/campaigns?tenantId=${f.tenantA}`])assert.equal((await actor.get(path)).status,403,path);
    const overview=(await actor.get('/overview')).body;assert.deepEqual(overview.devices,[]);assert.deepEqual(overview.clients,[]);assert.deepEqual(overview.counts,[]);assert.equal(overview.settings.client_quota,undefined);
    const input={tenantId:f.tenantA,contact:{name:'Contact',mobile:'03001234567'},reasonReference:reference};
    assert.equal((await actor.post('/contacts',input)).status,200);
    assert.equal((await actor.post('/contacts',{...input,evidenceReference:reference})).status,403);
    assert.equal((await actor.post('/contacts/import',{tenantId:f.tenantA,contacts:[input.contact],evidenceReference:reference,reasonReference:reference})).status,403);
    assert.equal((await f.db.query('SELECT * FROM recipient_tenant_consents')).rows.length,0);
    assert.equal((await f.command(actor,{action:'client-create',tenantId:f.tenantA})).status,403);
    assert.equal((await actor.post('/users',{action:'create',username:'escalation',access:{...assigned([]),superAdmin:true},reasonReference:reference})).status,403);
    const badGlobal=assigned([f.tenantA]);badGlobal.permissions.settings='manage';
    assert.equal((await f.root.post('/users',{action:'create',username:'bad-global',access:badGlobal,reasonReference:reference})).status,400);
    // Even a forged direct database grant cannot bypass the global scope guard.
    await f.db.query('UPDATE cms_users SET permissions_json=? WHERE id=?',[JSON.stringify(rights()),user.id]);
    assert.equal((await f.command(actor,{action:'global-pause',paused:true})).body.code,'CMS_GLOBAL_ACCESS_REQUIRED');
    const viewer=await f.create('readonly',{...assigned([f.tenantA],rights('view')),role:'viewer'});
    await f.db.query('UPDATE cms_users SET totp_enabled=true WHERE id=?',[viewer.id]);const view=await f.session(viewer.id);
    assert.equal((await view.get(`/contacts?tenantId=${f.tenantA}`)).status,200);
    assert.equal((await view.post('/contacts',input)).status,403);
  }finally{await f.dispose();}
});

test('access updates revoke sessions and scheduled work, with audit rollback and password reset', {skip:!enabled},async()=>{
  const f=await fixture();
  try {
    const contact=await f.addContact(f.tenantA,'Parent','03001234567');
    const created=await f.create('campaign-owner',assigned([f.tenantA,f.tenantB]));
    await f.db.query('UPDATE cms_users SET totp_enabled=true WHERE id=?',[created.id]);const actor=await f.session(created.id);
    assert.equal((await actor.get('/overview')).body.tenants.length,2);
    await createCampaign(f.db,cipher,actor,{id:randomUUID(),tenantId:f.tenantA,clientId:f.clientA,name:'Pending access',body:'School notice',contactIds:[contact],reasonReference:reference});
    await dispatchCampaigns(f.db,cipher);
    assert.equal((await f.db.query('SELECT status FROM outbound_messages')).rows[0]!.status,'QUEUED');
    await f.db.query("CREATE TRIGGER reject_access_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'");
    await assert.rejects(manageCmsUser(f.db,f.root.id,f.root.token_hash,{action:'update',userId:created.id,access:assigned([f.tenantB]),reasonReference:reference}));
    assert.equal((await actor.get('/session')).status,200);
    assert.equal((await f.db.query('SELECT status FROM campaigns')).rows[0]!.status,'ACTIVE');
    await f.db.query('DROP TRIGGER reject_access_audit');
    const updated=await f.root.post('/users',{action:'update',userId:created.id,access:assigned([f.tenantB]),reasonReference:reference});assert.equal(updated.status,200);
    assert.equal((await actor.get('/session')).status,401);
    await assert.rejects(cmsMutationGuard(f.db,created.id,actor.token_hash,'contacts',f.tenantA),{code:'ADMIN_REQUIRED'});
    assert.equal((await f.db.query('SELECT status FROM campaigns')).rows[0]!.status,'CANCELLED');
    assert.equal((await f.db.query('SELECT status FROM outbound_messages')).rows[0]!.status,'CANCELLED');
    const renewed=await f.session(created.id);assert.deepEqual((await renewed.get('/session')).body.access.tenantIds,[f.tenantB]);
    const reset=await f.root.post('/users',{action:'reset-password',userId:created.id,reasonReference:reference});assert.equal(reset.status,200);
    assert.equal((await renewed.get('/session')).status,401);
    const stored=(await f.db.query('SELECT password_hash,totp_enabled FROM cms_users WHERE id=?',[created.id])).rows[0]!;
    assert.ok(await passwordMatches(reset.body.password,stored.password_hash));assert.equal(Number(stored.totp_enabled),1);
    const disabled=await f.root.post('/users',{action:'update',userId:created.id,access:{...assigned([f.tenantB]),enabled:false},reasonReference:reference});assert.equal(disabled.status,200);
    assert.equal((await (await f.session(created.id)).get('/session')).status,401);
  }finally{await f.dispose();}
});
