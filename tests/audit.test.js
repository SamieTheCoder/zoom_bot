import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAudit } from '../server/audit.js';
test('DuckDB persists events and safely replays the durable outbox',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'duckdb-test-')),store=createStore(directory);let audit=await createAudit(store,directory);
  try{store.log('Joined.','meeting-1','meeting_in_meeting',{status:'in_meeting'});const row=store.db.prepare('SELECT * FROM audit_outbox').get();
    await audit.flush();assert.equal(audit.status().pending,0);
    store.db.prepare('INSERT INTO audit_outbox VALUES (?,?,?,?,?,?)').run(row.id,row.at,row.meeting_id,row.kind,row.message,row.metadata);
    await audit.flush();assert.equal((await audit.events()).length,1);await audit.close();audit=await createAudit(store,directory);
    const events=await audit.events();assert.equal(events[0].meetingId,'meeting-1');assert.equal(events[0].metadata.status,'in_meeting');
  }finally{await audit.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
