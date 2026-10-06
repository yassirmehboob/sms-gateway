import { assertTenantActive } from './tenant-services.js';
import { z } from 'zod';
import type { Database,Connection } from '../db/database.js';
import { digest } from '../security/crypto.js';
import { ApiError, normalizeNumber } from './policy.js';
import { randomBytes } from 'node:crypto';
import { approvedPublicKey } from '../security/device-signatures.js';

const reference = z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);
const tenantId = z.uuid();
const purpose = z.literal('transactional_notification');
export const operatorCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('global-pause'), paused: z.boolean() }).strict(),
  z.object({ action: z.literal('device-create'), tenantId, deviceId: z.uuid(), simId: z.number().int().min(0).max(2147483647) }).strict(),
  z.object({ action: z.literal('device-enrollment'), tenantId, deviceId: z.uuid(), publicKey: z.string().max(1024) }).strict(),
  z.object({ action: z.literal('device-pause'), tenantId, deviceId: z.uuid(), paused: z.boolean() }).strict(),
  z.object({ action: z.literal('device-revoke'), tenantId, deviceId: z.uuid() }).strict(),
  z.object({ action: z.literal('consent-grant'), tenantId, number: z.string(), purpose, evidenceReference: reference }).strict(),
  z.object({ action: z.literal('consent-revoke'), tenantId, number: z.string(), purpose }).strict(),
  z.object({ action: z.literal('client-revoke'), tenantId, clientId: z.uuid() }).strict(),
]);
export const operatorRequest = z.object({
  actorId: z.uuid(), reasonReference: reference, command: operatorCommand,
}).strict();

// Trusted local operator only. Never route this service through caller API keys.
export async function executeOperatorCommand(db: Database, input: unknown, authorize?: (tx:Connection)=>Promise<void>) {
  const { actorId, reasonReference, command } = operatorRequest.parse(input);
  return db.transaction(async tx => {
    const settings = (await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE')).rows[0];
    if (!settings) throw new ApiError(503, 'GATEWAY_NOT_INITIALIZED');
    await authorize?.(tx);
    const tenant = 'tenantId' in command ? command.tenantId : null;
    if(tenant && !['device-revoke','client-revoke','consent-revoke'].includes(command.action) && !(command.action==='device-pause'&&command.paused))await assertTenantActive(tx,tenant);
    if (tenant && !(await tx.query('SELECT id FROM tenants WHERE id=?', [tenant])).rows.length) throw new ApiError(404, 'TENANT_NOT_FOUND');
    let resource: string | null = null;
    let subjectHash: string | null = null;
    let enrollmentToken: string | undefined;
    switch (command.action) {
      case 'global-pause':
        await tx.query('UPDATE gateway_settings SET paused=? WHERE id=1', [command.paused]);
        if (command.paused) await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL");
        break;
      case 'device-create':
        resource = command.deviceId;
        if ((await tx.query('SELECT id FROM devices WHERE id=?', [resource])).rows.length) throw new ApiError(409, 'DEVICE_ALREADY_EXISTS');
        await tx.query('INSERT INTO devices (id,tenant_id,allowed_sim_id) VALUES (?,?,?)', [resource,tenant,command.simId]);
        break;
      case 'device-enrollment': {
        resource=command.deviceId;
        const device=(await tx.query('SELECT public_key,revoked_at FROM devices WHERE id=? AND tenant_id=?',[resource,tenant])).rows[0];
        if (!device) throw new ApiError(404,'DEVICE_NOT_FOUND');
        if (device.revoked_at || device.public_key) throw new ApiError(409,'DEVICE_ALREADY_BOUND_OR_REVOKED');
        const publicKey=approvedPublicKey(command.publicKey);
        enrollmentToken=randomBytes(32).toString('base64url');
        await tx.query('INSERT INTO enrollment_challenges (device_id,token_hash,public_key,expires_at) VALUES (?,?,?,CURRENT_TIMESTAMP(6)+INTERVAL 10 MINUTE) ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash),public_key=VALUES(public_key),expires_at=VALUES(expires_at),consumed_at=NULL',[resource,digest(enrollmentToken),publicKey]);
        break;
      }
      case 'device-pause':
      case 'device-revoke': {
        resource = command.deviceId;
        const device = (await tx.query('SELECT revoked_at FROM devices WHERE id=? AND tenant_id=?', [resource,tenant])).rows[0];
        if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND');
        if (command.action === 'device-pause') {
          if (device.revoked_at && !command.paused) throw new ApiError(409, 'DEVICE_REVOKED');
          await tx.query('UPDATE devices SET paused=? WHERE id=?', [command.paused, resource]);
        } else await tx.query('UPDATE devices SET paused=true, revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP(6)) WHERE id=?', [resource]);
        if (command.action === 'device-revoke' || command.paused) await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE device_id=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL", [resource]);
        break;
      }
      case 'consent-grant':
      case 'consent-revoke': {
        const number = normalizeNumber(command.number);
        subjectHash = digest(number);
        if (command.action === 'consent-grant') {
          await tx.query('INSERT INTO recipients (normalized_e164) VALUES (?) ON DUPLICATE KEY UPDATE normalized_e164=VALUES(normalized_e164)', [number]);
          // Recording renewed evidence never clears global STOP/suppression.
          await tx.query('INSERT INTO recipient_tenant_consents (tenant_id,normalized_e164,purpose,evidence) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE evidence=VALUES(evidence),revoked_at=NULL', [tenant,number,command.purpose,command.evidenceReference]);
        } else {
          if (!(await tx.query('SELECT 1 FROM recipient_tenant_consents WHERE tenant_id=? AND normalized_e164=? AND purpose=?', [tenant,number,command.purpose])).rows.length) throw new ApiError(404, 'CONSENT_NOT_FOUND');
          await tx.query('UPDATE recipient_tenant_consents SET revoked_at=CURRENT_TIMESTAMP(6) WHERE tenant_id=? AND normalized_e164=? AND purpose=?', [tenant,number,command.purpose]);
          await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE tenant_id=? AND normalized_e164=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL", [tenant,number]);
        }
        break;
      }
      case 'client-revoke':
        resource = command.clientId;
        if (!(await tx.query('SELECT id FROM api_clients WHERE id=? AND tenant_id=?', [resource,tenant])).rows.length) throw new ApiError(404, 'CLIENT_NOT_FOUND');
        await tx.query('UPDATE api_clients SET enabled=false WHERE id=?', [resource]);
        await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE client_id=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL", [resource]);
        break;
    }
    const action = command.action === 'global-pause' || command.action === 'device-pause'
      ? `${command.action}:${command.paused ? 'paused' : 'resumed'}` : command.action;
    await tx.query('INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id,reason_reference,subject_hash) VALUES (?,?,?,?,?,?)', [tenant,actorId,action,resource,reasonReference,subjectHash]);
    return { action, resourceId: resource, ...(enrollmentToken ? { enrollmentToken, expiresInSeconds:600 } : {}) };
  });
}
