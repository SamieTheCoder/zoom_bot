import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { challengeProvider } from '../server/domain.js';
import { createNotifier } from '../server/notify.js';
import { createStore } from '../server/store.js';
import { BrowserWorker } from '../server/browser.js';

test('challenge iframes are recognised, invisible background reCAPTCHA is ignored', () => {
  assert.equal(challengeProvider('https://www.google.com/recaptcha/api2/bframe?hl=en&k=x'), 'recaptcha');
  assert.equal(challengeProvider('https://www.google.com/recaptcha/api2/anchor?k=x&size=normal'), 'recaptcha');
  assert.equal(challengeProvider('https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible'), null);
  assert.equal(challengeProvider('https://newassets.hcaptcha.com/captcha/v1/abc'), 'hcaptcha');
  assert.equal(challengeProvider('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b'), 'turnstile');
  assert.equal(challengeProvider('https://evilhcaptcha.com/'), null);
  assert.equal(challengeProvider('https://zoom.us/wc/join/123456789'), null);
});

test('notifier posts to ntfy without meeting links and rejects plain HTTP', async () => {
  assert.equal(createNotifier({}).enabled, false);
  assert.throws(() => createNotifier({ url: 'http://ntfy.example/topic' }), /HTTPS/);
  const calls = [];
  const notifier = createNotifier({ url: 'https://ntfy.example/topic', token: 't', origin: 'https://desk.example',
    fetchImpl: async (url, options) => { calls.push({ url: String(url), ...options }); return { ok: true }; } });
  await notifier.send({ title: 'Verification needed ✓', message: 'Sunday session: solve it' });
  assert.equal(calls[0].url, 'https://ntfy.example/topic');
  assert.equal(calls[0].headers.Title, 'Verification needed ');
  assert.equal(calls[0].headers.Click, 'https://desk.example');
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
});

test('worker pauses on a challenge, alerts once, and resumes when it is solved', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-challenge-'));
  const store = createStore(directory);
  const sent = [];
  const worker = new BrowserWorker(store, {}, { enabled: true, send: async m => { sent.push(m); return true; } });
  const page = { bringToFront: async () => {} };
  try {
    const meeting = store.add({ title: 'Sunday session', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), autoJoin: true });
    const job = { id: meeting.id, cancelled: false, started: Date.now(), lastReload: Date.now() };
    worker.active = job;
    assert.equal(await worker.handleChallenge(job, meeting, page, 'recaptcha'), true);
    assert.equal(await worker.handleChallenge(job, meeting, page, 'recaptcha'), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(store.meeting(meeting.id).status, 'needs_attention');
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].message.includes('http'));
    assert.equal(worker.status().challenge.provider, 'recaptcha');
    assert.equal(await worker.handleChallenge(job, meeting, page, null), false);
    assert.equal(store.meeting(meeting.id).status, 'joining');
    assert.equal(worker.status().challenge, null);
    const kinds = store.db.prepare('SELECT kind FROM audit_outbox').all().map(e => e.kind);
    assert.ok(kinds.includes('captcha_detected') && kinds.includes('captcha_cleared'));
  } finally { worker.active = null; store.close(); rmSync(directory, { recursive: true, force: true }); }
});
