import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Connection, Database } from '../db/database.js';
import { contentCipher, digest } from '../security/crypto.js';
import { verifyDeviceProof, type DeviceProof } from '../security/device-signatures.js';
import { ApiError } from './policy.js';
import { controlSchema, receiveControl } from './sms-controls.js';

const readiness=z.object({subscriptionId:z.number().int().min(0),canSendSms:z.boolean(),locallyPaused:z.boolean()}).strict();
const eventSchema=z.object({eventId:z.uuid(),leaseId:z.uuid(),partIndex:z.literal(0),type:z.enum(['SENT_TO_CARRIER','DELIVERED','FAILED_DEFINITE','UNKNOWN'])}).strict();

export async function reconcileJobs(tx: Connection) {
  await tx.query("UPDATE outbound_messages SET status='EXPIRED' WHERE status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL AND expires_at<=CURRENT_TIMESTAMP(6)");
  await tx.query("UPDATE outbound_messages SET status='QUEUED',lease_id=NULL,lease_expires_at=NULL WHERE status='CLAIMED' AND send_attempt_started_at IS NULL AND lease_expires_at<=CURRENT_TIMESTAMP(6)");
  await tx.query("UPDATE outbound_messages SET status='UNKNOWN' WHERE status='ATTEMPT_RECORDED' AND send_attempt_started_at<=CURRENT_TIMESTAMP(6)-INTERVAL 2 MINUTE");
  await tx.query('DELETE FROM device_nonces WHERE expires_at<CURRENT_TIMESTAMP(6)');
}

export function deviceService(db: Database, cipher: ReturnType<typeof contentCipher>) {
  async function signed<T>(proof: DeviceProof, fn:(tx:Connection,device:Record<string,any>)=>Promise<T>, token?:string) {
    const outcome=await db.transaction(async tx=>{
      await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE');
      const device=(await tx.query('SELECT d.*,t.enabled AS tenant_enabled,UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) AS server_seconds FROM devices d JOIN tenants t ON t.id=d.tenant_id WHERE d.id=?',[proof.deviceId])).rows[0];
      if(!device || device.revoked_at || !device.tenant_enabled) throw new ApiError(401,'DEVICE_UNAUTHORIZED');
      let key=device.public_key;
      if(token!==undefined) {
        const challenge=(await tx.query('SELECT public_key FROM enrollment_challenges WHERE device_id=? AND token_hash=? AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(6)',[proof.deviceId,digest(token)])).rows[0];
        if(!challenge || key) throw new ApiError(401,'ENROLLMENT_INVALID');
        key=challenge.public_key;
      }
      if(!key) throw new ApiError(401,'DEVICE_NOT_ENROLLED');
      verifyDeviceProof(proof,key,Number(device.server_seconds));
      if((await tx.query('SELECT 1 FROM device_nonces WHERE device_id=? AND nonce=?',[proof.deviceId,proof.nonce])).rows.length) throw new ApiError(409,'DEVICE_REQUEST_REPLAY');
      await tx.query('INSERT INTO device_nonces VALUES (?,?,CURRENT_TIMESTAMP(6)+INTERVAL 5 MINUTE)',[proof.deviceId,proof.nonce]);
      device.verified_key=key;
      // Keep the nonce even for rejected operations; roll back their writes.
      await tx.query('SAVEPOINT device_operation');
      try { return {ok:true as const,value:await fn(tx,device)}; }
      catch(error) { await tx.query('ROLLBACK TO SAVEPOINT device_operation');return {ok:false as const,error}; }
    });
    if(!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  async function ready(tx:Connection,device:Record<string,any>,input:unknown) {
    const state=readiness.parse(input);
    const settings=(await tx.query('SELECT paused FROM gateway_settings WHERE id=1')).rows[0];
    if(!settings || settings.paused || device.paused) throw new ApiError(503,'GATEWAY_PAUSED');
    if(!state.canSendSms || state.locallyPaused || state.subscriptionId!==device.allowed_sim_id) throw new ApiError(409,'DEVICE_NOT_READY');
  }
  async function policy(tx:Connection,job:Record<string,any>) {
    const result=(await tx.query('SELECT c.enabled,r.suppressed,c.scopes FROM api_clients c JOIN recipients r ON r.normalized_e164=? WHERE c.id=? AND c.tenant_id=?',[job.normalized_e164,job.client_id,job.tenant_id])).rows[0];
    const scopes=typeof result?.scopes==='string'?JSON.parse(result.scopes):result?.scopes;
    const consent=await tx.query("SELECT 1 FROM recipient_tenant_consents WHERE tenant_id=? AND normalized_e164=? AND purpose='transactional_notification' AND revoked_at IS NULL",[job.tenant_id,job.normalized_e164]);
    const optedOut = Boolean((await tx.query('SELECT opted_out FROM sms_preferences WHERE normalized_e164=?',[job.normalized_e164])).rows[0]?.opted_out);
    const permitted = job.control_command ? (job.control_command === 'STOP') === optedOut : !optedOut && consent.rows.length > 0;
    if(!result?.enabled || result.suppressed || !Array.isArray(scopes) || !scopes.includes('sms:send') || !permitted) throw new ApiError(403,'SEND_POLICY_REVOKED');
  }
  return {
    inbound(proof:DeviceProof,input:unknown) {
      const event = controlSchema.parse(input);
      return signed(proof, (tx,device) => receiveControl(tx,device,event,cipher));
    },
    enroll(proof:DeviceProof,input:unknown) {
      const {enrollmentToken}=z.object({enrollmentToken:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(input);
      return signed(proof,async(tx,device)=>{
        await tx.query('UPDATE enrollment_challenges SET consumed_at=CURRENT_TIMESTAMP(6) WHERE device_id=?',[proof.deviceId]);
        await tx.query('UPDATE devices SET public_key=?,last_seen_at=CURRENT_TIMESTAMP(6) WHERE id=?',[device.verified_key,proof.deviceId]);
        await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id) VALUES (?,?,'DEVICE_ENROLLED',?)",[device.tenant_id,proof.deviceId,proof.deviceId]);
        return {deviceId:proof.deviceId,subscriptionId:device.allowed_sim_id,paused:Boolean(device.paused)};
      },enrollmentToken);
    },
    heartbeat(proof:DeviceProof,input:unknown) {
      readiness.parse(input);
      return signed(proof,async(tx,device)=>{
        await reconcileJobs(tx);
        await tx.query('UPDATE devices SET last_seen_at=CURRENT_TIMESTAMP(6) WHERE id=?',[proof.deviceId]);
        const settings=(await tx.query('SELECT paused FROM gateway_settings WHERE id=1')).rows[0];
        return {paused:Boolean(settings?.paused || device.paused),subscriptionId:device.allowed_sim_id};
      });
    },
    fcmToken(proof:DeviceProof,input:unknown) {
      const {token}=z.object({token:z.string().min(20).max(4096)}).strict().parse(input);
      return signed(proof,async tx=>{
        await tx.query('UPDATE devices SET encrypted_fcm_token=? WHERE id=?',[cipher.encrypt(token,`fcm:${proof.deviceId}`),proof.deviceId]);
        return {registered:true};
      });
    },
    claim(proof:DeviceProof,input:unknown) {
      return signed(proof,async(tx,device)=>{
        await ready(tx,device,input); await reconcileJobs(tx);
        const job=(await tx.query("SELECT * FROM outbound_messages WHERE device_id=? AND tenant_id=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL AND expires_at>CURRENT_TIMESTAMP(6) ORDER BY (status='CLAIMED') DESC,created_at,id LIMIT 1 FOR UPDATE",[proof.deviceId,device.tenant_id])).rows[0];
        if(!job) return {job:null};
        try { await policy(tx,job); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'SEND_POLICY_REVOKED') throw error;
          await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE id=?",[job.id]);
          return {job:null};
        }
        if(job.status==='QUEUED') {
          job.lease_id=randomUUID();
          await tx.query("UPDATE outbound_messages SET status='CLAIMED',lease_id=?,lease_expires_at=LEAST(expires_at,CURRENT_TIMESTAMP(6)+INTERVAL 60 SECOND) WHERE id=?",[job.lease_id,job.id]);
        }
        const lease=(await tx.query('SELECT lease_expires_at,expires_at FROM outbound_messages WHERE id=?',[job.id])).rows[0]!;
        return {job:{jobId:job.id,leaseId:job.lease_id,to:job.normalized_e164,body:cipher.decrypt(job.encrypted_body,job.id),bodyHash:job.body_hash,subscriptionId:device.allowed_sim_id,segments:job.segments,controlCommand:job.control_command,leaseExpiresAt:lease.lease_expires_at,expiresAt:lease.expires_at}};
      });
    },
    authorize(proof:DeviceProof,jobId:string,input:unknown) {
      const parsed=z.object({leaseId:z.uuid(),readiness}).strict().parse(input);
      return signed(proof,async(tx,device)=>{
        await ready(tx,device,parsed.readiness);
        const job=(await tx.query('SELECT *,expires_at>CURRENT_TIMESTAMP(6) AND lease_expires_at>CURRENT_TIMESTAMP(6) AS valid,TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(6),LEAST(expires_at,lease_expires_at))/1000 AS valid_for_ms FROM outbound_messages WHERE id=? AND device_id=? AND tenant_id=? FOR UPDATE',[jobId,proof.deviceId,device.tenant_id])).rows[0];
        if(!job) throw new ApiError(404,'NOT_FOUND');
        // Never reissue authorization, even after a lost response. Reconcile as UNKNOWN.
        if(job.status!=='CLAIMED' || job.send_attempt_started_at || job.lease_id!==parsed.leaseId || !job.valid) throw new ApiError(409,'ATTEMPT_NOT_AUTHORIZED');
        await policy(tx,job);
        await tx.query("UPDATE outbound_messages SET status='ATTEMPT_RECORDED',send_attempt_started_at=CURRENT_TIMESTAMP(6) WHERE id=?",[jobId]);
        await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action,resource_id) VALUES (?,?,'ATTEMPT_AUTHORIZED',?)",[device.tenant_id,proof.deviceId,jobId]);
        return {jobId,leaseId:parsed.leaseId,authorized:true,validUntil:job.lease_expires_at,validForMs:Math.max(0,Math.floor(Number(job.valid_for_ms)))};
      });
    },
    event(proof:DeviceProof,jobId:string,input:unknown) {
      const event=eventSchema.parse(input); const hash=digest(JSON.stringify({jobId,...event}));
      return signed(proof,async(tx,device)=>{
        const previous=(await tx.query('SELECT request_hash,resulting_status FROM device_events WHERE device_id=? AND event_id=?',[proof.deviceId,event.eventId])).rows[0];
        if(previous) {
          if(previous.request_hash!==hash) throw new ApiError(409,'EVENT_CONFLICT');
          return {jobId,status:previous.resulting_status};
        }
        const job=(await tx.query('SELECT * FROM outbound_messages WHERE id=? AND device_id=? AND tenant_id=? FOR UPDATE',[jobId,proof.deviceId,device.tenant_id])).rows[0];
        if(!job) throw new ApiError(404,'NOT_FOUND');
        if(!job.send_attempt_started_at || event.leaseId!==job.lease_id) throw new ApiError(409,'EVENT_WITHOUT_ATTEMPT');
        let status:string=event.type;
        if(job.status==='DELIVERED' && event.type==='SENT_TO_CARRIER') status='DELIVERED';
        else if(job.status===event.type) status=job.status;
        else if(!(['ATTEMPT_RECORDED','UNKNOWN'].includes(job.status) || job.status==='SENT_TO_CARRIER' && event.type==='DELIVERED')) throw new ApiError(409,'INVALID_EVENT_TRANSITION');
        await tx.query('UPDATE outbound_messages SET status=? WHERE id=?',[status,jobId]);
        await tx.query('INSERT INTO device_events (device_id,event_id,job_id,request_hash,event_type,resulting_status) VALUES (?,?,?,?,?,?)',[proof.deviceId,event.eventId,jobId,hash,event.type,status]);
        return {jobId,status};
      });
    },
  };
}
