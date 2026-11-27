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
 * - **読書メーター's 登録数 from the saved searches** (after the first fill): a linked 読書メーター
 *   id without a figure takes its 登録 count from the newest saved Bookmeter search that lists it
 *   (the link fix searched every saved listing; the search list shows 登録, not the 感想
 *   count), dated by the search. No requests. 読書メーター's 感想 count is not shown (user,
 *   2026-11-25: left to a later review showcase, which reads the same page).
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
import { parseBookmeterSearch } from '../cleanup/stage4/store-links';
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
  updateScoreParamsAsync,
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
/** Where Bookmeter's searches start (stage4/store-links.ts `bookmeterSearchUrl`). */
const BOOKMETER_SEARCH_PREFIX = 'https://bookmeter.com/search?';

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

/** Identifier rows per slice of a library-wide query (a few ms each on the PC). */
const IDS_PER_SLICE = 500;
/** The longest a first fill reads cached pages before it lets the server answer (ms). */
const FILL_SLICE_MS = 20;
/** 読書メーター searches read at once (the files are read off the event loop). */
const SEARCH_READS_AT_ONCE = 32;

const nextTurn = () => new Promise<void>((r) => setImmediate(r));

/**
 * Runs `sql` over one type's identifiers a slice of values at a time, with a turn of the event
 * loop between slices (2026-11-26: these queries read every identifier of a site at once, 1-3 s
 * on the NAS each, so the server didn't answer for seconds after every store page it read).
 * `sql` names the type @type and has `{range}` where the slice's bounds on `bi.value` go.
 */
export async function sliced<T>(
  db: Database.Database,
  type: string,
  sql: string,
  params: Record<string, unknown> = {},
  perSlice = IDS_PER_SLICE,
): Promise<T[]> {
  const bound = db
    .prepare(
      `SELECT value FROM book_identifiers WHERE type = ? AND value > ?
       ORDER BY value LIMIT 1 OFFSET ${Math.max(1, Math.floor(perSlice)) - 1}`,
    )
    .pluck();
  const mid = db.prepare(sql.replace('{range}', 'bi.value > @lo AND bi.value <= @hi'));
  const end = db.prepare(sql.replace('{range}', 'bi.value > @lo'));
  const out: T[] = [];
  for (let lo = ''; ; ) {
    const hi = bound.get(type, lo) as string | undefined;
    const rows = (
      hi === undefined ? end.all({ ...params, type, lo }) : mid.all({ ...params, type, lo, hi })
    ) as T[];
    for (const r of rows) out.push(r);
    if (hi === undefined) return out;
    lo = hi;
    await nextTurn();
  }
}

/** An id of a site that may be due: its figures as saved when its site's list was made. */
interface DueRow {
  id: string;
  pub: number | null;
  checked: number | null;
  state: RatingRow['state'] | null;
  fails: number | null;
  created: number;
}

/** A site's ids that may be due, never read first, then the oldest figures first. */
interface DueList {
  rows: DueRow[];
  /** Ids whose figures were saved since (fresh: not due). */
  saved: Set<string>;
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
    /** Answers read since fetching was switched on (or the server started). */
    read: number;
    /** The time left for what is due now at the pace measured over the last hour; null until
     * enough answers came back to measure it. */
    secondsLeft: number | null;
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
  /** Answers needed before the time left is shown (default 10; tests use fewer books). */
  paceMinAnswers?: number;
}

export class StoreRatings {
  readonly db: Database.Database;
  private readonly cacheDir: string | null;
  private readonly queue: () => FetchQueue | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private readonly paceMinAnswers: number;

  /** `quiet`: a later check for pages stage 4 saved since (every 10 minutes), shown without a bar. */
  private fill = { running: false, quiet: false, total: 0, done: 0, found: 0, startedAt: 0 };
  private lastFillAt = 0;
  private lastParamsAt = 0;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Set by stop(): a running first fill ends early. */
  private halted = false;
  private ticking = false;
  private fillBusy = false;
  private paramsRun: Promise<void> | null = null;
  private collectTimer: NodeJS.Timeout | null = null;
  private dueCounts: Record<string, number> = {};
  private dueAt = 0;
  /**
   * Each site's ids that may be due, listed in slices once a round (refreshDue); dueIds walks
   * this list, not the library (2026-11-26: the walk took 1-3 s per site on the NAS, and ran
   * for every site after every answer).
   */
  private dueLists = new Map<FetchedSite, DueList>();
  private dueBuild: Promise<void> | null = null;
  private dueAgain = false;
  /** Saved while a list was being made: in the new list's `saved`. */
  private savedDuringBuild: { site: FetchedSite; id: string }[] | null = null;
  /**
   * 読書メーター searches already read for these ids: every search finished from `from`
   * through `through` (searchFill reads only later ones while no new id wants a figure).
   */
  private searched: { from: number; through: number; ids: Set<string> } | null = null;
  /** Cached pages that didn't read, by site and id: their file's mtime (read again when changed). */
  private unreadable = new Map<string, number>();
  /** When fetching was switched on (or the server started), the answers read since, and the
   * times of those read in the last hour (the measured pace). */
  private onAt = 0;
  private readSinceOn = 0;
  private readTimes: number[] = [];

  constructor(opts: Options) {
    this.db = opts.db;
    this.cacheDir = opts.cacheDir;
    this.queue = opts.queue;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.tickMs = opts.tickMs ?? 5 * 60_000;
    this.paceMinAnswers = opts.paceMinAnswers ?? 10;
  }

  settings(): RatingSettings {
    return readRatingSettings(this.db);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.onAt = this.now();
    void this.firstFill();
    if (this.settings().refresh && this.queue()) void this.refreshDue();
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
    void this.firstFill(true);
  }

  /** An answer arrived in the fetch queue: collect ours soon. */
  answerArrived(): void {
    if (this.stopped || this.collectTimer) return;
    // One collect per second at most, however many of the cleanup's answers arrive.
    this.collectTimer = setTimeout(() => {
      this.collectTimer = null;
      void this.collect();
    }, 1000);
    this.collectTimer.unref?.();
  }

  // ------------------------------------------------------------ first fill

  /** The Amazon and BOOK☆WALKER ids of books in the library with no saved figure. */
  private async unfilledIds(): Promise<{ site: 'amazon_jp' | 'bookwalker'; id: string }[]> {
    const rows: { site: 'amazon_jp' | 'bookwalker'; id: string }[] = [];
    for (const site of ['amazon_jp', 'bookwalker'] as const) {
      for (const r of await sliced<{ site: 'amazon_jp' | 'bookwalker'; id: string }>(
        this.db,
        site,
        `SELECT DISTINCT bi.type AS site, bi.value AS id FROM book_identifiers bi
         JOIN book_sources s ON s.book_id = bi.book_id AND s.missing_at IS NULL
         LEFT JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
         WHERE bi.type = @type AND {range} AND r.site IS NULL`,
      ))
        rows.push(r);
    }
    return rows
      .map((r) => ({ site: r.site, id: r.id.trim() }))
      .filter((r) => SITE_ID_RE[r.site].test(r.id));
  }

  /** Reads every unfilled id's cached page; resolves when done (in short turns). */
  async firstFill(quiet = false): Promise<void> {
    // One fill at a time (listing the ids takes several turns now, before `running` is set).
    if (this.fill.running || this.fillBusy) return;
    this.fillBusy = true;
    try {
      await this.fillOnce(quiet);
    } finally {
      this.fillBusy = false;
    }
  }

  private async fillOnce(quiet: boolean): Promise<void> {
    const root = this.cacheDir ? path.join(this.cacheDir, 'cleanup') : null;
    if (!root || !fs.existsSync(path.join(root, 'fetch'))) {
      // No cached pages to read here; the saved searches still give 読書メーター's 登録数.
      this.lastFillAt = this.now();
      await this.searchFill();
      return;
    }
    this.lastFillAt = this.now();
    const ids = await this.unfilledIds();
    if (ids.length === 0) {
      await this.searchFill();
      await this.updateParams();
      return;
    }
    this.fill = {
      running: true,
      quiet,
      total: ids.length,
      done: 0,
      found: 0,
      startedAt: this.now(),
    };
    // Runs again every 10 minutes for new books' pages: logged only when it found some.
    try {
      // In slices of FILL_SLICE_MS (a page's parse takes a few ms), a turn between them.
      for (let i = 0; i < ids.length && !this.halted; ) {
        const started = performance.now();
        this.db.transaction(() => {
          for (; i < ids.length && performance.now() - started < FILL_SLICE_MS; i++) {
            const { site, id } = ids[i];
            const file = path.join(root, stage4CacheFile(site, id));
            let html: string;
            let mtime: number;
            try {
              const st = fs.statSync(file);
              mtime = Math.round(st.mtimeMs);
              // The same file that didn't read before: nothing to save, as then.
              if (this.unreadable.get(`${site}:${id}`) === mtime) {
                this.fill.done += 1;
                continue;
              }
              html = brotliDecompressSync(fs.readFileSync(file)).toString('utf8');
            } catch {
              this.fill.done += 1;
              continue;
            }
            const parsed = parsePage(site, id, html);
            // A cached page that can't be read is left to the refresher (no row).
            if (parsed.kind === 'blocked') {
              // Never readable through the VPN: recorded, so the refresher waits the long pace.
              saveRating(this.db, site, id, parsed, mtime);
              this.markSaved(site, id);
            } else if (parsed.kind !== 'unreadable') {
              saveRating(this.db, site, id, parsed, mtime);
              this.markSaved(site, id);
              this.fill.found += 1;
            } else if (
              site === 'amazon_jp' &&
              /ページが見つかりません|Page Not Found/i.test(html)
            ) {
              saveRating(this.db, site, id, { kind: 'gone' }, mtime);
              this.markSaved(site, id);
              this.fill.found += 1;
            } else {
              this.unreadable.set(`${site}:${id}`, mtime);
            }
            this.fill.done += 1;
          }
        })();
        await nextTurn();
      }
      if (this.fill.found > 0) {
        this.log(
          `Store ratings: read ${this.fill.found} of ${this.fill.total} ids from cached pages`,
        );
      }
      await this.searchFill();
    } catch (err) {
      this.lastError = `first fill: ${(err as Error).message}`;
      console.error('Store ratings: the first fill stopped:', err);
    } finally {
      this.fill.running = false;
    }
    await this.updateParams();
  }

  /**
   * 読書メーター's 登録数 for linked ids without a figure, from the saved Bookmeter searches
   * (stage 4's and the link fix's). Only searches finished since the oldest such book appeared
   * (less a day) are read, so after the first time it reads only a few; ids no search lists are
   * left to the refresher.
   */
  private async searchFill(): Promise<void> {
    const q = this.queue();
    if (!q || this.halted) return;
    const rows = await sliced<{ id: string; created: number }>(
      this.db,
      'bookmeter',
      `SELECT bi.value AS id, MIN(b.created_at) AS created FROM book_identifiers bi
       JOIN books b ON b.id = bi.book_id
       JOIN book_sources s ON s.book_id = bi.book_id AND s.missing_at IS NULL
       LEFT JOIN store_ratings r ON r.site = 'bookmeter' AND r.site_id = bi.value
       WHERE bi.type = @type AND {range} AND r.site IS NULL
       GROUP BY bi.value`,
    );
    const want = new Map<string, number>();
    for (const r of rows) {
      const id = r.id.trim();
      if (SITE_ID_RE.bookmeter.test(id)) want.set(id, r.created);
    }
    if (want.size === 0) return;
    let oldest = Infinity;
    for (const c of want.values()) if (c < oldest) oldest = c;
    const since = oldest - DAY;
    // Searches read before are read again only when they could say something new: for an id
    // not looked for then, or from an earlier start. Otherwise only the ones finished since
    // (2026-11-26: every fill read all 148,000 saved searches again, every 10 minutes, for ids
    // no search lists). The result is the same: the newest search listing an id.
    const prev = this.searched;
    const again = !prev || since < prev.from || [...want.keys()].some((id) => !prev.ids.has(id));
    const from = again || !prev ? since : prev.through + 1;
    const searches = await q.answeredSinceAsync('bookmeter', BOOKMETER_SEARCH_PREFIX, from);
    // id → the newest search's count (searches come in id order: the newest kept).
    const found = new Map<string, { count: number; at: number }>();
    let through = from;
    for (let i = 0; i < searches.length && !this.halted; i += SEARCH_READS_AT_ONCE) {
      const group = searches.slice(i, i + SEARCH_READS_AT_ONCE);
      // The files are read and unpacked off the event loop; only the parse runs here.
      const bodies = await Promise.all(group.map(({ id }) => q.readAnswerAsync(id)));
      group.forEach(({ finishedAt }, k) => {
        through = Math.max(through, finishedAt);
        const body = bodies[k];
        if (!body) return;
        for (const hit of parseBookmeterSearch(body)) {
          if (typeof hit.registrations === 'number' && want.has(hit.id)) {
            const had = found.get(hit.id);
            if (!had || finishedAt >= had.at)
              found.set(hit.id, { count: hit.registrations, at: finishedAt });
          }
        }
      });
      await nextTurn();
    }
    if (!this.halted) {
      this.searched = {
        from: again || !prev ? since : prev.from,
        through,
        ids: new Set(want.keys()),
      };
    }
    if (found.size === 0) return;
    const ids = [...found.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      this.db.transaction(() => {
        for (const id of ids.slice(i, i + 500)) {
          const f = found.get(id)!;
          // Not over a figure saved meanwhile (a book page read while the searches were read).
          const had = this.db
            .prepare("SELECT 1 FROM store_ratings WHERE site = 'bookmeter' AND site_id = ?")
            .get(id);
          if (had) continue;
          saveRating(
            this.db,
            'bookmeter',
            id,
            { kind: 'rating', avg: null, count: f.count, reviews: null },
            f.at,
          );
          this.markSaved('bookmeter', id);
        }
      })();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.dueAt = 0;
    this.log(
      `Store ratings: 読書メーター 登録数 for ${found.size} of ${want.size} ids from ${searches.length} saved searches`,
    );
  }

  /** The score's middle and every rated book's score, in slices (one update at a time). */
  private updateParams(): Promise<void> {
    this.lastParamsAt = this.now();
    const run = async () => {
      try {
        await updateScoreParamsAsync(this.db, this.settings().scoreRatings);
      } catch (err) {
        console.error('Store ratings: the score could not be updated:', err);
      }
    };
    this.paramsRun = (this.paramsRun ?? Promise.resolve()).then(run);
    return this.paramsRun;
  }

  // ------------------------------------------------------------ refresher

  /** One round: collect answers, then queue what's due (only with `refresh` on). */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    // What may be due is listed first, in slices (answers are collected meanwhile).
    if (this.settings().refresh && this.queue()) await this.refreshDue();
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (this.now() - this.lastParamsAt > DAY && !this.fill.running) await this.updateParams();
      const s = this.settings();
      const q = this.queue();
      if (!q) return;
      // Pages stage 4 saved since (new arrivals) are read from its cache, not asked again.
      this.wake();
      this.collectWith(q);
      if (!s.refresh) return;
      for (const site of FETCHED_SITES) {
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
      if (this.collectWith(q) === 0) return;
      // Top the queue up as it drains (not only every round), so the fetchers never wait on us:
      // once half of a site's requests are answered (the due query runs once per half-queue).
      const s = this.settings();
      if (!s.refresh) return;
      if (this.dueLists.size < FETCHED_SITES.length) void this.refreshDue();
      for (const site of FETCHED_SITES) {
        if (this.waitingFor(site) <= s.queuedPerSite / 2) this.enqueueDue(q, s, site);
      }
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
      this.markSaved(w.site, w.site_id);
      saved += 1;
      this.readSinceOn += 1;
      this.readTimes.push(now);
    }
    return saved;
  }

  /**
   * Lists each site's ids that may be due, in slices of the library's identifiers (the query the
   * due list was read with before, a slice at a time): every round, at start and after a settings
   * change. `again`: list once more after a listing already running (its settings may be old).
   */
  refreshDue(again = false): Promise<void> {
    if (this.dueBuild) {
      if (again) this.dueAgain = true;
      return this.dueBuild;
    }
    this.dueBuild = (async () => {
      try {
        do {
          this.dueAgain = false;
          for (const site of FETCHED_SITES) {
            this.savedDuringBuild = [];
            const rows = await this.listDue(site);
            const saved = new Set<string>();
            for (const r of this.savedDuringBuild) if (r.site === site) saved.add(r.id);
            this.dueLists.set(site, { rows, saved });
          }
          this.dueAt = 0;
        } while (this.dueAgain && !this.stopped);
      } catch (err) {
        this.lastError = (err as Error).message;
        console.error('Store ratings: what is due could not be listed:', err);
      } finally {
        this.savedDuringBuild = null;
        this.dueBuild = null;
      }
    })();
    return this.dueBuild;
  }

  private async listDue(site: FetchedSite): Promise<DueRow[]> {
    const s = this.settings();
    const rows = await sliced<DueRow>(
      this.db,
      site,
      `SELECT bi.value AS id, MIN(b.published_at) AS pub, r.checked_at AS checked, r.state AS state,
              r.fails AS fails, MIN(b.created_at) AS created
       FROM book_identifiers bi
       JOIN books b ON b.id = bi.book_id
       JOIN book_sources src ON src.book_id = bi.book_id AND src.missing_at IS NULL
       LEFT JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
       WHERE bi.type = @type AND {range}
         AND (r.checked_at IS NULL OR r.checked_at < @cutoff)
       GROUP BY bi.value
       ORDER BY bi.value`,
      { cutoff: this.now() - s.newDays * DAY },
    );
    // Never read first, then the oldest figures first (a stable sort: equal ones by id).
    return rows.sort(
      (a, b) =>
        (a.checked === null ? 0 : 1) - (b.checked === null ? 0 : 1) ||
        (a.checked ?? 0) - (b.checked ?? 0),
    );
  }

  /** An id's figures were saved: it isn't due (the next listing knows it). */
  private markSaved(site: FetchedSite, id: string): void {
    this.dueLists.get(site)?.saved.add(id);
    this.savedDuringBuild?.push({ site, id });
  }

  /** The id is due now by its figures (and, never read, isn't waiting for stage 4's page). */
  private dueNow(
    site: FetchedSite,
    r: DueRow,
    s: RatingSettings,
    now: number,
    q: FetchQueue | null,
  ): boolean {
    const id = r.id.trim();
    if (!SITE_ID_RE[site].test(id)) return false;
    if (r.checked === null) {
      // Never read: a new book's page (Amazon, BOOK☆WALKER) or its 読書メーター search is
      // fetched by the cleanup's stage 4 (new arrivals) and read from that saved answer by the
      // first fill and the search fill, so it isn't asked twice.
      if (now - r.created < s.newBookWaitHours * 3_600_000) return false;
      return !(
        site !== 'bookmeter' &&
        q?.isOpen(QUEUE_SITE[site], site === 'amazon_jp' ? id : pageUrl(site, id))
      );
    }
    // A failed read is tried again after a day (three times), then at the old-book pace.
    const wait = r.state === 'error' && (r.fails ?? 0) < 3 ? DAY : refreshAfterMs(s, r.pub, now);
    return now - r.checked >= wait;
  }

  /**
   * A site's ids due now, oldest first (never read first), from its list (none until listed).
   * `live`: each id's saved figures are read again before it is given out.
   */
  private walkDue(site: FetchedSite, limit: number, live: boolean): string[] {
    const list = this.dueLists.get(site);
    if (!list) return [];
    const s = this.settings();
    const now = this.now();
    const q = this.queue();
    const cutoff = now - s.newDays * DAY;
    const asked = new Set(
      this.db
        .prepare('SELECT site_id FROM store_rating_requests WHERE site = ?')
        .pluck()
        .all(site) as string[],
    );
    const savedRow = this.db.prepare(
      'SELECT checked_at AS checked, state, fails FROM store_ratings WHERE site = ? AND site_id = ?',
    );
    const out: string[] = [];
    for (const c of list.rows) {
      if (asked.has(c.id) || list.saved.has(c.id) || list.saved.has(c.id.trim())) continue;
      if (!this.dueNow(site, c, s, now, q)) continue;
      if (live) {
        const l = savedRow.get(site, c.id) as
          | Pick<DueRow, 'checked' | 'state' | 'fails'>
          | undefined;
        const r: DueRow = {
          ...c,
          checked: l?.checked ?? null,
          state: l?.state ?? null,
          fails: l?.fails ?? null,
        };
        if (r.checked !== null && r.checked >= cutoff) continue;
        if (r.checked !== c.checked && !this.dueNow(site, r, s, now, q)) continue;
      }
      out.push(c.id.trim());
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The ids of a site due now, oldest first (never read first), as of its last listing. */
  dueIds(site: FetchedSite, limit: number): string[] {
    return this.walkDue(site, limit, true);
  }

  private waitingFor(site: FetchedSite): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM store_rating_requests WHERE site = ?')
        .get(site) as { n: number }
    ).n;
  }

  private enqueueDue(q: FetchQueue, s: RatingSettings, site: FetchedSite): void {
    const room = s.queuedPerSite - this.waitingFor(site);
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
      if (!id) continue;
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
    const rows = [...saved.values()];
    return { rows, refreshing };
  }

  private raise(q: FetchQueue, site: FetchedSite, id: string): void {
    const r = this.db
      .prepare('SELECT request_id FROM store_rating_requests WHERE site = ? AND site_id = ?')
      .get(site, id) as { request_id: number } | undefined;
    if (r) q.requeue(r.request_id, OPEN_PRIORITY, this.now());
  }

  /** After a settings change: the score follows its setting; switching on starts a round. */
  /** Resolves once the score follows a changed score setting (worked out in slices). */
  settingsChanged(before: RatingSettings, after: RatingSettings): Promise<void> {
    this.dueAt = 0;
    // The lists' bound (newDays) may have changed: listed again.
    if (after.refresh && this.queue()) void this.refreshDue(true);
    else this.dueLists.clear();
    if (after.refresh && !before.refresh) {
      this.onAt = this.now();
      this.readSinceOn = 0;
      this.readTimes = [];
    }
    const score = before.scoreRatings !== after.scoreRatings ? this.updateParams() : null;
    if (after.refresh && !before.refresh) {
      void this.tick();
    }
    return score ?? Promise.resolve();
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
    // Counted from each site's list, not the library: at most once a minute (the page polls this).
    if (this.now() - this.dueAt > 60_000) {
      const due: Record<string, number> = {};
      if (s.refresh) {
        for (const site of FETCHED_SITES) {
          due[site] = this.walkDue(site, Number.MAX_SAFE_INTEGER, false).length;
        }
        if (this.dueLists.size < FETCHED_SITES.length && this.queue()) void this.refreshDue();
      }
      this.dueCounts = due;
      this.dueAt = this.now();
    }
    const due = this.dueCounts;
    const now = this.now();
    const hourAgo = now - 3_600_000;
    this.readTimes = this.readTimes.filter((t) => t > hourAgo);
    // The pace over the last hour (or since switching on: at least 2 minutes in, 10 answers).
    const span = now - Math.max(hourAgo, this.onAt);
    // What is left: due and not yet asked, plus asked and not yet answered.
    const dueTotal = Object.values(due).reduce((a, b) => a + b, 0) + waiting;
    const perMs =
      span >= 120_000 && this.readTimes.length >= this.paceMinAnswers
        ? this.readTimes.length / span
        : 0;
    // Not listed yet (the first round after a start): what is due isn't known yet.
    const listed = this.dueLists.size === FETCHED_SITES.length;
    const refreshLeft = !listed
      ? null
      : dueTotal === 0
        ? 0
        : perMs > 0
          ? Math.round(dueTotal / perMs / 1000)
          : null;
    return {
      fill: {
        // A quick later check has no bar on the page (it would flash every 10 minutes).
        running: this.fill.running && !this.fill.quiet,
        total: this.fill.total,
        done: this.fill.done,
        found: this.fill.found,
        secondsLeft: this.fill.running ? Math.round((left * perId) / 1000) : 0,
      },
      refresh: {
        on: s.refresh,
        available: this.queue() !== null,
        waiting,
        due,
        read: this.readSinceOn,
        secondsLeft: s.refresh ? refreshLeft : 0,
      },
      saved,
      lastError: this.lastError,
    };
  }
}
