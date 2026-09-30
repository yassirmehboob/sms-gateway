import express,{Router} from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { contentCipher,digest } from '../security/crypto.js';
import { passwordHash,passwordMatches,base32,verifyTotp,csrfToken,safeEqual } from '../security/admin-auth.js';
import { ApiError } from '../services/policy.js';
import { adminCommand } from '../services/admin-commands.js';
import { cmsPublicOrigin } from '../deployment.js';

const cookie='gateway_cms';
const loginSchema=z.object({username:z.string().trim().toLowerCase().min(3).max(80),password:z.string().min(1).max(256),code:z.string().max(6).optional()}).strict();
let dummyHash:Promise<string>|undefined;
export function adminRoutes(db:Database,key:string,options:{basePath?:string;publicOrigin?:string}={}) {
 const router=Router(),cipher=contentCipher(key);
 const publicOrigin=cmsPublicOrigin(options.publicOrigin);
 const cookiePath=`${options.basePath??''}/admin`;
 router.use((req,res,next)=>{
   // Match the actual Host, never a caller-controlled X-Forwarded-Host.
   const localHost=/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.get('host')??'');
   if(publicOrigin) {
     if((req.get('host')??'').toLowerCase()!==new URL(publicOrigin).host)throw new ApiError(403,'CMS_HOST_REJECTED');
     if(!req.secure || (req.header('X-Forwarded-Proto') && req.header('X-Forwarded-Proto')!=='https'))throw new ApiError(403,'CMS_HTTPS_REQUIRED');
   } else if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'') || !localHost || req.header('X-Forwarded-For') || req.header('X-Forwarded-Host') || req.header('X-Forwarded-Proto'))throw new ApiError(403,'CMS_LOCAL_ONLY');
   res.setHeader('Cache-Control','no-store');
   if(req.method!=='GET' && req.method!=='HEAD') {
     if(req.header('X-CMS-Request')!=='1' || !req.is('application/json'))throw new ApiError(403,'CMS_REQUEST_REJECTED');
     const expectedOrigin=publicOrigin??`${req.protocol}://${req.get('host')}`;
     if((publicOrigin || req.header('Origin')) && req.header('Origin')!==expectedOrigin)throw new ApiError(403,'CMS_ORIGIN_REJECTED');
   }
   next();
 });
 router.use(helmet({contentSecurityPolicy:{directives:{'upgrade-insecure-requests':null}}}));
 const publicRoot=fileURLToPath(new URL('../../public/admin/',import.meta.url));
 router.get('/',(req,res)=>{
   if(!(res.locals.externalUrl??req.originalUrl).split('?')[0].endsWith('/'))return res.redirect(308,`${cookiePath}/`);
   res.sendFile(`${publicRoot}index.html`);
 });
 router.use('/assets',express.static(publicRoot,{index:false,dotfiles:'deny'}));
 const loginLimit=rateLimit({windowMs:15*60*1000,limit:15,standardHeaders:true,legacyHeaders:false});
 async function issue(userId:string,verified:boolean) {
   const token=randomBytes(32).toString('base64url');
   await db.query('DELETE FROM cms_sessions WHERE expires_at<CURRENT_TIMESTAMP(6)');
   await db.query('INSERT INTO cms_sessions (token_hash,user_id,mfa_verified,expires_at) VALUES (?,?,?,TIMESTAMPADD(MINUTE,?,CURRENT_TIMESTAMP(6)))',[digest(token),userId,verified,verified?480:15]);
   return token;
 }
 router.post('/api/login',loginLimit,async(req,res)=>{
   const input=loginSchema.parse(req.body);
   const outcome=await db.transaction(async tx=>{
     const user=(await tx.query('SELECT *,locked_until>CURRENT_TIMESTAMP(6) AS locked FROM cms_users WHERE username=? FOR UPDATE',[input.username])).rows[0];
     const valid=await passwordMatches(input.password,user?.password_hash??await(dummyHash??=passwordHash('invalid-login-placeholder')));
     if(!user || !user.enabled || user.locked)return null;
     let step:number|null=null;
     if(valid && user.totp_enabled && user.encrypted_totp_secret)step=verifyTotp(cipher.decrypt(user.encrypted_totp_secret,`totp:${user.id}`),input.code??'',Number(user.last_totp_step));
     if(!valid || (user.totp_enabled && step===null)) {
       await tx.query('UPDATE cms_users SET failed_logins=failed_logins+1,locked_until=IF(failed_logins>=5,CURRENT_TIMESTAMP(6)+INTERVAL 15 MINUTE,locked_until) WHERE id=?',[user.id]);
       return null;
     }
     await tx.query('UPDATE cms_users SET failed_logins=0,locked_until=NULL,last_totp_step=? WHERE id=?',[step??-1,user.id]);
     await tx.query("INSERT INTO audit_logs (actor_id,action,resource_id) VALUES (?,'CMS_LOGIN',?)",[user.id,user.id]);
     return user;
   });
   if(!outcome)throw new ApiError(401,'INVALID_LOGIN');
   const token=await issue(outcome.id,Boolean(outcome.totp_enabled));
   res.cookie(cookie,token,{httpOnly:true,sameSite:'strict',secure:Boolean(publicOrigin)||req.secure,path:cookiePath,maxAge:outcome.totp_enabled?28800000:900000});
   res.json({username:outcome.username,role:outcome.role,mfaRequired:!outcome.totp_enabled,csrf:csrfToken(token,key)});
 });
 router.use('/api',async(req,res,next)=>{
   const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookie}=`))?.slice(cookie.length+1)??'';
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(401,'CMS_LOGIN_REQUIRED');
   const user=(await db.query('SELECT u.id,u.username,u.role,u.totp_enabled,s.mfa_verified,s.token_hash FROM cms_sessions s JOIN cms_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP(6) AND u.enabled=true',[digest(token)])).rows[0];
   if(!user)throw new ApiError(401,'CMS_LOGIN_REQUIRED');
   res.locals.admin=user;res.locals.csrf=csrfToken(token,key);
   if(req.method!=='GET' && !safeEqual(req.header('X-CSRF-Token')??'',res.locals.csrf))throw new ApiError(403,'CSRF_REQUIRED');
   if(!user.mfa_verified && !['/session','/mfa/setup','/mfa/confirm','/logout'].includes(req.path))throw new ApiError(403,'MFA_REQUIRED');
   next();
 });
 router.get('/api/session',(_req,res)=>res.json({username:res.locals.admin.username,role:res.locals.admin.role,mfaRequired:!res.locals.admin.mfa_verified,csrf:res.locals.csrf}));
 router.post('/api/logout',async(_req,res)=>{await db.query('DELETE FROM cms_sessions WHERE token_hash=?',[res.locals.admin.token_hash]);res.clearCookie(cookie,{path:cookiePath,secure:Boolean(publicOrigin),httpOnly:true,sameSite:'strict'});res.json({ok:true});});
 router.post('/api/mfa/setup',loginLimit,async(_req,res)=>{
   const secret=base32(randomBytes(20));const id=res.locals.admin.id;
   await db.transaction(async tx=>{
     const user=(await tx.query('SELECT totp_enabled FROM cms_users WHERE id=? FOR UPDATE',[id])).rows[0];
     if(user?.totp_enabled)throw new ApiError(409,'MFA_ALREADY_ENABLED');
     await tx.query('UPDATE cms_users SET encrypted_totp_secret=? WHERE id=?',[cipher.encrypt(secret,`totp:${id}`),id]);
   });
   res.json({secret,account:`SMS Gateway:${res.locals.admin.username}`,issuer:'SMS Gateway',digits:6,period:30});
 });
 router.post('/api/mfa/confirm',loginLimit,async(req,res)=>{
   const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);const id=res.locals.admin.id;
   await db.transaction(async tx=>{
     const user=(await tx.query('SELECT * FROM cms_users WHERE id=? FOR UPDATE',[id])).rows[0]!;
     if(user.totp_enabled || !user.encrypted_totp_secret)throw new ApiError(409,'MFA_SETUP_REQUIRED');
     const step=verifyTotp(cipher.decrypt(user.encrypted_totp_secret,`totp:${id}`),code,-1);
     if(step===null)throw new ApiError(401,'INVALID_AUTHENTICATOR_CODE');
     await tx.query('UPDATE cms_users SET totp_enabled=true,last_totp_step=? WHERE id=?',[step,id]);
     await tx.query('DELETE FROM cms_sessions WHERE user_id=?',[id]);
     await tx.query("INSERT INTO audit_logs (actor_id,action,resource_id) VALUES (?,'CMS_MFA_ENABLED',?)",[id,id]);
   });
   const token=await issue(id,true);
   res.cookie(cookie,token,{httpOnly:true,sameSite:'strict',secure:Boolean(publicOrigin)||req.secure,path:cookiePath,maxAge:28800000});
   res.json({csrf:csrfToken(token,key),ok:true});
 });
 router.post('/api/password',loginLimit,async(req,res)=>{
   const input=z.object({currentPassword:z.string().min(1).max(256),newPassword:z.string().min(12).max(256)}).strict().parse(req.body);
   const id=res.locals.admin.id;
   await db.transaction(async tx=>{
     const user=(await tx.query('SELECT password_hash FROM cms_users WHERE id=? FOR UPDATE',[id])).rows[0]!;
     if(!await passwordMatches(input.currentPassword,user.password_hash))throw new ApiError(401,'INVALID_LOGIN');
     await tx.query('UPDATE cms_users SET password_hash=? WHERE id=?',[await passwordHash(input.newPassword),id]);
     await tx.query('DELETE FROM cms_sessions WHERE user_id=?',[id]);
     await tx.query("INSERT INTO audit_logs (actor_id,action,resource_id) VALUES (?,'CMS_PASSWORD_CHANGED',?)",[id,id]);
   });
   res.clearCookie(cookie,{path:cookiePath,secure:Boolean(publicOrigin),httpOnly:true,sameSite:'strict'});res.json({ok:true});
 });
 router.get('/api/overview',async(_req,res)=>{
   const [settings,tenants,devices,clients,counts]=await Promise.all([
     db.query('SELECT * FROM gateway_settings WHERE id=1'),db.query('SELECT id,name,enabled FROM tenants ORDER BY name LIMIT 200'),
     db.query('SELECT id,tenant_id,paused,revoked_at,allowed_sim_id,last_seen_at,public_key IS NOT NULL AS enrolled,encrypted_fcm_token IS NOT NULL AS fcm_registered FROM devices ORDER BY id LIMIT 200'),
     db.query('SELECT id,tenant_id,enabled,scopes FROM api_clients ORDER BY id LIMIT 200'),
     db.query("SELECT status,COUNT(*) AS count FROM outbound_messages WHERE created_at>CURRENT_TIMESTAMP(6)-INTERVAL 24 HOUR GROUP BY status")
   ]);
   res.json({settings:settings.rows[0],tenants:tenants.rows,devices:devices.rows,clients:clients.rows,counts:counts.rows.map(row=>({...row,count:Number(row.count)})),configuration:{fcmEnabled:process.env.FCM_ENABLED==='true',firebaseConfigured:Boolean(process.env.FIREBASE_PROJECT_ID),credentialsConfigured:Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),apiHost:process.env.HOST??'127.0.0.1',apiPort:process.env.PORT??'3000'}});
 });
 router.get('/api/recipients',async(req,res)=>{
   const search=z.string().max(30).parse(req.query.search??'');const offset=z.coerce.number().int().min(0).max(1000000).parse(req.query.offset??0);
   const rows=await db.query(`SELECT r.normalized_e164,r.suppressed,r.next_allowed_at,COALESCE(p.opted_out,0) AS opted_out,
     (SELECT COUNT(*) FROM outbound_messages m WHERE m.normalized_e164=r.normalized_e164 AND m.created_at>CURRENT_TIMESTAMP(6)-INTERVAL 24 HOUR) AS daily_usage,
     (SELECT COUNT(*) FROM recipient_tenant_consents c WHERE c.normalized_e164=r.normalized_e164 AND c.revoked_at IS NULL) AS active_consents
     FROM recipients r LEFT JOIN sms_preferences p ON p.normalized_e164=r.normalized_e164 WHERE r.normalized_e164 LIKE ? ORDER BY r.normalized_e164 LIMIT 50 OFFSET ?`,[`%${search.replace(/[%_\\]/g,'')}%`,offset]);
   res.json({recipients:rows.rows.map(row=>({...row,daily_usage:Number(row.daily_usage),active_consents:Number(row.active_consents)})),offset});
 });
 router.get('/api/messages',async(req,res)=>{
   const offset=z.coerce.number().int().min(0).max(1000000).parse(req.query.offset??0);
   res.json({messages:(await db.query('SELECT id,tenant_id,device_id,normalized_e164,status,control_command,created_at,expires_at FROM outbound_messages ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?',[offset])).rows,offset});
 });
 router.get('/api/audit',async(_req,res)=>res.json({audit:(await db.query('SELECT id,actor_id,action,resource_id,reason_reference,recorded_at FROM audit_logs ORDER BY id DESC LIMIT 100')).rows.map(row=>({...row,id:String(row.id)}))}));
 router.post('/api/command',async(req,res)=>{
   if(res.locals.admin.role!=='admin')throw new ApiError(403,'ADMIN_REQUIRED');
   res.json(await adminCommand(db,res.locals.admin.id,res.locals.admin.token_hash,req.body));
 });
 return router;
}
