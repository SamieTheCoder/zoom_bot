import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, client } from './helpers.js';
test('Auth.js credentials, CSRF, role enforcement, private routes and revoked sessions', async () => {
  const f = await fixture(), c = client(f.base);
  try {
    assert.equal((await c.request('/api/health')).status,200);
    for(const path of ['/api/state','/api/activity','/desktop/vnc.html']) assert.equal((await c.request(path)).status,401);
    assert.equal((await c.request('/api/auth/callback/credentials',{},'POST','https://evil.example')).status,403);
    const noCsrf = await c.request('/api/auth/callback/credentials',{email:f.config.adminEmail,password:f.config.adminPassword});assert.match((await noCsrf.json()).url,/MissingCSRF/);
    assert.match((await (await c.login(f.config.adminEmail,'bad-password')).json()).url,/CredentialsSignin/);
    const login = await c.login(f.config.adminEmail,f.config.adminPassword); assert.equal(login.status,200);assert.ok(login.headers.getSetCookie().some(cookie=>cookie.includes('HttpOnly')));
    const savedCookies = new Map(c.cookies);
    const stateResponse = await c.request('/api/state'); assert.equal(stateResponse.status,200);
    const state = await stateResponse.json();assert.equal(state.user.role,'super_admin');assert.equal(state.rules.length,8);assert.equal(state.calendar,undefined);
    assert.equal((await c.request('/api/meetings',{title:'X',url:'https://evil.example',startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString()})).status,400);
    assert.equal((await c.request('/api/meetings',{title:'Test',url:'https://zoom.us/j/123456789',startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString(),autoJoin:false})).status,201);
    assert.equal((await c.request('/api/activity')).status,200);
    await c.request('/api/logout',{});c.cookies.clear();for(const [k,v] of savedCookies)c.cookies.set(k,v);
    assert.equal((await c.request('/api/state')).status,401,'Logout must revoke a copied JWT');
    f.store.db.prepare("UPDATE users SET role='viewer'").run();
    assert.match((await (await c.login(f.config.adminEmail,f.config.adminPassword)).json()).url,/CredentialsSignin/);
  } finally { await f.close(); }
});
test('password changes revoke sessions and stored passwords are hashed',async()=>{
  const f=await fixture(),c=client(f.base);
  try {
    assert.notEqual(f.store.db.prepare('SELECT * FROM users').get().password_hash,f.config.adminPassword);
    await c.login(f.config.adminEmail,f.config.adminPassword);
    assert.equal((await c.request('/api/account/password',{currentPassword:'incorrect',password:'new-long-secret-password'})).status,400);
    assert.equal((await c.request('/api/account/password',{currentPassword:f.config.adminPassword,password:'new-long-secret-password'})).status,200);
    assert.equal((await c.request('/api/state')).status,401);
    assert.match((await (await c.login(f.config.adminEmail,f.config.adminPassword)).json()).url,/CredentialsSignin/);
    await c.login(f.config.adminEmail,'new-long-secret-password');assert.equal((await c.request('/api/state')).status,200);
  } finally {await f.close();}
});
