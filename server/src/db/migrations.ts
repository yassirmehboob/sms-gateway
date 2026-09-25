import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Database } from './database.js';
export async function migrate(db: Database) {
  // DDL commits implicitly: use a session lock and resumable statements.
  await db.withConnection(async connection => {
    const { rows } = await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':gateway_migrations'), 10) AS acquired");
    if (Number(rows[0]?.acquired) !== 1) throw new Error('Migration lock unavailable');
    try {
      await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, checksum CHAR(64) NOT NULL) ENGINE=InnoDB');
      for (const name of ['001_foundation', '002_operator_audit', '003_device_protocol', '004_fcm_outbox', '005_sms_controls', '006_admin_cms']) {
        const sql = await readFile(new URL(`../../src/db/migrations/${name}.sql`, import.meta.url), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = (await connection.query('SELECT checksum FROM schema_migrations WHERE version=?', [name])).rows[0];
        if (applied) {
          if (applied.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
          continue;
        }
        // Checked-in migrations have no procedures or semicolons in literals.
        for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await connection.query(statement);
        await connection.query('INSERT INTO schema_migrations (version,checksum) VALUES (?,?)', [name, checksum]);
      }
    } finally { await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':gateway_migrations'))"); }
  });
}
