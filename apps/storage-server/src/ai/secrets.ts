/**
 * The AI provider keys (Anthropic, OpenAI), shared by every AI feature. Stored like the
 * notification secrets: AES-256-GCM in ttsu.db ai_secrets, the key in its own file beside it
 * (DB_DIR/ai-secrets.key, mode 0600), so a copy of ttsu.db alone reveals nothing and restoring
 * ttsu.db keeps them working. The browser can only write them and learn whether one is set and
 * its last four characters (as the cleanup showed them). A lost key file makes them unreadable
 * (shown as "can't be read": type them again).
 */
import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Provider } from './types';

export const AI_KEY_FILE = 'ai-secrets.key';

export const AI_SECRET_NAMES = ['anthropicApiKey', 'openaiApiKey'] as const;
export type AiSecretName = (typeof AI_SECRET_NAMES)[number];

export const KEY_NAME: Record<Provider, AiSecretName> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
};

export function isAiSecretName(name: string): name is AiSecretName {
  return (AI_SECRET_NAMES as readonly string[]).includes(name);
}

/** What the browser may see: never the value. */
export interface AiSecretInfo {
  set: boolean;
  /** The last four characters of the key (none for a value under 12 characters). */
  hint: string | null;
  updatedAt: number | null;
  /** Stored, but the key file is missing or another one: type it again. */
  unreadable?: boolean;
}

export const MAX_AI_SECRET_LENGTH = 4096;

/** Reads a key (tests give their own). */
export interface AiKeyReader {
  read(name: AiSecretName): string | null;
}

export class AiSecretStore implements AiKeyReader {
  private readonly keyPath: string;
  private cachedKey: Buffer | null = null;

  constructor(
    private readonly db: Database.Database,
    dbDir: string,
  ) {
    this.keyPath = path.join(dbDir, AI_KEY_FILE);
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

  put(name: AiSecretName, value: string, now = Date.now()): AiSecretInfo {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('A key must not be empty');
    }
    if (value.length > MAX_AI_SECRET_LENGTH) throw new Error('A key is too long');
    const key = this.key(true);
    if (!key) throw new Error('The key file for the AI keys is unusable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const hint = value.length < 12 ? null : value.slice(-4);
    this.db
      .prepare(
        `INSERT INTO ai_secrets (name, ciphertext, nonce, tag, hint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           tag = excluded.tag, hint = excluded.hint, updated_at = excluded.updated_at`,
      )
      .run(name, ciphertext, nonce, tag, hint, now);
    return { set: true, hint, updatedAt: now };
  }

  remove(name: AiSecretName): void {
    this.db.prepare('DELETE FROM ai_secrets WHERE name = ?').run(name);
  }

  /** True when any key is stored (the one-time move never overwrites it). */
  any(): boolean {
    return !!this.db.prepare('SELECT 1 FROM ai_secrets LIMIT 1').get();
  }

  info(): Record<AiSecretName, AiSecretInfo> {
    const rows = this.db.prepare('SELECT name, hint, updated_at FROM ai_secrets').all() as {
      name: string;
      hint: string | null;
      updated_at: number;
    }[];
    const out = {} as Record<AiSecretName, AiSecretInfo>;
    for (const name of AI_SECRET_NAMES) out[name] = { set: false, hint: null, updatedAt: null };
    for (const r of rows) {
      if (!isAiSecretName(r.name)) continue;
      out[r.name] =
        this.read(r.name) !== null
          ? { set: true, hint: r.hint, updatedAt: r.updated_at }
          : { set: false, hint: null, updatedAt: null, unreadable: true };
    }
    return out;
  }

  /** The plain value, for the server's own use. null when unset or unreadable. */
  read(name: AiSecretName): string | null {
    const row = this.db
      .prepare('SELECT ciphertext, nonce, tag FROM ai_secrets WHERE name = ?')
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
