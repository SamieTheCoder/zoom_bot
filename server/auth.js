import { ExpressAuth } from '@auth/express';
import Credentials from '@auth/express/providers/credentials';
import { getToken } from '@auth/core/jwt';
import { hashPassword, verifyPassword, publicUser } from './users.js';

export async function createAuth(store, config) {
  const dummy = await hashPassword('not-a-real-account-password');
  const secure = config.origin.startsWith('https:');
  const cookieName = `${secure ? '__Secure-' : ''}meeting-desk.session-token`;
  const validUser = token => {
    if (!token?.sub) return null;
    const user = store.db.prepare('SELECT * FROM users WHERE id=?').get(token.sub);
    return user?.enabled && user.role === 'super_admin' && user.session_version === token.version ? user : null;
  };
  const authConfig = {
    secret: config.secret, trustHost: true, basePath: '/api/auth',
    session: { strategy: 'jwt', maxAge: 12 * 3600 }, useSecureCookies: secure,
    cookies: { sessionToken: { name: cookieName, options: { httpOnly: true, sameSite: 'lax', path: '/', secure } } },
    pages: { signIn: '/', error: '/' },
    providers: [Credentials({ credentials: { email: {}, password: {} }, async authorize(input) {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const password = typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
      const user = store.db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const valid = await verifyPassword(password, user?.password_hash || dummy);
      if (!valid || !user?.enabled || user.role !== 'super_admin') return null;
      store.log('Super admin signed in.', null, 'sign_in');
      return { ...publicUser(user), version: user.session_version };
    } })],
    callbacks: {
      jwt({ token, user }) { if (user) { token.sub = user.id; token.version = user.version; } return token; },
      session({ session, token }) { const user = validUser(token); return { ...session, user: user ? publicUser(user) : null }; },
      redirect({ url }) { return url.startsWith('/') ? `${config.origin}${url}` : url.startsWith(`${config.origin}/`) ? url : config.origin; },
    },
    logger: { error(error) { if (error.type !== 'CredentialsSignin') console.error(`Auth.js error: ${error.type || 'Unknown'}`); }, warn() {}, debug() {} },
  };
  return {
    handler: ExpressAuth(authConfig), cookieName,
    async user(req) {
      try {
        const token = await getToken({ req: { headers: new Headers({ cookie: req.headers.cookie || '' }) }, secret: config.secret, cookieName, salt: cookieName, secureCookie: secure });
        return validUser(token);
      } catch { return null; }
    },
    revoke(id) { store.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(id); },
  };
}
