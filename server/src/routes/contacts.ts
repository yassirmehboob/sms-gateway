import { assertTenantActive } from '../services/tenant-services.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { contentCipher } from '../security/crypto.js';
import { ApiError } from '../services/policy.js';
import { assertPermission, hasPermission } from '../security/cms-access.js';
import { checkGroup, contactMutation, contactSchema, contactTemplate, parseContactWorkbook, referenceSchema, saveContacts } from '../services/contacts.js';
import { campaignControl, createCampaign } from '../services/campaigns.js';

export function contactsRoutes(db: Database, key: string) {
  const router = Router(), cipher = contentCipher(key);
  router.use(async(req,res,next)=>{
    const campaign=req.path==='/campaigns'||req.path.startsWith('/campaigns/');
    const contact=['/contacts','/groups','/group-members'].some(prefix=>req.path===prefix||req.path.startsWith(`${prefix}/`));
    if(!campaign&&!contact)return next();
    const section=campaign?'bulk':'contacts', manage=req.method!=='GET';
    const tenantId=z.uuid().optional().parse(manage?req.body?.tenantId:req.query.tenantId);
    // Group names/member counts also serve the bulk composer, without exposing contacts.
    if(req.method==='GET'&&req.path==='/groups'&&!hasPermission(res.locals.access,'contacts'))assertPermission(res.locals.access,'bulk',false,tenantId);
    else assertPermission(res.locals.access,section,manage,tenantId);
    if(tenantId&&(manage||!res.locals.access.allTenants))await assertTenantActive(db,tenantId);
    next();
  });
  const tenantQuery = z.object({ tenantId: z.uuid(), search: z.string().max(200).default(''), groupId: z.uuid().optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0) });
  router.get('/contacts', async (req, res) => {
    const query = tenantQuery.parse(req.query);
    const condition = `c.tenant_id=? AND (c.name LIKE ? OR c.normalized_e164 LIKE ?) ${query.groupId ? 'AND EXISTS (SELECT 1 FROM contact_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=?)' : ''}`;
    const search = `%${query.search.replace(/[%_\\]/g, '')}%`, values = [query.tenantId, search, search, ...(query.groupId ? [query.groupId] : [])];
    const rows = await db.query(`SELECT c.*,EXISTS (SELECT 1 FROM recipient_tenant_consents cs WHERE cs.tenant_id=c.tenant_id AND cs.normalized_e164=c.normalized_e164 AND cs.purpose='transactional_notification' AND cs.revoked_at IS NULL) AS consent, r.suppressed,COALESCE(p.opted_out,0) AS opted_out FROM contacts c JOIN recipients r ON r.normalized_e164=c.normalized_e164 LEFT JOIN sms_preferences p ON p.normalized_e164=c.normalized_e164 WHERE ${condition} ORDER BY c.name,c.id LIMIT 50 OFFSET ?`, [...values, query.offset]);
    const count = (await db.query(`SELECT COUNT(*) AS total FROM contacts c WHERE ${condition}`, values)).rows[0]!;
    res.json({ contacts: rows.rows, total: Number(count.total), offset: query.offset });
  });
  router.get('/groups', async (req, res) => {
    const tenantId = z.uuid().parse(req.query.tenantId);
    res.json({ groups: (await db.query('SELECT g.id,g.name,COUNT(m.contact_id) AS members FROM contact_groups g LEFT JOIN contact_group_members m ON m.group_id=g.id WHERE g.tenant_id=? GROUP BY g.id,g.name ORDER BY g.name', [tenantId])).rows.map(row => ({ ...row, members: Number(row.members) })) });
  });
  router.get('/contacts/template', async (_req, res) => {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', 'attachment; filename="contacts-template.xlsx"').send(Buffer.from(await contactTemplate()));
  });
  router.get('/campaigns', async (req, res) => {
    const tenantId = z.uuid().parse(req.query.tenantId), offset = z.coerce.number().int().min(0).max(1000000).parse(req.query.offset ?? 0);
    const rows = await db.query(`SELECT c.id,c.name,c.status,c.scheduled_at,c.expires_at,c.created_at,COUNT(r.id) AS total,
      SUM(r.status='PENDING') AS pending,SUM(r.status='SKIPPED') AS skipped,
      SUM(r.status='CANCELLED' OR m.status='CANCELLED') AS cancelled,
      SUM(m.status='DELIVERED') AS delivered,SUM(m.status='SENT_TO_CARRIER') AS sent,
      SUM(m.status IN ('QUEUED','CLAIMED','ATTEMPT_RECORDED')) AS queued,
      SUM(m.status IN ('UNKNOWN','FAILED_DEFINITE','EXPIRED')) AS unresolved
      FROM campaigns c JOIN campaign_recipients r ON r.campaign_id=c.id LEFT JOIN outbound_messages m ON m.id=r.job_id
      WHERE c.tenant_id=? GROUP BY c.id,c.name,c.status,c.scheduled_at,c.expires_at,c.created_at ORDER BY c.created_at DESC,c.id DESC LIMIT 50 OFFSET ?`, [tenantId, offset]);
    const numberFields = ['total', 'pending', 'skipped', 'cancelled', 'delivered', 'sent', 'queued', 'unresolved'];
    res.json({ campaigns: rows.rows.map(row => ({ ...row, ...Object.fromEntries(numberFields.map(field => [field, Number(row[field] ?? 0)])) })), offset });
  });
  router.get('/campaigns/:id/recipients', async (req, res) => {
    const id = z.uuid().parse(req.params.id), tenantId = z.uuid().parse(req.query.tenantId), offset = z.coerce.number().int().min(0).max(1000000).parse(req.query.offset ?? 0);
    const rows = await db.query('SELECT r.name,r.normalized_e164,COALESCE(m.status,r.status) AS status,r.last_error,r.next_attempt_at,r.job_id FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id LEFT JOIN outbound_messages m ON m.id=r.job_id WHERE c.id=? AND c.tenant_id=? ORDER BY r.name,r.id LIMIT 50 OFFSET ?', [id, tenantId, offset]);
    res.json({ recipients: rows.rows, offset });
  });
  router.post('/contacts', async (req, res) => {
    const data = z.object({ tenantId: z.uuid(), contact: contactSchema, groupId: z.uuid().optional(), evidenceReference: referenceSchema.optional(), reasonReference: referenceSchema }).strict().parse(req.body);
    res.json(await contactMutation(db, res.locals.admin, data.tenantId, data.evidenceReference ?? data.reasonReference, data.evidenceReference?'CONTACT_SAVED_WITH_CONSENT':'CONTACT_SAVED', tx => saveContacts(tx, data.tenantId, [data.contact], data.groupId, true, data.evidenceReference)));
  });
  router.post('/contacts/import/preview', async (req, res) => {
    const data = z.object({ tenantId: z.uuid(), base64: z.string().min(4).max(2800000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().parse(req.body);
    const preview = await parseContactWorkbook(Buffer.from(data.base64, 'base64'));
    const numbers = preview.rows.map(row => row.mobile);
    const existing = numbers.length ? (await db.query(`SELECT normalized_e164 FROM contacts WHERE tenant_id=? AND normalized_e164 IN (${numbers.map(() => '?').join(',')})`, [data.tenantId, ...numbers])).rows : [];
    res.json({ ...preview, existing: existing.length });
  });
  router.post('/contacts/import', async (req, res) => {
    const data = z.object({ tenantId: z.uuid(), contacts: z.array(contactSchema).min(1).max(1000), groupId: z.uuid().optional(), evidenceReference: referenceSchema.optional(), reasonReference: referenceSchema }).strict().parse(req.body);
    res.json(await contactMutation(db, res.locals.admin, data.tenantId, data.evidenceReference ?? data.reasonReference, data.evidenceReference ? 'CONTACTS_IMPORTED_WITH_CONSENT' : 'CONTACTS_IMPORTED', tx => saveContacts(tx, data.tenantId, data.contacts, data.groupId, false, data.evidenceReference)));
  });
  router.post('/groups', async (req, res) => {
    const data = z.object({ tenantId: z.uuid(), name: z.string().trim().min(1).max(200), reasonReference: referenceSchema }).strict().parse(req.body);
    res.json(await contactMutation(db, res.locals.admin, data.tenantId, data.reasonReference, 'GROUP_CREATED', async tx => {
      if ((await tx.query('SELECT id FROM contact_groups WHERE tenant_id=? AND name=?', [data.tenantId, data.name])).rows.length) throw new ApiError(409, 'GROUP_EXISTS');
      const id = randomUUID();
      await tx.query('INSERT INTO contact_groups (id,tenant_id,name) VALUES (?,?,?)', [id, data.tenantId, data.name]);
      return { id };
    }));
  });
  router.post('/group-members', async (req, res) => {
    const data = z.object({ tenantId: z.uuid(), groupId: z.uuid(), contactIds: z.array(z.uuid()).min(1).max(1000), remove: z.boolean().default(false), reasonReference: referenceSchema }).strict().parse(req.body);
    res.json(await contactMutation(db, res.locals.admin, data.tenantId, data.reasonReference, data.remove ? 'GROUP_MEMBERS_REMOVED' : 'GROUP_MEMBERS_ADDED', async tx => {
      await checkGroup(tx, data.tenantId, data.groupId);
      const ids = [...new Set(data.contactIds)];
      const found = await tx.query(`SELECT id FROM contacts WHERE tenant_id=? AND id IN (${ids.map(() => '?').join(',')})`, [data.tenantId, ...ids]);
      if (found.rows.length !== ids.length) throw new ApiError(404, 'CONTACT_NOT_FOUND');
      for (const id of ids) {
        if (data.remove) await tx.query('DELETE FROM contact_group_members WHERE group_id=? AND contact_id=?', [data.groupId, id]);
        else await tx.query('INSERT IGNORE INTO contact_group_members (group_id,contact_id,tenant_id) VALUES (?,?,?)', [data.groupId, id, data.tenantId]);
      }
      return { ok: true, count: ids.length };
    }));
  });
  router.post('/campaigns', async (req, res) => res.status(201).json(await createCampaign(db, cipher, res.locals.admin, req.body)));
  router.post('/campaigns/control', async (req, res) => res.json(await campaignControl(db, res.locals.admin, req.body)));
  return router;
}
