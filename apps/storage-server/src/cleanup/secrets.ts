/**
 * The cleanup's secrets (the Calibre password, Audiobookshelf's API key), decided with the user
 * 2026-11-13: AES-256-GCM in cleanup.db, with the key in ttsu.db (server_secrets
 * 'cleanup_secrets'). cleanup.db or its snapshots alone reveal nothing; whoever has both
 * files (e.g. the nightly appdata archive) can decrypt.
 *
 * The browser can only write them (PUT) and learn whether one is set (plus the last four
 * characters of an API key). Only the apply sidecar's token gets the Calibre password back.
 *
 * The AI provider keys were here too until cleanup.db v20; they moved to ttsu.db with v21 (the
 * shared AI layer, src/ai/secrets.ts; cleanup/ai-move.ts carried them over).
 */
import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getOrCreateSecret } from '../db/secrets';

export const CLEANUP_SECRET_KEY_NAME = 'cleanup_secrets';

export const SECRET_NAMES = [
  'calibrePassword',
  // WP21a: Audiobookshelf's API key (an admin's, to read every user's progress). Only read.
  'absApiKey',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

/** What the browser may see: never the value. */
export interface SecretInfo {
  set: boolean;
  /** Last four characters of an API key; never anything of the password. */
  hint: string | null;
  updatedAt: number | null;
}

export const MAX_SECRET_LENGTH = 4096;

export class SecretStore {
  constructor(
    private readonly cleanupDb: Database.Database,
    /** ttsu.db, which holds the encryption key. */
    private readonly mainDb: Database.Database,
  ) {}

  private key(): Buffer {
    return getOrCreateSecret(this.mainDb, CLEANUP_SECRET_KEY_NAME);
  }

  put(name: SecretName, value: string, now = Date.now()): SecretInfo {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('A secret must not be empty');
    }
    if (value.length > MAX_SECRET_LENGTH) throw new Error('A secret is too long');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const hint = name === 'calibrePassword' || value.length < 12 ? null : value.slice(-4);
    this.cleanupDb
      .prepare(
        `INSERT INTO secrets (name, ciphertext, nonce, tag, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           tag = excluded.tag, hint = excluded.hint, updated_at = excluded.updated_at`,
      )
      .run(name, ciphertext, nonce, tag, hint, now);
    return { set: true, hint, updatedAt: now };
  }

  remove(name: SecretName): void {
    this.cleanupDb.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  info(): Record<SecretName, SecretInfo> {
    const rows = this.cleanupDb.prepare('SELECT name, hint, updated_at FROM secrets').all() as {
      name: string;
      hint: string | null;
      updated_at: number;
    }[];
    const out = {} as Record<SecretName, SecretInfo>;
    for (const name of SECRET_NAMES) out[name] = { set: false, hint: null, updatedAt: null };
    for (const r of rows) {
      if (isSecretName(r.name)) out[r.name] = { set: true, hint: r.hint, updatedAt: r.updated_at };
    }
    return out;
  }

  /** The plain value, for the server's own use (the sidecar's config). null when unset or unreadable. */
  read(name: SecretName): string | null {
    return readCleanupSecret(this.cleanupDb, this.mainDb, name);
  }
}

/**
 * A stored cleanup secret by name (also the AI keys stored here before v21, for the one-time
 * move). null when unset or unreadable.
 */
export function readCleanupSecret(
  cleanupDb: Database.Database,
  mainDb: Database.Database,
  name: string,
): string | null {
  const row = cleanupDb
    .prepare('SELECT ciphertext, nonce, tag FROM secrets WHERE name = ?')
    .get(name) as { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
  if (!row) return null;
  try {
    const key = getOrCreateSecret(mainDb, CLEANUP_SECRET_KEY_NAME);
    const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // A rotated key or a damaged row: treated as not set (the page asks for it again).
    return null;
  }
}
