import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database,Connection } from '../db/database.js';
import { digest } from '../security/crypto.js';
import { ApiError,normalizeNumber } from './policy.js';
import { settingsSchema } from './admin-settings.js';
import { executeOperatorCommand,operatorCommand } from './operator.js';

const ref=z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);
const extra=z.discriminatedUnion('action',[
 z.object({action:z.literal('settings-update'),settings:settingsSchema}).strict(),
 z.object({action:z.literal('recipient-preference'),number:z.string(),optedOut:z.boolean()}).strict(),
 z.object({action:z.literal('recipient-suppression'),number:z.string(),suppressed:z.boolean()}).strict(),
 z.object({action:z.literal('tenant-create'),name:z.string().trim().min(1).max(200)}).strict(),
 z.object({action:z.literal('client-create'),tenantId:z.uuid()}).strict(),
 z.object({action:z.literal('client-rotate'),tenantId:z.uuid(),clientId:z.uuid()}).strict(),
 z.object({action:z.literal('device-sim'),tenantId:z.uuid(),deviceId:z.uuid(),simId:z.number().int().min(0).max(2147483647)}).strict(),
]);
export async function adminGuard(tx:Connection,userId:string,sessionHash:string) {
 const row=(await tx.query('SELECT u.id FROM cms_users u JOIN cms_sessions s ON s.user_id=u.id WHERE u.id=? AND u.enabled=true AND u.role=\'admin\' AND u.totp_enabled=true AND s.token_hash=? AND s.mfa_verified=true AND s.expires_at>CURRENT_TIMESTAMP(6)',[userId,sessionHash])).rows[0];
 if(!row)throw new ApiError(403,'ADMIN_REQUIRED');
}
export async function adminCommand(db:Database,userId:string,sessionHash:string,input:unknown) {
 const request=z.object({reasonReference:ref,command:z.union([operatorCommand,extra])}).strict().parse(input);
 const legacy=operatorCommand.safeParse(request.command);
 if(legacy.success)return executeOperatorCommand(db,{actorId:userId,...request},tx=>adminGuard(tx,userId,sessionHash));
 const command=extra.parse(request.command);
 return db.transaction(async tx=>{
   const before=(await tx.query('SELECT * FROM gateway_settings WHERE id=1 FOR UPDATE')).rows[0];
   await adminGuard(tx,userId,sessionHash);
   let resource:string|null=null,subject:string|null=null,tenant:string|null=null;
   let result:Record<string,unknown>={};
   if(command.action==='settings-update') {
     const settings=command.settings;
     const keys=Object.keys(settings) as Array<keyof typeof settings>;
     await tx.query(`UPDATE gateway_settings SET ${keys.map(key=>`${key}=?`).join(',')} WHERE id=1`,keys.map(key=>settings[key]));
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
   } else if(command.action==='client-create' || command.action==='client-rotate') {
     tenant=command.tenantId;
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
     tenant=command.tenantId;resource=command.deviceId;
     if(!(await tx.query('SELECT id FROM devices WHERE id=? AND tenant_id=? AND revoked_at IS NULL',[resource,tenant])).rows.length)throw new ApiError(404,'DEVICE_NOT_FOUND');
     await tx.query('UPDATE devices SET allowed_sim_id=?,paused=true WHERE id=?',[command.simId,resource]);
     await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE device_id=? AND send_attempt_started_at IS NULL AND status IN ('QUEUED','CLAIMED')",[resource]);
   }
   const details=command.action==='settings-update'?{before,after:command.settings}:command.action==='recipient-preference'?{optedOut:command.optedOut}:command.action==='recipient-suppression'?{suppressed:command.suppressed}:null;
   await tx.query('INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id,reason_reference,subject_hash,details_json) VALUES (?,?,?,?,?,?,?)',[tenant,userId,command.action,resource,request.reasonReference,subject,details?JSON.stringify(details):null]);
   return {action:command.action,resourceId:resource,...result};
 });
}
