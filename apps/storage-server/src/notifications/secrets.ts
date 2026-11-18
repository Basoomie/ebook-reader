/**
 * The notification secrets (the Discord webhook address, the Gmail app password), stored
 * like the cleanup's (cleanup/secrets.ts): AES-256-GCM, the browser can only write them and
 * learn whether one is set.
 *
 * Decided with the user 2026-11-18: the encrypted values are in ttsu.db, the key is in its
 * own file beside it (DB_DIR/notification-secrets.key, mode 0600). Snapshots and rollback
 * copies of ttsu.db therefore reveal nothing; restoring ttsu.db keeps them working because
 * the key file stays. A lost key file makes them unreadable (shown as not set).
 */
import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

export const NOTIFICATION_KEY_FILE = 'notification-secrets.key';

export const NOTIFICATION_SECRET_NAMES = ['discordWebhookUrl', 'gmailAppPassword'] as const;
export type NotificationSecretName = (typeof NOTIFICATION_SECRET_NAMES)[number];

export function isNotificationSecretName(name: string): name is NotificationSecretName {
  return (NOTIFICATION_SECRET_NAMES as readonly string[]).includes(name);
}

/** What the browser may see: never the value, not even part of it. */
export interface NotificationSecretInfo {
  set: boolean;
  updatedAt: number | null;
  /** Stored, but the key file is missing or another one: type it again. */
  unreadable?: boolean;
}

export const MAX_NOTIFICATION_SECRET_LENGTH = 2048;

export class NotificationSecretStore {
  private readonly keyPath: string;
  private cachedKey: Buffer | null = null;

  constructor(
    private readonly db: Database.Database,
    dbDir: string,
  ) {
    this.keyPath = path.join(dbDir, NOTIFICATION_KEY_FILE);
  }

  /** The key, or null when there is no key file yet (create: make one). */
  private key(create: boolean): Buffer | null {
    if (this.cachedKey) return this.cachedKey;
    try {
      const key = fs.readFileSync(this.keyPath);
      if (key.length === 32) return (this.cachedKey = key);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return null;
    }
    const key = randomBytes(32);
    try {
      fs.writeFileSync(this.keyPath, key, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      // Another writer won the race: use theirs.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return this.key(false);
      throw err;
    }
    return (this.cachedKey = key);
  }

  put(name: NotificationSecretName, value: string, now = Date.now()): NotificationSecretInfo {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('A secret must not be empty');
    }
    if (value.length > MAX_NOTIFICATION_SECRET_LENGTH) throw new Error('A secret is too long');
    const key = this.key(true);
    if (!key) throw new Error('The key file for the notification secrets is unusable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO notification_secrets (name, ciphertext, nonce, tag, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run(name, ciphertext, nonce, tag, now);
    return { set: true, updatedAt: now };
  }

  remove(name: NotificationSecretName): void {
    this.db.prepare('DELETE FROM notification_secrets WHERE name = ?').run(name);
  }

  info(): Record<NotificationSecretName, NotificationSecretInfo> {
    const rows = this.db.prepare('SELECT name, updated_at FROM notification_secrets').all() as {
      name: string;
      updated_at: number;
    }[];
    const out = {} as Record<NotificationSecretName, NotificationSecretInfo>;
    for (const name of NOTIFICATION_SECRET_NAMES) out[name] = { set: false, updatedAt: null };
    for (const r of rows) {
      if (!isNotificationSecretName(r.name)) continue;
      const readable = this.read(r.name) !== null;
      out[r.name] = readable
        ? { set: true, updatedAt: r.updated_at }
        : { set: false, updatedAt: null, unreadable: true };
    }
    return out;
  }

  /** The plain value, for the server's own use. null when unset or unreadable. */
  read(name: NotificationSecretName): string | null {
    const row = this.db
      .prepare('SELECT ciphertext, nonce, tag FROM notification_secrets WHERE name = ?')
      .get(name) as { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
    if (!row) return null;
    const key = this.key(false);
    if (!key) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(name, 'utf8'));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
