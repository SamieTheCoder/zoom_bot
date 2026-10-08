import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { challengeProvider, classifyZoomPage, isDue, isMeetingPath, isZoomHost, webClientUrl, zoomUrl } from './domain.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Zoom's own "allow microphone/camera?" sheet. Declining media is always safe; it never grants access.
const DECLINE_MEDIA = [/^Continue without (?:microphone and camera|audio or video|audio and video)$/i];
const JOIN_LABELS = [/^Register and Join$/i, /^Join from (?:Your )?Browser$/i, /^Join Meeting$/i, /^Join Webinar$/i, /^Join$/i];
export const POLL_REMINDER_MINUTES = 110;

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
  /** True when a checkbox-style widget inside a challenge frame reports it has been solved. */
  async challengeSolved(frame) {
    return frame.locator('#recaptcha-anchor[aria-checked="true"], #checkbox[aria-checked="true"], #success[style*="display: grid"], #success:visible')
      .first().isVisible({ timeout: 500 }).catch(() => false);
  }
  /** Finds a human-verification challenge that is actually shown and still unsolved (not hidden background scoring). */
  async findChallenge(page, kind) {
    const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
    for (const frame of page.frames()) {
      const provider = challengeProvider(frame.url());
      if (!provider) continue;
      const element = await frame.frameElement().catch(() => null);
      const box = element && await element.isVisible().catch(() => false) ? await element.boundingBox().catch(() => null) : null;
      if (!box || box.width <= 40 || box.height <= 40 || box.y + box.height <= 0 || box.x + box.width <= 0) continue;
      if (viewport && (box.x >= viewport.width || box.y >= viewport.height)) continue;
      // A solved checkbox stays on screen with a tick. It is no longer a challenge.
      if (await this.challengeSolved(frame)) continue;
      return provider;
    }
    return kind === 'challenge' ? 'zoom' : null;
  }
  /** Clear any pending verification/sign-in state, logging how long it took. Used when the user resolves it or the join succeeds. */
  clearPending(job, reason) {
    const now = Date.now();
    if (job.challenge) {
      const seconds = Math.round((now - job.challenge.since) / 1000);
      this.store.log(`Verification completed after ${seconds}s. ${reason}`, job.id, 'captcha_cleared', { provider: job.challenge.provider, seconds });
      job.challenge = null;
    }
    if (job.signInSince) {
      const seconds = Math.round((now - job.signInSince) / 1000);
      this.store.log(`Zoom sign-in completed after ${seconds}s. ${reason}`, job.id, 'signin_completed', { seconds });
      job.signInSince = null;
    }
  }
  async alert(job, title, message, { priority = 'high', tags = ['warning'] } = {}) {
    if (!this.notifier.enabled) return;
    try { await this.notifier.send({ title, message, priority, tags }); this.store.log('Alert sent to your phone.', job.id, 'alert_sent', { title }); }
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
      this.clearPending(job, 'Continuing the join.');
      job.started = now; job.lastReload = now;
      this.transition(job, job.joined ? 'in_meeting' : 'joining', job.joined ? 'Joined — Zoom meeting controls are visible.' : 'Verification completed. Continuing the join.');
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
        args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-notifications', '--deny-permission-prompts',
          '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
      });
      // Send top-level launcher navigations (/j/<id>) straight to the web client, so Zoom never
      // fires zoommtg:// and Chrome never shows its native "Open Zoom Meetings?" prompt.
      await context.route(/^https:\/\/(?:[a-z0-9-]+\.)*zoom\.(?:us|com)\/(?:j|w)\/\d{9,11}/i, async route => {
        const request = route.request();
        let topLevel = false;
        try { topLevel = request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame(); } catch { /* worker request */ }
        const target = topLevel ? webClientUrl(request.url()) : null;
        if (!target) return route.continue();
        this.store.log('Skipped the Zoom app launcher; opening the browser web client.', this.active?.id || null, 'launcher_bypassed');
        return route.fulfill({ status: 302, headers: { location: target, 'cache-control': 'no-store' } });
      });
      context.on('page', page => this.guardPage(page));
      for (const page of context.pages()) this.guardPage(page);
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
  /** JS dialogs block the page until answered. Let navigations proceed; dismiss everything else. */
  guardPage(page) {
    if (page.__meetingDeskGuarded) return;
    page.__meetingDeskGuarded = true;
    page.on('dialog', dialog => (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {}));
  }
  /**
   * Zoom's web client renders inside iframe#webclient on app.zoom.us/wc/<id>/join, so the join form and
   * meeting controls are not in the top document. Inspect the top frame plus every Zoom-hosted frame.
   */
  zoomFrames(page) {
    const main = page.mainFrame();
    return page.frames().filter(frame => !frame.isDetached() && (frame === main || isZoomHost(frame.url())));
  }
  async frameText(page) {
    const parts = await Promise.all(this.zoomFrames(page).map(frame =>
      frame.locator('body').innerText({ timeout: 3000 }).catch(() => '')));
    return parts.join('\n').slice(0, 60000);
  }
  async click(page, role, name) {
    for (const frame of this.zoomFrames(page)) {
      const element = frame.getByRole(role, { name, exact: true }).first();
      if (await element.isVisible().catch(() => false) && await element.isEnabled().catch(() => false)) {
        await element.click({ timeout: 2500 }); return true;
      }
    }
    return false;
  }
  async visible(page, role, name) {
    for (const frame of this.zoomFrames(page)) {
      if (await frame.getByRole(role, { name }).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }
  async fill(page, selectors, value) {
    if (!value) return;
    for (const frame of this.zoomFrames(page)) {
      for (const selector of selectors) {
        const input = frame.locator(selector).first();
        if (await input.isVisible().catch(() => false)) {
          if (!(await input.inputValue().catch(() => ''))) await input.fill(value, { timeout: 2000 });
          return;
        }
      }
    }
  }
  async run(job, meeting) {
    const context = await this.launch();
    if (job.cancelled) return;
    job.page = await context.newPage();
    let page = job.page;
    const adopt = target => {
      target.on('popup', async popup => {
        if (job.cancelled) return popup.close().catch(() => {});
        const previous = job.page;
        job.page = popup; adopt(popup);
        if (previous && previous !== popup) await previous.close().catch(() => {});
      });
    };
    adopt(page);
    const firstUrl = zoomUrl(meeting.url);
    await page.goto(webClientUrl(firstUrl) || firstUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    while (!job.cancelled && Date.now() < Date.parse(meeting.endsAt)) {
      page = job.page;
      if (page.isClosed()) { this.transition(job, 'interrupted', 'Meeting window was closed.'); return; }
      try {
        const url = page.url();
        // Remember the last web-client join URL so we can return to it after Zoom sign-in.
        if (/\/wc\/(?:join\/)?\d{9,11}/.test(url)) job.joinUrl = url;
        // A launcher page that slipped past the route (e.g. opened by script): go to the web client directly.
        const direct = webClientUrl(url);
        if (direct) { await page.goto(direct, { waitUntil: 'domcontentloaded', timeout: 30000 }); await delay(2500); continue; }
        const text = await this.frameText(page);
        const kind = classifyZoomPage(text, url);
        // A visible Leave control is the strongest evidence. Once in the meeting, nothing else may flag attention.
        // Zoom auto-hides its toolbar, so after a confirmed join nudge the mouse to reveal it before deciding.
        let inMeeting = kind !== 'ended' && await this.visible(page, 'button', /^(?:Leave|Leave Meeting)$/i);
        if (!inMeeting && job.joined && kind !== 'ended') {
          await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100).catch(() => {});
          await delay(300);
          inMeeting = await this.visible(page, 'button', /^(?:Leave|Leave Meeting)$/i);
        }
        // Still joined if the toolbar is merely hidden and nothing shows we left (sign-in, removal, waiting room).
        const stillJoined = !inMeeting && job.joined && kind === 'unknown';
        if (inMeeting || stillJoined) {
          this.clearPending(job, 'Joined the meeting.');
          if (stillJoined) { await delay(2500); continue; }
        } else if (await this.handleChallenge(job, meeting, page, await this.findChallenge(page, kind))) {
          // Never click, fill, or reload while verification is open; the owner solves it in the live browser.
          await delay(2500); continue;
        }
        if (!inMeeting && kind !== 'authentication' && job.signInSince) {
          // Sign-in finished. Zoom usually returns to the meeting; if it lands elsewhere, go back ourselves.
          this.clearPending(job, 'Continuing the join.');
          job.started = Date.now();
          this.transition(job, 'joining', 'Signed in to Zoom. Continuing the join.');
          if (isZoomHost(url) && !isMeetingPath(url)) {
            await page.goto(job.joinUrl || webClientUrl(firstUrl) || firstUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2500); continue;
          }
        }
        if (kind === 'ended') { this.transition(job, job.joined ? 'completed' : 'missed', job.joined ? 'Zoom reports that the meeting has ended.' : 'Zoom reports that the meeting has ended before a confirmed join.'); return; }
        if (inMeeting) {
          if (!job.joined) {
            job.joined = true;
            void this.alert(job, 'Meeting Desk: joined', `${meeting.title}: joined. Zoom meeting controls are visible.`, { priority: 'default', tags: ['white_check_mark'] });
          }
          this.transition(job, 'in_meeting', 'Joined — Zoom meeting controls are visible.');
          // Poll automation is not configured yet, so remind the owner at 1h50m to answer it manually.
          if (!job.pollReminded && Date.now() >= Date.parse(meeting.startsAt) + POLL_REMINDER_MINUTES * 60000) {
            job.pollReminded = true;
            this.store.update(job.id, { pollReminderAt: new Date().toISOString() });
            this.store.log('Poll time reached (1h50m). Poll automation is not configured; answer it in the live browser.', job.id, 'poll_manual_action');
            void this.alert(job, 'Meeting Desk: answer the poll', `${meeting.title}: 1h50m mark reached. Open Live browser and answer the poll.`, { priority: 'urgent', tags: ['bar_chart'] });
          }
          // Media permissions are never granted. If Zoom has activated a microphone or camera, turn it off.
          await this.click(page, 'button', /^Mute(?: my audio)?(?: \(.*\))?$/i).catch(() => {});
          await this.click(page, 'button', /^Stop Video(?: \(.*\))?$/i).catch(() => {});
        } else if (kind === 'authentication') {
          if (!job.signInSince) {
            job.signInSince = Date.now();
            this.store.log('Zoom asked for sign-in. Waiting for you in the live browser.', job.id, 'signin_required');
            await page.bringToFront().catch(() => {});
            if (!job.signInAlerted) {
              job.signInAlerted = true;
              void this.alert(job, 'Meeting Desk: Zoom sign-in needed', `${meeting.title}: Zoom wants you to sign in. Open Live browser and sign in; the join continues automatically.`);
            }
          }
          this.transition(job, 'needs_attention', 'Zoom sign-in is required. Sign in in the live browser; the bot returns to the meeting automatically.');
        } else if (kind === 'blocked') {
          this.transition(job, 'needs_attention', 'Zoom denied access to this meeting. Check the account or registration in the live browser.');
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
          for (const label of DECLINE_MEDIA) if (await this.click(page, 'button', label)) { clicked = true; break; }
          for (const label of clicked ? [] : JOIN_LABELS) {
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
