import { tenantSettings } from './tenant-services.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { contentCipher, digest } from '../security/crypto.js';
import { ApiError, validateSmsBody } from './policy.js';
import { contactMutation, referenceSchema, type AdminIdentity } from './contacts.js';
import { messageService } from './messages.js';
import { reconcileJobs } from './devices.js';
import { campaignCreatorAllowed } from '../security/cms-access.js';

export const campaignSchema = z.object({
  id: z.uuid(), tenantId: z.uuid(), clientId: z.uuid(), name: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(4096), includeOptOut: z.boolean().default(false),
  contactIds: z.array(z.uuid()).max(1000).default([]), groupIds: z.array(z.uuid()).max(100).default([]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(), reasonReference: referenceSchema,
}).strict().refine(value => value.contactIds.length + value.groupIds.length > 0);

export async function createCampaign(db: Database, cipher: ReturnType<typeof contentCipher>, admin: AdminIdentity, input: unknown) {
  const data = campaignSchema.parse(input);
  const body = data.body + (data.includeOptOut ? '\nReply STOP to unsubscribe' : '');
  validateSmsBody(body);
  const hash = digest(JSON.stringify({ ...data, contactIds: [...new Set(data.contactIds)].sort(), groupIds: [...new Set(data.groupIds)].sort() }));
  return contactMutation(db, admin, data.tenantId, data.reasonReference, 'CAMPAIGN_CREATED', async tx => {
    const previous = (await tx.query('SELECT id,request_hash FROM campaigns WHERE id=?', [data.id])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return { id: previous.id, reused: true };
    }
    const client = (await tx.query('SELECT scopes FROM api_clients WHERE id=? AND tenant_id=? AND enabled=true', [data.clientId, data.tenantId])).rows[0];
    const scopes = typeof client?.scopes === 'string' ? JSON.parse(client.scopes) : client?.scopes;
    if (!Array.isArray(scopes) || !scopes.includes('sms:send')) throw new ApiError(403, 'INSUFFICIENT_SCOPE');
    const now = (await tx.query('SELECT CURRENT_TIMESTAMP(6) AS now')).rows[0]!.now as Date;
    const scheduled = data.scheduledAt ? new Date(data.scheduledAt) : now;
    if (data.scheduledAt && (scheduled.getTime() < now.getTime() - 60_000 || scheduled.getTime() > now.getTime() + 366 * 86400000)) throw new ApiError(400, 'INVALID_SCHEDULE');
    const ids = [...new Set(data.contactIds)], groups = [...new Set(data.groupIds)];
    if (groups.length) {
      const found = await tx.query(`SELECT id FROM contact_groups WHERE tenant_id=? AND id IN (${groups.map(() => '?').join(',')})`, [data.tenantId, ...groups]);
      if (found.rows.length !== groups.length) throw new ApiError(404, 'GROUP_NOT_FOUND');
    }
    if (ids.length) {
      const found = await tx.query(`SELECT id FROM contacts WHERE tenant_id=? AND id IN (${ids.map(() => '?').join(',')})`, [data.tenantId, ...ids]);
      if (found.rows.length !== ids.length) throw new ApiError(404, 'CONTACT_NOT_FOUND');
    }
    const selected = await tx.query(`SELECT c.id,c.name,c.normalized_e164 FROM contacts c WHERE c.tenant_id=? AND (${ids.length ? `c.id IN (${ids.map(() => '?').join(',')})` : 'false'} OR ${groups.length ? `EXISTS (SELECT 1 FROM contact_group_members m WHERE m.contact_id=c.id AND m.tenant_id=c.tenant_id AND m.group_id IN (${groups.map(() => '?').join(',')}))` : 'false'}) ORDER BY c.id LIMIT 1001`, [data.tenantId, ...ids, ...groups]);
    if (!selected.rows.length || selected.rows.length > 1000) throw new ApiError(400, 'CAMPAIGN_RECIPIENT_LIMIT');
    await tx.query('INSERT INTO campaigns (id,tenant_id,client_id,name,encrypted_body,request_hash,scheduled_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,TIMESTAMPADD(DAY,7,?),?)', [data.id, data.tenantId, data.clientId, data.name, cipher.encrypt(body, `campaign:${data.id}`), hash, scheduled, scheduled, admin.id]);
    for (const contact of selected.rows) await tx.query('INSERT INTO campaign_recipients (id,campaign_id,name,normalized_e164) VALUES (?,?,?,?)', [randomUUID(), data.id, contact.name, contact.normalized_e164]);
    return { id: data.id, recipients: selected.rows.length, scheduledAt: scheduled };
  });
}

export async function campaignControl(db: Database, admin: AdminIdentity, input: unknown) {
  const data = z.object({ tenantId: z.uuid(), id: z.uuid(), action: z.enum(['pause', 'resume', 'cancel']), reasonReference: referenceSchema }).strict().parse(input);
  return contactMutation(db, admin, data.tenantId, data.reasonReference, `CAMPAIGN_${data.action.toUpperCase()}`, async tx => {
    const campaign = (await tx.query('SELECT status FROM campaigns WHERE id=? AND tenant_id=?', [data.id, data.tenantId])).rows[0];
    if (!campaign) throw new ApiError(404, 'CAMPAIGN_NOT_FOUND');
    if (['CANCELLED', 'COMPLETED'].includes(campaign.status)) throw new ApiError(409, 'CAMPAIGN_FINISHED');
    await tx.query('UPDATE campaigns SET status=? WHERE id=?', [data.action === 'pause' ? 'PAUSED' : data.action === 'resume' ? 'ACTIVE' : 'CANCELLED', data.id]);
    if (data.action === 'cancel') {
      await tx.query("UPDATE campaign_recipients SET status='CANCELLED',last_error='CAMPAIGN_CANCELLED' WHERE campaign_id=? AND status='PENDING'", [data.id]);
      await tx.query("UPDATE outbound_messages m JOIN campaign_recipients r ON r.job_id=m.id SET m.status='CANCELLED' WHERE r.campaign_id=? AND m.status IN ('QUEUED','CLAIMED') AND m.send_attempt_started_at IS NULL", [data.id]);
    }
    return { ok: true };
  });
}

// One outstanding bulk job globally prevents an offline phone accumulating a burst.
// All release/authorization decisions share the existing policy transaction lock.
export async function dispatchCampaigns(db: Database, cipher: ReturnType<typeof contentCipher>) {
  return db.transaction(async tx => {
    const settings = (await tx.query('SELECT *, bulk_last_activity_at IS NULL OR TIMESTAMPADD(SECOND,bulk_delay_seconds,bulk_last_activity_at)<=CURRENT_TIMESTAMP(6) AS bulk_ready FROM gateway_settings WHERE id=1 FOR UPDATE')).rows[0]!;
    await reconcileJobs(tx);
    await tx.query("UPDATE campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id SET r.status='SKIPPED',r.last_error='SCHEDULE_EXPIRED' WHERE r.status='PENDING' AND c.expires_at<=CURRENT_TIMESTAMP(6)");
    await tx.query("UPDATE campaigns c SET status='COMPLETED' WHERE c.status IN ('ACTIVE','PAUSED') AND NOT EXISTS (SELECT 1 FROM campaign_recipients r LEFT JOIN outbound_messages m ON m.id=r.job_id WHERE r.campaign_id=c.id AND (r.status='PENDING' OR m.status IN ('QUEUED','CLAIMED','ATTEMPT_RECORDED')))");
    if (settings.paused) return;
    const previousSettings=settings.bulk_last_tenant_id?await tenantSettings(tx,settings.bulk_last_tenant_id,settings):settings;
    if ((await tx.query("SELECT 1 FROM campaign_recipients r JOIN outbound_messages m ON m.id=r.job_id WHERE m.status IN ('QUEUED','CLAIMED') AND m.send_attempt_started_at IS NULL LIMIT 1")).rows.length) return;
    const target = (await tx.query("SELECT r.*,c.tenant_id,c.client_id,c.encrypted_body,c.created_by FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id LEFT JOIN tenant_plans tp ON tp.tenant_id=c.tenant_id WHERE (tp.expires_at IS NULL OR tp.expires_at>CURRENT_TIMESTAMP(6)) AND (? IS NULL OR TIMESTAMPADD(SECOND,GREATEST(?,COALESCE(JSON_VALUE(tp.settings_json,'$.bulk_delay_seconds'),?)),?)<=CURRENT_TIMESTAMP(6)) AND r.status='PENDING' AND r.next_attempt_at<=CURRENT_TIMESTAMP(6) AND c.status='ACTIVE' AND c.scheduled_at<=CURRENT_TIMESTAMP(6) AND c.expires_at>CURRENT_TIMESTAMP(6) ORDER BY r.next_attempt_at,c.scheduled_at,c.created_at,r.id LIMIT 1",[settings.bulk_last_activity_at,previousSettings.bulk_delay_seconds,settings.bulk_delay_seconds,settings.bulk_last_activity_at])).rows[0];
    if (!target) return;
    await tx.query('SAVEPOINT campaign_enqueue');
    try {
      if(!await campaignCreatorAllowed(tx,target.created_by,target.tenant_id))throw new ApiError(403,'CREATOR_ACCESS_REVOKED');
      const body = cipher.decrypt(target.encrypted_body, `campaign:${target.campaign_id}`);
      const result = await messageService(db, cipher).create({ id: target.client_id, tenant_id: target.tenant_id, scopes: ['sms:send'] }, `campaign-${target.id}`, { to: target.normalized_e164, body }, tx);
      await tx.query("UPDATE campaign_recipients SET status='QUEUED',job_id=?,last_error=NULL WHERE id=?", [result.jobId, target.id]);
      await tx.query('UPDATE gateway_settings SET bulk_last_activity_at=CURRENT_TIMESTAMP(6),bulk_last_tenant_id=? WHERE id=1',[target.tenant_id]);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT campaign_enqueue');
      if (!(error instanceof ApiError)) throw error;
      const retryable = ['GATEWAY_PAUSED', 'NO_AVAILABLE_GATEWAY', 'RECIPIENT_COOLDOWN', 'RECIPIENT_QUOTA', 'CLIENT_QUOTA', 'DEVICE_QUOTA'].includes(error.code);
      await tx.query('UPDATE campaign_recipients SET status=?,last_error=?,next_attempt_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)) WHERE id=?', [retryable ? 'PENDING' : 'SKIPPED', error.code, Math.max(30, error.retryAfter ?? 60), target.id]);
    }
  });
}

export function startCampaignDispatcher(db: Database, cipher: ReturnType<typeof contentCipher>) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const tick = () => {
    running = dispatchCampaigns(db, cipher).catch(() => { console.error(JSON.stringify({ event: 'campaign_dispatch_failed' })); }).finally(() => {
      if (!stopped) { timer = setTimeout(tick, 5000); timer.unref(); }
    });
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
