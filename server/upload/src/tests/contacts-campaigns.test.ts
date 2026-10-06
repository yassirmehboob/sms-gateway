import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { parseContactWorkbook, saveContacts, contactMutation } from '../services/contacts.js';
import { createCampaign, campaignControl, dispatchCampaigns } from '../services/campaigns.js';
import { contentCipher, digest } from '../security/crypto.js';
import { csrfToken } from '../security/admin-auth.js';
import { databaseFixture } from './database-fixture.js';
import { createApp } from '../app.js';
import { deviceService } from '../services/devices.js';
import { signaturePayload } from '../security/device-signatures.js';

test('Excel contact import validates headers, rows, numeric phones, duplicates and formulas', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Contacts');
  sheet.addRow(['Name', 'Mobile_no', 'Address', 'Email address']);
  sheet.addRow(['Ali', '03001234567', '', 'ali@example.org']);
  sheet.addRow(['Duplicate', '+923001234567', '', '']);
  sheet.addRow(['Numeric phone', 3001234568, 'Hyderabad', '']);
  sheet.addRow(['Bad number', '123', '', '']);
  sheet.addRow(['Bad email', '03001234569', '', 'invalid']);
  sheet.addRow(['Formula', { formula: '3001234570', result: 3001234570 }, '', '']);
  const parsed = await parseContactWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.deepEqual(parsed.rows.map(row => row.mobile), ['+923001234567', '+923001234568']);
  assert.equal(parsed.rows[1]!.address, 'Hyderabad');
  assert.equal(parsed.duplicates, 1);
  assert.deepEqual(parsed.errors.map(error => error.row), [5, 6, 7]);
  sheet.getCell('B1').value = 'Phone';
  await assert.rejects(parseContactWorkbook(Buffer.from(await book.xlsx.writeBuffer())), { code: 'IMPORT_HEADERS_REQUIRED' });
  await assert.rejects(parseContactWorkbook(Buffer.from('bad workbook')), { code: 'INVALID_EXCEL_FILE' });
  await assert.rejects(parseContactWorkbook(Buffer.alloc(2 * 1024 * 1024 + 1)), { code: 'IMPORT_FILE_TOO_LARGE' });
});

const key = 'ab'.repeat(32), cipher = contentCipher(key);
async function setup() {
  const fixture = await databaseFixture(), { db } = fixture;
  const tenantId = randomUUID(), clientId = randomUUID(), deviceId = randomUUID(), adminId = randomUUID();
  const token = randomBytes(32).toString('base64url'), admin = { id: adminId, token_hash: digest(token) };
  const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await db.query('INSERT INTO tenants VALUES (?,?,true)', [tenantId, 'Test school']);
  await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)', [clientId, tenantId, digest(randomUUID()), JSON.stringify(['sms:send'])]);
  await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id,public_key) VALUES (?,?,false,1,?)', [deviceId, tenantId, signing.publicKey.export({ format: 'pem', type: 'spki' }).toString()]);
  await db.query("INSERT INTO cms_users (id,username,password_hash,totp_enabled) VALUES (?,'test-admin','unused',true)", [adminId]);
  await db.query('INSERT INTO cms_sessions (token_hash,user_id,mfa_verified,expires_at) VALUES (?,?,true,CURRENT_TIMESTAMP(6)+INTERVAL 1 HOUR)', [admin.token_hash, adminId]);
  await db.query('UPDATE gateway_settings SET paused=false,cooldown_seconds=0,client_quota=100,device_quota=100,recipient_quota=100');
  const app = createApp(db, key);
  const post = (path: string, body: unknown) => request(app).post(`/admin/api${path}`).set('Cookie', `gateway_cms=${token}`).set('X-CMS-Request', '1').set('X-CSRF-Token', csrfToken(token, key)).send(body as object);
  const get = (path: string) => request(app).get(`/admin/api${path}`).set('Cookie', `gateway_cms=${token}`);
  const ready = { subscriptionId: 1, canSendSms: true, locallyPaused: false };
  function proof(path: string, input: unknown) {
    const data = { deviceId, method: 'POST', path: `/v1/device${path}`, nonce: randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)), body: Buffer.from(JSON.stringify(input)) };
    return { ...data, signature: sign('sha256', Buffer.from(signaturePayload(data)), signing.privateKey).toString('base64') };
  }
  const service = deviceService(db, cipher);
  const claim = () => service.claim(proof('/jobs/claim', ready), ready);
  const authorize = (job: { jobId: string; leaseId: string }) => {
    const input = { leaseId: job.leaseId, readiness: ready };
    return service.authorize(proof(`/jobs/${job.jobId}/authorize`, input), job.jobId, input);
  };
  const contacts = async (count: number, consent = true) => {
    await contactMutation(db, admin, tenantId, 'TEST-CONTACTS', 'CONTACTS_IMPORTED', tx => saveContacts(tx, tenantId, Array.from({ length: count }, (_, i) => ({ name: `Parent ${i}`, mobile: `+9230012345${String(67 + i).padStart(2, '0')}` })), undefined, false, consent ? 'TEST-CONSENT' : undefined));
    return (await db.query('SELECT id FROM contacts WHERE tenant_id=? ORDER BY name', [tenantId])).rows.map(row => row.id as string);
  };
  const campaign = (contactIds: string[], extra: Record<string, unknown> = {}) => ({ id: randomUUID(), tenantId, clientId, name: 'Attendance reminder', body: 'Please contact the school about attendance.', contactIds, reasonReference: 'TEST-CAMPAIGN', ...extra });
  return { ...fixture, tenantId, clientId, deviceId, admin, post, get, app, contacts, campaign, claim, authorize };
}

test('CMS contact/group endpoints enforce MFA roles, tenant membership, consent and import semantics', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f = await setup();
  try {
    const { db, tenantId, post, get } = f;
    assert.equal((await request(f.app).post('/admin/api/contacts').set('X-CMS-Request', '1').send({})).status, 401);
    const payload = { tenantId, contact: { name: 'Parent <script>', mobile: '03001234567', email: 'parent@example.org' }, reasonReference: 'TEST-CONTACT' };
    assert.equal((await post('/contacts', payload).set('X-CSRF-Token', '')).status, 403);
    assert.equal((await post('/contacts', payload)).status, 200);
    assert.equal((await db.query('SELECT * FROM recipient_tenant_consents')).rows.length, 0);
    assert.equal((await post('/contacts', { ...payload, contact: { ...payload.contact, name: 'Updated' }, evidenceReference: 'COLLECTED-PERMISSION' })).status, 200);
    assert.equal((await db.query('SELECT name FROM contacts')).rows[0]!.name, 'Updated');
    await db.query('UPDATE recipient_tenant_consents SET revoked_at=CURRENT_TIMESTAMP(6)');
    await post('/contacts', { ...payload, evidenceReference: 'NEW-IMPORT' });
    assert.ok((await db.query('SELECT revoked_at FROM recipient_tenant_consents')).rows[0]!.revoked_at);
    const group = await post('/groups', { tenantId, name: 'Class 8', reasonReference: 'TEST-GROUP' });
    assert.equal(group.status, 200);
    const id = (await db.query('SELECT id FROM contacts')).rows[0]!.id;
    assert.equal((await post('/group-members', { tenantId, groupId: group.body.id, contactIds: [id], reasonReference: 'TEST-MEMBERS' })).status, 200);
    assert.equal((await get(`/groups?tenantId=${tenantId}`)).body.groups[0].members, 1);
    const imported = await post('/contacts/import', { tenantId, contacts: [{ name: 'Keep existing details', mobile: '03001234567' }, { name: 'New', mobile: '03001234568' }], groupId: group.body.id, reasonReference: 'TEST-IMPORT' });
    assert.deepEqual(imported.body, { added: 1, existing: 1 });
    assert.equal((await get(`/contacts?tenantId=${tenantId}&groupId=${group.body.id}`)).body.total, 2);
    assert.equal((await get('/contacts/template')).status, 200);
    const otherTenant = randomUUID();
    await db.query('INSERT INTO tenants VALUES (?,?,true)', [otherTenant, 'Other tenant']);
    assert.equal((await post('/group-members', { tenantId: otherTenant, groupId: group.body.id, contactIds: [id], reasonReference: 'TEST-CROSS-TENANT' })).status, 404);
    assert.equal((await post('/campaigns', f.campaign([id], { tenantId: otherTenant }))).status, 403);
    await db.query("UPDATE cms_users SET role='viewer' WHERE id=?", [f.admin.id]);
    assert.equal((await post('/contacts', payload)).status, 403);
    assert.equal((await post('/campaigns', f.campaign([id]))).status, 403);
    assert.equal((await get(`/contacts?tenantId=${tenantId}`)).status, 200);
  } finally { await f.dispose(); }
});

test('campaign schedules, snapshot deduplication, concurrent dispatch and durable pacing', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f = await setup();
  try {
    const ids = await f.contacts(3);
    const group = await f.post('/groups', { tenantId: f.tenantId, name: 'Parents', reasonReference: 'TEST-GROUP' });
    await f.post('/group-members', { tenantId: f.tenantId, groupId: group.body.id, contactIds: ids, reasonReference: 'TEST-GROUP' });
    const input = f.campaign([ids[0]!], { groupIds: [group.body.id], scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    const created = await createCampaign(f.db, cipher, f.admin, input);
    assert.equal(created.recipients, 3);
    assert.equal((await createCampaign(f.db, cipher, f.admin, input)).reused, true);
    await assert.rejects(createCampaign(f.db, cipher, f.admin, { ...input, body: 'Changed content' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await f.db.query('DELETE FROM contact_group_members WHERE group_id=?', [group.body.id]);
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 0);
    await f.db.query('UPDATE campaigns SET scheduled_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?', [input.id]);
    await Promise.all([dispatchCampaigns(f.db, cipher), dispatchCampaigns(f.db, cipher), dispatchCampaigns(f.db, cipher)]);
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 1);
    // Even after the interval passes, an offline phone cannot accumulate bulk jobs.
    await f.db.query('UPDATE gateway_settings SET bulk_last_activity_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 HOUR');
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 1);
    const claimed = await f.claim();assert.ok(claimed.job);
    await f.authorize(claimed.job!);
    assert.equal(Number((await f.db.query('SELECT bulk_last_activity_at>CURRENT_TIMESTAMP(6) AS protected_window FROM gateway_settings')).rows[0]!.protected_window), 1);
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 1);
    await f.db.query('UPDATE gateway_settings SET bulk_last_activity_at=CURRENT_TIMESTAMP(6)-INTERVAL 61 SECOND');
    // A new invocation reads all state from MariaDB, as after process restart.
    await dispatchCampaigns(f.db, contentCipher(key));
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 2);
    const listed = await f.get(`/campaigns?tenantId=${f.tenantId}`);
    assert.equal(listed.status, 200);assert.equal(listed.body.campaigns[0].total, 3);
    assert.equal((await f.get(`/campaigns/${input.id}/recipients?tenantId=${f.tenantId}`)).body.recipients.length, 3);
  } finally { await f.dispose(); }
});

test('campaigns preserve permission checks, quota delays, pause/cancel, expiry and atomic enqueue', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f = await setup();
  try {
    const ids = await f.contacts(2, false);
    const input = f.campaign(ids);
    await createCampaign(f.db, cipher, f.admin, input);
    await dispatchCampaigns(f.db, cipher);
    const skipped = (await f.db.query("SELECT * FROM campaign_recipients WHERE status='SKIPPED'")).rows;
    assert.equal(skipped.length, 1);assert.equal(skipped[0]!.last_error, 'CONSENT_REQUIRED');
    await f.db.query("INSERT INTO recipient_tenant_consents (tenant_id,normalized_e164,purpose,evidence) SELECT tenant_id,normalized_e164,'transactional_notification','TEST-CONSENT' FROM contacts");
    await campaignControl(f.db, f.admin, { tenantId: f.tenantId, id: input.id, action: 'pause', reasonReference: 'TEST-PAUSE' });
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 0);
    await campaignControl(f.db, f.admin, { tenantId: f.tenantId, id: input.id, action: 'resume', reasonReference: 'TEST-RESUME' });
    await f.db.query("CREATE TRIGGER reject_batch_link BEFORE UPDATE ON campaign_recipients FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'");
    await assert.rejects(dispatchCampaigns(f.db, cipher));
    assert.equal((await f.db.query('SELECT id FROM outbound_messages')).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM idempotency_keys')).rows.length, 0);
    await f.db.query('DROP TRIGGER reject_batch_link');
    await dispatchCampaigns(f.db, cipher);
    const claimed = await f.claim();assert.ok(claimed.job);
    await campaignControl(f.db, f.admin, { tenantId: f.tenantId, id: input.id, action: 'pause', reasonReference: 'TEST-PAUSE' });
    await assert.rejects(f.authorize(claimed.job!), { code: 'CAMPAIGN_PAUSED' });
    assert.equal((await f.claim()).job, null);
    await campaignControl(f.db, f.admin, { tenantId: f.tenantId, id: input.id, action: 'cancel', reasonReference: 'TEST-CANCEL' });
    assert.equal((await f.db.query('SELECT status FROM outbound_messages')).rows[0]!.status, 'CANCELLED');
    const second = f.campaign(ids, { body: 'Another notice' });
    await createCampaign(f.db, cipher, f.admin, second);
    await f.db.query('UPDATE gateway_settings SET bulk_last_activity_at=NULL,device_quota=1');
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id=? AND status='PENDING'", [second.id])).rows[0]!.n, 2n);
    assert.equal((await f.db.query('SELECT last_error FROM campaign_recipients WHERE campaign_id=? AND last_error IS NOT NULL', [second.id])).rows[0]!.last_error, 'DEVICE_QUOTA');
    await f.db.query('UPDATE campaigns SET expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?', [second.id]);
    await dispatchCampaigns(f.db, cipher);
    assert.equal((await f.db.query('SELECT status FROM campaigns WHERE id=?', [second.id])).rows[0]!.status, 'COMPLETED');
    assert.equal((await f.db.query('SELECT last_error FROM campaign_recipients WHERE campaign_id=?', [second.id])).rows[0]!.last_error, 'SCHEDULE_EXPIRED');
  } finally { await f.dispose(); }
});
