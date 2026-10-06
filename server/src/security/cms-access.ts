import { assertTenantActive } from '../services/tenant-services.js';
import type { Connection } from '../db/database.js';
import { ApiError } from '../services/policy.js';

export const cmsSections = ['dashboard','settings','recipients','contacts','bulk','devices','clients','messages','audit'] as const;
export type CmsSection = typeof cmsSections[number];
export type AccessLevel = 'none' | 'view' | 'manage';
export interface CmsAccess {
  id: string; superAdmin: boolean; allTenants: boolean; tenantIds: string[];
  permissions: Record<CmsSection, AccessLevel>;
}
export async function accessForUser(tx: Connection, user: Record<string, any>): Promise<CmsAccess> {
  let stored: Record<string, unknown> = {};
  try { stored = typeof user.permissions_json === 'string' ? JSON.parse(user.permissions_json) : user.permissions_json ?? {}; } catch { /* Fail closed. */ }
  const superAdmin = Boolean(user.super_admin) && user.role === 'admin';
  const permissions = Object.fromEntries(cmsSections.map(section => {
    const level = stored?.[section];
    return [section, superAdmin ? 'manage' : level === 'manage' ? (user.role === 'admin' ? 'manage' : 'view') : level === 'view' ? 'view' : 'none'];
  })) as Record<CmsSection, AccessLevel>;
  const tenantIds = (await tx.query('SELECT tenant_id FROM cms_user_tenants WHERE user_id=? ORDER BY tenant_id', [user.id])).rows.map(row => row.tenant_id as string);
  return { id: user.id, superAdmin, allTenants: superAdmin || Boolean(user.all_tenants), tenantIds, permissions };
}
export function hasPermission(access: CmsAccess, section: CmsSection, manage = false) {
  const level = access.permissions[section];
  return manage ? level === 'manage' : level === 'view' || level === 'manage';
}
export function assertPermission(access: CmsAccess, section: CmsSection, manage = false, tenantId?: string, global = false) {
  if (!hasPermission(access, section, manage)) throw new ApiError(403, 'CMS_PERMISSION_DENIED');
  if (global && !access.allTenants) throw new ApiError(403, 'CMS_GLOBAL_ACCESS_REQUIRED');
  if (tenantId && !access.allTenants && !access.tenantIds.includes(tenantId)) throw new ApiError(403, 'CMS_TENANT_DENIED');
}
export function tenantFilter(access: CmsAccess, column: string): { sql: string; values: string[] } {
  // column is always a static SQL identifier supplied by application code.
  if (access.allTenants) return { sql: '1=1', values: [] };
  if (!access.tenantIds.length) return { sql: '1=0', values: [] };
  return { sql: `${column} IN (${access.tenantIds.map(() => '?').join(',')})`, values: access.tenantIds };
}
export async function cmsMutationGuard(tx: Connection, userId: string, sessionHash: string, section?: CmsSection, tenantId?: string, global = false) {
  const user = (await tx.query("SELECT u.* FROM cms_users u JOIN cms_sessions s ON s.user_id=u.id WHERE u.id=? AND u.enabled=true AND u.role='admin' AND u.totp_enabled=true AND s.token_hash=? AND s.mfa_verified=true AND s.expires_at>CURRENT_TIMESTAMP(6)", [userId, sessionHash])).rows[0];
  if (!user) throw new ApiError(403, 'ADMIN_REQUIRED');
  const access = await accessForUser(tx, user);
  if (section) assertPermission(access, section, true, tenantId, global);
  if(tenantId&&!access.allTenants)await assertTenantActive(tx,tenantId);
  if (!section && !access.superAdmin) throw new ApiError(403, 'SUPER_ADMIN_REQUIRED');
  return access;
}
export async function campaignCreatorAllowed(tx: Connection, userId: string, tenantId: string) {
  const user = (await tx.query("SELECT * FROM cms_users WHERE id=? AND enabled=true AND role='admin' AND totp_enabled=true", [userId])).rows[0];
  if (!user) return false;
  const access = await accessForUser(tx, user);
  return hasPermission(access, 'bulk', true) && (access.allTenants || access.tenantIds.includes(tenantId));
}
