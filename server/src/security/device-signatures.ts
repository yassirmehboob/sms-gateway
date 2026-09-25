import { createPublicKey, createHash, verify } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../services/policy.js';

export function approvedPublicKey(pem: string) {
  try {
    if (!pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch { throw new ApiError(400, 'INVALID_DEVICE_KEY'); }
}
export const proofSchema = z.object({
  deviceId: z.uuid(), timestamp: z.string().regex(/^\d{10}$/), nonce: z.uuid(),
  signature: z.string().min(80).max(120).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type DeviceProof = z.infer<typeof proofSchema> & { method: string; path: string; body: Buffer };
export function signaturePayload(proof: Omit<DeviceProof, 'signature'>) {
  return ['sms-gateway-device-v1',proof.deviceId,proof.timestamp,proof.nonce,proof.method,proof.path,
    createHash('sha256').update(proof.body).digest('hex')].join('\n');
}
export function verifyDeviceProof(proof: DeviceProof, pem: string, databaseSeconds: number) {
  if (Math.abs(databaseSeconds-Number(proof.timestamp))>120) throw new ApiError(401,'DEVICE_CLOCK_SKEW');
  let valid=false;
  try { valid=verify('sha256',Buffer.from(signaturePayload(proof)),{key:pem,dsaEncoding:'der'},Buffer.from(proof.signature,'base64')); } catch { /* fail closed */ }
  if (!valid) throw new ApiError(401,'INVALID_DEVICE_SIGNATURE');
}
