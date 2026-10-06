import { randomUUID } from 'node:crypto';
import mariadb from 'mariadb';
import { databaseOptions, mariaDatabase } from '../db/database.js';
import { migrate } from '../db/migrations.js';
export async function databaseFixture() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  const name = `gateway_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await mariadb.createConnection(databaseOptions(url.toString()));
  // Match common XAMPP defaults: FK tables must declare their own compatible collation.
  await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  url.pathname = `/${name}`;
  const database = mariaDatabase(url.toString());
  try { await migrate(database.db); }
  catch (error) { await database.close(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); throw error; }
  return { ...database, url: url.toString(), async dispose() {
    await database.close();
    // Generated identifier, never a user-supplied database name.
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
  } };
}
