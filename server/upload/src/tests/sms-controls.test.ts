import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { signaturePayload } from '../security/device-signatures.js';
import { contentCipher, digest } from '../security/crypto.js';
import { canonicalMessage } from '../services/policy.js';
import { messageService } from '../services/messages.js';
import { fcmOutbox } from '../workers/fcm-outbox.js';

test('opt-out JSON option appends instructions and validates final segment length', () => {
  const base = { to:'+923001234567', body:'Your order is ready.' };
  assert.equal(canonicalMessage({...base,includeOptOut:true}).body, `${base.body}\nReply STOP to unsubscribe`);
  assert.deepEqual(canonicalMessage({...base,includeOptOut:false}), canonicalMessage(base));
  assert.throws(() => canonicalMessage({...base,body:'a'.repeat(160),includeOptOut:true}));
  assert.throws(() => canonicalMessage({...base,includeOptOut:'true'}));
});

test('signed SMS controls suppress, confirm once, resume and preserve manual policy', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const fixture = await databaseFixture();
  const {db} = fixture;
  const tenant=randomUUID(), client=randomUUID(), device=randomUUID();
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const app=createApp(db,'ab'.repeat(32));
  const cipher=contentCipher('ab'.repeat(32));
  const number='+923001234567';
  const ready={subscriptionId:1,canSendSms:true,locallyPaused:false};
  const actor={id:client,tenant_id:tenant,scopes:['sms:send']};
  const messages=messageService(db,cipher);
  const now=Date.now()-60000;
  function signed(path:string, body:unknown) {
    const json=JSON.stringify(body);
    const proof={deviceId:device,nonce:randomUUID(),timestamp:String(Math.floor(Date.now()/1000)),method:'POST',path:`/v1/device${path}`,body:Buffer.from(json)};
    const signature=sign('sha256',Buffer.from(signaturePayload(proof)),key.privateKey).toString('base64');
    return request(app).post(proof.path).set('Content-Type','application/json').set('X-Device-Id',device).set('X-Device-Nonce',proof.nonce).set('X-Device-Timestamp',proof.timestamp).set('X-Device-Signature',signature).send(json);
  }
  const control=(command:string, receivedAt:number, eventId=randomUUID())=>({eventId,from:number,command,subscriptionId:1,receivedAt});
  try {
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenant,'Control tests']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[client,tenant,digest('test-control-token'),JSON.stringify(['sms:send'])]);
    await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id,public_key,encrypted_fcm_token) VALUES (?,?,false,1,?,?)',[device,tenant,key.publicKey.export({type:'spki',format:'pem'}).toString(),cipher.encrypt('test-control-fcm-token',`fcm:${device}`)]);
    await db.query('UPDATE gateway_settings SET paused=false');
    await db.query('INSERT INTO recipients (normalized_e164) VALUES (?)',[number]);
    await db.query('INSERT INTO recipient_tenant_consents VALUES (?,?,?,?,NULL)',[tenant,number,'transactional_notification','synthetic consent']);
    const normal=await messages.create(actor,randomUUID(),{to:number,body:'A test notification'});
    const claim=await signed('/jobs/claim',ready);
    assert.equal(claim.body.job.jobId,normal.jobId);
    const stop=control('STOP',now);
    assert.equal((await request(app).post('/v1/device/inbound-control').send(stop)).status,401);
    assert.equal((await signed('/inbound-control',{...stop,subscriptionId:2})).body.code,'WRONG_INBOUND_SIM');
    assert.equal((await signed('/inbound-control',{...stop,command:'hello'})).status,400);
    assert.equal((await signed('/inbound-control',{...stop,from:'+923001234568'})).body.reason,'UNKNOWN_RECIPIENT');
    const stopped=await signed('/inbound-control',stop);
    assert.equal(stopped.status,200); assert.equal(stopped.body.optedOut,true);
    assert.ok(stopped.body.confirmationJobId);
    assert.equal((await db.query('SELECT status FROM outbound_messages WHERE id=?',[normal.jobId])).rows[0]!.status,'CANCELLED');
    assert.equal((await signed(`/jobs/${normal.jobId}/authorize`,{leaseId:claim.body.job.leaseId,readiness:ready})).body.code,'ATTEMPT_NOT_AUTHORIZED');
    await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Must be blocked'}),{code:'RECIPIENT_OPTED_OUT'});
    assert.deepEqual((await signed('/inbound-control',stop)).body,stopped.body);
    assert.equal((await signed('/inbound-control',{...stop,command:'START'})).body.code,'EVENT_CONFLICT');
    assert.equal((await signed('/inbound-control',control('STOP',now+1000))).body.confirmationJobId,null);
    assert.equal((await db.query('SELECT status FROM outbound_messages WHERE id=?',[stopped.body.confirmationJobId])).rows[0]!.status,'QUEUED');
    let wakeups=0;
    const outbox=fcmOutbox(db,cipher,{async send(){wakeups++;} });
    assert.equal(await outbox.dispatchOne(),true); assert.equal(wakeups,1);
    const confirm=await signed('/jobs/claim',ready);
    assert.equal(confirm.body.job.controlCommand,'STOP');
    assert.match(confirm.body.job.body,/Reply START/);
    assert.equal((await signed(`/jobs/${confirm.body.job.jobId}/authorize`,{leaseId:confirm.body.job.leaseId,readiness:ready})).status,200);
    assert.equal((await signed(`/jobs/${confirm.body.job.jobId}/authorize`,{leaseId:confirm.body.job.leaseId,readiness:ready})).status,409);
    // START clears only the SMS preference, not manual suppression or revoked consent.
    await db.query('UPDATE recipients SET suppressed=true');
    const started=await signed('/inbound-control',control('START',now+2000));
    assert.equal(started.body.optedOut,false); assert.equal(started.body.confirmationJobId,null);
    await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Still manually suppressed'}),{code:'RECIPIENT_SUPPRESSED'});
    const stale=await signed('/inbound-control',control('STOP',now+1500));
    assert.equal(stale.body.stale,true); assert.equal(stale.body.optedOut,false);
    await db.query("UPDATE recipients SET suppressed=false,next_allowed_at='1970-01-01'");
    await db.query('UPDATE recipient_tenant_consents SET revoked_at=CURRENT_TIMESTAMP(6)');
    await assert.rejects(messages.create(actor,randomUUID(),{to:number,body:'Consent still required'}),{code:'CONSENT_REQUIRED'});
    await db.query('UPDATE recipient_tenant_consents SET revoked_at=NULL');
    assert.ok((await messages.create(actor,randomUUID(),{to:number,body:'Service resumed'})).jobId);
    // Audit failure must roll back suppression and confirmations.
    await db.query("CREATE TRIGGER reject_control_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'");
    assert.equal((await signed('/inbound-control',control('STOP',now+3000))).status,500);
    assert.equal((await db.query('SELECT opted_out FROM sms_preferences')).rows[0]!.opted_out,0);
    await db.query('DROP TRIGGER reject_control_audit');
    // After the reply rate limit, a new STOP/START transition can confirm again.
    await db.query('UPDATE sms_preferences SET last_stop_confirmation_at=CURRENT_TIMESTAMP(6)-INTERVAL 6 MINUTE');
    const stoppedAgain=await signed('/inbound-control',control('STOP',now+4000));
    assert.ok(stoppedAgain.body.confirmationJobId);
    // START has its own interval and can acknowledge immediately after STOP.
    const startedAgain=await signed('/inbound-control',control('START',now+5000));
    assert.ok(startedAgain.body.confirmationJobId);
    assert.equal((await db.query('SELECT status FROM outbound_messages WHERE id=?',[stoppedAgain.body.confirmationJobId])).rows[0]!.status,'CANCELLED');
    const startConfirmation=await signed('/jobs/claim',ready);
    assert.equal(startConfirmation.body.job.jobId,startedAgain.body.confirmationJobId);
    assert.equal(startConfirmation.body.job.controlCommand,'START');
    assert.match(startConfirmation.body.job.body,/START request is received/);
    assert.equal((await signed(`/jobs/${startConfirmation.body.job.jobId}/authorize`,{leaseId:startConfirmation.body.job.leaseId,readiness:ready})).status,200);
  } finally { await fixture.dispose(); }
});
