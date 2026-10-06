import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from './database-fixture.js';
import { databaseOptions } from '../db/database.js';
import { migrate } from '../db/migrations.js';
import { executeOperatorCommand, operatorRequest } from '../services/operator.js';
import { messageService } from '../services/messages.js';
import { contentCipher } from '../security/crypto.js';
test('MariaDB configuration requires explicit driver and retains UTC', () => {
  assert.throws(()=>databaseOptions('postgres://a:b@localhost/db'));
  assert.throws(()=>databaseOptions('mariadb://a:b@localhost/db?ssl=false'));
  const options=databaseOptions('mariadb://a:p%40ss@localhost:3307/db?ssl=true');
  assert.equal(options.password,'p@ss'); assert.equal(options.timezone,'+00:00'); assert.equal(options.ssl,true);
});
test('operator commands require attribution and reject unrecognized switches', () => {
  assert.equal(operatorRequest.safeParse({command:{action:'global-pause',paused:false}}).success,false);
  assert.equal(operatorRequest.safeParse({actorId:randomUUID(),reasonReference:'TICKET-1',command:{action:'global-pause',paused:false,force:true}}).success,false);
});
test('MariaDB operator changes are audited, atomic and preserve send protections', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const fixture=await databaseFixture(); const {db}=fixture;
  const tenantId=randomUUID(), deviceId=randomUUID(), clientId=randomUUID(), actorId=randomUUID();
  const number='+923001234567', purpose='transactional_notification';
  const run=(command:unknown)=>executeOperatorCommand(db,{actorId,reasonReference:'TICKET-123',command});
  try {
    await db.query('INSERT INTO tenants VALUES (?,?,true)',[tenantId,'Operator test']);
    await db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[clientId,tenantId,randomUUID(),JSON.stringify(['sms:send'])]);
    await t.test('migrations can rerun without resetting pause or data',async()=>{
      await run({action:'global-pause',paused:false});
      await migrate(db);
      assert.equal(Number((await db.query('SELECT paused FROM gateway_settings')).rows[0]!.paused),0);
      assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length,7);
    });
    await run({action:'device-create',tenantId,deviceId,simId:1});
    assert.equal(Number((await db.query('SELECT paused FROM devices')).rows[0]!.paused),1);
    await run({action:'device-pause',tenantId,deviceId,paused:false});
    await run({action:'consent-grant',tenantId,number,purpose,evidenceReference:'CONSENT-1'});
    const service=messageService(db,contentCipher('ab'.repeat(32)));
    const actor={id:clientId,tenant_id:tenantId,scopes:['sms:send']};
    const body={to:number,purpose,templateId:'appointment_reminder_v1',variables:{date:'2026-09-24'}};
    await service.create(actor,'operator-send-1',body);
    await t.test('pause cancels pending work but retains reservations',async()=>{
      await run({action:'global-pause',paused:true});
      assert.equal((await db.query('SELECT status FROM outbound_messages')).rows[0]!.status,'CANCELLED');
      await assert.rejects(()=>service.create(actor,'operator-send-2',body),{code:'GATEWAY_PAUSED'});
      await run({action:'global-pause',paused:false});
      await assert.rejects(()=>service.create(actor,'operator-send-2',body),{code:'RECIPIENT_COOLDOWN'});
    });
    await t.test('revocation cannot be undone by resume',async()=>{
      await run({action:'device-revoke',tenantId,deviceId});
      await assert.rejects(()=>run({action:'device-pause',tenantId,deviceId,paused:false}),{code:'DEVICE_REVOKED'});
      await assert.rejects(()=>service.create(actor,'operator-send-3',body),{code:'NO_AVAILABLE_GATEWAY'});
    });
    await t.test('renewed consent does not clear suppression',async()=>{
      await db.query('UPDATE recipients SET suppressed=true');
      await run({action:'consent-revoke',tenantId,number,purpose});
      await run({action:'consent-grant',tenantId,number,purpose,evidenceReference:'CONSENT-2'});
      assert.equal(Number((await db.query('SELECT suppressed FROM recipients')).rows[0]!.suppressed),1);
    });
    await t.test('cross-tenant mutation and audit failure roll back',async()=>{
      const other=randomUUID(); await db.query('INSERT INTO tenants VALUES (?,?,true)',[other,'Other']);
      await assert.rejects(()=>run({action:'device-revoke',tenantId:other,deviceId}),{code:'DEVICE_NOT_FOUND'});
      // A failing audit insert must prevent the corresponding policy change.
      await db.query("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test audit failure'");
      await assert.rejects(()=>run({action:'global-pause',paused:true}));
      assert.equal(Number((await db.query('SELECT paused FROM gateway_settings')).rows[0]!.paused),0);
      await db.query('DROP TRIGGER reject_audit');
    });
    await run({action:'client-revoke',tenantId,clientId});
    await assert.rejects(()=>service.create(actor,'operator-send-4',body),{code:'UNAUTHORIZED'});
    const audits=(await db.query('SELECT * FROM audit_logs WHERE reason_reference IS NOT NULL')).rows;
    assert.ok(audits.length>=10); assert.ok(audits.every(row=>row.actor_id===actorId && row.reason_reference==='TICKET-123'));
    assert.ok(!JSON.stringify(audits,(_k,v)=>typeof v==='bigint'?v.toString():v).includes(number));
  } finally { await fixture.dispose(); }
});
