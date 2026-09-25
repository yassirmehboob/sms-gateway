import 'dotenv/config';
import { mariaDatabase } from './database.js';
import { digest } from '../security/crypto.js';
if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.DEV_API_KEY ?? '')) throw new Error('Set DATABASE_URL and a random DEV_API_KEY (32-256 URL-safe characters)');
const { db, close } = mariaDatabase(process.env.DATABASE_URL);
try {
  await db.transaction(async tx => {
    await tx.query('SELECT id FROM gateway_settings WHERE id=true FOR UPDATE');
    await tx.query("INSERT INTO tenants VALUES ('00000000-0000-4000-8000-000000000001','Development',true) ON DUPLICATE KEY UPDATE id=id");
    await tx.query("INSERT INTO api_clients VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',?,JSON_ARRAY('sms:send','sms:read','sms:compliance:write'),true) ON DUPLICATE KEY UPDATE key_hash=VALUES(key_hash)", [digest(process.env.DEV_API_KEY!)]);
  });
  console.log('Development client provisioned. Existing pause, recipient and device state preserved.');
} finally { await close(); }
