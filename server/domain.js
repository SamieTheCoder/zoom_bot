import { z } from 'zod';

export function zoomUrl(input) {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(host === 'zoom.us' || host.endsWith('.zoom.us') || host === 'zoom.com' || host.endsWith('.zoom.com')) ||
      !/^\/(?:j\/\d{9,11}|wc\/(?:join\/)?\d{9,11}|meeting\/register\/[^/]+|w\/\d{9,11})(?:\/|$)/.test(url.pathname)) {
    throw new Error('Use an HTTPS Zoom meeting or registration link.');
  }
  return url.toString();
}

export function extractZoomUrl(text) {
  const candidates = String(text || '').replaceAll('&amp;', '&').match(/https:\/\/[^\s<>"']+/g) || [];
  for (const candidate of candidates) {
    try { return zoomUrl(candidate.replace(/[).,;]+$/, '')); } catch { /* another link */ }
  }
  return null;
}

export const meetingSchema = z.object({
  title: z.string().trim().min(1).max(150),
  url: z.string().max(3000).transform((value, ctx) => {
    try { return zoomUrl(value); } catch { ctx.addIssue({ code: 'custom', message: 'Enter a valid Zoom meeting or registration link.' }); return z.NEVER; }
  }),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  displayName: z.string().trim().min(1).max(80).default('Meeting assistant'),
  passcode: z.string().max(100).default(''),
  autoJoin: z.boolean().default(true),
}).refine(m => Date.parse(m.endsAt) > Date.parse(m.startsAt), { message: 'End time must be after start time.' })
  .refine(m => Date.parse(m.endsAt) - Date.parse(m.startsAt) <= 12 * 3600000, { message: 'Meetings can last up to 12 hours.' });

export const settingsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  firstName: z.string().trim().max(80),
  lastName: z.string().trim().max(80),
  email: z.union([z.email(), z.literal('')]),
  timezone: z.literal('Asia/Kolkata'),
  joinEarlyMinutes: z.number().int().min(0).max(15),
  paused: z.boolean(),
});

export const activeStatuses = ['joining', 'waiting', 'needs_attention', 'in_meeting'];
export function isDue(meeting, now, earlyMinutes) {
  return meeting.status === 'scheduled' && meeting.autoJoin &&
    Date.parse(meeting.startsAt) - earlyMinutes * 60000 <= now && Date.parse(meeting.endsAt) > now;
}

// Human-verification widgets. The bot never solves these; it detects them, pauses, and alerts the owner.
const challengeFrames = [
  ['recaptcha', /^https:\/\/(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/i],
  ['hcaptcha', /^https:\/\/(?:[a-z0-9-]+\.)*hcaptcha\.com\//i],
  ['turnstile', /^https:\/\/challenges\.cloudflare\.com\//i],
  ['arkose', /^https:\/\/(?:[a-z0-9-]+\.)*(?:arkoselabs\.com|funcaptcha\.com)\//i],
];
const challengeText = /verify (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|captcha verification|complete the security check|unusual traffic/i;

/** Provider name for a challenge iframe URL, or null. Invisible reCAPTCHA anchors are background scoring, not a challenge. */
export function challengeProvider(frameUrl = '') {
  if (/[?&]size=invisible(?:&|$)/i.test(frameUrl) && /\/anchor/i.test(frameUrl)) return null;
  for (const [provider, pattern] of challengeFrames) if (pattern.test(frameUrl)) return provider;
  return null;
}

export function classifyZoomPage(text, url = '') {
  if (/\/signin|accounts\.google\.com|\/sso\//i.test(url) || /sign in to (?:join|register)|sign in with google|sign in to your account/i.test(text)) return 'authentication';
  if (challengeText.test(text)) return 'challenge';
  if (/access denied|not authorized|not allowed to join|only.*authorized attendees|registration.*denied/i.test(text)) return 'blocked';
  if (/meeting has (?:been )?ended|removed by the host|this meeting has been ended/i.test(text)) return 'ended';
  if (/waiting for (?:the )?host|host will let you in|please wait.*host|waiting room/i.test(text)) return 'waiting';
  return 'unknown';
}
