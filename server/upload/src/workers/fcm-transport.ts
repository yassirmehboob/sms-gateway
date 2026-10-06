import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { randomUUID } from 'node:crypto';

export interface Wakeup { deviceId:string; token:string; ttlMs:number }
export interface WakeupTransport { send(wakeup:Wakeup):Promise<void> }
export function wakeupMessage({deviceId,token,ttlMs}:Wakeup):Message {
  return {token,data:{deviceId,jobAvailable:'true'},android:{priority:'normal',collapseKey:'gateway-work',ttl:Math.max(0,Math.floor(Math.min(ttlMs,60_000)))}};
}
export function firebaseTransport(projectId:string) {
  const app=initializeApp({projectId,credential:applicationDefault()},`gateway-worker-${randomUUID()}`);
  return {
    async send(wakeup:Wakeup) { await getMessaging(app).send(wakeupMessage(wakeup)); },
    close:()=>deleteApp(app),
  };
}

const invalidTokens=new Set(['messaging/registration-token-not-registered','messaging/invalid-registration-token']);
const permanent=new Set(['messaging/invalid-argument','messaging/invalid-payload','messaging/invalid-data-payload-key','messaging/payload-size-limit-exceeded','messaging/mismatched-credential','messaging/authentication-error','messaging/invalid-package-name']);
const transient=new Set(['messaging/server-unavailable','messaging/internal-error','messaging/unknown-error','messaging/quota-exceeded','messaging/message-rate-exceeded','messaging/device-message-rate-exceeded','app/network-error','app/network-timeout']);
export function deliveryFailure(error:unknown,now=Date.now()) {
  const value=error as {code?:unknown;httpResponse?:{headers?:Record<string,string>};retryAfterSeconds?:unknown}|null;
  const code=typeof value?.code==='string'?value.code:'';
  // Only persist known codes, never raw provider errors (which may contain tokens).
  const safeCode=invalidTokens.has(code)||permanent.has(code)||transient.has(code)?code:'FCM_TRANSIENT_ERROR';
  const raw=value?.httpResponse?.headers?.['retry-after'];
  let retryAfter=typeof value?.retryAfterSeconds==='number'?value.retryAfterSeconds:0;
  if(raw) retryAfter=/^\d+$/.test(raw)?Number(raw):Math.ceil((Date.parse(raw)-now)/1000);
  return {code:safeCode,invalidToken:invalidTokens.has(code),permanent:permanent.has(code),retryAfterSeconds:Number.isFinite(retryAfter)?Math.max(0,retryAfter):0};
}
export function retryDelay(failures:number,retryAfterSeconds=0,jitter=Math.random()) {
  const backoff=Math.min(900,60*2**Math.min(Math.max(failures-1,0),4));
  return Math.ceil(Math.max(retryAfterSeconds,backoff*(1+Math.max(0,Math.min(jitter,1))*0.25)));
}
