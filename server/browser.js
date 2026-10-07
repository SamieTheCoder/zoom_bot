import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { challengeProvider, classifyZoomPage, isDue, zoomUrl } from './domain.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BrowserWorker {
  constructor(store, config, notifier = { enabled: false, send: async () => false }) {
    this.store = store;
    this.config = config;
    this.notifier = notifier;
    this.context = null;
    this.launching = null;
    this.active = null;
    this.loginOpen = false;
    this.lastError = null;
    this.shuttingDown = false;
  }
  status() {
    return { running: !!this.context, loginOpen: this.loginOpen, activeMeetingId: this.active?.id || null,
      desktopAvailable: this.config.desktopEnabled, lastError: this.lastError, alertsEnabled: this.notifier.enabled,
      challenge: this.active?.challenge ? { provider: this.active.challenge.provider, since: new Date(this.active.challenge.since).toISOString() } : null };
  }
  /** Finds a human-verification challenge that is actually shown to the user (not hidden background scoring). */
  async findChallenge(page, kind) {
    for (const frame of page.frames()) {
      const provider = challengeProvider(frame.url());
      if (!provider) continue;
      const element = await frame.frameElement().catch(() => null);
      const box = element && await element.isVisible().catch(() => false) ? await element.boundingBox().catch(() => null) : null;
      if (box && box.width > 40 && box.height > 40 && box.y + box.height > 0 && box.x + box.width > 0) return provider;
    }
    return kind === 'challenge' ? 'zoom' : null;
  }
  async alert(job, title, message) {
    if (!this.notifier.enabled) return;
    try { await this.notifier.send({ title, message, tags: ['warning'] }); this.store.log('Alert sent to your phone.', job.id, 'alert_sent'); }
    catch (error) { this.store.log(`Alert could not be sent: ${error.message}`, job.id, 'alert_failed'); }
  }
  /** Pause automation on a challenge, alert once, remind once, and resume when it disappears. Returns true while paused. */
  async handleChallenge(job, meeting, page, provider) {
    const now = Date.now();
    if (provider) {
      if (!job.challenge) {
        job.challenge = { provider, since: now, reminded: false };
        this.transition(job, 'needs_attention', 'Zoom is asking for human verification. Solve it in the live browser; the join continues automatically.');
        this.store.log('Human verification detected. Automation paused on this page.', job.id, 'captcha_detected', { provider });
        await page.bringToFront().catch(() => {});
        void this.alert(job, 'Meeting Desk: verification needed', `${meeting.title}: Zoom wants you to confirm you're human. Open Live browser to solve it.`);
      } else if (!job.challenge.reminded && now - job.challenge.since > 5 * 60000) {
        job.challenge.reminded = true;
        void this.alert(job, 'Meeting Desk: still waiting', `${meeting.title}: verification is still open. The bot is waiting for you.`);
      }
      return true;
    }
    if (job.challenge) {
      const seconds = Math.round((now - job.challenge.since) / 1000);
      this.store.log(`Verification completed after ${seconds}s. Continuing the join.`, job.id, 'captcha_cleared', { provider: job.challenge.provider, seconds });
      job.challenge = null; job.started = now; job.lastReload = now;
      this.transition(job, 'joining', 'Verification completed. Continuing the join.');
    }
    return false;
  }
  async launch() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const executablePath = this.config.browserExecutable || (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium');
      if (!existsSync(executablePath)) throw new Error('Browser is not installed. Set BROWSER_EXECUTABLE or run the Docker image.');
      const context = await chromium.launchPersistentContext(join(this.config.dataDir, 'browser-profile'), {
        executablePath, headless: this.config.headless, viewport: null,
        acceptDownloads: false, locale: 'en-US', timeout: 45000,
        args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-notifications', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
      });
      this.context = context;
      this.lastError = null;
      context.on('close', () => {
        if (this.active) {
          this.active.cancelled = true;
          this.store.update(this.active.id, { status: 'interrupted', detail: 'Browser closed. Retry when ready.' });
          this.store.log('Browser closed during the meeting.', this.active.id);
        }
        this.context = null; this.active = null; this.loginOpen = false;
      });
      return context;
    })();
    try { return await this.launching; }
    catch (error) { this.lastError = error.message; throw error; }
    finally { this.launching = null; }
  }
  async openLogin() {
    if (this.active) throw new Error('Stop the active meeting before opening sign-in.');
    this.loginOpen = true;
    try {
      const context = await this.launch();
      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://zoom.us/signin', { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      this.store.log('Zoom sign-in opened. Complete sign-in in the browser, then resume scheduling.');
    } catch (error) { this.loginOpen = false; throw error; }
  }
  finishLogin() { this.loginOpen = false; this.store.log('Sign-in window released. Scheduling can resume; meeting access is checked on each join.'); }
  transition(job, status, detail) {
    if (job.cancelled || this.active !== job) return;
    const old = this.store.meeting(job.id);
    if (!old || (old.status === status && old.detail === detail)) return;
    const now = new Date().toISOString();
    const values = { status, detail, lastObservedAt: now };
    if (status === 'in_meeting' && !old.joinedAt) values.joinedAt = now;
    if (['completed','failed','missed','interrupted'].includes(status)) {
      values.endedAt = now;
      values.joinedSeconds = old.joinedAt ? Math.max(0, Math.round((Date.now() - Date.parse(old.joinedAt)) / 1000)) : 0;
    }
    this.store.update(job.id, values);
    this.store.log(detail, job.id, `meeting_${status}`, { status, previousStatus: old.status, attempt: old.attempt || 1 });
  }
  async start(id) {
    if (this.active || this.loginOpen) throw new Error('The browser is busy. Finish sign-in or stop the active meeting first.');
    const meeting = this.store.meeting(id);
    if (!meeting || Date.parse(meeting.endsAt) <= Date.now()) throw new Error('This meeting has ended. Schedule a new time to join.');
    const job = { id, cancelled: false, page: null, started: Date.now(), lastReload: Date.now(), joined: false };
    this.active = job;
    this.store.update(id, { attempt: (meeting.attempt || 0) + 1, attemptedAt: new Date().toISOString(), joinedAt: null, endedAt: null, joinedSeconds: 0, pollReminderAt: null });
    this.transition(job, 'joining', 'Opening the meeting in the saved browser profile.');
    void this.run(job, meeting).catch(() => {
      this.transition(job, 'failed', 'Browser could not complete the join. Check the browser and retry.');
    }).finally(async () => {
      if (job.page && !job.page.isClosed()) await job.page.close().catch(() => {});
      if (this.active === job) this.active = null;
    });
  }
  async click(page, role, name) {
    const element = page.getByRole(role, { name, exact: true }).first();
    if (await element.isVisible().catch(() => false) && await element.isEnabled().catch(() => false)) {
      await element.click({ timeout: 2500 }); return true;
    }
    return false;
  }
  async fill(page, selectors, value) {
    if (!value) return;
    for (const selector of selectors) {
      const input = page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) {
        if (!(await input.inputValue().catch(() => ''))) await input.fill(value, { timeout: 2000 });
        return;
      }
    }
  }
  async run(job, meeting) {
    const context = await this.launch();
    if (job.cancelled) return;
    job.page = await context.newPage();
    let page = job.page;
    page.on('popup', async popup => {
      if (job.cancelled) return popup.close().catch(() => {});
      job.page = popup;
      await page.close().catch(() => {});
      page = popup;
    });
    await page.goto(zoomUrl(meeting.url), { waitUntil: 'domcontentloaded', timeout: 45000 });
    while (!job.cancelled && Date.now() < Date.parse(meeting.endsAt)) {
      page = job.page;
      if (page.isClosed()) { this.transition(job, 'interrupted', 'Meeting window was closed.'); return; }
      try {
        const text = (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 40000);
        const kind = classifyZoomPage(text, page.url());
        // Never click, fill, or reload while verification is open; the owner solves it in the live browser.
        if (await this.handleChallenge(job, meeting, page, await this.findChallenge(page, kind))) { await delay(2500); continue; }
        if (kind === 'ended') { this.transition(job, 'completed', 'Zoom reports that the meeting has ended.'); return; }
        if (kind === 'authentication' || kind === 'blocked') {
          this.transition(job, 'needs_attention', kind === 'blocked' ? 'Zoom denied access to this meeting. Check the account or registration in the live browser.' : 'Zoom sign-in is required. Open the live browser to continue.');
        } else if (await page.getByRole('button', { name: /^(?:Leave|Leave Meeting)$/i }).first().isVisible().catch(() => false)) {
          job.joined = true;
          this.transition(job, 'in_meeting', 'Joined — Zoom meeting controls are visible.');
          if (!job.pollReminded && Date.now() >= Date.parse(meeting.startsAt) + 105 * 60000) {
            job.pollReminded = true;
            this.store.update(job.id, { pollReminderAt: new Date().toISOString() });
            this.store.log('Scheduled poll window reached. Poll automation is not configured; check the live browser.', job.id, 'poll_manual_action');
          }
          // Media permissions are never granted. If Zoom has activated a microphone or camera, turn it off.
          await this.click(page, 'button', /^Mute(?: my audio)?(?: \(.*\))?$/i).catch(() => {});
          await this.click(page, 'button', /^Stop Video(?: \(.*\))?$/i).catch(() => {});
        } else if (kind === 'waiting') {
          this.transition(job, 'waiting', 'Waiting for the host to start the meeting or admit you.');
        } else if (!job.joined) {
          const prefs = this.store.settings();
          await this.fill(page, ['input[name="first_name"]', '#first_name', '#inputFirstName', 'input[placeholder="First Name"]'], prefs.firstName);
          await this.fill(page, ['input[name="last_name"]', '#last_name', '#inputLastName', 'input[placeholder="Last Name"]'], prefs.lastName);
          await this.fill(page, ['input[name="email"]', '#email', '#inputEmail', 'input[type="email"]', 'input[placeholder="join@company.com"]'], prefs.email);
          await this.fill(page, ['input[name="email_confirm"]', '#email_confirm', '#inputConfirmEmail', 'input[placeholder="Confirm Email Address"]'], prefs.email);
          await this.fill(page, ['#input-for-name', 'input[name="displayName"]', '#inputname'], meeting.displayName);
          await this.fill(page, ['#input-for-pwd', 'input[name="passcode"]', '#inputpasscode'], meeting.passcode);
          let clicked = false;
          for (const label of [/^Register and Join$/i, /^Join from (?:Your )?Browser$/i, /^Join Meeting$/i, /^Join$/i]) {
            if (await this.click(page, 'button', label) || await this.click(page, 'link', label)) { clicked = true; break; }
          }
          if (!clicked && /\/meeting\/register\//.test(page.url()) && Date.now() - job.lastReload > 30000) {
            // Reload only a pre-registration page without a form. Preserve manual work and entered form data.
            if (await page.locator('input:not([type="hidden"]):not([type="checkbox"])').count() === 0) {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); job.lastReload = Date.now();
            }
          }
          if (!clicked && Date.now() - job.started > 90000) {
            this.transition(job, 'needs_attention', 'Join is not complete. Open the browser for registration, passcode, or browser-join options.');
          }
        }
      } catch { /* The page may be navigating; inspect again on the next pass. */ }
      await delay(2500);
    }
    if (!job.cancelled) this.transition(job, job.joined ? 'completed' : 'missed', job.joined ? 'Scheduled end reached. Left the meeting.' : 'Scheduled end reached without confirming a successful join.');
  }
  async stop(id) {
    if (this.active?.id === id) {
      const job = this.active;
      job.cancelled = true;
      if (job.page) await job.page.close().catch(() => {});
      // Keep the lock until run() has unwound, so a launch cannot race a stop.
    }
    const meeting = this.store.meeting(id);
    this.store.update(id, { status: 'cancelled', detail: 'Stopped by you.', endedAt: new Date().toISOString(),
      joinedSeconds: meeting?.joinedAt ? Math.max(0, Math.round((Date.now()-Date.parse(meeting.joinedAt))/1000)) : 0 });
    this.store.log('Meeting stopped by you.', id, 'meeting_cancelled');
  }
  async tick() {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const meeting of this.store.list()) {
      if (meeting.status === 'scheduled' && Date.parse(meeting.endsAt) <= now) this.store.update(meeting.id, { status: 'missed', detail: 'Scheduled time has passed.' });
    }
    if (this.active || this.loginOpen || this.store.settings().paused) return;
    const due = this.store.list().find(m => isDue(m, now, this.store.settings().joinEarlyMinutes));
    if (due) await this.start(due.id);
  }
  async close() {
    this.shuttingDown = true;
    if (this.active) {
      this.store.update(this.active.id, { status: 'interrupted', detail: 'Service restarted. Retry the meeting manually.' });
      this.active.cancelled = true;
    }
    await this.context?.close();
  }
}
