/**
 * The apply sidecar's tokens (WP20a), made with `cli token cleanup "<label>"`. They live in
 * cleanup.db, not in ttsu.db's api_tokens, so a sidecar token can never reach the reader's
 * API (requireUser doesn't know it) and the reader's tokens can't reach the sidecar's routes.
 * Only a SHA-256 hash is stored; the token is shown once.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { generateToken, hashToken } from '../db/tokens';

export interface ApplyToken {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export function createApplyToken(
  db: Database.Database,
  label: string,
  now = Date.now(),
): { token: string; record: ApplyToken } {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('A token needs a label (e.g. "cleanup sidecar").');
  const token = generateToken();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO apply_tokens (id, label, token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, trimmed, hashToken(token), now);
  return {
    token,
    record: { id, label: trimmed, createdAt: now, lastUsedAt: null, revokedAt: null },
  };
}

export function authenticateApplyToken(
  db: Database.Database,
  token: string,
  now = Date.now(),
): ApplyToken | null {
  const row = db
    .prepare('SELECT * FROM apply_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as
    | { id: string; label: string; created_at: number; last_used_at: number | null }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE apply_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: now,
    revokedAt: null,
  };
}

export function listApplyTokens(db: Database.Database): ApplyToken[] {
  const rows = db.prepare('SELECT * FROM apply_tokens ORDER BY created_at').all() as {
    id: string;
    label: string;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export function revokeApplyToken(db: Database.Database, id: string, now = Date.now()): boolean {
  return (
    db
      .prepare('UPDATE apply_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id).changes === 1
  );
}
