import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Connection, Database } from '../db/database.js';
import { adminGuard } from './admin-commands.js';
import { ApiError, normalizeNumber } from './policy.js';

export const referenceSchema = z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/);
export const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mobile: z.string().trim().min(5).max(30).transform(normalizeNumber),
  address: z.string().trim().max(500).default(''),
  email: z.union([z.email().max(254), z.literal('')]).default(''),
}).strict();
export type ContactInput = z.input<typeof contactSchema>;
export type AdminIdentity = { id: string; token_hash: string };

export async function contactMutation<T>(db: Database, admin: AdminIdentity, tenantId: string, reference: string, action: string, fn: (tx: Connection) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM gateway_settings WHERE id=1 FOR UPDATE');
    await adminGuard(tx, admin.id, admin.token_hash);
    if (!(await tx.query('SELECT id FROM tenants WHERE id=? AND enabled=true', [tenantId])).rows.length) throw new ApiError(404, 'TENANT_NOT_FOUND');
    const value = await fn(tx);
    await tx.query('INSERT INTO audit_logs (tenant_id,actor_id,action,reason_reference) VALUES (?,?,?,?)', [tenantId, admin.id, action, reference]);
    return value;
  });
}

export async function checkGroup(tx: Connection, tenantId: string, groupId: string) {
  if (!(await tx.query('SELECT id FROM contact_groups WHERE id=? AND tenant_id=?', [groupId, tenantId])).rows.length) throw new ApiError(404, 'GROUP_NOT_FOUND');
}

export async function saveContacts(tx: Connection, tenantId: string, inputs: ContactInput[], groupId?: string, updateExisting = false, evidenceReference?: string) {
  if (groupId) await checkGroup(tx, tenantId, groupId);
  let added = 0, existing = 0;
  for (const input of inputs) {
    const contact = contactSchema.parse(input);
    await tx.query('INSERT INTO recipients (normalized_e164) VALUES (?) ON DUPLICATE KEY UPDATE normalized_e164=VALUES(normalized_e164)', [contact.mobile]);
    if (evidenceReference) await tx.query("INSERT INTO recipient_tenant_consents (tenant_id,normalized_e164,purpose,evidence) VALUES (?,?,'transactional_notification',?) ON DUPLICATE KEY UPDATE normalized_e164=VALUES(normalized_e164)", [tenantId, contact.mobile, evidenceReference]);
    const previous = (await tx.query('SELECT id FROM contacts WHERE tenant_id=? AND normalized_e164=?', [tenantId, contact.mobile])).rows[0];
    const id = previous?.id ?? randomUUID();
    if (previous) {
      existing++;
      if (updateExisting) await tx.query('UPDATE contacts SET name=?,address=?,email=? WHERE id=?', [contact.name, contact.address || null, contact.email || null, id]);
    } else {
      await tx.query('INSERT INTO contacts (id,tenant_id,name,normalized_e164,address,email) VALUES (?,?,?,?,?,?)', [id, tenantId, contact.name, contact.mobile, contact.address || null, contact.email || null]);
      added++;
    }
    if (groupId) await tx.query('INSERT IGNORE INTO contact_group_members (group_id,contact_id,tenant_id) VALUES (?,?,?)', [groupId, id, tenantId]);
  }
  return { added, existing };
}

export async function parseContactWorkbook(buffer: Buffer) {
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new ApiError(400, 'IMPORT_FILE_TOO_LARGE');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  catch { throw new ApiError(400, 'INVALID_EXCEL_FILE'); }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new ApiError(400, 'IMPORT_EMPTY');
  if (sheet.rowCount > 1001 || sheet.columnCount > 20) throw new ApiError(400, 'IMPORT_TOO_MANY_ROWS');
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => {
    const header = cell.text.trim().toLowerCase().replace(/[\s_]+/g, '');
    if (columns.has(header)) throw new ApiError(400, 'IMPORT_DUPLICATE_HEADER');
    columns.set(header, index);
  });
  if (!columns.has('name') || !columns.has('mobileno')) throw new ApiError(400, 'IMPORT_HEADERS_REQUIRED');
  const rows: Array<z.output<typeof contactSchema> & { row: number }> = [];
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    if (!row.hasValues) continue;
    const read = (header: string) => {
      const column = columns.get(header);
      if (!column) return '';
      const cell = row.getCell(column);
      // Formulas are never evaluated or accepted as contact data.
      if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error || cell.type === ExcelJS.ValueType.Date) throw new Error('Use plain text cells, not formulas, dates or Excel errors.');
      if (header === 'mobileno' && typeof cell.value === 'number') {
        if (!Number.isSafeInteger(cell.value)) throw new Error('Mobile_no must contain a complete mobile number.');
        const digits = String(cell.value);
        return /^3\d{9}$/.test(digits) ? `0${digits}` : digits;
      }
      return cell.text.trim();
    };
    try {
      const input = { name: read('name'), mobile: read('mobileno'), address: read('address'), email: read('emailaddress') };
      if (Object.values(input).every(value => !value)) continue;
      const parsed = contactSchema.parse(input);
      if (seen.has(parsed.mobile)) { duplicates++; continue; }
      seen.add(parsed.mobile);
      rows.push({ ...parsed, row: index });
    } catch (error) {
      errors.push({ row: index, message: error instanceof ApiError ? 'Mobile_no must be a valid Pakistan mobile number.' : error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : (error as Error).message });
    }
  }
  return { rows, errors, duplicates };
}

export async function contactTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Contacts');
  sheet.addRow(['Name', 'Mobile_no', 'Address', 'Email address']);
  sheet.addRow(['Example recipient', '03001234567', '', '']);
  sheet.getColumn(2).numFmt = '@';
  for (const column of sheet.columns) column.width = 26;
  return workbook.xlsx.writeBuffer();
}
