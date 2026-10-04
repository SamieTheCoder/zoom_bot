import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import httpProxy from 'http-proxy';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { activeStatuses, meetingSchema, settingsSchema, zoomUrl } from './domain.js';
import { createAuth } from './auth.js';
import { hashPassword, verifyPassword, publicUser } from './users.js';
import { updateRule, materializeSchedule } from './schedule.js';

export async function createApp({ store, browser, audit, config }) {
  const app = express();
  const authService = await createAuth(store, config);
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'ws:', 'wss:'], frameSrc: ["'self'"],
    upgradeInsecureRequests: config.origin.startsWith('https:') ? [] : null,
  } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== config.origin)
      return res.status(403).json({ error: 'Request origin is not allowed. Check APP_ORIGIN.' });
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } });
  app.use('/api/auth/callback/credentials', authLimit);
  // Regexp capture supports @auth/express's basePath detection on Express 5.
  app.use(/^\/api\/auth\/(.*)/, (req, res, next) => {
    if (req.get('host') !== new URL(config.origin).host) return res.status(403).json({ error: 'Invalid authentication host.' });
    delete req.headers['x-forwarded-host'];
    req.headers['x-forwarded-proto'] = new URL(config.origin).protocol.slice(0,-1);
    return authService.handler(req, res, next);
  });
  app.get('/api/session', async (req, res) => {
    const user = await authService.user(req); res.json({ authenticated: !!user, user: user ? publicUser(user) : null });
  });
  async function auth(req, res, next) {
    const user = await authService.user(req);
    if (!user) return res.status(401).json({ error: 'Please sign in with your admin account.' });
    req.user = user; next();
  }
  app.use('/api', auth);
  app.post('/api/logout', (req, res) => {
    authService.revoke(req.user.id); res.clearCookie(authService.cookieName, { path: '/', secure: config.origin.startsWith('https:') });
    store.log('Super admin signed out. Sessions revoked.', null, 'sign_out'); res.json({ ok: true });
  });
  app.post('/api/account/password', authLimit, async (req, res) => {
    const values = z.object({ currentPassword: z.string().max(256), password: z.string().min(16).max(256) }).parse(req.body);
    if (!await verifyPassword(values.currentPassword, req.user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
    store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(values.password), req.user.id);
    authService.revoke(req.user.id); store.log('Admin password changed. All sessions revoked.', null, 'password_changed'); res.json({ ok: true });
  });
  app.get('/api/state', (req, res) => {
    materializeSchedule(store);
    const now = new Date();
    res.json({ user: publicUser(req.user), meetings: store.list(), rules: store.get('weekly_rules', []), settings: store.settings(),
      browser: browser.status(), audit: audit.status(), events: store.events(),
      serverTime: now.toISOString(), serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      istTime: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' }).format(now),
      poll: { state: 'awaiting_configuration', opensAfterMinutes: 105, targetAfterMinutes: 110 } });
  });
  app.get('/api/activity', async (_req, res) => {
    try { res.json({ events: await audit.events(200), archive: audit.status() }); }
    catch { res.status(503).json({ error: 'Activity archive is temporarily unavailable. Recent events remain captured locally.' }); }
  });
  app.put('/api/rules/:id', (req, res) => {
    const rule = z.object({ title: z.string().trim().min(1).max(150), enabled: z.boolean(),
      url: z.string().max(3000).transform(v => v ? zoomUrl(v) : '') }).parse(req.body);
    updateRule(store, req.params.id, rule); res.json({ ok: true });
  });
  app.post('/api/meetings', (req, res) => {
    const data = meetingSchema.parse(req.body);
    if (Date.parse(data.endsAt) <= Date.now()) return res.status(400).json({ error: 'Choose a future end time.' });
    const meeting = store.add({ ...data, startsAt: new Date(data.startsAt).toISOString(), endsAt: new Date(data.endsAt).toISOString(), source: 'manual' });
    store.log('One-off meeting added.', meeting.id, 'meeting_created'); res.status(201).json(meeting);
  });
  app.post('/api/meetings/:id/:action', async (req, res) => {
    const meeting = store.meeting(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
    switch (req.params.action) {
      case 'join': await browser.start(meeting.id); break;
      case 'stop': await browser.stop(meeting.id); break;
      case 'toggle':
        if (meeting.status !== 'scheduled') return res.status(409).json({ error: 'Only scheduled meetings can change auto-join.' });
        store.update(meeting.id, { autoJoin: !meeting.autoJoin }); break;
      case 'delete':
        if (activeStatuses.includes(meeting.status) || browser.status().activeMeetingId === meeting.id) return res.status(409).json({ error: 'Stop this meeting before removing it.' });
        if (meeting.source === 'weekly') store.update(meeting.id, { status: 'cancelled', detail: 'This occurrence was skipped by you.' });
        else store.remove(meeting.id);
        break;
      default: return res.status(404).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  });
  app.put('/api/settings', (req, res) => {
    const values = settingsSchema.parse(req.body); store.set('preferences', values);
    for (const meeting of store.list()) if (meeting.source === 'weekly' && meeting.status === 'scheduled') store.update(meeting.id, { displayName: values.displayName });
    store.log(values.paused ? 'Scheduler paused.' : 'Scheduler enabled.', null, 'preferences_updated'); res.json({ ok: true });
  });
  app.post('/api/browser/login', async (_req, res) => { await browser.openLogin(); res.json({ ok: true }); });
  app.post('/api/browser/finish-login', (_req, res) => { browser.finishLogin(); res.json({ ok: true }); });
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:6080', ws: true });
  proxy.on('error', (_err, _req, res) => { if (res?.writeHead && !res.headersSent) res.writeHead(502).end('Remote browser is starting. Try again shortly.'); else res?.destroy?.(); });
  app.use('/desktop', auth, (req, res) => {
    if (!config.desktopEnabled) return res.status(503).send('Use the browser window on this computer. The remote desktop is available in Docker.');
    res.set('Cache-Control', 'no-store'); proxy.web(req, res);
  });
  const dist = resolve('dist'); app.use(express.static(dist));
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
    if (!existsSync(resolve(dist, 'index.html'))) return res.status(503).send('Build the dashboard with npm run build first.');
    res.sendFile(resolve(dist, 'index.html'));
  });
  app.use((error, _req, res, _next) => {
    if (error.name === 'ZodError') return res.status(400).json({ error: error.issues[0].message });
    res.status(400).json({ error: error.type === 'entity.parse.failed' ? 'Invalid JSON.' : error.message || 'Request failed.' });
  });
  async function upgrade(req, socket, head) {
    try {
      if (!config.desktopEnabled || req.headers.origin !== config.origin || req.url.split('?')[0] !== '/desktop/websockify' || !await authService.user(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      req.url = req.url.replace(/^\/desktop/, ''); proxy.ws(req, socket, head);
      const timer = setInterval(() => void authService.user(req).then(user => { if (!user) socket.destroy(); }).catch(() => socket.destroy()), 15000);
      socket.on('close', () => clearInterval(timer));
    } catch { socket.destroy(); }
  }
  return { app, upgrade };
}
