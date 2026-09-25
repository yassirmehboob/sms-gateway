import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {databaseFixture} from './database-fixture.js';
import {mariaDatabase} from '../db/database.js';
import {contentCipher,digest} from '../security/crypto.js';
import {messageService} from '../services/messages.js';
import {fcmOutbox} from '../workers/fcm-outbox.js';
import {wakeupMessage,deliveryFailure,retryDelay,type Wakeup} from '../workers/fcm-transport.js';

test('FCM payload contains only wake-up hints and bounded normal-priority TTL',()=>{
  const message=wakeupMessage({deviceId:'device-fixture',token:'routing-token',ttlMs:500000});
  assert.deepEqual(message,{token:'routing-token',data:{deviceId:'device-fixture',jobAvailable:'true'},android:{priority:'normal',collapseKey:'gateway-work',ttl:60000}});
  assert.equal(wakeupMessage({deviceId:'d',token:'t',ttlMs:500}).android?.ttl,500);
});
test('provider failures are redacted and Retry-After controls backoff',()=>{
  assert.equal(deliveryFailure({code:'messaging/registration-token-not-registered'}).invalidToken,true);
  assert.equal(deliveryFailure({code:'messaging/invalid-argument'}).permanent,true);
  assert.equal(deliveryFailure({code:'secret-token',message:'private content'}).code,'FCM_TRANSIENT_ERROR');
  assert.equal(retryDelay(1,0,0),60);assert.equal(retryDelay(2,0,0),120);
  assert.equal(retryDelay(1,500,0),500);
  assert.equal(deliveryFailure({httpResponse:{headers:{'retry-after':'900'}}}).retryAfterSeconds,900);
  assert.equal(deliveryFailure({httpResponse:{headers:{'retry-after':new Date(200000).toUTCString()}}},100000).retryAfterSeconds,100);
});

test('MariaDB FCM outbox leases, retries, fencing and token rotation', {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const fixture=await databaseFixture();const second=mariaDatabase(fixture.url);const {db}=fixture;
  const tenant=randomUUID(),device=randomUUID(),client=randomUUID();
  const cipher=contentCipher('ab'.repeat(32));const encrypted=cipher.encrypt('old-routing-token',`fcm:${device}`);
  try {
    await t.test('UTC timestamps round-trip independently of host timezone',async()=>{
      const row=(await db.query('SELECT CURRENT_TIMESTAMP(6) AS now,UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) AS epoch')).rows[0]!;
      assert.ok(Math.abs(row.now.getTime()-Number(row.epoch)*1000)<2);
      const instant=new Date('2026-09-23T09:00:00.123Z');
      const roundtrip=(await db.query('SELECT CAST(? AS DATETIME(6)) AS moment',[instant])).rows[0]!;
      assert.equal(roundtrip.moment.toISOString(),instant.toISOString());
    });
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenant,'FCM test']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[client,tenant,digest('client-fixture'),JSON.stringify(['sms:send'])]);
    await db.query('INSERT INTO devices (id,tenant_id,allowed_sim_id,paused,public_key,encrypted_fcm_token) VALUES (?,?,1,false,?,?)',[device,tenant,'approved-key-fixture',encrypted]);
    await db.query('UPDATE gateway_settings SET paused=false');
    await db.query("INSERT INTO recipients (normalized_e164) VALUES ('+923001234567')");
    await db.query("INSERT INTO recipient_tenant_consents VALUES (?,'+923001234567','transactional_notification','fixture',NULL)",[tenant]);
    const job=await messageService(db,cipher).create({id:client,tenant_id:tenant,scopes:['sms:send']},randomUUID(),{to:'+923001234567',templateId:'appointment_reminder_v1',purpose:'transactional_notification',variables:{date:'2026-09-24'}});
    const reset=async()=>{
      await db.query('UPDATE outbox_events SET published_at=NULL,abandoned_at=NULL,lease_token=NULL,lease_until=NULL,retry_count=0,last_error=NULL,available_at=CURRENT_TIMESTAMP(6)');
      await db.query("UPDATE outbound_messages SET status='QUEUED',send_attempt_started_at=NULL,expires_at=CURRENT_TIMESTAMP(6)+INTERVAL 10 MINUTE");
      await db.query('UPDATE devices SET paused=false,revoked_at=NULL,encrypted_fcm_token=?',[encrypted]);
      await db.query('UPDATE gateway_settings SET paused=false');
      await db.query('UPDATE recipients SET suppressed=false');
    };
    const state=async()=>(await db.query('SELECT * FROM outbox_events')).rows[0]!;
    await t.test('two workers publish one wake-up without advancing SMS state',async()=>{
      const sent:Wakeup[]=[];const transport={async send(w:Wakeup){sent.push(w);}};
      const workers=[db,second.db].map(database=>fcmOutbox(database,cipher,transport));
      await Promise.all(workers.map(w=>w.dispatchOne()));
      assert.equal(sent.length,1);assert.equal(sent[0]!.deviceId,device);assert.equal(sent[0]!.token,'old-routing-token');
      assert.ok((await state()).published_at);
      assert.equal((await db.query('SELECT status FROM outbound_messages WHERE id=?',[job.jobId])).rows[0]!.status,'QUEUED');
    });
    await t.test('pause, missing tokens and revoked policy prevent dispatch',async()=>{
      await reset();let count=0;const worker=fcmOutbox(db,cipher,{async send(){count++;}});
      await db.query('UPDATE gateway_settings SET paused=true');assert.equal(await worker.dispatchOne(),false);
      await db.query('UPDATE gateway_settings SET paused=false');await db.query('UPDATE devices SET encrypted_fcm_token=NULL');assert.equal(await worker.dispatchOne(),false);
      await db.query('UPDATE devices SET encrypted_fcm_token=?',[encrypted]);await db.query('UPDATE recipients SET suppressed=true');assert.equal(await worker.dispatchOne(),false);
      await db.query('UPDATE recipients SET suppressed=false');await db.query('UPDATE devices SET revoked_at=CURRENT_TIMESTAMP(6)');assert.equal(await worker.dispatchOne(),false);
      assert.equal(count,0);
    });
    await t.test('expired and already-attempted jobs are closed without a hint',async()=>{
      for(const attempted of [false,true]) {
        await reset();let count=0;
        if(attempted)await db.query("UPDATE outbound_messages SET status='ATTEMPT_RECORDED',send_attempt_started_at=CURRENT_TIMESTAMP(6)");
        else await db.query('UPDATE outbound_messages SET expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND');
        assert.equal(await fcmOutbox(db,cipher,{async send(){count++;}}).dispatchOne(),false);
        assert.ok((await state()).abandoned_at);assert.equal(count,0);
      }
    });
    await t.test('transient failure schedules durable backoff and retries later',async()=>{
      await reset();let attempts=0;
      const worker=fcmOutbox(db,cipher,{async send(){if(++attempts===1)throw {code:'messaging/server-unavailable',httpResponse:{headers:{'retry-after':'180'}}};}},()=>0);
      await worker.dispatchOne();const failed=await state();assert.equal(failed.retry_count,1);assert.equal(failed.published_at,null);
      assert.ok(failed.available_at.getTime()-Date.now()>170000);
      assert.equal(await worker.dispatchOne(),false);
      await db.query('UPDATE outbox_events SET available_at=CURRENT_TIMESTAMP(6)');await worker.dispatchOne();assert.equal(attempts,2);assert.ok((await state()).published_at);
    });
    await t.test('invalid old token cannot erase a concurrently rotated token',async()=>{
      await reset();const rotated=cipher.encrypt('new-routing-token',`fcm:${device}`);
      await fcmOutbox(db,cipher,{async send(){await second.db.query('UPDATE devices SET encrypted_fcm_token=?',[rotated]);throw {code:'messaging/registration-token-not-registered'};}}).dispatchOne();
      assert.equal((await db.query('SELECT encrypted_fcm_token FROM devices')).rows[0]!.encrypted_fcm_token,rotated);
      assert.equal((await state()).abandoned_at,null);
      await reset();await fcmOutbox(db,cipher,{async send(){throw {code:'messaging/registration-token-not-registered'};}}).dispatchOne();
      assert.equal((await db.query('SELECT encrypted_fcm_token FROM devices')).rows[0]!.encrypted_fcm_token,null);
    });
    await t.test('permanent failures terminate only the outbox item',async()=>{
      await reset();await fcmOutbox(db,cipher,{async send(){throw {code:'messaging/invalid-argument',message:'secret'};}}).dispatchOne();
      assert.ok((await state()).abandoned_at);assert.equal((await state()).last_error,'messaging/invalid-argument');
      assert.equal((await db.query('SELECT status FROM outbound_messages')).rows[0]!.status,'QUEUED');
    });
    await t.test('expired leases recover and stale acknowledgments are fenced',async()=>{
      await reset();await db.query('UPDATE outbox_events SET lease_token=?,lease_until=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND',[randomUUID()]);
      const newer=randomUUID();
      await fcmOutbox(db,cipher,{async send(){await second.db.query('UPDATE outbox_events SET lease_token=?,lease_until=CURRENT_TIMESTAMP(6)+INTERVAL 2 MINUTE',[newer]);}}).dispatchOne();
      assert.equal((await state()).published_at,null);assert.equal((await state()).lease_token,newer);
      await db.query('UPDATE outbox_events SET lease_until=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND');
      await fcmOutbox(db,cipher,{async send(){}}).dispatchOne();assert.ok((await state()).published_at);
    });
    await t.test('failed publication acknowledgment retries a hint after lease expiry',async()=>{
      await reset();let sends=0;
      const worker=fcmOutbox(db,cipher,{async send(){sends++;await second.db.query("CREATE TRIGGER reject_publish BEFORE UPDATE ON outbox_events FOR EACH ROW BEGIN IF NEW.published_at IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test failure'; END IF; END");}});
      await assert.rejects(()=>worker.dispatchOne());assert.equal(sends,1);assert.equal((await state()).published_at,null);
      await db.query('DROP TRIGGER reject_publish');await db.query('UPDATE outbox_events SET lease_until=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND');
      await fcmOutbox(db,cipher,{async send(){sends++;}}).dispatchOne();assert.equal(sends,2);assert.ok((await state()).published_at);
    });
  } finally {await second.close();await fixture.dispose();}
});
