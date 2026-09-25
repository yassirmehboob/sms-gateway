import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { mariaDatabase } from './db/database.js';
import { executeOperatorCommand } from './services/operator.js';
import { ApiError } from './services/policy.js';
import { ZodError } from 'zod';

const file = process.argv[2];
if (!file || process.argv.length !== 3 || !process.env.DATABASE_URL) {
  console.error('Usage: npm run operator -- command.json (DATABASE_URL required)');
  process.exitCode = 1;
} else {
  const { db, close } = mariaDatabase(process.env.DATABASE_URL);
  try {
    const input: unknown = JSON.parse(await readFile(file, 'utf8'));
    console.log(JSON.stringify(await executeOperatorCommand(db, input)));
  } catch (error) {
    const code = error instanceof ApiError ? error.code : error instanceof ZodError || error instanceof SyntaxError ? 'INVALID_COMMAND' : 'OPERATOR_FAILED';
    console.error(JSON.stringify({ code }));
    process.exitCode = 1;
  } finally { await close(); }
}
