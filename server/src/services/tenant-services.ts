import type { Connection } from '../db/database.js';
import { settingsSchema } from './admin-settings.js';
import { ApiError } from './policy.js';

export const tenantOverridesSchema=settingsSchema.partial();
export async function tenantPlan(tx:Connection,tenantId:string) {
 const row=(await tx.query('SELECT t.enabled,p.expires_at,p.settings_json,COALESCE(p.expires_at<=CURRENT_TIMESTAMP(6),false) AS expired, TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(6),p.expires_at)/1000 AS remaining_ms FROM tenants t LEFT JOIN tenant_plans p ON p.tenant_id=t.id WHERE t.id=?',[tenantId])).rows[0];
 if(!row)throw new ApiError(404,'TENANT_NOT_FOUND');
 const overrides=tenantOverridesSchema.parse(typeof row.settings_json==='string'?JSON.parse(row.settings_json):row.settings_json??{});
 return {enabled:Boolean(row.enabled),expires_at:row.expires_at as Date|null,expired:Boolean(row.expired),remaining_ms:row.remaining_ms as number|null,overrides,active:Boolean(row.enabled)&&!row.expired};
}
export async function assertTenantActive(tx:Connection,tenantId:string) {
 const plan=await tenantPlan(tx,tenantId);
 if(!plan.enabled)throw new ApiError(403,'TENANT_DISABLED');
 if(plan.expired)throw new ApiError(403,'TENANT_EXPIRED');
 return plan;
}
export async function tenantSettings(tx:Connection,tenantId:string,defaults?:Record<string,any>) {
 const plan=await tenantPlan(tx,tenantId);
 defaults??=(await tx.query('SELECT * FROM gateway_settings WHERE id=1')).rows[0]!;
 return {...defaults,...plan.overrides} as Record<string,any>;
}
// Called under the shared policy lock, including before renewing an expired plan.
export async function reconcileTenantExpiry(tx:Connection) {
 await tx.query("UPDATE outbound_messages m JOIN tenant_plans p ON p.tenant_id=m.tenant_id SET m.status='CANCELLED' WHERE p.expires_at<=CURRENT_TIMESTAMP(6) AND m.status IN ('QUEUED','CLAIMED') AND m.send_attempt_started_at IS NULL");
 await tx.query("UPDATE campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id JOIN tenant_plans p ON p.tenant_id=c.tenant_id SET r.status='CANCELLED',r.last_error='TENANT_EXPIRED' WHERE p.expires_at<=CURRENT_TIMESTAMP(6) AND r.status='PENDING'");
 await tx.query("UPDATE campaigns c JOIN tenant_plans p ON p.tenant_id=c.tenant_id SET c.status='CANCELLED' WHERE p.expires_at<=CURRENT_TIMESTAMP(6) AND c.status IN ('ACTIVE','PAUSED')");
}
