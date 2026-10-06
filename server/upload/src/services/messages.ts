import { randomUUID } from 'node:crypto';
import type { Connection, Database } from '../db/database.js';
import { contentCipher, digest } from '../security/crypto.js';
import { ApiError, canonicalMessage } from './policy.js';
export interface Actor { id: string; tenant_id: string; scopes: string[] }
export function messageService(db: Database, cipher: ReturnType<typeof contentCipher>) {
  return {
    async create(actor: Actor, key: string, input: unknown, connection?: Connection) {
      const message = canonicalMessage(input);
      const fingerprint = digest(JSON.stringify(message));
      const enqueue = async (tx: Connection) => {
        // A single durable policy lock serializes all reservations at MVP volume.
        // Pause, suppression and provisioning must acquire this lock before mutation.
        const settings = (await tx.query('SELECT * FROM gateway_settings WHERE id = true FOR UPDATE')).rows[0];
        const identity = (await tx.query('SELECT c.enabled, c.scopes, t.enabled AS tenant_enabled FROM api_clients c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=? AND c.tenant_id=?', [actor.id, actor.tenant_id])).rows[0];
        if (!identity?.enabled || !identity.tenant_enabled) throw new ApiError(401, 'UNAUTHORIZED');
        const scopes = typeof identity.scopes === 'string' ? JSON.parse(identity.scopes) : identity.scopes;
        if (!Array.isArray(scopes) || !scopes.includes('sms:send')) throw new ApiError(403, 'INSUFFICIENT_SCOPE');
        const previous = (await tx.query('SELECT request_hash, job_id FROM idempotency_keys WHERE tenant_id=? AND idempotency_key=?', [actor.tenant_id, key])).rows[0];
        if (previous) {
          if (previous.request_hash !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
          return { jobId: previous.job_id as string, status: 'QUEUED', statusUrl: `/v1/messages/${previous.job_id}` };
        }
        if (!settings || settings.paused) throw new ApiError(503, 'GATEWAY_PAUSED');
        const device = (await tx.query('SELECT id FROM devices WHERE tenant_id=? AND paused=false AND revoked_at IS NULL ORDER BY id LIMIT 1', [actor.tenant_id])).rows[0];
        if (!device) throw new ApiError(503, 'NO_AVAILABLE_GATEWAY');
        await tx.query('INSERT INTO recipients (normalized_e164) VALUES (?) ON DUPLICATE KEY UPDATE normalized_e164=VALUES(normalized_e164)', [message.to]);
        const recipient = (await tx.query('SELECT suppressed, GREATEST(0, CEIL(TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(6), next_allowed_at)/1000000)) AS retry_seconds FROM recipients WHERE normalized_e164=? FOR UPDATE', [message.to])).rows[0]!;
        if (recipient.suppressed) throw new ApiError(403, 'RECIPIENT_SUPPRESSED');
        if ((await tx.query('SELECT 1 FROM sms_preferences WHERE normalized_e164=? AND opted_out=true', [message.to])).rows.length) throw new ApiError(403, 'RECIPIENT_OPTED_OUT');
        const jobId = randomUUID();
        const consent = (await tx.query('SELECT revoked_at FROM recipient_tenant_consents WHERE tenant_id=? AND normalized_e164=? AND purpose=?', [actor.tenant_id, message.to, message.purpose])).rows[0];
        if (consent?.revoked_at) throw new ApiError(403, 'evidenceReference' in message ? 'CONSENT_REVOKED' : 'CONSENT_REQUIRED');
        if (!consent) {
          const evidence = 'evidenceReference' in message ? message.evidenceReference : undefined;
          if (!evidence) throw new ApiError(403, 'CONSENT_REQUIRED');
          // The caller attests to permission already collected outside the gateway.
          // This transaction also queues the message: any later rejection rolls both back.
          await tx.query('INSERT INTO recipient_tenant_consents (tenant_id,normalized_e164,purpose,evidence) VALUES (?,?,?,?)', [actor.tenant_id,message.to,message.purpose,evidence]);
          await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id,reason_reference) VALUES (?,?,'CONSENT_RECORDED_ON_SEND',?,?)", [actor.tenant_id,actor.id,jobId,evidence]);
        }
        if (Number(recipient.retry_seconds) > 0) throw new ApiError(429, 'RECIPIENT_COOLDOWN', Number(recipient.retry_seconds));
        const bodyHash = digest(message.body);
        const duplicate = await tx.query("SELECT 1 FROM outbound_messages WHERE tenant_id=? AND normalized_e164=? AND body_hash=? AND created_at > TIMESTAMPADD(HOUR,-?,CURRENT_TIMESTAMP(6))", [actor.tenant_id, message.to, bodyHash,settings.replay_window_hours]);
        if (duplicate.rows.length) throw new ApiError(409, 'CONTENT_REPLAY');
        for (const [column, value, hours, cap, code] of [
          ['normalized_e164', message.to, 24, Number(settings.recipient_quota), 'RECIPIENT_QUOTA'],
          ['client_id', actor.id, 1, Number(settings.client_quota), 'CLIENT_QUOTA'],
          ['device_id', device.id, 24, Number(settings.device_quota), 'DEVICE_QUOTA'],
        ] as const) {
          const usage = (await tx.query(`SELECT COUNT(*) AS count, CEIL(TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(6), DATE_ADD(MIN(created_at), INTERVAL ? HOUR))/1000000) AS retry_seconds FROM outbound_messages WHERE ${column}=? AND created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL ? HOUR)`, [hours, value, hours])).rows[0]!;
          if (Number(usage.count) >= cap) throw new ApiError(429, code, Math.max(1, Number(usage.retry_seconds)));
        }
        await tx.query("INSERT INTO outbound_messages (id,tenant_id,client_id,device_id,normalized_e164,encrypted_body,body_hash,segments,expires_at) VALUES (?,?,?,?,?,?,?,1,TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)))", [jobId, actor.tenant_id, actor.id, device.id, message.to, cipher.encrypt(message.body, jobId), bodyHash,settings.message_ttl_seconds]);
        await tx.query("UPDATE recipients SET next_allowed_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)) WHERE normalized_e164=?", [settings.cooldown_seconds,message.to]);
        await tx.query('INSERT INTO idempotency_keys VALUES (?,?,?,?)', [actor.tenant_id,key,fingerprint,jobId]);
        await tx.query("INSERT INTO outbox_events (id,job_id,event_type) VALUES (?,?,'JOB_AVAILABLE')", [randomUUID(),jobId]);
        await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id) VALUES (?,?,'MESSAGE_ACCEPTED',?)", [actor.tenant_id,actor.id,jobId]);
        return { jobId, status: 'QUEUED', statusUrl: `/v1/messages/${jobId}` };
      };
      return connection ? enqueue(connection) : db.transaction(enqueue);
    },
  };
}
