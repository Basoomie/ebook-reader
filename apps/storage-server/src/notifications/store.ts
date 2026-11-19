/**
 * The notifications' rows in ttsu.db (migration 25): problems, the log (also the outbox),
 * digest lines and small state values.
 *
 * A problem is one thing that is wrong (a paused stage, an offline helper). Its row is made
 * when the watcher first sees it; it is "noticed" (the alert goes out) once it has lasted
 * its wait time, and never again while it lasts (one alert per problem). When it ends, a
 * noticed problem keeps its row with resolved_at until the next digest says "Resolved";
 * one that ended before its wait time is simply forgotten (it fixed itself).
 */
import type Database from 'better-sqlite3';
import type { Channel } from './settings';

export interface ProblemRow {
  key: string;
  event: string;
  first_seen_at: number;
  last_active_at: number;
  noticed_at: number | null;
  resolved_at: number | null;
  summary: string | null;
  detail: string | null;
}

export interface Observation {
  /** When the problem began, if known better than "now" (e.g. a helper's last heartbeat). */
  startAt?: number;
  /** How long it must last before the alert (0: at once). */
  waitMs: number;
  /** The alert's first line (also the digest's "Resolved: …" and the open-problems list). */
  summary: string;
  /** Longer text for the open-problems list (e.g. the indexer's whole warning). */
  detail?: string | null;
}

export interface LogRow {
  id: number;
  created_at: number;
  event: string;
  /** report: a stats message (N2, migration 26). */
  kind: 'now' | 'digest' | 'test' | 'report';
  channel: Channel;
  text: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  next_at: number | null;
  error: string | null;
  sent_at: number | null;
}

export class NotificationStore {
  constructor(readonly db: Database.Database) {}

  // ---- state ----

  getState<T>(name: string): T | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM notification_state WHERE name = ?')
      .get(name) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  setState(name: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO notification_state (name, value_json) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(name, JSON.stringify(value));
  }

  // ---- problems ----

  getProblem(key: string): ProblemRow | undefined {
    return this.db.prepare('SELECT * FROM notification_problems WHERE key = ?').get(key) as
      | ProblemRow
      | undefined;
  }

  problemsOf(event: string): ProblemRow[] {
    return this.db
      .prepare('SELECT * FROM notification_problems WHERE event = ? ORDER BY first_seen_at')
      .all(event) as ProblemRow[];
  }

  /**
   * The problem is there now. Returns true exactly once per problem: when it has lasted its
   * wait time (the alert is due).
   */
  observe(key: string, event: string, o: Observation, now: number): boolean {
    let row = this.getProblem(key);
    if (row && row.resolved_at !== null) {
      // Back before the digest reported it as resolved: a new problem.
      this.db.prepare('DELETE FROM notification_problems WHERE key = ?').run(key);
      row = undefined;
    }
    if (!row) {
      const first = Math.min(o.startAt ?? now, now);
      this.db
        .prepare(
          `INSERT INTO notification_problems (key, event, first_seen_at, last_active_at, summary, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, event, first, now, o.summary, o.detail ?? null);
      row = this.getProblem(key)!;
    } else {
      this.db
        .prepare(
          `UPDATE notification_problems SET last_active_at = ?,
             summary = CASE WHEN noticed_at IS NULL THEN ? ELSE summary END, detail = ?
           WHERE key = ?`,
        )
        .run(now, o.summary, o.detail ?? null, key);
    }
    if (row.noticed_at === null && now - row.first_seen_at >= o.waitMs) {
      this.db
        .prepare('UPDATE notification_problems SET noticed_at = ?, summary = ? WHERE key = ?')
        .run(now, o.summary, key);
      return true;
    }
    return false;
  }

  /** The problem is gone. */
  clear(key: string, now: number): void {
    const row = this.getProblem(key);
    if (!row || row.resolved_at !== null) return;
    if (row.noticed_at === null) {
      this.db.prepare('DELETE FROM notification_problems WHERE key = ?').run(key);
    } else {
      this.db
        .prepare('UPDATE notification_problems SET resolved_at = ? WHERE key = ?')
        .run(now, key);
    }
  }

  /** Clears every unresolved problem of `event` whose key is not in `active`. */
  clearOthers(event: string, active: Set<string>, now: number): void {
    for (const p of this.problemsOf(event)) {
      if (p.resolved_at === null && !active.has(p.key)) this.clear(p.key, now);
    }
  }

  openProblems(): ProblemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_problems WHERE noticed_at IS NOT NULL AND resolved_at IS NULL
         ORDER BY noticed_at`,
      )
      .all() as ProblemRow[];
  }

  resolvedProblems(): ProblemRow[] {
    return this.db
      .prepare(
        'SELECT * FROM notification_problems WHERE resolved_at IS NOT NULL ORDER BY resolved_at',
      )
      .all() as ProblemRow[];
  }

  deleteProblem(key: string): void {
    this.db.prepare('DELETE FROM notification_problems WHERE key = ?').run(key);
  }

  // ---- digest lines ----

  addDigestLine(event: string, text: string, link: string | null, now: number): void {
    this.db
      .prepare(
        'INSERT INTO notification_digest_lines (event, text, link, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(event, text, link, now);
  }

  digestLines(): { id: number; event: string; text: string; link: string | null }[] {
    return this.db
      .prepare('SELECT id, event, text, link FROM notification_digest_lines ORDER BY id')
      .all() as { id: number; event: string; text: string; link: string | null }[];
  }

  deleteDigestLines(upToId: number): void {
    this.db.prepare('DELETE FROM notification_digest_lines WHERE id <= ?').run(upToId);
  }

  // ---- log / outbox ----

  queue(
    event: string,
    kind: LogRow['kind'],
    channel: Channel,
    text: string,
    now: number,
    /** When the sender may try it; null: never (a test, tried by its caller). */
    nextAt: number | null = now,
  ): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO notification_log (created_at, event, kind, channel, text, status, attempts, next_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
        )
        .run(now, event, kind, channel, text, nextAt).lastInsertRowid,
    );
  }

  due(now: number, limit = 20): LogRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_log WHERE status = 'pending' AND next_at <= ?
         ORDER BY id LIMIT ?`,
      )
      .all(now, limit) as LogRow[];
  }

  getLog(id: number): LogRow | undefined {
    return this.db.prepare('SELECT * FROM notification_log WHERE id = ?').get(id) as
      | LogRow
      | undefined;
  }

  markSent(id: number, attempts: number, now: number): void {
    this.db
      .prepare(
        `UPDATE notification_log SET status = 'sent', attempts = ?, sent_at = ?, error = NULL,
           next_at = NULL WHERE id = ?`,
      )
      .run(attempts, now, id);
  }

  markRetry(id: number, attempts: number, nextAt: number, error: string): void {
    this.db
      .prepare('UPDATE notification_log SET attempts = ?, next_at = ?, error = ? WHERE id = ?')
      .run(attempts, nextAt, error, id);
  }

  markFailed(id: number, attempts: number, error: string): void {
    this.db
      .prepare(
        `UPDATE notification_log SET status = 'failed', attempts = ?, error = ?, next_at = NULL
         WHERE id = ?`,
      )
      .run(attempts, error, id);
  }

  recentLog(limit: number): LogRow[] {
    return this.db
      .prepare('SELECT * FROM notification_log ORDER BY id DESC LIMIT ?')
      .all(limit) as LogRow[];
  }

  /** Keeps the newest `keep` messages (never one still waiting to be sent). */
  prune(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM notification_log WHERE status <> 'pending' AND id <= (
           SELECT id FROM notification_log ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(keep);
  }
}
