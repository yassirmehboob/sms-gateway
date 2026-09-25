import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from './database-fixture.js';
import { messageService } from '../services/messages.js';
import { contentCipher } from '../security/crypto.js';
test('MariaDB quota reservations and failed outbox writes cannot leak jobs or cooldowns', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const fixture=await databaseFixture(); const {db}=fixture;
  try {
    const tenant=randomUUID(), client=randomUUID(), otherClient=randomUUID(), device=randomUUID();
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenant,'Quota test']);
    for(const id of [client,otherClient]) await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[id,tenant,randomUUID(),JSON.stringify(['sms:send'])]);
    await db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id) VALUES (?,?,false,1)',[device,tenant]);
    await db.query('UPDATE gateway_settings SET paused=false');
    // Historical synthetic reservations, never actual telephony.
    await db.query("INSERT INTO recipients (normalized_e164) VALUES ('+923001234567'),('+923001234568')");
    await db.query("INSERT INTO recipient_tenant_consents VALUES (?,'+923001234568','transactional_notification','fixture',NULL)",[tenant]);
    const service=messageService(db,contentCipher('ab'.repeat(32)));
    const body={to:'+923001234568',templateId:'appointment_reminder_v1',purpose:'transactional_notification',variables:{date:'2026-09-24'}};
    const actor={id:client,tenant_id:tenant,scopes:['sms:send']};
    const reserve=async(id:string)=>db.query("INSERT INTO outbound_messages (id,tenant_id,client_id,device_id,normalized_e164,encrypted_body,body_hash,segments,status,expires_at) VALUES (?,?,?,?,'+923001234567','fixture','fixture',1,'UNKNOWN',CURRENT_TIMESTAMP(6)+INTERVAL 10 MINUTE)",[randomUUID(),tenant,id,device]);
    await t.test('client and device budgets include UNKNOWN reservations',async()=>{
      for(let i=0;i<10;i++) await reserve(client);
      await assert.rejects(()=>service.create(actor,'client-cap-001',body),{code:'CLIENT_QUOTA'});
      await db.query('UPDATE outbound_messages SET client_id=?',[otherClient]);
      for(let i=0;i<20;i++) await reserve(otherClient);
      await assert.rejects(()=>service.create(actor,'device-cap-001',body),{code:'DEVICE_QUOTA'});
      assert.equal((await db.query('SELECT * FROM idempotency_keys')).rows.length,0);
    });
    await t.test('outbox failure rolls back message and recipient reservation',async()=>{
      await db.query('UPDATE outbound_messages SET created_at=CURRENT_TIMESTAMP(6)-INTERVAL 25 HOUR');
      await db.query("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test outbox failure'");
      await assert.rejects(()=>service.create(actor,'outbox-rollback-1',body));
      assert.equal((await db.query('SELECT * FROM outbound_messages')).rows.length,30);
      assert.equal((await db.query('SELECT * FROM idempotency_keys')).rows.length,0);
      assert.equal((await db.query('SELECT * FROM audit_logs')).rows.length,0);
      await db.query('DROP TRIGGER reject_outbox');
      assert.equal((await service.create(actor,'outbox-rollback-1',body)).status,'QUEUED');
    });
  } finally {await fixture.dispose();}
});
