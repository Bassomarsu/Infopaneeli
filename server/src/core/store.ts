import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(config.dataDir, { recursive: true });

/**
 * `node:sqlite` ships with Node 24, so there is no native module to compile on
 * Windows. That was the deciding factor over better-sqlite3.
 */
const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_cache (
    id          TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Wilma ei kerro onko viesti luettu (ks. server/src/providers/wilma.ts:isUnread).
  -- Tämä taulu on siis infonäytön oma kirjanpito siitä mitkä viestit on avattu
  -- TÄLLÄ näytöllä, ei Wilman oma tila. message_id viittaa Wilman viestitunnisteeseen.
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER PRIMARY KEY,
    read_at    TEXT NOT NULL
  );
`);

const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const selectCache = db.prepare("SELECT payload, fetched_at FROM provider_cache WHERE id = ?");
const upsertCache = db.prepare(
  `INSERT INTO provider_cache (id, payload, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
);

export function getSetting<T>(key: string): T | null {
  const row = selectSetting.get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  upsertSetting.run(key, JSON.stringify(value));
}

export interface CachedPayload<T> {
  data: T;
  fetchedAt: string;
}

/**
 * Last-good data survives a restart on purpose: a schedule fetched yesterday
 * evening is still worth showing at breakfast if Wilma is down this morning.
 */
export function readCache<T>(id: string): CachedPayload<T> | null {
  const row = selectCache.get(id) as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

export function writeCache(id: string, data: unknown, fetchedAt: string): void {
  upsertCache.run(id, JSON.stringify(data), fetchedAt);
}

export interface Note {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

export function listNotes(): Note[] {
  const rows = db.prepare("SELECT id, text, done, created_at FROM notes ORDER BY done, id").all() as Array<{
    id: number;
    text: string;
    done: number;
    created_at: string;
  }>;
  return rows.map((r) => ({ id: r.id, text: r.text, done: r.done === 1, createdAt: r.created_at }));
}

export function addNote(text: string): Note {
  const createdAt = new Date().toISOString();
  const result = db.prepare("INSERT INTO notes (text, done, created_at) VALUES (?, 0, ?)").run(text, createdAt);
  return { id: Number(result.lastInsertRowid), text, done: false, createdAt };
}

export function setNoteDone(id: number, done: boolean): void {
  db.prepare("UPDATE notes SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
}

export function deleteNote(id: number): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

const selectMessageRead = db.prepare("SELECT 1 FROM message_reads WHERE message_id = ?");
const selectAllMessageReads = db.prepare("SELECT message_id FROM message_reads");
const upsertMessageRead = db.prepare(
  `INSERT INTO message_reads (message_id, read_at) VALUES (?, ?)
   ON CONFLICT(message_id) DO UPDATE SET read_at = excluded.read_at`,
);

/**
 * Whether a Wilma message has been opened on this display. This is entirely
 * local bookkeeping — see the comment on `message_reads` above for why Wilma's
 * own read state cannot be used.
 */
export function isMessageRead(messageId: number): boolean {
  return selectMessageRead.get(messageId) !== undefined;
}

/** Every message id known to have been opened here, for bulk-checking a whole inbox at once. */
export function listReadMessageIds(): Set<number> {
  const rows = selectAllMessageReads.all() as Array<{ message_id: number }>;
  return new Set(rows.map((r) => r.message_id));
}

/** Idempotent: opening an already-read message just refreshes read_at. */
export function markMessageRead(messageId: number): string {
  const readAt = new Date().toISOString();
  upsertMessageRead.run(messageId, readAt);
  return readAt;
}

export { db };
