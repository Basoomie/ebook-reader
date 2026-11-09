import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { User } from './users';

/** Per-user API tokens. Only a SHA-256 hash is stored; the token is shown once. */
export const TOKEN_PREFIX = 'ttsu_';

export interface ApiToken {
  id: string;
  userId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AuthenticatedToken {
  user: Pick<User, 'id' | 'name'>;
  /** deviceId: the device this token is bound to (WP4), null until it registers. */
  token: Pick<ApiToken, 'id' | 'label'> & { deviceId: string | null };
}

interface TokenRow {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function generateToken(): string {
  // 32 random bytes = 256 bits, 43 base64url characters.
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createToken(
  db: Database.Database,
  userId: string,
  label: string,
  now = Date.now(),
): { token: string; record: ApiToken } {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('A token needs a label (e.g. the device name).');
  const token = generateToken();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, trimmed, hashToken(token), now);
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow;
  return { token, record: toToken(row) };
}

/** Looks up an active token and records its use. Returns null for unknown or revoked tokens. */
export function authenticateToken(
  db: Database.Database,
  token: string,
  now = Date.now(),
): AuthenticatedToken | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.label, t.device_id, u.id AS user_id, u.name
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(hashToken(token)) as
    | { token_id: string; label: string; device_id: string | null; user_id: string; name: string }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.token_id);
  return {
    user: { id: row.user_id, name: row.name },
    token: { id: row.token_id, label: row.label, deviceId: row.device_id },
  };
}

export function listTokens(db: Database.Database): (ApiToken & { userName: string })[] {
  const rows = db
    .prepare(
      `SELECT t.*, u.name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at`,
    )
    .all() as (TokenRow & { user_name: string })[];
  return rows.map((r) => ({ ...toToken(r), userName: r.user_name }));
}

/** Returns false when no active token has this id. */
export function revokeToken(db: Database.Database, id: string, now = Date.now()): boolean {
  const result = db
    .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, id);
  return result.changes === 1;
}
