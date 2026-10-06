import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { databaseFixture } from './database-fixture.js';
import { contentCipher, digest } from '../security/crypto.js';
import { normalizeNumber } from '../services/policy.js';
const tenant = '00000000-0000-4000-8000-000000000001';
const client = '00000000-0000-4000-8000-000000000002';
const device = '00000000-0000-4000-8000-000000000003';
const token = 'development-test-token-only-123456789';
// Synthetic format fixtures only; no test has a transport capable of sending SMS.
const destination = '+923001234567';
const payload = { to: destination, templateId: 'appointment_reminder_v1', purpose: 'transactional_notification', variables: { date: '2026-09-24' } };
test('Pakistan mobile normalization shares identity across formats', () => {
  for (const value of ['03001234567','923001234567','+923001234567']) assert.equal(normalizeNumber(value), destination);
  for (const value of ['+12025550123','garbage','call 03001234567']) assert.throws(() => normalizeNumber(value));
});
test('encrypted bodies require the key and original job identity', () => {
  const cipher = contentCipher(randomBytes(32).toString('hex'));
  const encrypted = cipher.encrypt('private content', 'job-one');
  assert.equal(cipher.decrypt(encrypted, 'job-one'), 'private content');
  assert.ok(!encrypted.includes('private content'));
  assert.throws(() => cipher.decrypt(encrypted, 'job-two'));
  assert.throws(() => contentCipher(''));
});
test('MariaDB-backed API enforces reservations, consent, scopes and isolation', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const fixture = await databaseFixture();
  try {
    const { db } = fixture;
    await db.query('INSERT INTO tenants VALUES (?,?,true)', [tenant,'Test']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)', [client,tenant,digest(token),JSON.stringify(['sms:send','sms:read','sms:compliance:write'])]);
    await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id) VALUES (?,?,false,1)', [device,tenant]);
    const app = createApp(db, 'ab'.repeat(32));
    const send = (key: string, body = payload) => request(app).post('/v1/messages').auth(token,{type:'bearer'}).set('Idempotency-Key',key).send(body);
    await t.test('anonymous and invalid input are rejected', async () => {
      assert.equal((await request(app).post('/v1/messages').send(payload)).status,401);
      assert.equal((await send('invalid-input',{...payload, variables:{date:'bad'}})).status,400);
    });
    await t.test('paused and unconsented requests reserve nothing', async () => {
      assert.equal((await send('paused-001')).body.code,'GATEWAY_PAUSED');
      await db.query('UPDATE gateway_settings SET paused=false');
      assert.equal((await send('consent-001')).body.code,'CONSENT_REQUIRED');
      assert.equal((await db.query('SELECT * FROM outbound_messages')).rows.length,0);
    });
    await db.query('INSERT INTO recipients (normalized_e164) VALUES (?)',[destination]);
    await db.query('INSERT INTO recipient_tenant_consents VALUES (?,?,?,?,NULL)',[tenant,destination,payload.purpose,'synthetic test fixture']);
    let jobId: string;
    await t.test('acceptance encrypts body and atomically writes outbox and audit', async () => {
      const response = await send('accepted-001');
      assert.equal(response.status,202); jobId=response.body.jobId;
      const row = (await db.query('SELECT * FROM outbound_messages')).rows[0]!;
      assert.ok(!row.encrypted_body.includes('Reminder'));
      assert.equal((await db.query('SELECT * FROM outbox_events')).rows.length,1);
      assert.equal((await db.query('SELECT * FROM audit_logs')).rows.length,1);
      const status = await request(app).get(`/v1/messages/${jobId}`).auth(token,{type:'bearer'});
      assert.equal(status.body.status,'QUEUED'); assert.equal(status.body.encrypted_body,undefined);
      const list = await request(app).get('/v1/messages?status=QUEUED&limit=1&offset=0').auth(token,{type:'bearer'});
      assert.equal(list.status,200); assert.equal(list.body.messages[0].id,jobId);
      assert.equal((await request(app).get('/v1/messages').auth(token,{type:'bearer'})).status,200);
    });
    await t.test('canonical retry returns same job; changed request conflicts', async () => {
      const retry = await send('accepted-001',{...payload,to:'03001234567'});
      assert.equal(retry.status,202); assert.equal(retry.body.jobId,jobId!);
      assert.equal((await send('accepted-001',{...payload,variables:{date:'2026-09-25'}})).status,409);
      assert.equal((await db.query('SELECT * FROM outbound_messages')).rows.length,1);
    });
    await t.test('cooldown and content replay survive new idempotency keys', async () => {
      const cooldown = await send('cooldown-001');
      assert.equal(cooldown.status,429); assert.ok(Number(cooldown.headers['retry-after'])>0);
      await db.query("UPDATE recipients SET next_allowed_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND");
      assert.equal((await send('duplicate-001')).body.code,'CONTENT_REPLAY');
    });
    await t.test('rolling recipient quota includes unknown attempts', async () => {
      for (const date of ['2026-09-25','2026-09-26']) {
        assert.equal((await send(`quota-${date}`,{...payload,variables:{date}})).status,202);
        await db.query("UPDATE recipients SET next_allowed_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND");
      }
      await db.query("UPDATE outbound_messages SET status='UNKNOWN'");
      assert.equal((await send('quota-denied',{...payload,variables:{date:'2026-09-27'}})).body.code,'RECIPIENT_QUOTA');
    });
    await t.test('suppression rejects future sends', async () => {
      assert.equal((await request(app).post(`/v1/recipients/${destination}/suppress`).auth(token,{type:'bearer'})).status,204);
      assert.equal((await send('suppressed-001')).body.code,'RECIPIENT_SUPPRESSED');
    });
    await t.test('tenant isolation and scope checks', async () => {
      const otherTenant='00000000-0000-4000-8000-000000000004';
      const otherToken='another-development-token-123456789';
      await db.query('INSERT INTO tenants VALUES (?,?,true)',[otherTenant,'Other']);
      await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',['00000000-0000-4000-8000-000000000005',otherTenant,digest(otherToken),JSON.stringify(['sms:read'])]);
      assert.equal((await request(app).get(`/v1/messages/${jobId!}`).auth(otherToken,{type:'bearer'})).status,404);
      assert.equal((await request(app).post('/v1/messages').auth(otherToken,{type:'bearer'}).send(payload)).status,403);
      await db.query('UPDATE api_clients SET enabled=false WHERE id=?',[client]);
      assert.equal((await send('revoked-001')).status,401);
    });
  } finally { await fixture.dispose(); }
});
