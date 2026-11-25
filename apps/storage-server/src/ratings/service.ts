/**
 * Store ratings (2026-11-25, docs/design/store-ratings.md): what other readers thought of a book,
 * read from its store pages by the ids its links use.
 *
 * - **First fill** (at start, then after each index at most every 10 minutes): every Amazon and
 *   BOOK☆WALKER id without a saved figure is read from the page the cleanup's stage 4 cached
 *   (CACHE_DIR/cleanup/fetch, read only), dated by the file. No requests.
 * - **Refresher** (setting `refresh`, Off after deploy): asks the cleanup's fetch queue, so the
 *   pages come through the fetch container and its VPN at each site's pace and back-off, behind
 *   every cleanup request (priority below theirs). Ids never read go first, then by age: books
 *   published in the last 6 months every `newDays`, in the last 2 years every `recentDays`, older
 *   every `oldDays`. One request row per id (key `ratings:<id>`), put back in line when due; its
 *   answer is read, saved and its cached file deleted, so the cleanup's own answers are never
 *   changed and the cache doesn't grow. 読書メーター only with its setting on.
 * - **On open**: a book page whose figures are older than `openMaxAgeDays` asks again ahead of
 *   the routine (still behind the cleanup).
 * - The Rating sort's `m` (the median pooled average) is worked out after each fill and daily.
 *
 * Natively's learners' rating comes from the Natively level's own reader (natively/levels.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import type { FetchQueue } from '../cleanup/stage4/queue';
import type { FetchSite } from '../cleanup/settings';
import {
  parseAmazonRating,
  parseBookmeterCounts,
  parseBookwalkerRating,
  type ParsedRating,
} from './parse';
import { readRatingSettings, type RatingSettings } from './settings';
import {
  SITE_ID_RE,
  bookSiteIds,
  bookRatings,
  saveRating,
  updateScoreParams,
  type RatingRow,
  type RatingSite,
} from './store';

/** The sites read through the fetch queue (Natively has its own reader). */
export type FetchedSite = Exclude<RatingSite, 'natively'>;
export const FETCHED_SITES: FetchedSite[] = ['amazon_jp', 'bookwalker', 'bookmeter'];

/** Below every cleanup request (the lowest the cleanup uses is -1). */
export const ROUTINE_PRIORITY = -5;
export const OPEN_PRIORITY = -2;

const DAY = 86_400_000;

export const QUEUE_SITE: Record<FetchedSite, FetchSite> = {
  amazon_jp: 'amazon-dp',
  bookwalker: 'bookwalker',
  bookmeter: 'bookmeter',
};

export function pageUrl(site: FetchedSite, id: string): string {
  switch (site) {
    case 'amazon_jp':
      return `https://www.amazon.co.jp/dp/${id}`;
    case 'bookwalker':
      return `https://bookwalker.jp/de${id}/`;
    case 'bookmeter':
      return `https://bookmeter.com/books/${id}`;
  }
}

export function parsePage(site: FetchedSite, id: string, html: string): ParsedRating {
  switch (site) {
    case 'amazon_jp':
      return parseAmazonRating(html);
    case 'bookwalker':
      return parseBookwalkerRating(html, id);
    case 'bookmeter':
      return parseBookmeterCounts(html);
  }
}

/** Stage 4's cached page of an id (its request key), relative to CACHE_DIR/cleanup. */
export function stage4CacheFile(site: 'amazon_jp' | 'bookwalker', id: string): string {
  const qsite = QUEUE_SITE[site];
  const key = site === 'amazon_jp' ? id : `https://bookwalker.jp/de${id}/`;
  const h = createHash('sha256').update(`${qsite}\n${key}`).digest('hex');
  return path.join('fetch', qsite, h.slice(0, 2), `${h}.br`);
}

/** How long an id's figures stay fresh, by its earliest book's publication date. */
export function refreshAfterMs(s: RatingSettings, publishedAt: number | null, now: number): number {
  if (publishedAt !== null && now - publishedAt < 183 * DAY) return s.newDays * DAY;
  if (publishedAt !== null && now - publishedAt < 730 * DAY) return s.recentDays * DAY;
  return s.oldDays * DAY;
}

export interface RatingsProgress {
  fill: { running: boolean; total: number; done: number; found: number; secondsLeft: number };
  refresh: {
    on: boolean;
    /** False when the cleanup (and its fetch queue) isn't running on this server. */
    available: boolean;
    waiting: number;
    /** Ids due now (never read or old), per site. */
    due: Record<string, number>;
  };
  /** Saved figures per site (state ok). */
  saved: Record<string, number>;
  lastError: string | null;
}

interface Options {
  db: Database.Database;
  /** CACHE_DIR (the cleanup's cache is CACHE_DIR/cleanup); null = no first fill. */
  cacheDir: string | null;
  /** The cleanup's fetch queue; null when the cleanup is off (no refresher). */
  queue: () => FetchQueue | null;
  now?: () => number;
  log?: (line: string) => void;
  /** How often the refresher looks (ms; default 5 min). */
  tickMs?: number;
}

export class StoreRatings {
  readonly db: Database.Database;
  private readonly cacheDir: string | null;
  private readonly queue: () => FetchQueue | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;

  private fill = { running: false, total: 0, done: 0, found: 0, startedAt: 0 };
  private lastFillAt = 0;
  private lastParamsAt = 0;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Set by stop(): a running first fill ends early. */
  private halted = false;
  private ticking = false;
  private dueCounts: Record<string, number> = {};
  private dueAt = 0;

  constructor(opts: Options) {
    this.db = opts.db;
    this.cacheDir = opts.cacheDir;
    this.queue = opts.queue;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.tickMs = opts.tickMs ?? 5 * 60_000;
  }

  settings(): RatingSettings {
    return readRatingSettings(this.db);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    void this.firstFill();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** After an index of the library: new ids get a first fill, at most every 10 minutes. */
  wake(): void {
    if (this.stopped || this.now() - this.lastFillAt < 600_000) return;
    void this.firstFill();
  }

  /** An answer arrived in the fetch queue: collect ours soon. */
  answerArrived(): void {
    if (this.stopped || this.ticking) return;
    setTimeout(() => void this.collect(), 1000).unref?.();
  }

  // ------------------------------------------------------------ first fill

  /** The Amazon and BOOK☆WALKER ids of books in the library with no saved figure. */
  private unfilledIds(): { site: 'amazon_jp' | 'bookwalker'; id: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT bi.type AS site, bi.value AS id FROM book_identifiers bi
         JOIN book_sources s ON s.book_id = bi.book_id AND s.missing_at IS NULL
         LEFT JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
         WHERE bi.type IN ('amazon_jp', 'bookwalker') AND r.site IS NULL`,
      )
      .all() as { site: 'amazon_jp' | 'bookwalker'; id: string }[];
    return rows
      .map((r) => ({ site: r.site, id: r.id.trim() }))
      .filter((r) => SITE_ID_RE[r.site].test(r.id));
  }

  /** Reads every unfilled id's cached page; resolves when done (in short turns). */
  async firstFill(): Promise<void> {
    if (this.fill.running || !this.cacheDir) return;
    const root = path.join(this.cacheDir, 'cleanup');
    if (!fs.existsSync(path.join(root, 'fetch'))) return;
    this.lastFillAt = this.now();
    const ids = this.unfilledIds();
    if (ids.length === 0) {
      this.updateParams();
      return;
    }
    this.fill = { running: true, total: ids.length, done: 0, found: 0, startedAt: this.now() };
    this.log(`Store ratings: reading ${ids.length} cached store pages`);
    try {
      for (let i = 0; i < ids.length && !this.halted; i += 50) {
        this.db.transaction(() => {
          for (const { site, id } of ids.slice(i, i + 50)) {
            const file = path.join(root, stage4CacheFile(site, id));
            let html: string;
            let mtime: number;
            try {
              const st = fs.statSync(file);
              mtime = Math.round(st.mtimeMs);
              html = brotliDecompressSync(fs.readFileSync(file)).toString('utf8');
            } catch {
              this.fill.done += 1;
              continue;
            }
            const parsed = parsePage(site, id, html);
            // A cached page that can't be read is left to the refresher (no row).
            if (parsed.kind !== 'unreadable') {
              saveRating(this.db, site, id, parsed, mtime);
              this.fill.found += 1;
            } else if (
              site === 'amazon_jp' &&
              /ページが見つかりません|Page Not Found/i.test(html)
            ) {
              saveRating(this.db, site, id, { kind: 'gone' }, mtime);
              this.fill.found += 1;
            }
            this.fill.done += 1;
          }
        })();
        await new Promise<void>((r) => setImmediate(r));
      }
      this.log(
        `Store ratings: read ${this.fill.found} of ${this.fill.total} ids from cached pages`,
      );
    } catch (err) {
      this.lastError = `first fill: ${(err as Error).message}`;
      console.error('Store ratings: the first fill stopped:', err);
    } finally {
      this.fill.running = false;
      this.updateParams();
    }
  }

  private updateParams(): void {
    this.lastParamsAt = this.now();
    try {
      updateScoreParams(this.db, this.settings().scoreRatings);
    } catch (err) {
      console.error('Store ratings: the score could not be updated:', err);
    }
  }

  // ------------------------------------------------------------ refresher

  /** One round: collect answers, then queue what's due (only with `refresh` on). */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (this.now() - this.lastParamsAt > DAY && !this.fill.running) this.updateParams();
      const s = this.settings();
      const q = this.queue();
      if (!q) return;
      this.collectWith(q);
      if (!s.refresh) return;
      for (const site of FETCHED_SITES) {
        if (site === 'bookmeter' && !s.bookmeter) continue;
        this.enqueueDue(q, s, site);
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error('Store ratings: the refresher failed a round:', err);
    } finally {
      this.ticking = false;
    }
  }

  private async collect(): Promise<void> {
    const q = this.queue();
    if (!q || this.ticking) return;
    this.ticking = true;
    try {
      this.collectWith(q);
    } catch (err) {
      this.lastError = (err as Error).message;
    } finally {
      this.ticking = false;
    }
  }

  /** Saves every answered request we wait on and deletes its cached file. */
  private collectWith(q: FetchQueue): number {
    const waiting = this.db
      .prepare('SELECT site, site_id, request_id FROM store_rating_requests')
      .all() as { site: FetchedSite; site_id: string; request_id: number }[];
    let saved = 0;
    for (const w of waiting) {
      const state = q.requestState(w.request_id);
      if (state === 'queued' || state === 'leased') continue;
      const now = this.now();
      if (state === 'done') {
        const body = q.readAnswer(w.request_id);
        const parsed = body
          ? parsePage(w.site, w.site_id, body.toString('utf8'))
          : ({ kind: 'unreadable' } as const);
        saveRating(this.db, w.site, w.site_id, parsed, now);
      } else if (state === 'gone') {
        saveRating(this.db, w.site, w.site_id, { kind: 'gone' }, now);
      } else {
        saveRating(this.db, w.site, w.site_id, { kind: 'error', error: 'the fetch failed' }, now);
      }
      q.forgetAnswer(w.request_id);
      this.db
        .prepare('DELETE FROM store_rating_requests WHERE site = ? AND site_id = ?')
        .run(w.site, w.site_id);
      saved += 1;
    }
    return saved;
  }

  /** The ids of a site due now, oldest first (never read first). */
  dueIds(site: FetchedSite, limit: number): string[] {
    const s = this.settings();
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT bi.value AS id, MIN(b.published_at) AS pub, r.checked_at AS checked, r.state AS state,
                r.fails AS fails
         FROM book_identifiers bi
         JOIN books b ON b.id = bi.book_id
         JOIN book_sources src ON src.book_id = bi.book_id AND src.missing_at IS NULL
         LEFT JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
         LEFT JOIN store_rating_requests q ON q.site = bi.type AND q.site_id = bi.value
         WHERE bi.type = ? AND q.site IS NULL
           AND (r.checked_at IS NULL OR r.checked_at < ?)
         GROUP BY bi.value
         ORDER BY r.checked_at IS NOT NULL, r.checked_at`,
      )
      .all(site, now - s.newDays * DAY) as {
      id: string;
      pub: number | null;
      checked: number | null;
      state: RatingRow['state'] | null;
      fails: number | null;
    }[];
    const out: string[] = [];
    for (const r of rows) {
      const id = r.id.trim();
      if (!SITE_ID_RE[site].test(id)) continue;
      if (r.checked !== null) {
        // A failed read is tried again after a day (three times), then at the old-book pace.
        const wait =
          r.state === 'error' && (r.fails ?? 0) < 3 ? DAY : refreshAfterMs(s, r.pub, now);
        if (now - r.checked < wait) continue;
      }
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  }

  private enqueueDue(q: FetchQueue, s: RatingSettings, site: FetchedSite): void {
    const waiting = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM store_rating_requests WHERE site = ?')
        .get(site) as { n: number }
    ).n;
    const room = s.queuedPerSite - waiting;
    if (room <= 0) return;
    for (const id of this.dueIds(site, room)) this.ask(q, site, id, ROUTINE_PRIORITY);
  }

  /** Puts one id's page in the fetch queue (a known request is put back in line). */
  private ask(q: FetchQueue, site: FetchedSite, id: string, priority: number): void {
    const now = this.now();
    const row = q.enqueue(
      { site: QUEUE_SITE[site], key: `ratings:${id}`, url: pageUrl(site, id), priority },
      null,
      now,
    );
    if (row.state !== 'queued' && row.state !== 'leased') q.requeue(row.id, priority, now);
    this.db
      .prepare(
        `INSERT INTO store_rating_requests (site, site_id, request_id, asked_at, urgent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site, site_id) DO UPDATE SET urgent = MAX(urgent, excluded.urgent)`,
      )
      .run(site, id, row.id, now, priority === OPEN_PRIORITY ? 1 : 0);
  }

  // ------------------------------------------------------------ the book page

  /**
   * A book's saved figures. With `fresh`, old or missing figures of its ids are asked for ahead
   * of the routine (when fetching is on); the answer comes on a later read (`refreshing`).
   */
  forBook(bookId: string, fresh: boolean): { rows: RatingRow[]; refreshing: boolean } {
    const s = this.settings();
    const ids = bookSiteIds(this.db, bookId);
    const saved = bookRatings(this.db, bookId);
    let refreshing = false;
    const q = s.refresh ? this.queue() : null;
    for (const site of FETCHED_SITES) {
      const id = ids.get(site);
      if (!id || (site === 'bookmeter' && !s.bookmeter)) continue;
      const pending = this.db
        .prepare('SELECT 1 FROM store_rating_requests WHERE site = ? AND site_id = ?')
        .get(site, id);
      if (pending) {
        refreshing = true;
        if (fresh && q) this.raise(q, site, id);
        continue;
      }
      if (!fresh || !q) continue;
      const row = saved.get(site);
      if (row && this.now() - row.checkedAt < s.openMaxAgeDays * DAY) continue;
      this.ask(q, site, id, OPEN_PRIORITY);
      refreshing = true;
    }
    const rows = [...saved.values()].filter((r) => r.site !== 'bookmeter' || s.bookmeter);
    return { rows, refreshing };
  }

  private raise(q: FetchQueue, site: FetchedSite, id: string): void {
    const r = this.db
      .prepare('SELECT request_id FROM store_rating_requests WHERE site = ? AND site_id = ?')
      .get(site, id) as { request_id: number } | undefined;
    if (r) q.requeue(r.request_id, OPEN_PRIORITY, this.now());
  }

  /** After a settings change: the score follows its setting; switching on starts a round. */
  settingsChanged(before: RatingSettings, after: RatingSettings): void {
    this.dueAt = 0;
    if (before.scoreRatings !== after.scoreRatings) this.updateParams();
    if (after.refresh && (!before.refresh || after.bookmeter !== before.bookmeter)) {
      void this.tick();
    }
  }

  // ------------------------------------------------------------ progress

  progress(): RatingsProgress {
    const s = this.settings();
    const left = this.fill.total - this.fill.done;
    const elapsed = this.now() - this.fill.startedAt;
    const perId = this.fill.done > 0 ? elapsed / this.fill.done : 0;
    const saved: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT site, COUNT(*) AS n FROM store_ratings WHERE state = 'ok' GROUP BY site")
      .all() as { site: string; n: number }[]) {
      saved[r.site] = r.n;
    }
    const waiting = (
      this.db.prepare('SELECT COUNT(*) AS n FROM store_rating_requests').get() as { n: number }
    ).n;
    // Counting what's due walks every id: at most once a minute (the page polls this).
    if (this.now() - this.dueAt > 60_000) {
      const due: Record<string, number> = {};
      if (s.refresh) {
        for (const site of FETCHED_SITES) {
          if (site === 'bookmeter' && !s.bookmeter) continue;
          due[site] = this.dueIds(site, 1_000_000).length;
        }
      }
      this.dueCounts = due;
      this.dueAt = this.now();
    }
    const due = this.dueCounts;
    return {
      fill: {
        running: this.fill.running,
        total: this.fill.total,
        done: this.fill.done,
        found: this.fill.found,
        secondsLeft: this.fill.running ? Math.round((left * perId) / 1000) : 0,
      },
      refresh: { on: s.refresh, available: this.queue() !== null, waiting, due },
      saved,
      lastError: this.lastError,
    };
  }
}
