/**
 * The series-arrival alert (2026-11-25, docs/design/series-arrivals.md): when a book arrives
 * in the library and it belongs to a series you're reading, you're told once (an alert and a
 * digest line per series). Rounds every minute inside the storage server; nothing is recorded
 * while the alert is off in Settings › Notifications.
 *
 * - On: the Library and data section on and the event switched on for a channel. Switching it
 *   on records `on_since`; books created before are never announced (and switching it on
 *   later sends no backlog). Off forgets on_since and the series (decided books stay decided).
 * - The series you're reading are recorded with `since` = the round that first saw them; a
 *   book created before its series counted is not news.
 * - A book waits until the cleanup's new arrivals are done with it (its series, number and
 *   library are final), at most the wait time; then it is decided once (rules.ts) and recorded.
 * - One message per round for every book told in it.
 */
import type Database from 'better-sqlite3';
import { buildMessage, type ToldBook } from './message';
import { SERIES_ARRIVAL_EVENT } from './events';
import { countPending, decide, pendingBooks, readingSeries } from './rules';

export interface SeriesArrivalNotifications {
  settings(): {
    sections: Record<string, boolean>;
    events: Record<string, { discord: boolean; email: boolean }>;
    waits: { seriesArrivalWaitHours: number };
  };
  notify(m: { event: string; lines: string[]; link: string | null }): void;
  addDigestLine(event: string, text: string, link?: string | null): void;
  poke?(): void;
}

export interface SeriesArrivalsDeps {
  db: Database.Database;
  notifications: SeriesArrivalNotifications | null;
  /**
   * The cleanup's new arrivals are done with the books first indexed before this time
   * (Infinity: every book, as without the cleanup; -Infinity: a run is open).
   */
  arrivalsDoneBefore?: () => number;
  now?: () => number;
  log?: (line: string) => void;
  roundMs?: number;
}

export interface RoundResult {
  on: boolean;
  told: number;
  decided: number;
  waiting: number;
}

export class SeriesArrivals {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SeriesArrivalsDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(l));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.safeRound(), this.deps.roundMs ?? 60_000);
    this.timer.unref();
    setTimeout(() => this.safeRound(), 5_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private safeRound(): void {
    try {
      this.round();
    } catch (err) {
      console.error('Series arrivals: a round failed:', err);
    }
  }

  /** Whether the alert is switched on (its section and a channel's switch). */
  isOn(): boolean {
    const n = this.deps.notifications;
    if (!n) return false;
    const s = n.settings();
    const sw = s.events[SERIES_ARRIVAL_EVENT];
    return !!s.sections.data && !!sw && (sw.discord || sw.email);
  }

  round(): RoundResult {
    const on = this.isOn();
    const users = (
      this.db.prepare('SELECT id FROM users ORDER BY created_at').all() as { id: string }[]
    ).map((r) => r.id);
    const result: RoundResult = { on, told: 0, decided: 0, waiting: 0 };
    if (!on) {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM series_arrival_state').run();
        this.db.prepare('DELETE FROM series_arrival_series').run();
      })();
      return result;
    }
    const waitMs = this.deps.notifications!.settings().waits.seriesArrivalWaitHours * 3_600_000;
    for (const userId of users) {
      const r = this.userRound(userId, waitMs);
      result.told += r.told;
      result.decided += r.decided;
      result.waiting += r.waiting;
    }
    return result;
  }

  private userRound(userId: string, waitMs: number): Omit<RoundResult, 'on'> {
    const now = this.now();
    const told: ToldBook[] = [];
    let decided = 0;
    let waiting = 0;
    this.db.transaction(() => {
      const state = this.db
        .prepare('SELECT on_since FROM series_arrival_state WHERE user_id = ?')
        .get(userId) as { on_since: number } | undefined;
      const onSince = state?.on_since ?? now;
      if (!state) {
        this.db
          .prepare('INSERT INTO series_arrival_state (user_id, on_since) VALUES (?, ?)')
          .run(userId, now);
      }

      // The series you're reading now; a new one counts from this round, one no longer read
      // is forgotten (it counts again from when it is read again, or shown again).
      const reading = readingSeries(this.db, userId);
      const known = new Map(
        (
          this.db
            .prepare(
              'SELECT library_id, series_id, since FROM series_arrival_series WHERE user_id = ?',
            )
            .all(userId) as { library_id: string; series_id: number; since: number }[]
        ).map((r) => [`${r.library_id}\u0000${r.series_id}`, r.since]),
      );
      const since = new Map<string, number>();
      const add = this.db.prepare(
        'INSERT INTO series_arrival_series (user_id, library_id, series_id, since) VALUES (?, ?, ?, ?)',
      );
      for (const s of reading) {
        const key = `${s.libraryId}\u0000${s.seriesId}`;
        const at = known.get(key);
        if (at === undefined) add.run(userId, s.libraryId, s.seriesId, now);
        since.set(key, at ?? now);
        known.delete(key);
      }
      const drop = this.db.prepare(
        'DELETE FROM series_arrival_series WHERE user_id = ? AND library_id = ? AND series_id = ?',
      );
      for (const key of known.keys()) {
        const [lib, sid] = key.split('\u0000');
        drop.run(userId, lib, Number(sid));
      }

      const record = this.db.prepare(
        `INSERT INTO series_arrival_books
           (user_id, book_id, decided_at, told, reason, library_id, series_id, series_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Settled: older than the wait time, or the new arrivals are done with it.
      const done = this.doneBefore();
      const before = Math.min(Math.max(now - waitMs + 1, done), Number.MAX_SAFE_INTEGER);
      for (const b of pendingBooks(this.db, userId, onSince, before)) {
        const d = decide(b, since.get(`${b.libraryId}\u0000${b.seriesId}`));
        // Past the wait time but its run still going (a long run writes series late, and a
        // book still has Calibre's own series name): it may be told now, but "no series" or
        // "not a series you're reading" waits for the run to end, so no volume is missed.
        if (b.createdAt >= done && (d === 'no_series' || d === 'not_reading')) continue;
        record.run(
          userId,
          b.id,
          now,
          d === 'told' ? 1 : 0,
          d,
          b.libraryId,
          b.seriesId,
          b.seriesIndex,
        );
        decided++;
        if (d === 'told') {
          told.push({
            id: b.id,
            title: b.title,
            libraryId: b.libraryId,
            seriesName: b.seriesName ?? '',
            seriesIndex: b.seriesIndex,
          });
        }
      }
      waiting = countPending(this.db, userId, onSince);
    })();
    if (told.length) this.tell(told);
    return { told: told.length, decided, waiting };
  }

  /** The cleanup's answer; when it can't be read, nothing counts as done but the wait time. */
  private doneBefore(): number {
    if (!this.deps.arrivalsDoneBefore) return Infinity;
    try {
      return this.deps.arrivalsDoneBefore();
    } catch (err) {
      console.error('Series arrivals: could not read the new arrivals:', err);
      return -Infinity;
    }
  }

  private tell(books: ToldBook[]): void {
    const n = this.deps.notifications;
    const m = buildMessage(books);
    if (!n || !m) return;
    try {
      n.notify({ event: SERIES_ARRIVAL_EVENT, lines: m.lines, link: m.link });
      for (const d of m.digest) n.addDigestLine(SERIES_ARRIVAL_EVENT, d.text, d.link);
      n.poke?.();
    } catch (err) {
      console.error('Series arrivals: could not tell:', err);
    }
    this.log(`Series arrivals: told ${books.length} new volume(s)`);
  }
}
