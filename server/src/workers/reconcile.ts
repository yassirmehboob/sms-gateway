import type { Database } from '../db/database.js';
import { reconcileJobs } from '../services/devices.js';
export function reconcile(db:Database) {
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE');
    await reconcileJobs(tx);
  });
}
export function startReconciler(db:Database) {
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>;
  let running=Promise.resolve();
  const tick=()=>{
    running=reconcile(db).catch(()=>{console.error(JSON.stringify({event:'reconciliation_failed'}));}).finally(()=>{
      if(!stopped) {timer=setTimeout(tick,30_000);timer.unref();}
    });
  };
  tick();
  return async()=>{stopped=true;clearTimeout(timer);await running;};
}
