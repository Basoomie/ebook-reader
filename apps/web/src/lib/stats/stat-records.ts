/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Statistics records (WP12, server: `apps/storage-server/src/sync/kinds.ts`).
 *
 * - `stat-session`     id <bookId>:<deviceId>:<uuid>. One stretch of reading of one
 *                      book on one device. Only that device writes it (owner); it is
 *                      updated while open and sealed with `closed: true`. The only
 *                      source of reading time and characters from WP12 on.
 * - `stat-session-fix` id = the session's id. A correction any device may make:
 *                      `{excluded: true}` or replacement `seconds` / `chars`.
 * - `stat-day`         id <bookId>:<YYYY-MM-DD>. Frozen: the per-day rows from
 *                      before device tracking. Read only; devices never write them.
 */

export const STAT_SESSION_KIND = 'stat-session';
export const STAT_SESSION_FIX_KIND = 'stat-session-fix';
export { STAT_DAY_KIND } from '$lib/sync/record-statistics';

export type StatSessionSource = 'tracker' | 'completion';

export interface StatSessionData {
  /** The day key under the day boundary in effect when it was written. */
  day: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  chars: number;
  /** Dictionary popups opened while it was open. */
  lookups: number;
  /** The book's current read-through when it started (null = the first). */
  readThroughId: string | null;
  source: StatSessionSource;
  closed: boolean;
}

export interface StatSessionFixData {
  excluded?: true;
  seconds?: number;
  chars?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function statSessionId(bookId: string, deviceId: string, sessionId: string): string {
  return `${bookId}:${deviceId}:${sessionId}`;
}

export function parseStatSessionId(
  id: string
): { bookId: string; deviceId: string; sessionId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || !parts.every((p) => UUID_RE.test(p))) return null;
  return { bookId: parts[0], deviceId: parts[1], sessionId: parts[2] };
}
