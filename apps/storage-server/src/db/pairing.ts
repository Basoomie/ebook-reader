import type Database from 'better-sqlite3';
import { createHash, randomInt } from 'crypto';
import { ApiToken, createToken } from './tokens';

/**
 * Device pairing (WP6). The CLI makes a short one-time code; a device trades it
 * for its own API token, so nobody has to type a 48-character token on an
 * e-reader. Only a hash of the code is stored.
 */

/** Crockford base32: no I, L, O or U, so codes are hard to misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

export interface PairingCode {
  /** Shown to the user, e.g. "K7QM-3XWD". */
  code: string;
  label: string;
  expiresAt: number;
}

/** Uppercases, drops spaces and dashes, and maps the look-alikes Crockford allows (O->0, I/L->1). */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(`pair|${normalized}`, 'utf8').digest('hex');
}

function formatCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function createPairingCode(
  db: Database.Database,
  userId: string,
  label: string,
  validMinutes: number,
  now = Date.now(),
): PairingCode {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('A pairing code needs a label (e.g. the device name).');
  let normalized = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) normalized += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = now + Math.round(validMinutes * 60_000);
  db.prepare(
    `INSERT INTO pairing_codes (code_hash, user_id, label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hashCode(normalized), userId, trimmed, now, expiresAt);
  return { code: formatCode(normalized), label: trimmed, expiresAt };
}

/**
 * Trades a valid, unused, unexpired code for a new API token (single use).
 * Returns null for anything else, without saying why.
 */
export function redeemPairingCode(
  db: Database.Database,
  input: string,
  now = Date.now(),
): { token: string; record: ApiToken } | null {
  const normalized = normalizePairingCode(input);
  if (normalized.length !== PAIRING_CODE_LENGTH) return null;
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT code_hash, user_id, label FROM pairing_codes
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(hashCode(normalized), now) as
      | { code_hash: string; user_id: string; label: string }
      | undefined;
    if (!row) return null;
    const created = createToken(db, row.user_id, row.label, now);
    db.prepare('UPDATE pairing_codes SET used_at = ?, token_id = ? WHERE code_hash = ?').run(
      now,
      created.record.id,
      row.code_hash,
    );
    return created;
  })();
}

/** Deletes codes (used or not) that expired more than a day ago. Run by `token pair`. */
export function prunePairingCodes(db: Database.Database, now = Date.now()): number {
  return db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(now - 86_400_000).changes;
}

/**
 * Counts failed redeem attempts in a sliding one-minute window, across all
 * clients (a single-user server has no reason to see many failures).
 */
export class PairingRateLimiter {
  private failures: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  /** True when another attempt may be made now. */
  allow(now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => t > now - 60_000);
    return this.failures.length < this.maxPerMinute;
  }

  recordFailure(now = Date.now()): void {
    this.failures.push(now);
  }
}
