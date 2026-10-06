import 'dotenv/config';
import { z } from 'zod';
import { mariaDatabase } from './db/database.js';
import { contentCipher } from './security/crypto.js';
import { firebaseTransport } from './workers/fcm-transport.js';
import { fcmOutbox } from './workers/fcm-outbox.js';

if(process.env.FCM_ENABLED!=='true') {
  console.log('FCM worker disabled. Set FCM_ENABLED=true and configure Firebase credentials to enable.');
} else {
  const config=z.object({DATABASE_URL:z.string().min(1),CONTENT_ENCRYPTION_KEY:z.string().regex(/^[a-f0-9]{64}$/i),FIREBASE_PROJECT_ID:z.string().min(1)}).parse(process.env);
  const {db,close}=mariaDatabase(config.DATABASE_URL);
  let transport:ReturnType<typeof firebaseTransport>|undefined;
  try {
    try {
      await db.query('SELECT lease_token FROM outbox_events LIMIT 0');
      await db.query('SELECT control_command FROM outbound_messages LIMIT 0');
      await db.query('SELECT opted_out FROM sms_preferences LIMIT 0');
      await db.query('SELECT event_id FROM sms_control_events LIMIT 0');
    } catch (error) {
      const code = (error as {code?:string})?.code;
      if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
        throw new Error('FCM database schema is outdated. Run npm.cmd run migrate from the server folder, then restart the worker.');
      }
      throw new Error('FCM database check failed. Check MariaDB availability and DATABASE_URL credentials.');
    }
    transport=firebaseTransport(config.FIREBASE_PROJECT_ID);
    const worker=fcmOutbox(db,contentCipher(config.CONTENT_ENCRYPTION_KEY),transport);
    let stopped=false;let wake:(()=>void)|undefined;
    const stop=()=>{stopped=true;wake?.();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    console.log('FCM outbox worker started');
    while(!stopped) {
      try {await worker.dispatchOne();} catch (error) {
        const value=(error as {code?:string})?.code;
        const code=['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ECONNREFUSED','ER_ACCESS_DENIED_ERROR'].includes(value ?? '') ? value : 'UNEXPECTED_ERROR';
        console.error(JSON.stringify({event:'fcm_worker_failed',code}));
      }
      if(!stopped) await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);wake=()=>{clearTimeout(timer);resolve();};});
    }
  } finally {await transport?.close();await close();}
}
