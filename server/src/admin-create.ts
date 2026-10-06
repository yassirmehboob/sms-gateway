import 'dotenv/config';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { mariaDatabase } from './db/database.js';
import { passwordHash } from './security/admin-auth.js';

const username=z.string().regex(/^[a-z0-9_.-]{3,80}$/).parse(process.argv[2]??'admin');
const role=z.enum(['admin','viewer']).parse(process.argv[3]??'admin');
const {db,close}=mariaDatabase(z.string().min(1).parse(process.env.DATABASE_URL));
const path=resolve('../.local',`cms-${username}-login.txt`);
try {
 await db.transaction(async tx=>{
   await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE');
   if((await tx.query('SELECT id FROM cms_users WHERE username=?',[username])).rows.length)throw new Error('CMS username already exists. Existing credentials were not changed.');
   const password=randomBytes(24).toString('base64url'),id=randomUUID();
   const permissions=Object.fromEntries(['dashboard','settings','recipients','contacts','bulk','devices','clients','messages','audit'].map(section=>[section,'view']));
   await tx.query('INSERT INTO cms_users (id,username,password_hash,role,super_admin,all_tenants,permissions_json) VALUES (?,?,?,?,?,true,?)',[id,username,await passwordHash(password),role,role==='admin',JSON.stringify(permissions)]);
   await tx.query("INSERT INTO audit_logs (actor_id,action,resource_id,reason_reference) VALUES (?,'CMS_USER_CREATED',?,'LOCAL-BOOTSTRAP')",[id,id]);
   await mkdir(resolve('../.local'),{recursive:true});
   await writeFile(path,`CMS: http://127.0.0.1:${process.env.CMS_PORT??3001}/admin/\nUsername: ${username}\nPassword: ${password}\n\nSign in on this PC, enroll an authenticator, then change your password under Account. Delete this file after storing your credentials securely.\n`,{flag:'wx',mode:0o600});
 });
 console.log(`CMS account created. Login details saved to ${path}`);
} finally {await close();}
