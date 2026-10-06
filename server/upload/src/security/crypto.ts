import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function contentCipher(hexKey: string) {
  if (!/^[a-f0-9]{64}$/i.test(hexKey)) throw new Error('CONTENT_ENCRYPTION_KEY must be 32 random bytes encoded as hex');
  const key = Buffer.from(hexKey, 'hex');
  return {
    encrypt(body: string, jobId: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(jobId));
      const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.');
    },
    decrypt(value: string, jobId: string) {
      const [iv, tag, body] = value.split('.').map(v => Buffer.from(v, 'base64'));
      if (!iv || !tag || !body) throw new Error('Invalid ciphertext');
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(jobId)); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
    },
  };
}
