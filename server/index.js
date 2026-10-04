import { resolve } from 'node:path';
import { createStore } from './store.js';
import { BrowserWorker } from './browser.js';
import { createApp } from './app.js';
import { activeStatuses } from './domain.js';
import { createAudit } from './audit.js';
import { seedAdmin } from './users.js';
import { seedSchedule, materializeSchedule } from './schedule.js';

const config = {
  origin: process.env.APP_ORIGIN || 'http://localhost:3000',
  adminEmail: process.env.ADMIN_EMAIL, adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD, secret: process.env.AUTH_SECRET || '',
  dataDir: resolve(process.env.DATA_DIR || './data'), browserExecutable: process.env.BROWSER_EXECUTABLE,
  headless: process.env.BROWSER_HEADLESS === 'true', desktopEnabled: process.env.DESKTOP_ENABLED === 'true',
};
if (config.secret.length < 32) throw new Error('Set AUTH_SECRET (32+ random characters).');
if (new URL(config.origin).origin !== config.origin) throw new Error('APP_ORIGIN must have no path or trailing slash.');
if (!config.origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.origin)) throw new Error('Use HTTPS for a public APP_ORIGIN.');
const store = createStore(config.dataDir);
await seedAdmin(store, config);
seedSchedule(store); materializeSchedule(store);
store.db.prepare("DELETE FROM settings WHERE key IN ('google_tokens','oauth_pending','calendar_last_sync','calendar_error')").run();
for (const meeting of store.list()) {
  if (activeStatuses.includes(meeting.status)) store.update(meeting.id, { status: 'interrupted', detail: 'Service restarted. Retry manually.' });
  if (meeting.source === 'google' && meeting.status === 'scheduled') store.update(meeting.id, { status: 'cancelled', autoJoin: false, detail: 'Calendar integration removed.' });
}
const audit = await createAudit(store, config.dataDir);
const browser = new BrowserWorker(store, config);
const { app, upgrade } = await createApp({ store, browser, audit, config });
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Meeting Desk listening on port ${process.env.PORT || 3000}; schedule timezone: Asia/Kolkata`));
server.on('upgrade', upgrade);
const ticker = setInterval(() => {
  materializeSchedule(store);
  void browser.tick().catch(() => store.log('Scheduler could not start a meeting.', null, 'scheduler_error'));
}, 5000);
const auditTimer = setInterval(() => void audit.flush().catch(() => {}), 5000);
async function shutdown() {
  clearInterval(ticker); clearInterval(auditTimer);
  await browser.close(); await audit.close().catch(() => {});
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
