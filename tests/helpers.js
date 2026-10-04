import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createAudit } from '../server/audit.js';
import { seedAdmin } from '../server/users.js';
import { seedSchedule, weeklySlots } from '../server/schedule.js';
import { createApp } from '../server/app.js';
import { BrowserWorker } from '../server/browser.js';
export async function fixture({ rules = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-desk-'));
  const store = createStore(directory);
  const config = { origin: 'http://127.0.0.1:3000', adminEmail: 'admin@example.com', adminName: 'Demo Admin', adminPassword: randomBytes(24).toString('hex'), secret: randomBytes(32).toString('hex'), desktopEnabled: false };
  await seedAdmin(store, config);
  const env = { REGISTRATION_FIRST_NAME: 'Demo', REGISTRATION_LAST_NAME: 'Admin', REGISTRATION_EMAIL: 'admin@example.com' };
  if (rules) for (const [id] of weeklySlots) env[`MEETING_URL_${id.replaceAll('-','_').toUpperCase()}`] = 'https://zoom.us/meeting/register/example';
  seedSchedule(store, env);
  const audit = await createAudit(store, directory), worker = new BrowserWorker(store, config);
  const { app } = await createApp({ store, browser: worker, audit, config });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`; config.origin = base;
  return { store, audit, worker, config, base, async close() {
    await worker.close(); await new Promise(r => server.close(r)); await audit.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  } };
}
export function client(base) {
  const cookies = new Map();
  return { cookies, async request(path, body, method = 'POST', origin = base) {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : method,
        headers: { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), Origin: origin, 'Content-Type': 'application/json', 'X-Auth-Return-Redirect': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const index = pair.indexOf('='); cookies.set(pair.slice(0,index), pair.slice(index+1)); }
      return response;
    }, async login(email, password) {
      const csrf = await (await this.request('/api/auth/csrf')).json();
      return this.request('/api/auth/callback/credentials', { email, password, csrfToken: csrf.csrfToken, callbackUrl: base });
    } };
}
