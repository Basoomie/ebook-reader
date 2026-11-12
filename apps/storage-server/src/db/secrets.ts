import type Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Named random keys kept in the database (server_secrets). */

export const THUMBNAIL_URL_SECRET = 'thumbnail_url';
/** Signs audio stream URLs (WP15): an <audio> element can't send the token. */
export const AUDIO_URL_SECRET = 'audio_url';

/** Returns the named key, creating a random 32-byte key on first use. */
export function getOrCreateSecret(db: Database.Database, name: string, now = Date.now()): Buffer {
  const row = db.prepare('SELECT value FROM server_secrets WHERE name = ?').get(name) as
    | { value: Buffer }
    | undefined;
  if (row) return row.value;
  db.prepare('INSERT OR IGNORE INTO server_secrets (name, value, created_at) VALUES (?, ?, ?)').run(
    name,
    randomBytes(32),
    now,
  );
  return (
    db.prepare('SELECT value FROM server_secrets WHERE name = ?').get(name) as {
      value: Buffer;
    }
  ).value;
}

/** Replaces the named key, which invalidates everything signed with the old one. */
export function rotateSecret(db: Database.Database, name: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO server_secrets (name, value, created_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
  ).run(name, randomBytes(32), now);
}

/** 128-bit HMAC-SHA256 signature, base64url. */
export function sign(key: Buffer, message: string): string {
  return createHmac('sha256', key)
    .update(message, 'utf8')
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function verify(key: Buffer, message: string, signature: string): boolean {
  const expected = Buffer.from(sign(key, message), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
