import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';

export async function createAudit(store, directory) {
  const instance = await DuckDBInstance.create(join(directory, 'activity.duckdb'));
  const connection = await instance.connect();
  await connection.run('CREATE TABLE IF NOT EXISTS activity (id VARCHAR PRIMARY KEY, "at" VARCHAR, meeting_id VARCHAR, kind VARCHAR, message VARCHAR, metadata VARCHAR)');
  let chain = Promise.resolve();
  let lastError = null;
  // A durable SQLite outbox makes event capture synchronous and crash safe. Only one
  // DuckDB writer flushes it. UUIDs make replay after a crash idempotent.
  function flush() {
    chain = chain.catch(() => {}).then(async () => {
      const rows = store.db.prepare('SELECT * FROM audit_outbox ORDER BY rowid LIMIT 1000').all();
      for (const row of rows) {
        await connection.run('INSERT INTO activity VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [row.id, row.at, row.meeting_id, row.kind, row.message, row.metadata]);
        store.db.prepare('DELETE FROM audit_outbox WHERE id=?').run(row.id);
      }
      lastError = null;
    }).catch(error => { lastError = 'Activity archive is temporarily unavailable. Events remain queued safely.'; throw error; });
    return chain;
  }
  return {
    flush,
    status() { return { engine: 'DuckDB', error: lastError, pending: store.db.prepare('SELECT count(*) AS total FROM audit_outbox').get().total }; },
    async events(limit = 100) {
      await flush();
      // Queue reads with writes because they share one connection.
      const result = chain.then(async () => {
        const reader = await connection.runAndReadAll('SELECT id, "at", meeting_id AS meetingId, kind, message, metadata FROM activity ORDER BY "at" DESC, id DESC LIMIT $1', [limit]);
        return reader.getRowObjects().map(row => ({ ...row, metadata: JSON.parse(row.metadata || '{}') }));
      });
      chain = result.then(() => {}); return result;
    },
    async close() { await flush(); connection.closeSync(); instance.closeSync(); },
  };
}
