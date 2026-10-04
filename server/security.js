import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function equalSecret(a, b) {
  return timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
}
export function cryptoBox(secret) {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
    },
    open(value) {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    },
  };
}
export function cookieToken(req) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('meeting_session='))?.slice(16);
}
export function sessionHash(token) { return createHash('sha256').update(token || '').digest('hex'); }
