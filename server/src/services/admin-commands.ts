import { tenantOverridesSchema, tenantPlan, assertTenantActive, reconcileTenantExpiry } from './tenant-services.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database,Connection } from '../db/database.js';
import { digest } from '../security/crypto.js';
import { ApiError,normalizeNumber } from './policy.js';
import { settingsSchema } from './admin-settings.js';
import { executeOperatorCommand,operatorCommand } from './operator.js';
import { cmsMutationGuard, type CmsSection } from '../security/cms-access.js';

const ref=z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);
const extra=z.discriminatedUnion('action',[
 z.object({action:z.literal('settings-update'),settings:settingsSchema}).strict(),
 z.object({action:z.literal('tenant-settings-update'),tenantId:z.uuid(),overrides:tenantOverridesSchema}).strict(),
 z.object({action:z.literal('tenant-expiry-update'),tenantId:z.uuid(),expiresAt:z.iso.datetime({offset:true}).nullable()}).strict(),
 z.object({action:z.literal('recipient-preference'),number:z.string(),optedOut:z.boolean()}).strict(),
 z.object({action:z.literal('recipient-suppression'),number:z.string(),suppressed:z.boolean()}).strict(),
 z.object({action:z.literal('tenant-create'),name:z.string().trim().min(1).max(200),expiresAt:z.iso.datetime({offset:true}).nullable().optional()}).strict(),
 z.object({action:z.literal('client-create'),tenantId:z.uuid()}).strict(),
 z.object({action:z.literal('client-rotate'),tenantId:z.uuid(),clientId:z.uuid()}).strict(),
 z.object({action:z.literal('device-sim'),tenantId:z.uuid(),deviceId:z.uuid(),simId:z.number().int().min(0).max(2147483647)}).strict(),
]);
export const adminGuard=cmsMutationGuard;
function commandAccess(tx:Connection,userId:string,sessionHash:string,command:{action:string;tenantId?:string}) {
 const action=command.action;
 const section:CmsSection=action==='global-pause'?'dashboard':['settings-update','tenant-settings-update'].includes(action)?'settings':action.startsWith('device-')?'devices':action.startsWith('client-')||action.startsWith('tenant-')?'clients':'recipients';
 const global=['global-pause','settings-update','tenant-settings-update','tenant-expiry-update','tenant-create','recipient-preference','recipient-suppression'].includes(action);
 return adminGuard(tx,userId,sessionHash,section,command.tenantId,global);
}
export async function adminCommand(db:Database,userId:string,sessionHash:string,input:unknown) {
 const request=z.object({reasonReference:ref,command:z.union([operatorCommand,extra])}).strict().parse(input);
 const legacy=operatorCommand.safeParse(request.command);
 if(legacy.success)return executeOperatorCommand(db,{actorId:userId,...request},async tx=>{await commandAccess(tx,userId,sessionHash,legacy.data);});
 const command=extra.parse(request.command);
 return db.transaction(async tx=>{
   const before=(await tx.query('SELECT * FROM gateway_settings WHERE id=1 FOR UPDATE')).rows[0];
   await commandAccess(tx,userId,sessionHash,command);
   let resource:string|null=null,subject:string|null=null,tenant:string|null=null;
   let result:Record<string,unknown>={};
   if(command.action==='settings-update') {
     const settings=command.settings;
     const keys=Object.keys(settings) as Array<keyof typeof settings>;
     await tx.query(`UPDATE gateway_settings SET ${keys.map(key=>`${key}=?`).join(',')} WHERE id=1`,keys.map(key=>settings[key]));
    } else if(command.action==='tenant-settings-update' || command.action==='tenant-expiry-update') {
     tenant=command.tenantId;resource=tenant;
     const previous=await tenantPlan(tx,tenant);
     await reconcileTenantExpiry(tx);
     await tx.query("INSERT IGNORE INTO tenant_plans (tenant_id,settings_json) VALUES (?,'{}')",[tenant]);
     if(command.action==='tenant-settings-update')await tx.query('UPDATE tenant_plans SET settings_json=? WHERE tenant_id=?',[JSON.stringify(command.overrides),tenant]);
     else await tx.query('UPDATE tenant_plans SET expires_at=? WHERE tenant_id=?',[command.expiresAt?new Date(command.expiresAt):null,tenant]);
     await reconcileTenantExpiry(tx);
     result={before:{expiresAt:previous.expires_at,overrides:previous.overrides},after:{expiresAt:(await tenantPlan(tx,tenant)).expires_at,overrides:(await tenantPlan(tx,tenant)).overrides}};
   } else if(command.action==='recipient-preference' || command.action==='recipient-suppression') {
     const number=normalizeNumber(command.number);subject=digest(number);
     if(!(await tx.query('SELECT 1 FROM recipients WHERE normalized_e164=?',[number])).rows.length)throw new ApiError(404,'RECIPIENT_NOT_FOUND');
     let stop=false;
     if(command.action==='recipient-preference') {
       stop=command.optedOut;
       // Database time fences off delayed SMS reports from before the operator change.
       await tx.query('INSERT INTO sms_preferences (normalized_e164,opted_out,last_received_at) VALUES (?,?,FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6))*1000)) ON DUPLICATE KEY UPDATE opted_out=VALUES(opted_out),last_received_at=GREATEST(last_received_at,VALUES(last_received_at))',[number,stop]);
       await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE normalized_e164=? AND control_command IS NOT NULL AND send_attempt_started_at IS NULL AND status IN ('QUEUED','CLAIMED')",[number]);
     } else {stop=command.suppressed;await tx.query('UPDATE recipients SET suppressed=? WHERE normalized_e164=?',[stop,number]);}
     if(stop)await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE normalized_e164=? AND send_attempt_started_at IS NULL AND status IN ('QUEUED','CLAIMED')",[number]);
   } else if(command.action==='tenant-create') {
     resource=randomUUID();tenant=resource;await tx.query('INSERT INTO tenants VALUES (?,?,true)',[resource,command.name]);
     if(command.expiresAt)await tx.query("INSERT INTO tenant_plans (tenant_id,expires_at,settings_json) VALUES (?,?,'{}')",[tenant,new Date(command.expiresAt)]);
   } else if(command.action==='client-create' || command.action==='client-rotate') {
     tenant=command.tenantId;
     await assertTenantActive(tx,tenant);
     if(!(await tx.query('SELECT id FROM tenants WHERE id=? AND enabled=true',[tenant])).rows.length)throw new ApiError(404,'TENANT_NOT_FOUND');
     const apiKey=randomBytes(32).toString('base64url');
     if(command.action==='client-create') {resource=randomUUID();await tx.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[resource,tenant,digest(apiKey),JSON.stringify(['sms:send','sms:read','sms:compliance:write'])]);}
     else {
       resource=command.clientId;
       if(!(await tx.query('SELECT id FROM api_clients WHERE id=? AND tenant_id=? AND enabled=true',[resource,tenant])).rows.length)throw new ApiError(404,'CLIENT_NOT_FOUND');
       await tx.query('UPDATE api_clients SET key_hash=? WHERE id=?',[digest(apiKey),resource]);
     }
     result={apiKey};
   } else if(command.action==='device-sim') {
     tenant=command.tenantId;resource=command.deviceId;await assertTenantActive(tx,tenant);
     if(!(await tx.query('SELECT id FROM devices WHERE id=? AND tenant_id=? AND revoked_at IS NULL',[resource,tenant])).rows.length)throw new ApiError(404,'DEVICE_NOT_FOUND');
     await tx.query('UPDATE devices SET allowed_sim_id=?,paused=true WHERE id=?',[command.simId,resource]);
     await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE device_id=? AND send_attempt_started_at IS NULL AND status IN ('QUEUED','CLAIMED')",[resource]);
   }
   const details=command.action==='tenant-settings-update'||command.action==='tenant-expiry-update'?result:command.action==='tenant-create'?{expiresAt:command.expiresAt??null}:command.action==='settings-update'?{before,after:command.settings}:command.action==='recipient-preference'?{optedOut:command.optedOut}:command.action==='recipient-suppression'?{suppressed:command.suppressed}:null;
   await tx.query('INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id,reason_reference,subject_hash,details_json) VALUES (?,?,?,?,?,?,?)',[tenant,userId,command.action,resource,request.reasonReference,subject,details?JSON.stringify(details):null]);
   return {action:command.action,resourceId:resource,...result};
 });
}
