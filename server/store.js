import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'meetings.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, source_key TEXT UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, meeting_id TEXT, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, session_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS audit_outbox (id TEXT PRIMARY KEY, at TEXT, meeting_id TEXT, kind TEXT, message TEXT, metadata TEXT);`);
  const api = {
    db,
    get(key, fallback = null) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; },
    set(key, value) { db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
    list() { return db.prepare('SELECT body FROM meetings').all().map(r => JSON.parse(r.body)).sort((a,b) => a.startsAt.localeCompare(b.startsAt)); },
    meeting(id) { const row = db.prepare('SELECT body FROM meetings WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; },
    save(meeting) {
      db.prepare('INSERT INTO meetings VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, source_key=excluded.source_key')
        .run(meeting.id, meeting.sourceKey || null, JSON.stringify(meeting));
      return meeting;
    },
    add(input) { return api.save({ ...input, id: randomUUID(), status: 'scheduled', createdAt: new Date().toISOString() }); },
    update(id, values) { const m = api.meeting(id); return m ? api.save({ ...m, ...values }) : null; },
    remove(id) { db.prepare('DELETE FROM meetings WHERE id=?').run(id); },
    log(message, meetingId = null, kind = 'info', metadata = {}) {
      const at = new Date().toISOString();
      db.prepare('INSERT INTO events(at,meeting_id,message) VALUES (?,?,?)').run(at, meetingId, message);
      db.prepare('INSERT INTO audit_outbox VALUES (?,?,?,?,?,?)').run(randomUUID(), at, meetingId, kind, message, JSON.stringify(metadata));
      db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)');
    },
    events() { return db.prepare('SELECT at, meeting_id AS meetingId, message FROM events ORDER BY id DESC LIMIT 60').all(); },
    settings() { return api.get('preferences', { displayName: 'Meeting assistant', firstName: '', lastName: '', email: '', timezone: 'Asia/Kolkata', joinEarlyMinutes: 10, paused: true }); },
    close() { db.close(); },
  };
  return api;
}
