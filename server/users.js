import { randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, encoded] = stored.split(':');
  const expected = Buffer.from(encoded, 'hex');
  const actual = await scrypt(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function seedAdmin(store, { adminEmail, adminName, adminPassword }) {
  const existing = store.db.prepare("SELECT id FROM users WHERE role='super_admin'").get();
  if (existing) return existing.id;
  if (!adminEmail || !adminPassword || adminPassword.length < 16) throw new Error('First run requires ADMIN_EMAIL and ADMIN_PASSWORD (16+ characters).');
  const id = randomUUID();
  store.db.prepare('INSERT INTO users(id,email,name,password_hash,role,enabled,session_version) VALUES (?,?,?,?,?,1,1)')
    .run(id, adminEmail.trim().toLowerCase(), adminName || 'Super admin', await hashPassword(adminPassword), 'super_admin');
  store.log('Super admin account created.', null, 'account_created');
  return id;
}
export function publicUser(user) { return { id: user.id, email: user.email, name: user.name, role: user.role }; }
