import { Router } from 'express';
import type { Database } from '../db/database.js';
import { ApiError } from '../services/policy.js';
import { accessForUser, cmsSections } from '../security/cms-access.js';
import { manageCmsUser } from '../services/cms-users.js';

export function cmsUserRoutes(db: Database) {
  const router = Router();
  router.use((_req, res, next) => {
    if (!res.locals.access.superAdmin) throw new ApiError(403, 'SUPER_ADMIN_REQUIRED');
    next();
  });
  router.get('/', async (_req, res) => {
    const rows = (await db.query('SELECT id,username,role,super_admin,all_tenants,permissions_json,enabled,totp_enabled,created_at FROM cms_users ORDER BY username')).rows;
    const users = await Promise.all(rows.map(async user => ({ id: user.id, username: user.username, role: user.role, enabled: Boolean(user.enabled), mfaEnabled: Boolean(user.totp_enabled), createdAt: user.created_at, access: await accessForUser(db, user) })));
    res.json({ users, sections: cmsSections, tenants: (await db.query('SELECT id,name,enabled FROM tenants ORDER BY name')).rows });
  });
  router.post('/', async (req, res) => res.json(await manageCmsUser(db, res.locals.admin.id, res.locals.admin.token_hash, req.body)));
  return router;
}
