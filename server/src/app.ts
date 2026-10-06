import { assertTenantActive } from './services/tenant-services.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import type { Database } from './db/database.js';
import { contentCipher, digest } from './security/crypto.js';
import { ApiError, normalizeNumber } from './services/policy.js';
import { messageService, type Actor } from './services/messages.js';
import { deviceRoutes } from './routes/devices.js';
import { adminRoutes } from './routes/admin.js';
import { applicationBasePath, applicationUrls } from './deployment.js';
export function createApp(db: Database, encryptionKey: string, options: { proxyHops?: number; basePath?: string; cmsOrigin?: string } = {}) {
  const app = express();
  const basePath = applicationBasePath(options.basePath);
  app.use((req, res, next) => {
    const urls = applicationUrls(req.url, basePath);
    req.url = urls.internal;
    res.locals.externalUrl = urls.external;
    next();
  });
  const proxyHops = z.number().int().min(0).max(10).parse(options.proxyHops ?? 0);
  app.set('trust proxy', proxyHops === 0 ? false : proxyHops);
  const messages = messageService(db, contentCipher(encryptionKey));
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));
  const normalJson=express.json({ limit: '8kb', inflate:false, verify:(_req,res,body)=>{ (res as express.Response).locals.rawBody=Buffer.from(body); } });
  const importJson=express.json({limit:'3mb',inflate:false});
  app.use((req,res,next)=>req.path.startsWith('/admin/api/') ? importJson(req,res,next) : normalJson(req,res,next));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/admin',adminRoutes(db,encryptionKey,{basePath,publicOrigin:options.cmsOrigin}));
  app.use('/v1/device',deviceRoutes(db,encryptionKey));
  app.use('/v1', async (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization ?? '');
    if (!match) throw new ApiError(401, 'UNAUTHORIZED');
    const result = await db.query<Actor>('SELECT c.id,c.tenant_id,c.scopes FROM api_clients c JOIN tenants t ON t.id=c.tenant_id WHERE c.key_hash=? AND c.enabled=true AND t.enabled=true', [digest(match[1]!)]);
    if (!result.rows[0]) throw new ApiError(401, 'UNAUTHORIZED');
    const identity = result.rows[0];
    await assertTenantActive(db,identity.tenant_id);
    const scopes = z.array(z.string()).parse(typeof identity.scopes === 'string' ? JSON.parse(identity.scopes) : identity.scopes);
    res.locals.actor = { ...identity, scopes }; next();
  });
  app.use('/v1', rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (_req, res) => res.locals.actor.id, standardHeaders: 'draft-8', legacyHeaders: false }));
  function actor(res: express.Response, scope: string): Actor {
    const identity = res.locals.actor as Actor;
    if (!identity.scopes.includes(scope)) throw new ApiError(403, 'INSUFFICIENT_SCOPE');
    return identity;
  }
  app.post('/v1/messages', async (req, res) => {
    const identity = actor(res, 'sms:send');
    const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional().parse(req.header('Idempotency-Key')) ?? randomUUID();
    const result = await messages.create(identity, key, req.body);
    result.statusUrl = basePath + result.statusUrl;
    res.status(202).set('Idempotency-Key', key).location(result.statusUrl).json(result);
  });
  app.get('/v1/messages/:id', async (req, res) => {
    const identity = actor(res, 'sms:read');
    const id = z.uuid().parse(req.params.id);
    const result = await db.query('SELECT id,status,created_at,expires_at FROM outbound_messages WHERE id=? AND tenant_id=?', [id, identity.tenant_id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND');
    res.json(result.rows[0]);
  });
  app.get('/v1/messages', async (req, res) => {
    const identity = actor(res, 'sms:read');
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0), status: z.enum(['QUEUED','CLAIMED','ATTEMPT_RECORDED','SENT_TO_CARRIER','DELIVERED','EXPIRED','CANCELLED','FAILED_DEFINITE','UNKNOWN']).optional() }).strict().parse(req.query);
    const result = await db.query('SELECT id,status,created_at,expires_at FROM outbound_messages WHERE tenant_id=? AND (? IS NULL OR status=?) ORDER BY created_at DESC,id LIMIT ? OFFSET ?', [identity.tenant_id, query.status ?? null, query.status ?? null, query.limit, query.offset]);
    res.json({ messages: result.rows, offset: query.offset, limit: query.limit });
  });
  app.post('/v1/recipients/:number/suppress', async (req, res) => {
    const identity = actor(res, 'sms:compliance:write');
    const number = normalizeNumber(z.string().parse(req.params.number));
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM gateway_settings WHERE id=true FOR UPDATE');
      await assertTenantActive(tx,identity.tenant_id);
      const current = (await tx.query('SELECT c.scopes FROM api_clients c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=? AND c.tenant_id=? AND c.enabled=true AND t.enabled=true', [identity.id,identity.tenant_id])).rows[0];
      if (!current) throw new ApiError(401, 'UNAUTHORIZED');
      const scopes = typeof current.scopes === 'string' ? JSON.parse(current.scopes) : current.scopes;
      if (!Array.isArray(scopes) || !scopes.includes('sms:compliance:write')) throw new ApiError(403, 'INSUFFICIENT_SCOPE');
      const consent = await tx.query('SELECT 1 FROM recipient_tenant_consents WHERE tenant_id=? AND normalized_e164=?', [identity.tenant_id,number]);
      if (!consent.rows.length) throw new ApiError(404, 'NOT_FOUND');
      await tx.query('UPDATE recipients SET suppressed=true WHERE normalized_e164=?', [number]);
      await tx.query("UPDATE outbound_messages SET status='CANCELLED' WHERE normalized_e164=? AND status IN ('QUEUED','CLAIMED') AND send_attempt_started_at IS NULL", [number]);
      await tx.query("INSERT INTO audit_logs (tenant_id,actor_id,action) VALUES (?,?,'RECIPIENT_SUPPRESSED')", [identity.tenant_id,identity.id]);
    });
    res.status(204).end();
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      res.status(error.status).json({ code: error.code, ...(error.retryAfter ? { nextAllowedAt: new Date(Date.now()+error.retryAfter*1000).toISOString() } : {}) });
    } else if (error instanceof ZodError || (error instanceof SyntaxError && 'body' in error)) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE' });
    } else {
      console.error(JSON.stringify({ event: 'request_failed' }));
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  });
  return app;
}
