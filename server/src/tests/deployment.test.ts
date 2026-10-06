import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import type { Database } from '../db/database.js';
import { deploymentConfig, needsCmsListener, applicationUrls, applicationBasePath } from '../deployment.js';
import { signaturePayload, verifyDeviceProof } from '../security/device-signatures.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { digest } from '../security/crypto.js';
import { canonicalMessage } from '../services/policy.js';

const unavailable = async (): Promise<never> => { throw new Error('Unexpected database access'); };
const db: Database = { query: unavailable, transaction: unavailable, withConnection: unavailable };
const key = 'ab'.repeat(32);

test('subfolder routes work with intact or proxy-stripped prefixes', async () => {
  const app = createApp(db, key, { basePath: '/sms-gateway/' });
  for (const path of ['/sms-gateway/healthz', '/healthz', '/sms-gateway/healthz?check=1']) {
    const response = await request(app).get(path).expect(200);
    assert.deepEqual(response.body, { status: 'ok' });
  }
  await request(app).post('/sms-gateway/v1/messages').send({}).expect(401);
  await request(app).get('/sms-gateway-other/healthz').expect(404);
  await request(app).get('/sms-gateway/missing').expect(404);
  assert.equal(applicationBasePath('/'), '');
  for (const path of ['/../admin', '//sms', '/sms?x=1', '/sms%2fgateway']) assert.throws(() => applicationBasePath(path));
});

test('device signatures cover the external path for both proxy forwarding styles', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const path = '/sms-gateway/v1/device/heartbeat';
  const proof = { deviceId: 'device', timestamp: '1790000000', nonce: 'nonce', method: 'POST', path, body: Buffer.from('{}') };
  const signature = sign('sha256', Buffer.from(signaturePayload(proof)), privateKey).toString('base64');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  for (const url of [path, '/v1/device/heartbeat']) {
    const external = applicationUrls(url, '/sms-gateway').external;
    verifyDeviceProof({ ...proof, path: external, signature }, pem, 1790000000);
  }
  assert.throws(() => verifyDeviceProof({ ...proof, path: '/v1/device/heartbeat', signature }, pem, 1790000000));
});

test('message responses and Location headers retain the public prefix', async () => {
  const body = { to: '+923001234567', body: 'Subfolder deployment check' };
  const jobId = '00000000-0000-4000-8000-000000000001';
  const actor = { id: 'client', tenant_id: 'tenant', scopes: ['sms:send'] };
  const fakeDb: Database = {
    async query<T>(sql: string) {
      let row: unknown;
      if (sql.includes('c.key_hash')) row = actor;
      else if (sql.includes('LEFT JOIN tenant_plans')) row = { enabled: true, expired: false, settings_json: '{}' };
      else if (sql.includes('gateway_settings')) row = { paused: false };
      else if (sql.includes('c.enabled, c.scopes')) row = { enabled: true, tenant_enabled: true, scopes: actor.scopes };
      else if (sql.includes('idempotency_keys')) row = { request_hash: digest(JSON.stringify(canonicalMessage(body))), job_id: jobId };
      else throw new Error('Unexpected query');
      return { rows: [row as T] };
    },
    transaction: fn => fn(fakeDb),
    withConnection: fn => fn(fakeDb),
  };
  const app = createApp(fakeDb, key, { basePath: '/sms-gateway' });
  const response = await request(app).post('/sms-gateway/v1/messages')
    .set('Authorization', `Bearer ${'a'.repeat(32)}`).set('Idempotency-Key', 'existing-key').send(body).expect(202);
  assert.equal(response.body.statusUrl, `/sms-gateway/v1/messages/${jobId}`);
  assert.equal(response.headers.location, response.body.statusUrl);
});

test('Passenger avoids a second listener while local CMS retains its listener', () => {
  assert.equal(deploymentConfig({}, true).passenger, true);
  assert.equal(deploymentConfig({ DEPLOYMENT_MODE: 'passenger' }).passenger, true);
  assert.equal(needsCmsListener(true, '127.0.0.1', 3000, 3001), false);
  assert.equal(needsCmsListener(false, '127.0.0.1', 3000, 3001), true);
  assert.equal(needsCmsListener(false, '127.0.0.1', 3000, 3000), false);
  assert.equal(deploymentConfig({}).proxyHops, 0);
  for (const value of ['true', '-1', '1.5', '11']) assert.throws(() => deploymentConfig({ TRUST_PROXY_HOPS: value }));
});

test('one proxy hop isolates client quotas and ignores spoofed leftmost addresses', async () => {
  const app = createApp(db, key, { proxyHops: 1 });
  for (let i = 0; i < 60; i++) {
    await request(app).get('/healthz').set('X-Forwarded-For', `198.51.100.${i + 1}, 203.0.113.10`).expect(200);
  }
  await request(app).get('/healthz').set('X-Forwarded-For', '198.51.100.200, 203.0.113.10').expect(429);
  await request(app).get('/healthz').set('X-Forwarded-For', '203.0.113.11').expect(200);
});

test('forwarded headers cannot expose the local CMS when proxy trust is enabled', async () => {
  const app = createApp(db, key, { proxyHops: 1 });
  await request(app).get('/admin/').set('Host', 'localhost').expect(200);
  await request(app).get('/admin/').set('Host', 'sms.example.com').set('X-Forwarded-Host', 'localhost').expect(403);
  await request(app).get('/admin/').set('Host', 'localhost').set('X-Forwarded-For', '203.0.113.10').expect(403);
});
