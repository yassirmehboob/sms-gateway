import { tenantPlan, tenantSettings } from './tenant-services.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Connection } from '../db/database.js';
import { contentCipher, digest } from '../security/crypto.js';
import { ApiError, normalizeNumber } from './policy.js';

export const controlSchema = z.object({
  eventId: z.uuid(), from: z.string().min(5).max(30), command: z.enum(['STOP','START']),
  subscriptionId: z.number().int().min(0), receivedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

// Called only inside a verified device operation holding the global policy lock.
export async function receiveControl(tx: Connection, device: Record<string,any>, input: z.infer<typeof controlSchema>, cipher: ReturnType<typeof contentCipher>) {
  if (input.subscriptionId !== device.allowed_sim_id) throw new ApiError(409, 'WRONG_INBOUND_SIM');
  const from = normalizeNumber(input.from);
  const hash = digest(JSON.stringify({ ...input, from }));
  const previous = (await tx.query('SELECT request_hash,result_json FROM sms_control_events WHERE device_id=? AND event_id=?', [device.id,input.eventId])).rows[0];
  if (previous) {
    if (previous.request_hash !== hash) throw new ApiError(409,'EVENT_CONFLICT');
    return typeof previous.result_json === 'string' ? JSON.parse(previous.result_json) : previous.result_json;
  }
  // Only recipients previously messaged through this enrolled phone can control service.
  const known = (await tx.query("SELECT m.client_id,r.suppressed FROM outbound_messages m JOIN recipients r ON r.normalized_e164=m.normalized_e164 WHERE m.device_id=? AND m.tenant_id=? AND m.normalized_e164=? AND m.control_command IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT 1", [device.id,device.tenant_id,from])).rows[0];
  if (!known) return { accepted:false, reason:'UNKNOWN_RECIPIENT' };
  const now = Number(device.server_seconds) * 1000;
  if (input.receivedAt > now + 120000) throw new ApiError(422,'INBOUND_CLOCK_SKEW');
  await tx.query('INSERT INTO sms_preferences (normalized_e164) VALUES (?) ON DUPLICATE KEY UPDATE normalized_e164=VALUES(normalized_e164)', [from]);
  const settings=await tenantSettings(tx,device.tenant_id);
  const plan=await tenantPlan(tx,device.tenant_id);
  const confirmationColumn = input.command === 'STOP' ? 'last_stop_confirmation_at' : 'last_start_confirmation_at';
  const preference = (await tx.query(`SELECT *,${confirmationColumn} IS NULL OR ${confirmationColumn}<TIMESTAMPADD(SECOND,-?,CURRENT_TIMESTAMP(6)) AS can_confirm FROM sms_preferences WHERE normalized_e164=? FOR UPDATE`, [settings.confirmation_cooldown_seconds,from])).rows[0]!;
  let confirmationJobId: string | null = null;
  const stale = input.receivedAt <= Number(preference.last_received_at);
  const optedOut = input.command === 'STOP';
  const changed = !stale && Boolean(preference.opted_out) !== optedOut;
  if (!stale) {
    await tx.query('UPDATE sms_preferences SET opted_out=?,last_received_at=? WHERE normalized_e164=?', [optedOut,input.receivedAt,from]);
    // Superseded confirmations and all unattempted ordinary messages after STOP are cancelled.
    await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE normalized_e164=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL AND ((? AND control_command IS NULL) OR (control_command IS NOT NULL AND control_command<>?))", [from,optedOut,input.command]);
    await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id,subject_hash) VALUES (?,?,?,?,?)", [device.tenant_id,device.id,`SMS_${input.command}`,input.eventId,digest(from)]);
    const budget = (await tx.query("SELECT COUNT(*) AS count FROM outbound_messages WHERE device_id=? AND created_at>CURRENT_TIMESTAMP(6)-INTERVAL 24 HOUR", [device.id])).rows[0]!;
    // Fixed confirmations are the only exception to SMS opt-out and recipient cooldown.
    // Separate per-keyword intervals let START confirm immediately after STOP.
    if (plan.active && changed && preference.can_confirm && !known.suppressed && Number(budget.count) < Number(settings.device_quota)) {
      confirmationJobId = randomUUID();
      const body = optedOut ? 'Your STOP request was received. Messages are stopped. Reply START to resume.' : 'Your START request is received. Messages are resumed';
      await tx.query("INSERT INTO outbound_messages (id,tenant_id,client_id,device_id,normalized_e164,encrypted_body,body_hash,segments,control_command,expires_at) VALUES (?,?,?,?,?,?,?,1,?,TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)))", [confirmationJobId,device.tenant_id,known.client_id,device.id,from,cipher.encrypt(body,confirmationJobId),digest(body),input.command,settings.message_ttl_seconds]);
      await tx.query("INSERT INTO outbox_events (id,job_id,event_type) VALUES (?,?,'JOB_AVAILABLE')", [randomUUID(),confirmationJobId]);
      await tx.query(`UPDATE sms_preferences SET last_confirmation_at=CURRENT_TIMESTAMP(6),${confirmationColumn}=CURRENT_TIMESTAMP(6) WHERE normalized_e164=?`, [from]);
    }
  }
  const result = { accepted:true, optedOut:stale ? Boolean(preference.opted_out) : optedOut, stale, confirmationJobId };
  await tx.query('INSERT INTO sms_control_events (device_id,event_id,request_hash,result_json) VALUES (?,?,?,?)', [device.id,input.eventId,hash,JSON.stringify(result)]);
  return result;
}
