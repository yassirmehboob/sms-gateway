import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import type { Database } from '../db/database.js';
import { cmsPublicOrigin } from '../deployment.js';
import { passwordHash, csrfToken } from '../security/admin-auth.js';

const origin='https://itsc.usindh.edu.pk', host='itsc.usindh.edu.pk';
const key='ab'.repeat(32), base='/sms-gateway/admin';
const unavailable=async():Promise<never>=>{throw new Error('Unexpected database access');};
const db:Database={query:unavailable,transaction:unavailable,withConnection:unavailable};
const options={proxyHops:1,basePath:'/sms-gateway',cmsOrigin:origin};
function headers(r:request.Test) {return r.set('Host',host).set('X-Forwarded-Proto','https').set('X-Forwarded-For','203.0.113.7');}
function write(r:request.Test) {return headers(r).set('Origin',origin).set('X-CMS-Request','1');}

test('remote CMS serves prefixed assets and canonicalizes trailing slash',async()=>{
 const app=createApp(db,key,options);
 const redirect=await headers(request(app).get(base)).expect(308);
 assert.equal(redirect.headers.location,`${base}/`);
 for(const route of [`${base}/`,'/admin/']) {
   const page=await headers(request(app).get(route)).expect(200);
   assert.match(page.text,/src="\.\/assets\/app.js"/);
 }
 const script=await headers(request(app).get(`${base}/assets/app.js`)).expect(200);
 assert.match(script.text,/new URL\(`api\$\{path\}`, window.location.href\)/);
 await headers(request(app).get(`${base}/assets/style.css`)).expect(200);
 await headers(request(app).get(`${base}/api/session`)).expect(401);
});

test('remote CMS fails closed for wrong host, HTTP, untrusted proxy and bad Origin',async()=>{
 const app=createApp(db,key,options);
 await request(app).get(`${base}/`).set('Host',host).expect(403);
 await headers(request(app).get(`${base}/`)).set('Host','evil.example').set('X-Forwarded-Host',host).expect(403);
 await request(createApp(db,key,{...options,proxyHops:0})).get(`${base}/`).set('Host',host).set('X-Forwarded-Proto','https').expect(403);
 for(const badOrigin of ['', 'https://evil.example', 'null']) {
   await headers(request(app).post(`${base}/api/login`)).set('Origin',badOrigin).set('X-CMS-Request','1').send({}).expect(403);
 }
 await write(request(app).post(`${base}/api/login`)).set('X-CMS-Request','0').send({}).expect(403);
 for(const value of ['http://itsc.usindh.edu.pk',`${origin}/sms-gateway`,`${origin}?q=x`,'https://user:pass@itsc.usindh.edu.pk'])assert.throws(()=>cmsPublicOrigin(value));
});

test('remote login issues scoped secure cookies and preserves MFA and CSRF gates',async()=>{
 const hash=await passwordHash('test-password-only-123');
 const sessionToken='a'.repeat(43);
 const fakeDb:Database={
   async query<T>(sql:string) {
     let rows:unknown[]=[];
     if(sql.includes('locked_until>CURRENT_TIMESTAMP'))rows=[{id:'user',username:'admin',role:'admin',enabled:true,locked:false,password_hash:hash,totp_enabled:false}];
     else if(sql.includes('FROM cms_sessions s'))rows=[{id:'user',username:'admin',role:'admin',mfa_verified:false}];
     else if(!/^(UPDATE cms_users|INSERT INTO audit_logs|DELETE FROM cms_sessions|INSERT INTO cms_sessions)/.test(sql))throw new Error(`Unexpected query: ${sql}`);
     return {rows:rows as T[]};
   },transaction:fn=>fn(fakeDb),withConnection:fn=>fn(fakeDb)
 };
 const app=createApp(fakeDb,key,options);
 const login=await write(request(app).post(`${base}/api/login`)).send({username:'admin',password:'test-password-only-123'}).expect(200);
 assert.equal(login.body.mfaRequired,true);
 const cookie=login.headers['set-cookie']!.toString();
 assert.match(cookie,/Path=\/sms-gateway\/admin;/);
 assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/SameSite=Strict/);
 const csrf=csrfToken(sessionToken,key);
 const auth=(r:request.Test)=>write(r).set('Cookie',`gateway_cms=${sessionToken}`);
 const denied=await auth(request(app).post(`${base}/api/command`)).set('X-CSRF-Token',csrf).send({}).expect(403);
 assert.equal(denied.body.code,'MFA_REQUIRED');
 const missing=await auth(request(app).post(`${base}/api/logout`)).send({}).expect(403);
 assert.equal(missing.body.code,'CSRF_REQUIRED');
 const logout=await auth(request(app).post(`${base}/api/logout`)).set('X-CSRF-Token',csrf).send({}).expect(200);
 assert.match(logout.headers['set-cookie']!.toString(),/Path=\/sms-gateway\/admin;/);
});
