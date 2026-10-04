export async function api(path, body, method = 'POST') {
  const res = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json();
  if (!res.ok) { if (res.status === 401) window.dispatchEvent(new Event('signed-out')); throw new Error(data.error || 'Request failed. Please try again.'); }
  return data;
}
export async function signIn(email, password) {
  const { csrfToken } = await api('/auth/csrf');
  const response = await fetch('/api/auth/callback/credentials', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: location.origin }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Sign-in failed. Try again shortly.');
  if (new URL(result.url, location.origin).searchParams.has('error')) throw new Error('Email or password is incorrect.');
  const session = await api('/session');
  if (!session.authenticated) throw new Error('Sign-in failed. Please try again.');
  return session;
}
