import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zoomUrl, extractZoomUrl, meetingSchema, isDue, classifyZoomPage } from '../server/domain.js';
import { cryptoBox, cookieToken } from '../server/security.js';
import { createStore } from '../server/store.js';
import { BrowserWorker } from '../server/browser.js';

test('Zoom links preserve passcodes and personal registration tokens', () => {
  const link = 'https://futurense.zoom.us/j/12345678901?pwd=secret&tk=personal#join';
  assert.equal(zoomUrl(link), link);
  assert.equal(zoomUrl('https://futurense.zoom.us/meeting/register/registration-id#/registration'), 'https://futurense.zoom.us/meeting/register/registration-id#/registration');
  assert.equal(extractZoomUrl('<a href="https://zoom.us/j/123456789?pwd=a&amp;tk=b">Join</a>'), 'https://zoom.us/j/123456789?pwd=a&tk=b');
});
test('meeting links reject arbitrary hosts, credentials, ports, and non-join paths', () => {
  for (const url of ['https://evilzoom.us/j/123456789','https://zoom.us.evil.com/j/123456789','http://zoom.us/j/123456789','https://user:pass@zoom.us/j/123456789','https://zoom.us:1234/j/123456789','https://127.0.0.1/j/123456789','https://zoom.us/signin','file:///etc/passwd']) assert.throws(() => zoomUrl(url), url);
});
test('meeting validation rejects reversed or excessively long meeting windows', () => {
  const meeting = {title:'Meeting',url:'https://zoom.us/j/123456789',startsAt:'2026-10-05T10:00:00Z',endsAt:'2026-10-05T11:00:00Z'};
  assert.equal(meetingSchema.parse(meeting).autoJoin, true);
  assert.throws(() => meetingSchema.parse({...meeting,endsAt:meeting.startsAt}));
  assert.throws(() => meetingSchema.parse({...meeting,endsAt:'2026-10-06T11:00:00Z'}));
});
test('scheduler joins only enabled upcoming meetings inside the early window', () => {
  const m = { status:'scheduled',autoJoin:true,startsAt:'2026-10-05T10:00:00Z',endsAt:'2026-10-05T11:00:00Z' };
  assert.equal(isDue(m,Date.parse('2026-10-05T09:49:00Z'),10),false);
  assert.equal(isDue(m,Date.parse('2026-10-05T09:50:00Z'),10),true);
  assert.equal(isDue(m,Date.parse(m.endsAt),10),false);
  assert.equal(isDue({...m,autoJoin:false},Date.parse(m.startsAt),10),false);
  assert.equal(isDue({...m,status:'cancelled'},Date.parse(m.startsAt),10),false);
});
test('page classification never calls a waiting room or unknown page joined', () => {
  assert.equal(classifyZoomPage('Please wait, the host will let you in soon'),'waiting');
  assert.equal(classifyZoomPage('Sign in with Google'),'authentication');
  assert.equal(classifyZoomPage('Verify you are human'),'challenge');
  assert.equal(classifyZoomPage('Access denied'),'blocked');
  assert.equal(classifyZoomPage('This meeting has ended'),'ended');
  assert.equal(classifyZoomPage('Welcome to Zoom'),'unknown');
});
test('encrypted OAuth tokens resist tampering and wrong keys', () => {
  const box = cryptoBox('a'.repeat(32)); const ciphertext = box.seal({refresh_token:'private'});
  assert.deepEqual(box.open(ciphertext),{refresh_token:'private'});
  assert.ok(!ciphertext.includes('private'));
  assert.throws(()=>cryptoBox('b'.repeat(32)).open(ciphertext));
  const altered=Buffer.from(ciphertext,'base64');altered[35]^=1;
  assert.throws(()=>box.open(altered.toString('base64')));
  assert.equal(cookieToken({headers:{cookie:'other=1; meeting_session=abc123; x=2'}}),'abc123');
});
test('database persists meetings and unique source IDs prevent duplicate imports', () => {
  const directory=mkdtempSync(join(tmpdir(),'meeting-store-'));
  let store=createStore(directory);
  try {
    const meeting=store.add({title:'Test',sourceKey:'google:primary:event',startsAt:'2026-10-05T10:00:00Z'});
    assert.throws(()=>store.add({title:'Duplicate',sourceKey:'google:primary:event'}));
    store.close(); store=createStore(directory);
    assert.equal(store.meeting(meeting.id).title,'Test');
    store.update(meeting.id,{status:'cancelled'});
    assert.equal(store.list()[0].status,'cancelled');
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('worker locks concurrent joins and pauses during interactive sign-in', async () => {
  const directory=mkdtempSync(join(tmpdir(),'meeting-worker-'));const store=createStore(directory);
  const worker=new BrowserWorker(store,{});
  let finish;
  worker.run=()=>new Promise(resolve=>{finish=resolve;});
  try {
    const meeting=store.add({startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString(),autoJoin:true});
    worker.loginOpen=true;
    await assert.rejects(worker.start(meeting.id),/busy/);
    worker.loginOpen=false;
    await worker.start(meeting.id);
    await assert.rejects(worker.start(meeting.id),/busy/);
    await worker.stop(meeting.id);
    assert.equal(store.meeting(meeting.id).status,'cancelled');
    finish();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(worker.active,null);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
