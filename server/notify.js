// Push alerts through ntfy (https://ntfy.sh or a self-hosted ntfy server).
// Meeting links are never included: they contain personal registration tokens.
export function createNotifier({ url, token, origin, fetchImpl = globalThis.fetch } = {}) {
  if (!url) return { enabled: false, send: async () => false };
  const target = new URL(url);
  if (target.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(target.hostname)) throw new Error('ALERT_NTFY_URL must use HTTPS.');
  return {
    enabled: true,
    async send({ title, message, priority = 'high', tags = [] }) {
      const headers = { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: priority, Tags: tags.join(',') };
      if (origin) { headers.Click = origin; headers.Actions = `view, Open Meeting Desk, ${origin}`; }
      if (token) headers.Authorization = `Bearer ${token}`;
      const body = origin ? `${message}\n${origin}` : message;
      const response = await fetchImpl(target, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Alert service responded ${response.status}.`);
      return true;
    },
  };
}
