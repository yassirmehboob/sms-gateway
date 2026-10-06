import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mariaDatabase } from '../db/database.js';
import { messageService } from '../services/messages.js';
import { contentCipher } from '../security/crypto.js';
import { databaseFixture } from './database-fixture.js';

test('MariaDB: two pools and tenants share cooldown; retries reserve exactly once', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const first = await databaseFixture();
  const second = mariaDatabase(first.url);
  try {
    const tenants=[randomUUID(),randomUUID()], devices=[randomUUID(),randomUUID()], clients=[randomUUID(),randomUUID()];
    for (let i=0;i<2;i++) {
      await first.db.query('INSERT INTO tenants VALUES (?,?,true)',[tenants[i],'Race fixture']);
      await first.db.query('INSERT INTO api_clients VALUES (?,?,?,?,true)',[clients[i],tenants[i],randomUUID(),JSON.stringify(['sms:send'])]);
      await first.db.query('INSERT INTO devices (id,tenant_id,paused,allowed_sim_id) VALUES (?,?,false,1)',[devices[i],tenants[i]]);
    }
    await first.db.query('UPDATE gateway_settings SET paused=false');
    await first.db.query("INSERT INTO recipients (normalized_e164) VALUES ('+923001234567')");
    for (const tenant of tenants) await first.db.query("INSERT INTO recipient_tenant_consents VALUES (?,'+923001234567','transactional_notification','synthetic fixture',NULL)",[tenant]);
    const services=[first,second].map(p=>messageService(p.db,contentCipher('ab'.repeat(32))));
    const body={to:'+923001234567',templateId:'appointment_reminder_v1',purpose:'transactional_notification',variables:{date:'2026-09-24'}};
    const actor=(i:number)=>({id:clients[i]!,tenant_id:tenants[i]!,scopes:['sms:send']});
    const results=await Promise.allSettled(Array.from({length:12},(_,i)=>services[i%2]!.create(actor(i%2),randomUUID(),{...body,to:i%2?'03001234567':body.to})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    for (const result of results) if(result.status==='rejected') assert.equal(result.reason.code,'RECIPIENT_COOLDOWN');
    assert.equal((await first.db.query('SELECT * FROM outbound_messages')).rows.length,1);
    assert.equal((await first.db.query('SELECT * FROM outbox_events')).rows.length,1);
    // Distinct, case-sensitive idempotency keys must not collapse in MariaDB collations.
    await first.db.query("UPDATE recipients SET next_allowed_at='1970-01-01'");
    const changed={...body,variables:{date:'2026-09-25'}};
    const same=await Promise.all(Array.from({length:12},(_,i)=>services[i%2]!.create(actor(0),'SameKey-0001',changed)));
    assert.equal(new Set(same.map(r=>r.jobId)).size,1);
    await assert.rejects(()=>services[0]!.create(actor(0),'samekey-0001',changed),{code:'RECIPIENT_COOLDOWN'});
    assert.equal((await first.db.query('SELECT * FROM outbound_messages')).rows.length,2);
    assert.equal((await first.db.query('SELECT * FROM outbox_events')).rows.length,2);
  } finally { await second.close(); await first.dispose(); }
});
