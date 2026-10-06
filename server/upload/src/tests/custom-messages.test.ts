import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { canonicalMessage, validateSmsBody, ApiError } from '../services/policy.js';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { contentCipher, digest } from '../security/crypto.js';

test('custom bodies preserve exact text and normalize recipient/purpose', () => {
  const body = ' Hello\nYour order is ready. ';
  assert.deepEqual(canonicalMessage({ to: '03001234567', body }), {
    to: '+923001234567', purpose: 'transactional_notification', body,
  });
  assert.throws(() => canonicalMessage({ to: '+12025550123', body }));
  assert.throws(() => canonicalMessage({ to: '03001234567', body, templateId: 'appointment_reminder_v1', variables: { date: '2026-09-24' } }));
  assert.throws(() => canonicalMessage({ to: '03001234567', body, purpose: 'marketing' }));
});

test('single segment budget counts GSM extension characters and Unicode units', () => {
  for (const body of ['a'.repeat(160), '^'.repeat(80), '€'.repeat(80), 'ا'.repeat(70), '😀'.repeat(35), 'Your order is ready.']) validateSmsBody(body);
  for (const body of ['a'.repeat(161), '^'.repeat(81), '€'.repeat(81), 'ا'.repeat(71), '😀'.repeat(36), 'a'.repeat(70) + 'ا']) {
    assert.throws(() => validateSmsBody(body), (error: unknown) => error instanceof ApiError && error.code === 'MESSAGE_TOO_LONG');
  }
  for (const body of ['', '  \n', '\u0000hello', '\u001b', '\ud800', '\udc00']) {
    assert.throws(() => validateSmsBody(body), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_MESSAGE_BODY');
  }
});

test('custom API preserves encryption, idempotency and recipient policy', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const fixture = await databaseFixture();
  try {
    const { db } = fixture;
    const tenant = '00000000-0000-4000-8000-000000000001';
    const client = '00000000-0000-4000-8000-000000000002';
    const device = '00000000-0000-4000-8000-000000000003';
    const to = '+923001234567';
    const token = 'custom-message-test-token-123456789';
    const cipher = contentCipher('ab'.repeat(32));
    await db.query('INSERT INTO tenants VALUES (?,?,true)', [tenant, 'Custom test']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)', [client, tenant, digest(token), JSON.stringify(['sms:send','sms:read'])]);
    await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id) VALUES (?,?,false,1)', [device,tenant]);
    const app = createApp(db, 'ab'.repeat(32));
    const body = 'آپ کا آرڈر تیار ہے۔';
    const send = (key: string, data: object = { to, body }) => request(app).post('/v1/messages').auth(token, { type:'bearer' }).set('Idempotency-Key', key).send(data);
    assert.equal((await send('paused-custom')).body.code, 'GATEWAY_PAUSED');
    await db.query('UPDATE gateway_settings SET paused=false');
    assert.equal((await send('no-consent')).body.code, 'CONSENT_REQUIRED');
    assert.equal((await send('too-long', { to, body: 'ا'.repeat(71) })).body.code, 'MESSAGE_TOO_LONG');
    assert.equal((await db.query('SELECT * FROM outbound_messages')).rows.length, 0);
    await db.query('INSERT INTO recipients (normalized_e164) VALUES (?)', [to]);
    await db.query('INSERT INTO recipient_tenant_consents VALUES (?,?,?,?,NULL)', [tenant,to,'transactional_notification','synthetic fixture']);
    const withoutKey = () => request(app).post('/v1/messages').auth(token, { type:'bearer' }).send({ to, body });
    assert.equal((await send('bad')).status, 400);
    const accepted = await withoutKey();
    assert.equal(accepted.status, 202);
    const generatedKey = accepted.headers['idempotency-key'];
    assert.ok(generatedKey);
    assert.match(generatedKey, /^[0-9a-f-]{36}$/);
    assert.equal((await withoutKey()).body.code, 'RECIPIENT_COOLDOWN');
    const row = (await db.query('SELECT * FROM outbound_messages')).rows[0]!;
    assert.equal(cipher.decrypt(row.encrypted_body, row.id), body);
    assert.equal(row.body_hash, digest(body));
    assert.equal(row.segments, 1);
    assert.equal((await db.query('SELECT * FROM outbox_events')).rows.length, 1);
    const retry = await send(generatedKey, { to: '03001234567', body, purpose: 'transactional_notification' });
    assert.equal(retry.body.jobId, accepted.body.jobId);
    assert.equal((await send(generatedKey, { to, body: 'Changed text' })).body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await send('custom-cooldown')).body.code, 'RECIPIENT_COOLDOWN');
    await db.query("UPDATE recipients SET next_allowed_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND");
    assert.equal((await send('custom-replay')).body.code, 'CONTENT_REPLAY');
    assert.equal((await withoutKey()).body.code, 'CONTENT_REPLAY');
    await db.query('UPDATE recipients SET suppressed=true');
    assert.equal((await send('custom-suppressed', { to, body: 'Another message' })).body.code, 'RECIPIENT_SUPPRESSED');
    assert.equal((await db.query('SELECT * FROM outbound_messages')).rows.length, 1);
  } finally { await fixture.dispose(); }
});
