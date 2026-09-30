import 'dotenv/config';
import { isIPv4 } from 'node:net';
import type { Server } from 'node:http';
import { z } from 'zod';
import { createApp } from './app.js';
import { mariaDatabase } from './db/database.js';
import { startReconciler } from './workers/reconcile.js';
import { deploymentConfig, needsCmsListener } from './deployment.js';
const deployment = deploymentConfig(process.env, 'PhusionPassenger' in globalThis);
const config = z.object({ DATABASE_URL: z.string().min(1), CONTENT_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i), PORT: z.coerce.number().int().min(1).max(65535).default(3000) }).parse(process.env);
const { db, close } = mariaDatabase(config.DATABASE_URL);
await db.query('SELECT id FROM gateway_settings');
const stopReconciler=startReconciler(db);
const host = z.string().refine(isIPv4, 'HOST must be an IPv4 address').parse(process.env.HOST ?? '127.0.0.1');
const app = createApp(db, config.CONTENT_ENCRYPTION_KEY, { proxyHops: deployment.proxyHops, basePath: deployment.basePath, cmsOrigin: deployment.cmsOrigin });
function listen(port:number,address:string):Promise<Server> {
  return new Promise((resolve,reject)=>{
    const listener=app.listen(port,address,(error?:Error)=>error?reject(error):resolve(listener));
  });
}
const server = await listen(config.PORT,host);
console.log(`Gateway API listening on ${host}:${config.PORT}`);
const cmsPort=z.coerce.number().int().min(1).max(65535).parse(process.env.CMS_PORT??3001);
let cmsServer:Server|null=null;
if(needsCmsListener(deployment.passenger, host, config.PORT, cmsPort)) {
  try { cmsServer=await listen(cmsPort,'127.0.0.1');console.log(`Gateway CMS: http://127.0.0.1:${cmsPort}/admin/`); }
  catch {console.error('CMS listener could not start. Check CMS_PORT for a port conflict.');}
}
server.requestTimeout = 15000;
server.headersTimeout = 10000;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { cmsServer?.close(); server.close(() => { void stopReconciler().then(close); }); });
