import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number) { super(code); }
}
const templateSchema = z.object({
  to: z.string().min(5).max(30),
  templateId: z.literal('appointment_reminder_v1'),
  purpose: z.literal('transactional_notification'),
  variables: z.object({ date: z.iso.date() }).strict(),
}).strict();
const customSchema = z.object({
  to: z.string().min(5).max(30),
  body: z.string().min(1).max(4096),
  includeOptOut: z.boolean().optional(),
  evidenceReference: z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:/-]+$/).optional(),
  purpose: z.literal('transactional_notification').default('transactional_notification'),
}).strict();
export const messageSchema = z.union([templateSchema, customSchema]);

// GSM default alphabet excludes ESC itself. Extension characters use two septets.
const gsmBasic = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const gsmExtended = new Set(Array.from('\f^{}\\[~]|€'));
export function validateSmsBody(body: string) {
  if (!body.trim() || /[\ud800-\udfff]/u.test(body) || /[\u0000-\u0009\u000b\u000e-\u001f\u007f]/u.test(body)) {
    throw new ApiError(422, 'INVALID_MESSAGE_BODY');
  }
  let septets = 0;
  let gsm = true;
  for (const char of body) {
    if (gsmBasic.has(char)) septets++;
    else if (gsmExtended.has(char)) septets += 2;
    else gsm = false;
  }
  // UTF-16 units count supplementary characters twice, matching the wire budget.
  if (gsm ? septets > 160 : body.length > 70) throw new ApiError(422, 'MESSAGE_TOO_LONG');
}
export function normalizeNumber(raw: string) {
  const trimmed = raw.trim();
  const input = /^92\d{10}$/.test(trimmed) ? `+${trimmed}` : trimmed;
  const number = parsePhoneNumberFromString(input, { defaultCountry: 'PK', extract: false });
  if (!number?.isValid() || number.country !== 'PK' || number.getType() !== 'MOBILE') {
    throw new ApiError(422, 'RECIPIENT_NOT_ALLOWED');
  }
  return number.number;
}
export function canonicalMessage(input: unknown) {
  const parsed = messageSchema.parse(input);
  if ('body' in parsed) {
    const body = parsed.body + (parsed.includeOptOut ? '\nReply STOP to unsubscribe' : '');
    validateSmsBody(body);
    return { to: normalizeNumber(parsed.to), purpose: parsed.purpose, body, ...(parsed.evidenceReference === undefined ? {} : { evidenceReference: parsed.evidenceReference }) };
  }
  return { ...parsed, to: normalizeNumber(parsed.to), body: `Reminder: your appointment is on ${parsed.variables.date}. Reply STOP to unsubscribe` };
}
