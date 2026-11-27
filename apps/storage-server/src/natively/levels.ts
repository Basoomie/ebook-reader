/**
 * The Natively level (2026-11-24): the server reads each linked book's level from its Natively
 * page and keeps the last one read (ttsu.db `natively_levels`, mirrored on `books` for the
 * level: filter and the Level sort; migration 32).
 *
 * - One request at a time, at least `requestSeconds` apart (Settings › Library › Book page).
 * - A book page that opens asks for its level again when the saved one is older than
 *   `maxAgeDays`; that request goes ahead of the first pass.
 * - The first pass: every Natively id of a book in the library with no saved level (at start,
 *   after an index of the library at most once a minute (wake), and once a day), so books that
 *   get an id later are read too. Its progress (done, left, time left) is shown in Settings. An
 *   id whose page fails 3 times is left to the book page (it asks again on every open).
 * - Refused or failed requests (429, 5xx, no answer) wait, twice as long each time up to
 *   `maxBackoffMinutes`; a page that is gone (404) clears the level; an error keeps the last
 *   level read.
 *
 * Only Natively's book pages are asked (robots.txt allows them; never its search). The cleanup's
 * fetch container and cache are not used.
 *
 * Store ratings (2026-11-25): the same page's learners' rating is saved too (store_ratings, site
 * 'natively'); the first pass also reads every id without one, once.
 */
import type Database from 'better-sqlite3';
import { noteFiguresWrite } from '../catalog/catalog-version';
import { saveRating } from '../ratings/store';
import { NATIVELY_ID_RE, parseNativelyLevel, parseNativelyReviews } from './parse';
import { readNativelySettings, type NativelySettings } from './settings';

export const NATIVELY_BASE_URL = 'https://learnnatively.com';

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface LevelRow {
  nativelyId: string;
  level: number | null;
  temporary: boolean;
  state: 'ok' | 'none' | 'gone' | 'error';
  checkedAt: number;
}

export interface NativelyProgress {
  /** The first pass: ids it set out to read, how many are done, and the time left (seconds). */
  pass: { running: boolean; total: number; done: number; left: number; secondsLeft: number };
  /** Books with a Natively id and a saved level / without one yet. */
  saved: number;
  /** When requests may start again after a refusal (ms), or null. */
  waitingUntil: number | null;
  lastError: string | null;
}

interface Options {
  db: Database.Database;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  log?: (line: string) => void;
  /** How long one request may take (seconds). */
  timeoutSeconds?: number;
  /** How often the first pass looks for ids without a level (ms; default a day). */
  passEveryMs?: number;
  /** Milliseconds in one of the settings' seconds (tests make the pace short; default 1000). */
  msPerSecond?: number;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; ttsu-reader; personal library)';

export class NativelyLevels {
  readonly db: Database.Database;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly passEveryMs: number;
  private readonly unit: number;

  /** On-open refreshes, first come first served, ahead of the pass. */
  private readonly urgent = new Set<string>();
  private pass: string[] = [];
  private passTotal = 0;
  private passDone = 0;
  private passRunning = false;
  private readonly waiters = new Map<string, ((row: LevelRow | null) => void)[]>();

  private lastRequestAt = 0;
  private readonly intervals: number[] = [];
  private backoffMs = 0;
  private waitingUntil = 0;
  private lastError: string | null = null;

  private running = false;
  private stopped = false;
  private wakeLoop: (() => void) | null = null;
  private passTimer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private lastWake = 0;

  constructor(opts: Options) {
    this.db = opts.db;
    this.fetchFn =
      opts.fetch ??
      ((url, init) =>
        fetch(url, init) as unknown as Promise<{ status: number; text(): Promise<string> }>);
    this.baseUrl = (opts.baseUrl ?? NATIVELY_BASE_URL).replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.timeoutMs = (opts.timeoutSeconds ?? 30) * 1000;
    this.passEveryMs = opts.passEveryMs ?? 24 * 3600_000;
    this.unit = opts.msPerSecond ?? 1000;
  }

  settings(): NativelySettings {
    return readNativelySettings(this.db);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.startPass();
    this.passTimer = setInterval(() => this.startPass(), this.passEveryMs);
    this.passTimer.unref?.();
    this.loop = this.run().catch((err) => {
      console.error('Natively levels: the reader stopped:', err);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.passTimer) clearInterval(this.passTimer);
    this.passTimer = null;
    this.wakeLoop?.();
    for (const [, list] of this.waiters) for (const w of list) w(null);
    this.waiters.clear();
    await this.loop;
    this.running = false;
  }

  /** The book's Natively id (a direct link), or null. */
  nativelyIdOf(bookId: string): string | null {
    const r = this.db
      .prepare("SELECT value FROM book_identifiers WHERE book_id = ? AND type = 'natively'")
      .get(bookId) as { value: string } | undefined;
    const id = r?.value.trim();
    return id && NATIVELY_ID_RE.test(id) ? id : null;
  }

  saved(nativelyId: string): LevelRow | null {
    const r = this.db
      .prepare(
        'SELECT natively_id, level, temporary, state, checked_at FROM natively_levels WHERE natively_id = ?',
      )
      .get(nativelyId) as
      | {
          natively_id: string;
          level: number | null;
          temporary: number;
          state: LevelRow['state'];
          checked_at: number;
        }
      | undefined;
    if (!r) return null;
    return {
      nativelyId: r.natively_id,
      level: r.level,
      temporary: r.temporary === 1,
      state: r.state,
      checkedAt: r.checked_at,
    };
  }

  /** True when the saved level is missing or older than the setting. */
  isOld(row: LevelRow | null): boolean {
    if (!row || row.checkedAt === 0) return true;
    return this.now() - row.checkedAt > this.settings().maxAgeDays * 86400 * this.unit;
  }

  /**
   * The book page's refresh: reads the level again ahead of the pass when the saved one is old,
   * waiting up to `waitMs` for the answer; else (or when it takes longer) the saved one.
   */
  async refresh(nativelyId: string, waitMs: number): Promise<LevelRow | null> {
    const saved = this.saved(nativelyId);
    if (!this.isOld(saved) || !this.running || this.stopped) return saved;
    const answer = new Promise<LevelRow | null>((resolve) => {
      const list = this.waiters.get(nativelyId) ?? [];
      list.push(resolve);
      this.waiters.set(nativelyId, list);
    });
    this.urgent.add(nativelyId);
    this.wakeLoop?.();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<LevelRow | null>((resolve) => {
      timer = setTimeout(() => resolve(this.saved(nativelyId)), waitMs);
    });
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  progress(): NativelyProgress {
    const left = this.pass.length;
    const counts = this.db
      .prepare(
        `SELECT COUNT(DISTINCT bi.value) AS ids,
                COUNT(DISTINCT CASE WHEN nl.level IS NOT NULL THEN bi.value END) AS saved
         FROM book_identifiers bi LEFT JOIN natively_levels nl ON nl.natively_id = bi.value
         WHERE bi.type = 'natively'`,
      )
      .get() as { ids: number; saved: number };
    return {
      pass: {
        running: this.passRunning,
        total: this.passTotal,
        done: this.passDone,
        left,
        secondsLeft: Math.round((left * this.stepMs()) / this.unit),
      },
      saved: counts.saved,
      waitingUntil: this.waitingUntil > this.now() ? this.waitingUntil : null,
      lastError: this.lastError,
    };
  }

  /** The time one request takes from start to start (measured, else the setting). */
  private stepMs(): number {
    const set = this.settings().requestSeconds * this.unit;
    if (this.intervals.length < 3) return set;
    const avg = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
    return Math.max(set, avg);
  }

  /** Every Natively id of a book in the library with no level read yet (or only failures). */
  private missingIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT bi.value AS id FROM book_identifiers bi
         JOIN book_sources s ON s.book_id = bi.book_id AND s.missing_at IS NULL
         LEFT JOIN natively_levels nl ON nl.natively_id = bi.value
         LEFT JOIN store_ratings sr ON sr.site = 'natively' AND sr.site_id = bi.value
         WHERE bi.type = 'natively'
           AND (nl.natively_id IS NULL
                OR (nl.state = 'error' AND nl.checked_at = 0 AND nl.fails < 3)
                OR (sr.site IS NULL AND nl.state <> 'error'))
         ORDER BY bi.value`,
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id.trim()).filter((id) => NATIVELY_ID_RE.test(id));
  }

  /** After an index of the library (indexer.ts): new links start a pass, at most once a minute. */
  wake(): void {
    if (!this.running || this.stopped) return;
    const now = this.now();
    if (now - this.lastWake < 60 * this.unit) return;
    this.lastWake = now;
    this.startPass();
  }

  /** Starts the first pass unless one is running (no-op when nothing is missing). */
  startPass(): void {
    if (this.passRunning || this.stopped) return;
    const ids = this.missingIds();
    if (ids.length === 0) return;
    this.pass = ids;
    this.passTotal = ids.length;
    this.passDone = 0;
    this.passRunning = true;
    this.log(`Natively levels: reading the levels of ${ids.length} books`);
    this.wakeLoop?.();
  }

  private next(): { id: string; urgent: boolean } | null {
    for (const id of this.urgent) {
      this.urgent.delete(id);
      return { id, urgent: true };
    }
    const id = this.pass.shift();
    if (id !== undefined) return { id, urgent: false };
    if (this.passRunning) {
      this.passRunning = false;
      this.log(`Natively levels: read ${this.passDone} of ${this.passTotal} books`);
    }
    return null;
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.stopped) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.wakeLoop = null;
        resolve();
      }, ms);
      this.wakeLoop = () => {
        clearTimeout(t);
        this.wakeLoop = null;
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      // Pace and back-off first (an on-open request waits for them too).
      const due = Math.max(
        this.lastRequestAt + this.settings().requestSeconds * this.unit,
        this.waitingUntil,
      );
      const wait = due - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      const job = this.next();
      if (!job) {
        await this.sleep(3600_000);
        continue;
      }
      // Skip an id another request already read while it waited (fresh enough).
      if (job.urgent && !this.isOld(this.saved(job.id))) {
        this.settle(job.id);
        continue;
      }
      const started = this.now();
      if (this.lastRequestAt) {
        this.intervals.push(started - this.lastRequestAt);
        if (this.intervals.length > 20) this.intervals.shift();
      }
      this.lastRequestAt = started;
      const retry = await this.read(job.id);
      if (retry && !job.urgent) this.pass.unshift(job.id);
      else if (!job.urgent) this.passDone += 1;
      this.settle(job.id);
    }
  }

  private settle(id: string): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    const row = this.saved(id);
    for (const w of list) w(row);
  }

  /** One request; returns true when it should be tried again after the back-off. */
  private async read(id: string): Promise<boolean> {
    const url = `${this.baseUrl}/book/${encodeURIComponent(id)}/`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let status = 0;
    let body = '';
    try {
      const res = await this.fetchFn(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      status = res.status;
      if (status === 200) body = await res.text();
    } catch (err) {
      clearTimeout(timer);
      return this.failed(id, `no answer (${(err as Error).message})`, true);
    }
    clearTimeout(timer);
    if (status === 404 || status === 410) {
      this.save(id, { level: null, temporary: false, state: 'gone' });
      this.saveReviews(id, null, true);
      this.succeeded();
      return false;
    }
    if (status === 429 || status >= 500) return this.failed(id, `HTTP ${status}`, true);
    if (status !== 200) return this.failed(id, `HTTP ${status}`, false);
    const parsed = parseNativelyLevel(body);
    this.succeeded();
    this.saveReviews(id, body, false);
    if (parsed.kind === 'level') {
      this.save(id, { level: parsed.level, temporary: parsed.temporary, state: 'ok' });
    } else if (parsed.kind === 'none') {
      this.save(id, { level: null, temporary: false, state: 'none' });
    } else {
      this.failed(id, "the page's level couldn't be read", false);
    }
    return false;
  }

  /** The page's learners' rating (store ratings); never breaks the level's read. */
  private saveReviews(id: string, body: string | null, gone: boolean): void {
    try {
      const now = this.now();
      if (gone) {
        saveRating(this.db, 'natively', id, { kind: 'gone' }, now);
        return;
      }
      const r = body ? parseNativelyReviews(body) : null;
      if (!r) return;
      saveRating(
        this.db,
        'natively',
        id,
        r.count > 0 && r.avg !== null
          ? { kind: 'rating', avg: r.avg, count: r.count, reviews: null }
          : { kind: 'none' },
        now,
      );
    } catch (err) {
      this.log(
        `Natively levels: ${id}: the learners' rating wasn't saved: ${(err as Error).message}`,
      );
    }
  }

  private succeeded(): void {
    if (this.backoffMs) this.log('Natively levels: Natively answers again');
    this.backoffMs = 0;
    this.waitingUntil = 0;
  }

  private failed(id: string, error: string, backOff: boolean): boolean {
    this.lastError = error;
    this.db
      .prepare(
        `INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at, error, fails)
         VALUES (?, NULL, 0, 'error', 0, ?, 1)
         ON CONFLICT(natively_id) DO UPDATE SET state = 'error', error = excluded.error,
           fails = fails + 1`,
      )
      .run(id, error);
    if (!backOff) {
      this.log(`Natively levels: ${id}: ${error}`);
      return false;
    }
    const max = this.settings().maxBackoffMinutes * 60 * this.unit;
    this.backoffMs = Math.min(max, this.backoffMs ? this.backoffMs * 2 : 60 * this.unit);
    this.waitingUntil = this.now() + this.backoffMs;
    this.log(
      `Natively levels: ${error}; waiting ${Math.round(this.backoffMs / (60 * this.unit))} min before the next request`,
    );
    return true;
  }

  private save(
    id: string,
    v: { level: number | null; temporary: boolean; state: LevelRow['state'] },
  ): void {
    const before = this.saved(id);
    this.db
      .prepare(
        `INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at, error, fails)
         VALUES (@id, @level, @temporary, @state, @now, NULL, 0)
         ON CONFLICT(natively_id) DO UPDATE SET level = excluded.level,
           temporary = excluded.temporary, state = excluded.state,
           checked_at = excluded.checked_at, error = NULL, fails = 0`,
      )
      .run({ id, level: v.level, temporary: v.temporary ? 1 : 0, state: v.state, now: this.now() });
    this.lastError = null;
    if (!before || before.level !== v.level || before.temporary !== v.temporary) {
      noteFiguresWrite(this.db);
    }
  }
}
