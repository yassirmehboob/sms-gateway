import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { databaseFixture } from './database-fixture.js';
import { executeOperatorCommand } from '../services/operator.js';
import { signaturePayload, approvedPublicKey } from '../security/device-signatures.js';
import { contentCipher, digest } from '../security/crypto.js';
import { messageService } from '../services/messages.js';
import { reconcile } from '../workers/reconcile.js';

const ready={subscriptionId:1,canSendSms:true,locallyPaused:false};
test('device enrollment only accepts P-256 public keys',()=>{
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  assert.ok(approvedPublicKey(ec.publicKey.export({format:'pem',type:'spki'}).toString()).includes('PUBLIC KEY'));
  assert.throws(()=>approvedPublicKey(ec.privateKey.export({format:'pem',type:'pkcs8'}).toString()));
  const wrong=generateKeyPairSync('ec',{namedCurve:'secp384r1'});
  assert.throws(()=>approvedPublicKey(wrong.publicKey.export({format:'pem',type:'spki'}).toString()));
});

test('MariaDB device protocol: enrollment, signatures, leases and irreversible authorization', {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const fixture=await databaseFixture();const {db}=fixture;
  const tenantId=randomUUID(),deviceId=randomUUID(),clientId=randomUUID(),operatorId=randomUUID();
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const cipher=contentCipher('ab'.repeat(32));const app=createApp(db,'ab'.repeat(32));
  const run=(command:unknown)=>executeOperatorCommand(db,{actorId:operatorId,reasonReference:'TEST-DEVICE',command});
  function signed(path:string,body:unknown,options:{nonce?:string;timestamp?:string;identity?:string;signingKey?:typeof key.privateKey;actualBody?:unknown}={}) {
    const json=JSON.stringify(body);
    const proof={deviceId:options.identity??deviceId,nonce:options.nonce??randomUUID(),timestamp:options.timestamp??String(Math.floor(Date.now()/1000)),method:'POST',path:`/v1/device${path}`,body:Buffer.from(json)};
    const signature=sign('sha256',Buffer.from(signaturePayload(proof)),{key:options.signingKey??key.privateKey,dsaEncoding:'der'}).toString('base64');
    return request(app).post(proof.path).set('Content-Type','application/json').set('X-Device-Id',proof.deviceId).set('X-Device-Nonce',proof.nonce).set('X-Device-Timestamp',proof.timestamp).set('X-Device-Signature',signature).send(options.actualBody===undefined?json:JSON.stringify(options.actualBody));
  }
  try {
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenantId,'Device test']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[clientId,tenantId,digest('test-token'),JSON.stringify(['sms:send'])]);
    await run({action:'device-create',tenantId,deviceId,simId:1});
    const issued=await run({action:'device-enrollment',tenantId,deviceId,publicKey:key.publicKey.export({format:'pem',type:'spki'}).toString()});
    await t.test('one-time enrollment requires the pinned key and unexpired token',async()=>{
      const wrong=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      assert.equal((await signed('/enroll',{enrollmentToken:issued.enrollmentToken},{signingKey:wrong.privateKey})).status,401);
      const success=await signed('/enroll',{enrollmentToken:issued.enrollmentToken});
      assert.equal(success.status,200);assert.equal(success.body.paused,true);
      assert.equal((await signed('/enroll',{enrollmentToken:issued.enrollmentToken})).status,401);
      assert.equal((await db.query('SELECT token_hash FROM enrollment_challenges')).rows[0]!.token_hash,digest(issued.enrollmentToken!));
    });
    await t.test('signatures bind body and timestamp and reject replay',async()=>{
      const nonce=randomUUID();
      assert.equal((await signed('/heartbeat',ready,{nonce})).status,200);
      assert.equal((await signed('/heartbeat',ready,{nonce})).body.code,'DEVICE_REQUEST_REPLAY');
      assert.equal((await signed('/heartbeat',ready,{timestamp:'1000000000'})).body.code,'DEVICE_CLOCK_SKEW');
      assert.equal((await signed('/heartbeat',ready,{actualBody:{...ready,subscriptionId:2}})).body.code,'INVALID_DEVICE_SIGNATURE');
      assert.equal((await request(app).post('/v1/device/jobs/claim').send(ready)).status,401);
    });
    await t.test('FCM registration is signed and encrypted',async()=>{
      const token='test-fcm-routing-address-123456789';
      assert.equal((await signed('/fcm-token',{token})).status,200);
      const encrypted=(await db.query('SELECT encrypted_fcm_token FROM devices WHERE id=?',[deviceId])).rows[0]!.encrypted_fcm_token;
      assert.ok(!encrypted.includes(token));assert.equal(cipher.decrypt(encrypted,`fcm:${deviceId}`),token);
    });
    await run({action:'device-pause',tenantId,deviceId,paused:false});await run({action:'global-pause',paused:false});
    await run({action:'consent-grant',tenantId,number:'+923001234567',purpose:'transactional_notification',evidenceReference:'CONSENT-1'});
    const messages=messageService(db,cipher);const actor={id:clientId,tenant_id:tenantId,scopes:['sms:send']};
    const create=async(date:string)=>{
      await db.query("UPDATE recipients SET next_allowed_at='1970-01-01'");
      return messages.create(actor,randomUUID(),{to:'+923001234567',templateId:'appointment_reminder_v1',purpose:'transactional_notification',variables:{date}});
    };
    const job=await create('2026-09-24');let leaseId:string;
    await t.test('duplicate claims share one lease and wrong SIM cannot claim',async()=>{
      const rejectedNonce=randomUUID();
      assert.equal((await signed('/jobs/claim',{...ready,subscriptionId:2},{nonce:rejectedNonce})).body.code,'DEVICE_NOT_READY');
      assert.equal((await signed('/jobs/claim',{...ready,subscriptionId:2},{nonce:rejectedNonce})).body.code,'DEVICE_REQUEST_REPLAY');
      const claims=await Promise.all([signed('/jobs/claim',ready),signed('/jobs/claim',ready)]);
      assert.ok(claims.every(r=>r.status===200));leaseId=claims[0]!.body.job.leaseId;
      assert.equal(claims[1]!.body.job.leaseId,leaseId);assert.equal(claims[0]!.body.job.jobId,job.jobId);
      assert.ok(claims[0]!.body.job.body.includes('2026-09-24'));
    });
    await t.test('authorization rechecks suppression and only succeeds once',async()=>{
      assert.equal((await signed(`/jobs/${job.jobId}/events`,{eventId:randomUUID(),leaseId,partIndex:0,type:'SENT_TO_CARRIER'})).body.code,'EVENT_WITHOUT_ATTEMPT');
      await db.query('UPDATE recipients SET suppressed=true');
      assert.equal((await signed(`/jobs/${job.jobId}/authorize`,{leaseId,readiness:ready})).body.code,'SEND_POLICY_REVOKED');
      await db.query('UPDATE recipients SET suppressed=false');
      await db.query("CREATE TRIGGER reject_attempt_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test audit failure'");
      assert.equal((await signed(`/jobs/${job.jobId}/authorize`,{leaseId,readiness:ready})).status,500);
      const unchanged=(await db.query('SELECT status,send_attempt_started_at FROM outbound_messages WHERE id=?',[job.jobId])).rows[0]!;
      assert.equal(unchanged.status,'CLAIMED');assert.equal(unchanged.send_attempt_started_at,null);
      await db.query('DROP TRIGGER reject_attempt_audit');
      const results=await Promise.all([signed(`/jobs/${job.jobId}/authorize`,{leaseId,readiness:ready}),signed(`/jobs/${job.jobId}/authorize`,{leaseId,readiness:ready})]);
      assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
      const authorized=results.find(r=>r.status===200)!;
      assert.ok(authorized.body.validForMs>0 && authorized.body.validForMs<=60000);
      assert.equal((await signed('/jobs/claim',ready)).body.job,null);
    });
    await t.test('lost authorization becomes UNKNOWN; late events reconcile without resending',async()=>{
      await db.query('UPDATE outbound_messages SET send_attempt_started_at=CURRENT_TIMESTAMP(6)-INTERVAL 3 MINUTE WHERE id=?',[job.jobId]);
      await reconcile(db);
      assert.equal((await db.query('SELECT status FROM outbound_messages WHERE id=?',[job.jobId])).rows[0]!.status,'UNKNOWN');
      assert.equal((await signed('/jobs/claim',ready)).body.job,null);
      const event={eventId:randomUUID(),leaseId,partIndex:0,type:'DELIVERED'};
      assert.equal((await signed(`/jobs/${job.jobId}/events`,event)).body.status,'DELIVERED');
      assert.equal((await signed(`/jobs/${job.jobId}/events`,event)).body.status,'DELIVERED');
      assert.equal((await signed(`/jobs/${job.jobId}/events`,{...event,type:'FAILED_DEFINITE'})).body.code,'EVENT_CONFLICT');
      assert.equal((await signed(`/jobs/${job.jobId}/events`,{...event,eventId:randomUUID(),type:'SENT_TO_CARRIER'})).body.status,'DELIVERED');
      assert.equal((await db.query('SELECT * FROM device_events')).rows.length,2);
    });
    const second=await create('2026-09-25');
    await t.test('expired claim can be reclaimed but its old lease cannot authorize',async()=>{
      const old=(await signed('/jobs/claim',ready)).body.job;
      await db.query('UPDATE outbound_messages SET lease_expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?',[second.jobId]);
      const fresh=(await signed('/jobs/claim',ready)).body.job;assert.notEqual(fresh.leaseId,old.leaseId);
      assert.equal((await signed(`/jobs/${second.jobId}/authorize`,{leaseId:old.leaseId,readiness:ready})).status,409);
      await db.query('UPDATE outbound_messages SET expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?',[second.jobId]);
      assert.equal((await signed(`/jobs/${second.jobId}/authorize`,{leaseId:fresh.leaseId,readiness:ready})).status,409);
      await reconcile(db);assert.equal((await signed('/jobs/claim',ready)).body.job,null);
    });
    await t.test('another enrolled device cannot access jobs and revocation invalidates signatures',async()=>{
      const otherId=randomUUID();const otherKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      await run({action:'device-create',tenantId,deviceId:otherId,simId:1});
      const token=await run({action:'device-enrollment',tenantId,deviceId:otherId,publicKey:otherKey.publicKey.export({format:'pem',type:'spki'}).toString()});
      await db.query('UPDATE enrollment_challenges SET expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE device_id=?',[otherId]);
      assert.equal((await signed('/enroll',{enrollmentToken:token.enrollmentToken},{identity:otherId,signingKey:otherKey.privateKey})).status,401);
      const renewed=await run({action:'device-enrollment',tenantId,deviceId:otherId,publicKey:otherKey.publicKey.export({format:'pem',type:'spki'}).toString()});
      assert.equal((await signed('/enroll',{enrollmentToken:renewed.enrollmentToken},{identity:otherId,signingKey:otherKey.privateKey})).status,200);
      assert.equal((await signed(`/jobs/${job.jobId}/events`,{eventId:randomUUID(),leaseId,partIndex:0,type:'DELIVERED'},{identity:otherId,signingKey:otherKey.privateKey})).status,404);
      await run({action:'device-revoke',tenantId,deviceId});
      assert.equal((await signed('/heartbeat',ready)).status,401);
    });
  } finally {await fixture.dispose();}
});
