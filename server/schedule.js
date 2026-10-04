import { zoomUrl } from './domain.js';

export const TIMEZONE = 'Asia/Kolkata';
export const weeklySlots = [
  ['sunday', 0, 'Sunday session', '17:00', '19:00'],
  ['monday', 1, 'Monday session', '18:00', '20:00'],
  ['tuesday', 2, 'Tuesday session', '18:00', '20:00'],
  ['wednesday', 3, 'Wednesday session', '17:00', '19:00'],
  ['thursday', 4, 'Thursday session', '17:00', '19:00'],
  ['friday', 5, 'Friday session', '17:00', '19:00'],
  ['saturday-am', 6, 'Saturday morning', '10:00', '12:00'],
  ['saturday-pm', 6, 'Saturday afternoon', '14:00', '16:00'],
];
export function seedSchedule(store, env = process.env) {
  if (!store.get('weekly_rules')) store.set('weekly_rules', weeklySlots.map(([id, weekday, title, start, end]) => {
    const input = env[`MEETING_URL_${id.replaceAll('-', '_').toUpperCase()}`] || '';
    return { id, weekday, title, start, end, url: input ? zoomUrl(input) : '', enabled: true };
  }));
  if (!store.get('registration_seeded')) {
    store.set('preferences', { ...store.settings(), firstName: env.REGISTRATION_FIRST_NAME || '',
      lastName: env.REGISTRATION_LAST_NAME || '', email: env.REGISTRATION_EMAIL || '',
      displayName: [env.REGISTRATION_FIRST_NAME, env.REGISTRATION_LAST_NAME].filter(Boolean).join(' ') || 'Meeting assistant',
      timezone: TIMEZONE, paused: true });
    store.set('registration_seeded', true);
  }
}
export function istDate(date, time) {
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}
export function materializeSchedule(store, now = Date.now(), days = 21) {
  const rules = store.get('weekly_rules', []);
  const existing = new Map(store.list().filter(m => m.sourceKey).map(m => [m.sourceKey, m]));
  // IST has no daylight saving. Use UTC calendar arithmetic on an IST-shifted instant,
  // never the host's local timezone or locale-dependent Date string parsing.
  const local = new Date(now + 330 * 60000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let day = 0; day < days; day++) {
    const date = new Date(midnight + day * 86400000);
    const key = date.toISOString().slice(0, 10);
    for (const rule of rules.filter(r => r.weekday === date.getUTCDay() && r.url)) {
      const startsAt = istDate(key, rule.start), endsAt = istDate(key, rule.end);
      if (Date.parse(endsAt) <= now) continue;
      const sourceKey = `weekly:${rule.id}:${key}`;
      if (!existing.has(sourceKey)) {
        store.add({ title: rule.title, url: rule.url, startsAt, endsAt, source: 'weekly', sourceKey,
          ruleId: rule.id, autoJoin: rule.enabled, displayName: store.settings().displayName, passcode: '' });
      }
    }
  }
}
export function updateRule(store, id, changes) {
  const rules = store.get('weekly_rules', []);
  const rule = rules.find(r => r.id === id);
  if (!rule) throw new Error('Weekly session not found.');
  Object.assign(rule, changes);
  store.set('weekly_rules', rules);
  for (const meeting of store.list()) if (meeting.ruleId === id && meeting.status === 'scheduled') {
    store.update(meeting.id, { title: rule.title, url: rule.url, autoJoin: rule.enabled && !!rule.url });
  }
  materializeSchedule(store);
  store.log('Weekly session preferences updated.', null, 'schedule_updated', { ruleId: id });
}
