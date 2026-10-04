import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSchedule, materializeSchedule, istDate, updateRule, weeklySlots } from '../server/schedule.js';
import { createStore } from '../server/store.js';
test('eight IST slots map to UTC correctly across host timezones and restarts',()=>{
  const directory=mkdtempSync(join(tmpdir(),'weekly-test-')),store=createStore(directory),original=process.env.TZ;
  try {
    const env={};for(const [id] of weeklySlots)env[`MEETING_URL_${id.replaceAll('-','_').toUpperCase()}`]='https://zoom.us/meeting/register/test';seedSchedule(store,env);
    process.env.TZ='America/Los_Angeles';materializeSchedule(store,Date.parse('2026-10-03T18:30:00Z'),7);assert.equal(store.list().length,8);
    assert.deepEqual(store.list().map(m=>m.startsAt),['2026-10-04T11:30:00.000Z','2026-10-05T12:30:00.000Z','2026-10-06T12:30:00.000Z','2026-10-07T11:30:00.000Z','2026-10-08T11:30:00.000Z','2026-10-09T11:30:00.000Z','2026-10-10T04:30:00.000Z','2026-10-10T08:30:00.000Z']);
    for(const m of store.list())assert.equal(Date.parse(m.endsAt)-Date.parse(m.startsAt),2*3600000);
    process.env.TZ='UTC';materializeSchedule(store,Date.parse('2026-10-03T18:30:00Z'),7);assert.equal(store.list().length,8);
    const first=store.list()[0];store.update(first.id,{status:'cancelled'});materializeSchedule(store,Date.parse('2026-10-03T18:30:00Z'),7);assert.equal(store.meeting(first.id).status,'cancelled');
    assert.equal(istDate('2027-01-01','00:15'),'2026-12-31T18:45:00.000Z');
  }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;store.close();rmSync(directory,{recursive:true,force:true});}
});
test('missing links do not schedule; disabled weekly rules disable pending joins',()=>{
  const directory=mkdtempSync(join(tmpdir(),'weekly-toggle-')),store=createStore(directory);
  try{seedSchedule(store,{});materializeSchedule(store);assert.equal(store.list().length,0);
    updateRule(store,'saturday-am',{url:'https://zoom.us/meeting/register/test',title:'Morning',enabled:true});assert.ok(store.list().length>=2);
    updateRule(store,'saturday-am',{url:'https://zoom.us/meeting/register/test',title:'Morning',enabled:false});assert.ok(store.list().every(m=>!m.autoJoin));assert.equal(store.settings().paused,true);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
