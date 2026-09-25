import 'dotenv/config';
import { mariaDatabase } from './database.js';
import { migrate } from './migrations.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, close } = mariaDatabase(process.env.DATABASE_URL);
try { await migrate(db); console.log('MariaDB migrations applied'); }
finally { await close(); }
