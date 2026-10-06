import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { cmsMutationGuard, cmsSections, accessForUser, hasPermission } from '../security/cms-access.js';
import { passwordHash } from '../security/admin-auth.js';
import { ApiError } from './policy.js';

const permissionSchema = z.object(Object.fromEntries(cmsSections.map(section => [section, z.enum(['none','view','manage']).default('none')]))).strict();
const accessSchema = z.object({
  role: z.enum(['admin','viewer']), superAdmin: z.boolean().default(false),
  allTenants: z.boolean().default(false), tenantIds: z.array(z.uuid()).max(200).default([]),
  permissions: permissionSchema, enabled: z.boolean().default(true),
}).strict().superRefine((data, context) => {
  if (data.superAdmin && data.role !== 'admin') context.addIssue({ code: 'custom', message: 'A super administrator must have the admin role.' });
  if (data.role === 'viewer' && Object.values(data.permissions).includes('manage')) context.addIssue({ code: 'custom', message: 'Viewers cannot have Manage rights.' });
  if (!data.superAdmin && !data.allTenants && (data.permissions.settings === 'manage' || data.permissions.dashboard === 'manage')) context.addIssue({ code: 'custom', message: 'Managing global limits or gateway pause requires all-tenant access.' });
});
const ref = z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);
export const userCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,80}$/), access: accessSchema, reasonReference: ref }).strict(),
  z.object({ action: z.literal('update'), userId: z.uuid(), access: accessSchema, reasonReference: ref }).strict(),
  z.object({ action: z.literal('reset-password'), userId: z.uuid(), reasonReference: ref }).strict(),
]);
export async function manageCmsUser(db: Database, actorId: string, sessionHash: string, input: unknown) {
  const command = userCommandSchema.parse(input);
  const password = command.action === 'update' ? undefined : randomBytes(24).toString('base64url');
  // Authorize before doing expensive password hashing, then recheck under lock.
  await cmsMutationGuard(db, actorId, sessionHash);
  const hash = password ? await passwordHash(password) : undefined;
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE');
    await cmsMutationGuard(tx, actorId, sessionHash);
    const id = command.action === 'create' ? randomUUID() : command.userId;
    if (id === actorId) throw new ApiError(409, 'CMS_CANNOT_EDIT_SELF');
    const before = command.action === 'create' ? undefined : (await tx.query('SELECT * FROM cms_users WHERE id=?', [id])).rows[0];
    if (command.action !== 'create' && !before) throw new ApiError(404, 'CMS_USER_NOT_FOUND');
    const previousAccess = before ? await accessForUser(tx, before) : undefined;
    if (command.action === 'create' && (await tx.query('SELECT id FROM cms_users WHERE username=?', [command.username])).rows.length) throw new ApiError(409, 'CMS_USERNAME_EXISTS');
    if (command.action === 'reset-password') {
      await tx.query('UPDATE cms_users SET password_hash=?,failed_logins=0,locked_until=NULL WHERE id=?', [hash, id]);
    } else {
      const access = command.access, tenants = [...new Set(access.tenantIds)];
      if (tenants.length) {
        const found = await tx.query(`SELECT id FROM tenants WHERE id IN (${tenants.map(() => '?').join(',')})`, tenants);
        if (found.rows.length !== tenants.length) throw new ApiError(404, 'TENANT_NOT_FOUND');
      }
      if (before?.super_admin && before.enabled && (!access.superAdmin || !access.enabled || access.role !== 'admin')) {
        const remaining = (await tx.query("SELECT id FROM cms_users WHERE id<>? AND super_admin=true AND enabled=true AND role='admin' AND totp_enabled=true", [id])).rows;
        if (!remaining.length) throw new ApiError(409, 'CMS_LAST_SUPER_ADMIN');
      }
      const values = [access.role, access.superAdmin, access.superAdmin || access.allTenants, JSON.stringify(access.permissions), access.enabled];
      if (command.action === 'create') await tx.query('INSERT INTO cms_users (id,username,password_hash,role,super_admin,all_tenants,permissions_json,enabled) VALUES (?,?,?,?,?,?,?,?)', [id, command.username, hash, ...values]);
      else await tx.query('UPDATE cms_users SET role=?,super_admin=?,all_tenants=?,permissions_json=?,enabled=? WHERE id=?', [...values, id]);
      await tx.query('DELETE FROM cms_user_tenants WHERE user_id=?', [id]);
      if (!access.superAdmin && !access.allTenants) for (const tenantId of tenants) await tx.query('INSERT INTO cms_user_tenants (user_id,tenant_id) VALUES (?,?)', [id, tenantId]);
      const updated = await accessForUser(tx, { id, role: access.role, super_admin: access.superAdmin, all_tenants: access.allTenants, permissions_json: access.permissions });
      // Removing a creator's access also cancels their unattempted scheduled work.
      const campaigns = (await tx.query("SELECT id,tenant_id FROM campaigns WHERE created_by=? AND status IN ('ACTIVE','PAUSED')", [id])).rows;
      for (const campaign of campaigns) {
        if (access.enabled && hasPermission(updated, 'bulk', true) && (updated.allTenants || updated.tenantIds.includes(campaign.tenant_id))) continue;
        await tx.query("UPDATE campaigns SET status='CANCELLED' WHERE id=?", [campaign.id]);
        await tx.query("UPDATE campaign_recipients SET status='CANCELLED',last_error='CREATOR_ACCESS_REVOKED' WHERE campaign_id=? AND status='PENDING'", [campaign.id]);
        await tx.query("UPDATE outbound_messages m JOIN campaign_recipients r ON r.job_id=m.id SET m.status='CANCELLED' WHERE r.campaign_id=? AND m.send_attempt_started_at IS NULL AND m.status IN ('QUEUED','CLAIMED')", [campaign.id]);
      }
    }
    await tx.query('DELETE FROM cms_sessions WHERE user_id=?', [id]);
    await tx.query('INSERT INTO audit_logs (actor_id,action,resource_id,reason_reference,details_json) VALUES (?,?,?,?,?)', [actorId, `CMS_USER_${command.action.toUpperCase().replaceAll('-','_')}`, id, command.reasonReference, JSON.stringify({ before: previousAccess ? { ...previousAccess, enabled: Boolean(before?.enabled) } : null, ...(command.action === 'reset-password' ? {} : { after: command.access }) })]);
    return { id, username: command.action === 'create' ? command.username : before!.username, ...(password ? { password } : {}) };
  });
}
