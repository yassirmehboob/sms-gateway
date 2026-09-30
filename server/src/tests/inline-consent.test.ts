import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { contentCipher, digest } from '../security/crypto.js';
import { canonicalMessage } from '../services/policy.js';

test('inline evidence is validated, retained for idempotency and excluded from SMS text',()=>{
 const input={to:'03001234567',body:'Order confirmed.',evidenceReference:'CUSTOMER-SIGNUP-123'};
 assert.equal(canonicalMessage(input).body,input.body);
 assert.notDeepEqual(canonicalMessage(input),canonicalMessage({...input,evidenceReference:'OTHER-123'}));
 for(const evidenceReference of ['', 'ab','a'.repeat(129),'contains spaces',null,123])assert.throws(()=>canonicalMessage({...input,evidenceReference}));
});

test('single-call consent is tenant-scoped, atomic, audited and cannot undo blocks', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const fixture=await databaseFixture();
 const {db}=fixture;
 try {
   const tenant=randomUUID(),client=randomUUID(),device=randomUUID(),otherTenant=randomUUID(),otherClient=randomUUID(),otherDevice=randomUUID();
   const token='inline-consent-test-token-123456789',otherToken='other-inline-consent-token-123456789';
   for(const [t,c,d,k] of [[tenant,client,device,token],[otherTenant,otherClient,otherDevice,otherToken]]) {
     await db.query('INSERT INTO tenants VALUES (?,?,true)',[t,'Inline test']);
     await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[c,t,digest(k!),JSON.stringify(['sms:send'])]);
     await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id) VALUES (?,?,false,1)',[d,t]);
   }
   await db.query('UPDATE gateway_settings SET paused=false,cooldown_seconds=0,recipient_quota=100,client_quota=100,device_quota=100');
   const app=createApp(db,'ab'.repeat(32));
   const to='+923001234567';
   const input={to,body:'Your order is confirmed.',includeOptOut:true,evidenceReference:'CUSTOMER-SIGNUP-123'};
   const send=(body:object,key=randomUUID(),apiKey=token)=>request(app).post('/v1/messages').auth(apiKey,{type:'bearer'}).set('Idempotency-Key',key).send(body);
   assert.equal((await send({to,body:'No evidence'})).body.code,'CONSENT_REQUIRED');
   const idem=randomUUID();
   const [a,b]=await Promise.all([send(input,idem),send(input,idem)]);
   assert.equal(a.status,202);assert.equal(b.status,202);assert.equal(a.body.jobId,b.body.jobId);
   const records=(await db.query('SELECT * FROM recipient_tenant_consents')).rows;
   assert.equal(records.length,1);assert.equal(records[0]!.tenant_id,tenant);assert.equal(records[0]!.evidence,input.evidenceReference);
   const audits=(await db.query("SELECT * FROM audit_logs WHERE action='CONSENT_RECORDED_ON_SEND'")).rows;
   assert.equal(audits.length,1);assert.equal(audits[0]!.actor_id,client);assert.equal(audits[0]!.resource_id,a.body.jobId);
   const job=(await db.query('SELECT * FROM outbound_messages')).rows[0]!;
   assert.equal(contentCipher('ab'.repeat(32)).decrypt(job.encrypted_body,job.id),input.body+'\nReply STOP to unsubscribe');
   assert.equal((await send({...input,evidenceReference:'CHANGED-123'},idem)).body.code,'IDEMPOTENCY_CONFLICT');
   assert.equal((await send({to,body:'Other tenant'},randomUUID(),otherToken)).body.code,'CONSENT_REQUIRED');
   assert.equal((await send({...input,body:'Other tenant'},randomUUID(),otherToken)).status,202);
   assert.equal((await db.query('SELECT * FROM recipient_tenant_consents')).rows.length,2);
   assert.equal((await send({...input,body:'Another message',evidenceReference:'NEW-REF-123'})).status,202);
   assert.equal((await db.query('SELECT evidence FROM recipient_tenant_consents WHERE tenant_id=?',[tenant])).rows[0]!.evidence,input.evidenceReference);
   await db.query('UPDATE recipient_tenant_consents SET revoked_at=CURRENT_TIMESTAMP(6) WHERE tenant_id=?',[tenant]);
   assert.equal((await send({...input,body:'Revoked'})).body.code,'CONSENT_REVOKED');

   const blocked='+923001234568';
   await db.query('INSERT INTO recipients (normalized_e164,suppressed) VALUES (?,true)',[blocked]);
   assert.equal((await send({...input,to:blocked})).body.code,'RECIPIENT_SUPPRESSED');
   await db.query('UPDATE recipients SET suppressed=false WHERE normalized_e164=?',[blocked]);
   await db.query('INSERT INTO sms_preferences (normalized_e164,opted_out) VALUES (?,true)',[blocked]);
   assert.equal((await send({...input,to:blocked})).body.code,'RECIPIENT_OPTED_OUT');
   assert.equal((await db.query('SELECT * FROM recipient_tenant_consents WHERE normalized_e164=?',[blocked])).rows.length,0);
   await db.query('UPDATE sms_preferences SET opted_out=false WHERE normalized_e164=?',[blocked]);
   await db.query('UPDATE gateway_settings SET client_quota=1');
   assert.equal((await send({...input,to:blocked})).body.code,'CLIENT_QUOTA');
   assert.equal((await db.query('SELECT * FROM recipient_tenant_consents WHERE normalized_e164=?',[blocked])).rows.length,0);
   assert.equal((await db.query("SELECT * FROM audit_logs WHERE action='CONSENT_RECORDED_ON_SEND'")).rows.length,2);
 } finally {await fixture.dispose();}
});
