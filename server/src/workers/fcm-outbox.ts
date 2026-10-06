import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Connection, Database } from '../db/database.js';
import { contentCipher } from '../security/crypto.js';
import { deliveryFailure,retryDelay,type WakeupTransport } from './fcm-transport.js';

interface Dispatch {
  id:string; leaseToken:string; deviceId:string; encryptedToken:string; retryCount:number;
}
// Selection and validation use the same durable policy lock as API mutations.
const eligible=`m.status='QUEUED' AND m.send_attempt_started_at IS NULL AND m.expires_at>CURRENT_TIMESTAMP(6)
 AND t.enabled=true AND NOT EXISTS (SELECT 1 FROM tenant_plans tp WHERE tp.tenant_id=t.id AND tp.expires_at<=CURRENT_TIMESTAMP(6)) AND c.enabled=true AND d.revoked_at IS NULL AND d.tenant_id=m.tenant_id
 AND c.tenant_id=m.tenant_id AND r.suppressed=false
 AND JSON_CONTAINS(c.scopes, '"sms:send"')
 AND ((m.control_command='STOP' AND EXISTS (SELECT 1 FROM sms_preferences p WHERE p.normalized_e164=m.normalized_e164 AND p.opted_out=true))
 OR (m.control_command='START' AND NOT EXISTS (SELECT 1 FROM sms_preferences p WHERE p.normalized_e164=m.normalized_e164 AND p.opted_out=true))
 OR (m.control_command IS NULL AND NOT EXISTS (SELECT 1 FROM sms_preferences p WHERE p.normalized_e164=m.normalized_e164 AND p.opted_out=true)
 AND EXISTS (SELECT 1 FROM recipient_tenant_consents consent WHERE consent.tenant_id=m.tenant_id
 AND consent.normalized_e164=m.normalized_e164 AND consent.purpose='transactional_notification' AND consent.revoked_at IS NULL)))`;
const joins=`FROM outbox_events o JOIN outbound_messages m ON m.id=o.job_id JOIN devices d ON d.id=m.device_id
 JOIN tenants t ON t.id=m.tenant_id JOIN api_clients c ON c.id=m.client_id JOIN recipients r ON r.normalized_e164=m.normalized_e164`;

export function fcmOutbox(db:Database,cipher:ReturnType<typeof contentCipher>,transport:WakeupTransport,jitter= Math.random) {
  async function lock(tx:Connection) { return (await tx.query('SELECT paused FROM gateway_settings WHERE id=1 FOR UPDATE')).rows[0]; }
  async function reserve():Promise<Dispatch|null> {
    return db.transaction(async tx=>{
      const settings=await lock(tx);
      await tx.query(`UPDATE outbox_events o JOIN outbound_messages m ON m.id=o.job_id
        SET o.abandoned_at=CURRENT_TIMESTAMP(6),o.last_error='JOB_NO_LONGER_QUEUED',o.lease_token=NULL,o.lease_until=NULL
        WHERE o.published_at IS NULL AND o.abandoned_at IS NULL AND (m.status<>'QUEUED' OR m.expires_at<=CURRENT_TIMESTAMP(6) OR m.send_attempt_started_at IS NOT NULL)`);
      if(!settings || settings.paused) return null;
      const row=(await tx.query(`SELECT o.id,o.retry_count,d.id AS device_id,d.encrypted_fcm_token ${joins}
        WHERE o.published_at IS NULL AND o.abandoned_at IS NULL AND o.available_at<=CURRENT_TIMESTAMP(6)
        AND (o.lease_until IS NULL OR o.lease_until<=CURRENT_TIMESTAMP(6)) AND ${eligible}
        AND d.paused=false AND d.public_key IS NOT NULL AND d.encrypted_fcm_token IS NOT NULL
        ORDER BY o.available_at,o.created_at,o.id LIMIT 1 FOR UPDATE`)).rows[0];
      if(!row) return null;
      const leaseToken=randomUUID();
      await tx.query('UPDATE outbox_events SET lease_token=?,lease_until=CURRENT_TIMESTAMP(6)+INTERVAL 2 MINUTE WHERE id=?',[leaseToken,row.id]);
      return {id:row.id,leaseToken,deviceId:row.device_id,encryptedToken:row.encrypted_fcm_token,retryCount:row.retry_count};
    });
  }
  async function validate(dispatch:Dispatch) {
    return db.transaction(async tx=>{
      const settings=await lock(tx);
      if(!settings || settings.paused) return null;
      const row=(await tx.query(`SELECT TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(6),m.expires_at)/1000 AS ttl_ms ${joins}
        WHERE o.id=? AND o.lease_token=? AND o.lease_until>CURRENT_TIMESTAMP(6) AND o.published_at IS NULL AND o.abandoned_at IS NULL
        AND ${eligible} AND d.paused=false AND d.public_key IS NOT NULL AND d.encrypted_fcm_token=?`,[dispatch.id,dispatch.leaseToken,dispatch.encryptedToken])).rows[0];
      return row?Number(row.ttl_ms):null;
    });
  }
  async function release(dispatch:Dispatch) {
    await db.transaction(async tx=>{
      await lock(tx);
      await tx.query('UPDATE outbox_events SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?',[dispatch.id,dispatch.leaseToken]);
    });
  }
  return {
    async dispatchOne():Promise<boolean> {
      const dispatch=await reserve();if(!dispatch)return false;
      const started=performance.now();
      const remaining=await validate(dispatch);
      if(remaining===null) {await release(dispatch);return true;}
      let token:string;
      try {token=cipher.decrypt(dispatch.encryptedToken,`fcm:${dispatch.deviceId}`);}
      catch {
        await db.transaction(async tx=>{
          await lock(tx);
          await tx.query("UPDATE outbox_events SET abandoned_at=CURRENT_TIMESTAMP(6),last_error='FCM_TOKEN_DECRYPTION_FAILED',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",[dispatch.id,dispatch.leaseToken]);
        });return true;
      }
      const ttlMs=remaining-(performance.now()-started);
      if(ttlMs<=0) {await release(dispatch);return true;}
      // No DB transaction/lock is held while calling Firebase. Duplicate hints
      // after a crash are harmless; the device protocol controls SMS attempts.
      try {await transport.send({deviceId:dispatch.deviceId,token,ttlMs});}
      catch(error) {
        const failure=deliveryFailure(error);
        await db.transaction(async tx=>{
          await lock(tx);
          const owned=(await tx.query('SELECT id FROM outbox_events WHERE id=? AND lease_token=? AND published_at IS NULL AND abandoned_at IS NULL',[dispatch.id,dispatch.leaseToken])).rows[0];
          if(!owned)return;
          if(failure.invalidToken) {
            // A failed old token must not erase a newly registered token.
            await tx.query('UPDATE devices SET encrypted_fcm_token=NULL WHERE id=? AND encrypted_fcm_token=?',[dispatch.deviceId,dispatch.encryptedToken]);
          }
          // Jobs expire within ten minutes; bound hostile provider header values
          // without retrying any still-valid job before its Retry-After deadline.
          const delay=Math.min(86400,retryDelay(dispatch.retryCount+1,failure.retryAfterSeconds,jitter()));
          await tx.query(`UPDATE outbox_events SET retry_count=retry_count+1,last_error=?,available_at=TIMESTAMPADD(SECOND,?,CURRENT_TIMESTAMP(6)),
            abandoned_at=IF(?,CURRENT_TIMESTAMP(6),NULL),lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,
            [failure.code,delay,failure.permanent,dispatch.id,dispatch.leaseToken]);
        });return true;
      }
      // If this commit fails, let the lease expire and retry only the wake-up.
      await db.transaction(async tx=>{
        await lock(tx);
        await tx.query('UPDATE outbox_events SET published_at=CURRENT_TIMESTAMP(6),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND abandoned_at IS NULL',[dispatch.id,dispatch.leaseToken]);
      });
      return true;
    },
  };
}
