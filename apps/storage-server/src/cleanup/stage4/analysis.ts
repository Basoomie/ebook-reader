/**
 * Stage 4 analysis (WP20d, plan section 6): online sources, Preview only.
 *
 * Phases, all resumable from cleanup.db:
 * 1. read: every book with an EPUB, read as the measured run read it (ref-epub.ts), the labeled
 *    books first; kept as evidence (kind 'reffile') and read again only when the file changed.
 *    Holds the shared disk lock (a Calibre-side job).
 * 2. lookups: each book's requests go to the fetch queue (labeled books first), its answers move
 *    it on, step by step, in the order of the measured run: Amazon (product page by ASIN, else
 *    Kindle search then the picked product), RanobeDB (search, book, series), BookWalker
 *    (search, series list, detail), Bookmeter (search; its store list once the match passes
 *    acceptance), the Amazon cover for a small or missing file cover. A book whose lookups are
 *    answered gets its proposals at once (the rules need no AI in WP20d). Meanwhile Natively's
 *    sitemap and book pages are read once, and the authors' readings asked of Web NDL
 *    Authorities in batches (names NDL lacks get a generated reading from the fetcher's Sudachi).
 * 3. final: identifiers and author_sort proposed again for every book now that Natively and the
 *    readings are complete.
 * The gate grades the labeled books per field as soon as they are proposed, and again at the end.
 * Writes nothing but cleanup.db and the fetch cache.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { gunzipSync, gzipSync } from 'zlib';
import { snapshotFile } from '../../calibre/indexer';
import { getLibrary } from '../../calibre/libraries';
import { resolveInside, statFile } from '../../calibre/source-fs';
import { differenceHash, imageFacts, readFileMetadata } from '../file-metadata';
import { readSourceFile } from '../../calibre/source-fs';
import { createHash } from 'node:crypto';
import { CALIBRE_FETCH_SITES, getSettings, stage4Bar, type CleanupSettings } from '../settings';
import { Pacer } from '../stage1';
import { loadEvidence as loadFileEvidence } from '../stage2';
import {
  defaultReferenceFile,
  loadGold,
  mapLabeledIds,
  pauseField,
  resumeField,
} from '../stage2-gate';
import { hammingHex } from '../stage2-rules';
import {
  readStage2Snapshot,
  spellingLookup,
  type Stage2Book,
  type Stage2Snapshot,
} from '../stage2-snapshot';
import { getStage, updateStage } from '../stages';
import {
  jload,
  parseAmazonDp,
  parseAmazonSearch,
  parseBwDetail,
  parseBwList,
  rdbAuthorMatch,
  rdbBook,
  rdbCandidates,
  rdbSeries,
} from './parse';
import { bwAsAmazon, bwSettles, STANDIN, titleStem } from './bw-standin';
import { NEXT_STEPS, type FollowUps } from './eta';
import { ASIN_RE, pickByVolume, pyQuote, queryTitle, sim } from './pick';
import { proposeStage4, type CalibreCoverNow, type Stage4Proposal } from './proposals';
import { storedAiValues, type Stage4AiValues } from './ai-decide';
import { FetchQueue, LABELED_PRIORITY } from './queue';
import { readRefEpub, type RefFile } from './ref-epub';
import { nfkc } from './ref-text';
import type { RefRecord } from './rules-v3';
import { spellingOf } from './series-spelling';
import type { PoolEntry, SeriesBook, ValueFrom } from './series-order';
import { seriesChoiceOf } from './series-order-store';
import { N } from '../title-rules';
import {
  MEASURED_V3,
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  FIELD_NAMES,
  type ScoredField,
  type Stage4Gold,
} from './score';
import { readStage4Extras, type Stage4Extras } from './snapshot4';
import { attachMarks } from '../marks';
import { decideStage4, STAGE4_RULES_VERSION, type Stage4Decision } from './stage4-rules';
import {
  NATIVELY_SITEMAP,
  NDL_SPARQL,
  acceptBookmeter,
  BOOKMETER_SEARCH_KEY,
  bookmeterSearchUrl,
  bookmeterStoresUrl,
  oldBookmeterSearch,
  isbn13From10,
  ndlQuery,
  ndlReading,
  parseBookmeterSearch,
  parseBookmeterStores,
  parseNativelyBook,
  parseNativelySitemap,
  parseNdl,
  type BookmeterHit,
  type StoreIds,
} from './store-links';

export const STAGE = 4;
export const REF_KIND = 'reffile';
export const ONLINE_KIND = 'online';
export const ONLINE_VERSION = 1;

export type Stage4Phase = 'read' | 'lookups' | 'final' | 'done';

export interface Stage4Progress {
  analysisId: string;
  phase: Stage4Phase;
  libraryId: string;
  startedAt: number;
  finishedAt: number | null;
  pass: 'labeled' | 'all';
  labeledIds: number[];
  cursor: number;
  readTotal: number;
  readDone: number;
  filesRead: number;
  readErrors: number;
  booksWithoutEpub: number;
  finalCursor: number;
  rulesVersion: number;
  labelsError: string | null;
  error: string | null;
  /** When the labeled books were all proposed (for the report's "time to the first gate"). */
  labeledDoneAt: number | null;
  /** The gate ran at least once (the time left keeps the labeled books' ratios meanwhile). */
  labeledCheckedOnce?: boolean;
  /** The answer time of the Natively sitemap whose pages are listed. */
  nativelyListedAt?: number | null;
  /**
   * "Amazon where needed" (2026-11-18): the one-time sweep that takes the Amazon requests queued
   * before it out of the queue (cursor per phase), so each book asks Amazon only when BookWalker
   * and RanobeDB don't settle it.
   */
  amazonSweep?: { phase: 'waiters' | 'requests' | 'books' | 'done'; cursor: string };
  /** Bookmeter asked again with its plain index (bookmeterRedoStep), once per analysis. */
  bookmeterRedo?: { phase: 'queued' | 'books' | 'done'; cursor: string; books: number };
  /** BookWalker asked once more for books its search found nothing for (bookwalkerRetryStep). */
  bookwalkerRetry?: { phase: 'books' | 'done'; cursor: string; books: number };
  /**
   * WP20e: Bookmeter's edition check (acceptBookmeter) applied once to an analysis that
   * accepted its matches before it existed, from the stored answers (nothing is asked again
   * unless another hit is now the match: then only its store list).
   */
  bookmeterEditions?: {
    phase: 'books' | 'done';
    cursor: string;
    changed: number;
    reopened: number;
  };
  /**
   * Series-order follow-up (2026-11-22): every finished book's Amazon, RanobeDB and BookWalker
   * picks made again from its stored search results with the fixed picker (pick.ts), once per
   * analysis. A book whose pick changed waits for the record it now needs (most are cached).
   */
  repick?: {
    phase: 'books' | 'done';
    cursor: string;
    amazon: number;
    ranobedb: number;
    bookwalker: number;
    reopened: number;
  };
  /** Books the final pass has proposed again (for its time left). */
  finalDone?: number;
  /** Each step's answers and the new requests they led to (stage4/eta.ts, the time left). */
  followUps?: FollowUps;
  /** PROPOSE_TIMES_VERSION the 'propose: book' time was measured under. */
  proposeTimesVersion?: number;
  /** Time per step (lessons 1-3: every stage times its steps from the first build). */
  times?: Record<string, StepTime>;
}

/** Wall time of one named step: total, count and the longest single run (ms). */
export interface StepTime {
  ms: number;
  n: number;
  max: number;
}

function addTime(p: Stage4Progress, name: string, ms: number): void {
  const times = (p.times ??= {});
  const t = (times[name] ??= { ms: 0, n: 0, max: 0 });
  t.ms += ms;
  t.n += 1;
  if (ms > t.max) t.max = ms;
}

async function timed<T>(p: Stage4Progress, name: string, fn: () => T | Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    addTime(p, name, performance.now() - t);
  }
}

/** The step times as one log line, the costliest first. */
export function formatTimes(times: Record<string, StepTime> | undefined): string {
  return Object.entries(times ?? {})
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([k, t]) => `${k} ${Math.round(t.ms)} ms/${t.n} (max ${Math.round(t.max)})`)
    .join(', ');
}

/** How often the step times go to the server log. */
const TIMES_LOG_MS = 10 * 60_000;

/** One book's online evidence (kind 'online'), in the reference record's shape plus the store links. */
export interface OnlineEvidence {
  v: number;
  query: { title: string; author: string; text_book: boolean };
  amazon: {
    /** Amazon was asked for this book (after BookWalker and RanobeDB, when they don't settle it). */
    asked?: boolean;
    /** BookWalker settles the book in Amazon's place (bw-standin.ts); Amazon isn't asked. */
    standin?: string;
    asin_from_title?: boolean;
    search_candidates?: [string, string][];
    picked_from_search?: boolean;
    product?: ReturnType<typeof parseAmazonDp> | null;
    gone?: boolean;
    failed?: string;
  };
  ranobedb: {
    search_candidates?: [unknown, string][];
    book?: ReturnType<typeof rdbBook>;
    author_match?: boolean;
    series?: ReturnType<typeof rdbSeries>;
    failed?: string;
  };
  bookwalker: {
    search_candidates?: [string, string][];
    series_candidates?: [string, string][];
    detail?: ReturnType<typeof parseBwDetail> & { url: string };
    failed?: string;
    /** The simpler query asked after the search found nothing (bookwalkerRetryQuery). */
    retried?: string;
  };
  bookmeter: {
    hits?: BookmeterHit[];
    accepted?: { id: string; reason: string } | null;
    reason?: string;
    stores?: StoreIds;
    failed?: string;
  };
  cover: {
    url: string;
    width?: number;
    height?: number;
    dhash?: string | null;
    failed?: string;
  } | null;
  /** Request ids of every answer used (the pages stay in the fetch cache). */
  requests: Record<string, number>;
  /** Steps still open: amazon, ranobedb, bookwalker, bookmeter, stores, cover. */
  open: string[];
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Gives the server back at least every SLICE_MS (lessons 3: a synchronous step blocks the reader
 * and /cleanup; one answer can take ~15 ms: decompressing and parsing a 1.3 MB page).
 */
const SLICE_MS = 30;
class Slicer {
  private at = Date.now();
  constructor(private readonly p?: Stage4Progress) {}
  async maybeYield(): Promise<void> {
    const ran = Date.now() - this.at;
    if (ran < SLICE_MS) return;
    if (this.p) addTime(this.p, 'sync slice', ran);
    await yieldNow();
    this.at = Date.now();
  }
}
const READ_CHUNK = 20;
const PLAN_CHUNK = 500;
const ANSWER_CHUNK = 200;
const PROPOSE_CHUNK = 100;
/**
 * Bumped when a proposal's cost changes: its time ('propose: book', the final pass's time left)
 * starts over (2: the per-book delete by the book index, 2026-11-20; the mean of the slow ones
 * would have kept the final pass at 8 h on the page).
 */
const PROPOSE_TIMES_VERSION = 2;
const FINAL_CHUNK = 50;
const NATIVELY_ENQUEUE_CHUNK = 2000;
/** Rows per chunk of the one-time Amazon sweep (measured on a live copy: 42 ms typical, 82 ms p90). */
const SWEEP_CHUNK = 500;

/**
 * BookWalker's second query when its search found nothing: the title up to its volume number
 * (bw-standin.ts titleStem), or null when that is the same query or too short to search.
 */
export function bookwalkerRetryQuery(title: string): string | null {
  const stem = titleStem(title);
  return stem.length >= 2 && nfkc(stem) !== nfkc(title) ? stem : null;
}
/** The waiter "library" of Natively's pages (they belong to no book). */
const NATIVELY_WAITER = 'natively';

export interface Stage4Deps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string;
  cacheDir: string;
  dbDir?: string | null;
  queue: FetchQueue;
  log?: (m: string) => void;
}

export function emptyStage4Progress(libraryId: string, now = Date.now()): Stage4Progress {
  return {
    analysisId: randomUUID(),
    phase: 'read',
    libraryId,
    startedAt: now,
    finishedAt: null,
    pass: 'labeled',
    labeledIds: [],
    cursor: 0,
    readTotal: 0,
    readDone: 0,
    filesRead: 0,
    readErrors: 0,
    booksWithoutEpub: 0,
    finalCursor: 0,
    rulesVersion: STAGE4_RULES_VERSION,
    labelsError: null,
    error: null,
    labeledDoneAt: null,
    // A new analysis accepts Bookmeter's matches with the edition check from the start.
    bookmeterEditions: { phase: 'done', cursor: '', changed: 0, reopened: 0 },
    // ... and picks with the fixed picker from the start.
    repick: { phase: 'done', cursor: '', amazon: 0, ranobedb: 0, bookwalker: 0, reopened: 0 },
  };
}

/**
 * The earliest date a colophon prints (yyyymmdd; day 0 when only the month is printed): the
 * first edition's, as the series order uses it. Measured on the 300 sampled series: 206 of
 * 317 books without a printed number have one.
 */
export function firstColophonDate(text: string): number | null {
  const t = nfkc(text);
  let best: number | null = null;
  const add = (y: number, m: number, d: number) => {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 0 || d > 31) return;
    const v = y * 10000 + m * 100 + d;
    if (best === null || v < best) best = v;
  };
  for (const m of t.matchAll(/((?:19|20)\d\d)\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/gu))
    add(Number(m[1]), Number(m[2]), Number(m[3] ?? 0));
  for (const m of t.matchAll(/((?:19|20)\d\d)[./-](\d{1,2})[./-](\d{1,2})/gu))
    add(Number(m[1]), Number(m[2]), Number(m[3]));
  return best;
}

/** The one-time passes over a finished analysis are through (they can reopen books). */
export function oneTimePassesDone(p: Stage4Progress): boolean {
  return p.bookmeterEditions?.phase === 'done' && p.repick?.phase === 'done';
}

function gz(v: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(v), 'utf8'));
}
function ungz<T>(b: Buffer): T {
  return JSON.parse(gunzipSync(b).toString('utf8')) as T;
}

export interface RefEvidence {
  v: number;
  path: string;
  size: number;
  mtimeMs: number;
  file: RefFile | null;
  error: string | null;
  /** The file's own cover (stage 2's facts when it read the book, else read here); null = none. */
  cover?: { width: number; height: number; dhash: string | null } | null;
}

export class Stage4Analysis {
  private snapshot: Stage2Snapshot | null = null;
  private extras: Map<number, Stage4Extras> | null = null;
  private snapshotFor: string | null = null;
  private snapshotMtime = 0;
  private byUuid: Map<string, Stage2Book> | null = null;
  private readPacer: Pacer | null = null;
  private readPacerBps = -1;
  private readonly log: (m: string) => void;
  private timesLoggedAt = Date.now();
  private withEpubCache: Stage2Book[] | null = null;

  constructor(private readonly deps: Stage4Deps) {
    this.log = deps.log ?? (() => {});
  }

  private get db(): Database.Database {
    return this.deps.cleanup;
  }

  progress(): Stage4Progress | null {
    const p = getStage(this.db, STAGE).progress as unknown as Stage4Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage4Progress, state?: string): void {
    updateStage(this.db, STAGE, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(libraryId: string): Stage4Progress {
    const p = emptyStage4Progress(libraryId);
    this.invalidate();
    // Lookups of an earlier analysis are kept (their answers are cached); the books start over.
    this.db.prepare('DELETE FROM fetch_waiters').run();
    this.db.prepare('DELETE FROM stage4_books WHERE library_id = ?').run(libraryId);
    this.save(p, 'analysing');
    return p;
  }

  invalidate(): void {
    this.snapshot = null;
    this.extras = null;
    this.byUuid = null;
  }

  referenceFile(): string | null {
    const s = getSettings(this.db).gate.labeledBooksFile;
    if (s) return s;
    return this.deps.dbDir ? defaultReferenceFile(this.deps.dbDir) : null;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new Error('The chosen library is not in the reader any more');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  /** The reader's metadata.db snapshot, read again whenever the indexer made a new one. */
  loadSnapshot(libraryId: string): Stage2Snapshot {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (this.snapshot && this.snapshotFor === file && this.snapshotMtime === mtime)
      return this.snapshot;
    this.snapshotMtime = mtime;
    this.withEpubCache = null;
    const t = performance.now();
    this.snapshot = readStage2Snapshot(file);
    // The Google run's marks stage 5 removed from Calibre still count for the rules (WP20f).
    attachMarks(this.db, libraryId, this.snapshot.books.values());
    this.extras = readStage4Extras(file);
    this.byUuid = new Map([...this.snapshot.books.values()].map((b) => [b.uuid, b]));
    this.snapshotFor = file;
    const p = this.progress();
    if (p) addTime(p, 'snapshot load', performance.now() - t);
    return this.snapshot;
  }

  /** One unit of work; true when finished (or failed). Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (p && p.phase === 'done' && !p.error && !oneTimePassesDone(p)) {
      if (p.bookmeterEditions?.phase !== 'done') await this.bookmeterEditionsStep(p);
      else await this.repickStep(p);
      this.save(p, p.phase === 'done' ? 'ready' : 'analysing');
      return p.phase === 'done' && oneTimePassesDone(p);
    }
    if (!p || p.phase === 'done') return true;
    try {
      const q = p;
      if (q.proposeTimesVersion !== PROPOSE_TIMES_VERSION) {
        if (q.times) delete q.times['propose: book'];
        q.proposeTimesVersion = PROPOSE_TIMES_VERSION;
      }
      if (q.phase === 'read') {
        const r = await timed(q, 'read', () => this.readStep(q, shouldStop));
        // Books already read start their lookups while the rest of the library is read.
        await timed(r, 'lookups', () => this.lookupStep(r));
        p = r;
      } else if (q.phase === 'lookups') {
        p = await timed(q, 'lookups', () => this.lookupStep(q));
      } else if (q.phase === 'final') {
        p = await timed(q, 'final', () => this.finalStep(q));
      }
      if (Date.now() - this.timesLoggedAt >= TIMES_LOG_MS) {
        this.timesLoggedAt = Date.now();
        this.log(`stage 4 timing: ${formatTimes(p.times)}`);
      }
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      this.log(`stage 4 analysis failed: ${p.error}`);
      return true;
    }
  }

  // ------------------------------------------------------------ read

  private pacer(): Pacer {
    const bps = getSettings(this.db).pacing.readMbPerSecond * 1024 * 1024;
    if (!this.readPacer || this.readPacerBps !== bps) {
      this.readPacer = new Pacer(bps);
      this.readPacerBps = bps;
    }
    return this.readPacer;
  }

  loadRef(libraryId: string, uuid: string): RefEvidence | null {
    const r = this.db
      .prepare(
        'SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = ?',
      )
      .get(libraryId, uuid, REF_KIND) as { data: Buffer } | undefined;
    if (!r) return null;
    try {
      return ungz<RefEvidence>(r.data);
    } catch {
      return null;
    }
  }

  private saveEvidence(libraryId: string, uuid: string, kind: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO evidence_records (library_id, calibre_uuid, kind, version, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, calibre_uuid, kind) DO UPDATE SET version = excluded.version,
           data = excluded.data, created_at = excluded.created_at`,
      )
      .run(libraryId, uuid, kind, ONLINE_VERSION, gz(value), Date.now());
  }

  loadOnline(libraryId: string, uuid: string): OnlineEvidence | null {
    const r = this.db
      .prepare(
        'SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = ?',
      )
      .get(libraryId, uuid, ONLINE_KIND) as { data: Buffer } | undefined;
    return r ? ungz<OnlineEvidence>(r.data) : null;
  }

  private async readBook(
    p: Stage4Progress,
    libDir: string,
    libraryId: string,
    book: Stage2Book,
  ): Promise<{ ev: RefEvidence | null; read: boolean }> {
    if (!book.filePath) return { ev: null, read: false };
    const epub = resolveInside(libDir, book.filePath);
    const st = await statFile(epub);
    const old = this.loadRef(libraryId, book.uuid);
    if (
      old &&
      st &&
      old.path === book.filePath &&
      old.size === st.size &&
      old.mtimeMs === st.mtimeMs
    ) {
      return { ev: old, read: false };
    }
    const counted = { bytes: 0 };
    let file: RefFile | null = null;
    let error: string | null = st ? null : 'file_missing';
    let cover: RefEvidence['cover'] = null;
    if (st) {
      try {
        file = await timed(p, 'read: EPUB text', () => readRefEpub(epub, counted));
      } catch (err) {
        error = `read: ${String((err as Error).message ?? err).slice(0, 300)}`;
      }
      const s2 = loadFileEvidence(this.db, libraryId, book.uuid);
      const same =
        s2 && s2.path === book.filePath && s2.size === st.size && s2.mtimeMs === st.mtimeMs;
      let fc = same ? (s2.file?.cover ?? null) : null;
      if (!same && file) {
        try {
          fc = (
            await timed(p, 'read: cover', () => readFileMetadata(epub, { text: false, counted }))
          ).cover;
        } catch {
          fc = null;
        }
      }
      cover = fc ? { width: fc.width, height: fc.height, dhash: fc.dhash } : null;
      await timed(p, 'read: pace wait', () => this.pacer().take(counted.bytes));
    }
    const ev: RefEvidence = {
      v: 1,
      path: book.filePath,
      size: st?.size ?? 0,
      mtimeMs: st?.mtimeMs ?? 0,
      file,
      error,
      cover,
    };
    this.saveEvidence(libraryId, book.uuid, REF_KIND, ev);
    return { ev, read: true };
  }

  private async readStep(p: Stage4Progress, shouldStop: () => boolean): Promise<Stage4Progress> {
    const snap = this.loadSnapshot(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const withEpub = (this.withEpubCache ??= [...snap.books.values()].filter(
      (b) => b.filePath !== null,
    ));
    p.readTotal = withEpub.length;
    p.booksWithoutEpub = snap.books.size - withEpub.length;
    if (p.pass === 'labeled' && p.labeledIds.length === 0 && p.cursor === 0) {
      const file = this.referenceFile();
      const { gold, error } = file
        ? loadGold(file)
        : { gold: null, error: 'No labeled-books file is set' };
      p.labelsError = error;
      if (gold) {
        const mapped = mapLabeledIds(this.db, p.libraryId, Object.keys(gold));
        p.labeledIds = [...new Set([...mapped.values()])]
          .filter((id) => snap.books.get(id)?.filePath)
          .sort((a, b) => a - b);
      }
    }
    const ids =
      p.pass === 'labeled'
        ? p.labeledIds.filter((id) => id > p.cursor).slice(0, READ_CHUNK)
        : withEpub
            .map((b) => b.calibreId)
            .filter((id) => id > p.cursor)
            .slice(0, READ_CHUNK);
    if (ids.length === 0) {
      if (p.pass === 'labeled') {
        p.pass = 'all';
        p.cursor = 0;
        return p;
      }
      p.phase = 'lookups';
      return p;
    }
    const labeled = new Set(p.labeledIds);
    for (const id of ids) {
      if (shouldStop()) break;
      const book = snap.books.get(id)!;
      // The labeled books are read in the first pass and skipped (already planned) in the second.
      if (p.pass === 'all' && labeled.has(id)) {
        // Read (and counted) in the first pass: not counted again.
        p.cursor = id;
        continue;
      }
      const { ev, read } = await timed(p, 'read: book', () =>
        this.readBook(p, libDir, p.libraryId, book),
      );
      this.db.transaction(() => {
        p.cursor = id;
        p.readDone += 1;
        if (read) p.filesRead += 1;
        if (ev?.error) p.readErrors += 1;
        this.db
          .prepare(
            `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(library_id, calibre_uuid) DO UPDATE SET calibre_id = excluded.calibre_id,
               analysis_id = excluded.analysis_id, labeled = excluded.labeled, state = excluded.state,
               updated_at = excluded.updated_at`,
          )
          .run(
            p.libraryId,
            book.uuid,
            id,
            p.analysisId,
            labeled.has(id) ? 1 : 0,
            ev?.file ? 'read' : 'error',
            Date.now(),
          );
        this.save(p);
      })();
    }
    await yieldNow();
    return p;
  }

  // ------------------------------------------------------------ lookups

  private book(uuid: string): Stage2Book | null {
    return this.byUuid?.get(uuid) ?? null;
  }

  private record(book: Stage2Book, ref: RefFile, ev: OnlineEvidence): RefRecord {
    const r = this.baseRecord(book, ref, ev);
    // BookWalker settles the book: the rules read its page in Amazon's place.
    if (ev.amazon.standin === STANDIN) r.amazon = bwAsAmazon(r) ?? {};
    return r;
  }

  private baseRecord(book: Stage2Book, ref: RefFile, ev: OnlineEvidence): RefRecord {
    return {
      calibre: {
        cal_title: book.title,
        cal_authors: book.authors.join('&'),
        cal_tags: book.tags.join('|'),
        has_cover: book.hasCover ? 1 : 0,
      },
      file: ref,
      amazon: { ...ev.amazon } as RefRecord['amazon'],
      ranobedb: { ...ev.ranobedb } as RefRecord['ranobedb'],
      bookwalker: { ...ev.bookwalker } as RefRecord['bookwalker'],
    };
  }

  /** Starts a book's lookups (as ref4 asked them). */
  private plan(p: Stage4Progress, book: Stage2Book, ref: RefFile, labeled: boolean): void {
    const q = this.deps.queue;
    const prio = labeled ? LABELED_PRIORITY : 0;
    const title = queryTitle(ref.opf_title || book.title);
    let author = ((ref.creators ?? [])[0]?.name ?? '').replace(/[\s\u3000]/g, '');
    if (author.toLowerCase() === 'unknown') author = '';
    const ev: OnlineEvidence = {
      v: ONLINE_VERSION,
      query: { title, author, text_book: (ref.chars ?? 0) >= 5000 },
      amazon: {},
      ranobedb: {},
      bookwalker: {},
      bookmeter: {},
      cover: null,
      requests: {},
      open: ['amazon', 'ranobedb', 'bookwalker', 'bookmeter'],
    };
    const w = (step: string) => ({ libraryId: p.libraryId, uuid: book.uuid, step });
    // Amazon is asked only once BookWalker and RanobeDB have answered and don't settle the book
    // (decideAmazon): Amazon allows this address ~3,600-4,000 requests a day.
    ev.requests['ranobedb-search'] = q.enqueue(
      {
        site: 'ranobedb',
        key: `search:${title}`,
        url: `https://ranobedb.org/api/v0/books?q=${pyQuote(title)}&limit=8`,
        priority: prio,
      },
      w('ranobedb-search'),
    ).id;
    ev.requests['bookwalker-search'] = q.enqueue(
      {
        site: 'bookwalker',
        key: `search:${title}`,
        url: `https://bookwalker.jp/search/?word=${pyQuote(title)}`,
        priority: prio,
      },
      w('bookwalker-search'),
    ).id;
    ev.requests['bookmeter-search'] = q.enqueue(
      {
        site: 'bookmeter',
        key: `${BOOKMETER_SEARCH_KEY}${title}`,
        url: bookmeterSearchUrl(title),
        accept: 'text/html, */*; q=0.01',
        priority: prio,
      },
      w('bookmeter-search'),
    ).id;
    this.db.transaction(() => {
      this.saveEvidence(p.libraryId, book.uuid, ONLINE_KIND, ev);
      this.db
        .prepare(
          `UPDATE stage4_books SET state = 'waiting', pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
        )
        .run(ev.open.length, Date.now(), p.libraryId, book.uuid);
    })();
  }

  /** True while the book's Amazon step waits for the decision (not asked, not settled). */
  private amazonPending(libraryId: string, uuid: string, ev: OnlineEvidence): boolean {
    if (!ev.open.includes('amazon') || ev.amazon.asked || ev.amazon.standin) return false;
    return !this.db
      .prepare(
        `SELECT 1 FROM fetch_waiters WHERE library_id = ? AND calibre_uuid = ?
         AND step IN ('amazon-search', 'amazon-dp') LIMIT 1`,
      )
      .get(libraryId, uuid);
  }

  /**
   * Once BookWalker and RanobeDB have answered: BookWalker settles the book (bw-standin.ts), or
   * Amazon is asked as before. A book whose file cover is small or missing always asks Amazon
   * (covers are replaced only from Amazon's picture). True when the evidence changed.
   */
  private decideAmazon(
    p: Stage4Progress,
    book: Stage2Book,
    ref: RefFile,
    ev: OnlineEvidence,
    labeled: boolean,
  ): boolean {
    if (ev.open.includes('bookwalker') || ev.open.includes('ranobedb')) return false;
    // Not while the sweep still clears old Amazon requests (it would clear this book's new one);
    // its pass over every book decides the books that waited meanwhile.
    const sweep = p.amazonSweep?.phase;
    if (sweep === 'waiters' || sweep === 'requests') return false;
    if (!this.amazonPending(p.libraryId, book.uuid, ev)) return false;
    const fc = this.loadRef(p.libraryId, book.uuid)?.cover ?? null;
    const side = fc ? Math.max(fc.width, fc.height) : null;
    const coverOk = side !== null && side >= getSettings(this.db).fetch.smallCoverPx;
    if (coverOk && bwSettles(this.baseRecord(book, ref, ev))) {
      ev.amazon.standin = STANDIN;
      ev.open = ev.open.filter((x) => x !== 'amazon');
      return true;
    }
    this.askAmazon(p, book, ref, ev, labeled);
    return true;
  }

  /** Asks Amazon where the book's Amazon lookup stands: the product page of its ASIN or pick, else the Kindle search. */
  private askAmazon(
    p: Stage4Progress,
    book: Stage2Book,
    ref: RefFile,
    ev: OnlineEvidence,
    labeled: boolean,
  ): void {
    const q = this.deps.queue;
    const prio = labeled ? LABELED_PRIORITY : 0;
    const w = (step: string) => ({ libraryId: p.libraryId, uuid: book.uuid, step });
    ev.amazon.asked = true;
    if (ev.amazon.picked_from_search && ev.amazon.search_candidates) {
      // The search was answered before the sweep: its pick's product page.
      const pick = pickByVolume(
        ev.query.title,
        ev.amazon.search_candidates.slice(0, 6),
        ev.query.text_book,
      );
      if (!pick) {
        ev.open = ev.open.filter((x) => x !== 'amazon');
        return;
      }
      ev.requests['amazon-dp'] = q.enqueue(
        {
          site: 'amazon-dp',
          key: pick[0],
          url: `https://www.amazon.co.jp/dp/${pick[0]}`,
          priority: prio,
        },
        w('amazon-dp'),
      ).id;
      return;
    }
    let asin = ref.asin;
    if (!asin) {
      const m = ASIN_RE.exec(nfkc(`${ref.opf_title || ''} ${book.title}`));
      if (m) {
        asin = m[0];
        ev.amazon.asin_from_title = true;
      }
    }
    if (asin) {
      ev.requests['amazon-dp'] = q.enqueue(
        {
          site: 'amazon-dp',
          key: asin,
          url: `https://www.amazon.co.jp/dp/${asin}`,
          priority: prio,
        },
        w('amazon-dp'),
      ).id;
    } else {
      const k = `${ev.query.title} ${ev.query.author}`.trim();
      ev.requests['amazon-search'] = q.enqueue(
        {
          site: 'amazon-search',
          key: k,
          url: `https://www.amazon.co.jp/s?k=${pyQuote(k)}&i=digital-text`,
          priority: prio,
        },
        w('amazon-search'),
      ).id;
    }
  }

  /**
   * The one-time sweep after "Amazon where needed" came in (chunked, the server answers
   * between chunks): the Amazon requests still queued lose their waiters and leave the queue,
   * then every waiting book whose BookWalker and RanobeDB have answered is decided now.
   */
  private async amazonSweepStep(p: Stage4Progress): Promise<void> {
    const sw = (p.amazonSweep ??= { phase: 'waiters', cursor: '' });
    if (sw.phase === 'done') return;
    const db = this.db;
    const t = performance.now();
    if (sw.phase === 'waiters') {
      const n = db
        .prepare(
          `DELETE FROM fetch_waiters WHERE rowid IN (
             SELECT w.rowid FROM fetch_requests r CROSS JOIN fetch_waiters w ON w.request_id = r.id
             WHERE r.site IN ('amazon-search', 'amazon-dp') AND r.state = 'queued'
               AND w.step IN ('amazon-search', 'amazon-dp') LIMIT ${SWEEP_CHUNK})`,
        )
        .run().changes;
      if (n < SWEEP_CHUNK) sw.phase = 'requests';
    } else if (sw.phase === 'requests') {
      const n = db
        .prepare(
          `DELETE FROM fetch_requests WHERE id IN (
             SELECT r.id FROM fetch_requests r
             WHERE r.site IN ('amazon-dp', 'amazon-search') AND r.state = 'queued'
               AND NOT EXISTS (SELECT 1 FROM fetch_waiters w WHERE w.request_id = r.id)
             LIMIT ${SWEEP_CHUNK})`,
        )
        .run().changes;
      if (n < SWEEP_CHUNK) {
        sw.phase = 'books';
        sw.cursor = '';
      }
    } else {
      const rows = db
        .prepare(
          `SELECT calibre_uuid, labeled, state FROM stage4_books
           WHERE library_id = ? AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
        )
        .all(p.libraryId, sw.cursor) as { calibre_uuid: string; labeled: number; state: string }[];
      const slicer = new Slicer(p);
      for (const r of rows) {
        await slicer.maybeYield();
        sw.cursor = r.calibre_uuid;
        if (r.state !== 'waiting') continue;
        const book = this.book(r.calibre_uuid);
        const ev = book ? this.loadOnline(p.libraryId, r.calibre_uuid) : null;
        const ref = book ? this.loadRef(p.libraryId, r.calibre_uuid)?.file : null;
        if (!book || !ev || !ref) continue;
        if (!this.decideAmazon(p, book, ref, ev, r.labeled === 1)) continue;
        db.transaction(() => {
          this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
          db.prepare(
            `UPDATE stage4_books SET state = ?, pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
          ).run(
            ev.open.length ? 'waiting' : 'ready',
            ev.open.length,
            Date.now(),
            p.libraryId,
            r.calibre_uuid,
          );
        })();
        if (!ev.open.length || !ev.requests['core-done']) {
          // Its last source closed with the decision: the follow-ups (Bookmeter's store list).
          if (this.core.every((s) => !ev.open.includes(s)) && !ev.requests['core-done']) {
            ev.requests['core-done'] = 1;
            this.afterCore(p, book, ref, ev, r.labeled === 1);
            db.transaction(() => {
              this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
              db.prepare(
                `UPDATE stage4_books SET state = ?, pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
              ).run(
                ev.open.length ? 'waiting' : 'ready',
                ev.open.length,
                Date.now(),
                p.libraryId,
                r.calibre_uuid,
              );
            })();
          }
        }
      }
      if (rows.length < 200) sw.phase = 'done';
    }
    addTime(p, `amazon sweep: ${sw.phase}`, performance.now() - t);
    this.save(p);
  }

  /**
   * Bookmeter asked again with its plain index, once per analysis (found 2026-11-19: the
   * type=japanese_v2 index returned nothing for 46% of the searches). First the searches still
   * queued are pointed at the plain index (their address only: nothing was answered yet). Then
   * every book whose Bookmeter search was answered by the old index without an accepted match
   * asks the new search (key BOOKMETER_SEARCH_KEY) and waits for it; its other sources stay as
   * answered, and once the answer is in its match is checked again and its proposals rewritten.
   * Chunked and sliced like the Amazon sweep (the event loop never waits long).
   */
  private async bookmeterRedoStep(p: Stage4Progress): Promise<void> {
    const r0 = (p.bookmeterRedo ??= { phase: 'queued', cursor: '', books: 0 });
    if (r0.phase === 'done') return;
    const db = this.db;
    const t = performance.now();
    if (r0.phase === 'queued') {
      const n = db
        .prepare(
          `UPDATE fetch_requests SET url = replace(url, 'type=japanese_v2', 'type=japanese'), updated_at = ?
           WHERE id IN (SELECT id FROM fetch_requests WHERE site = 'bookmeter' AND state = 'queued'
             AND url LIKE '%type=japanese_v2%' LIMIT ${SWEEP_CHUNK})`,
        )
        .run(Date.now()).changes;
      if (n < SWEEP_CHUNK) r0.phase = 'books';
    } else {
      const rows = db
        .prepare(
          `SELECT calibre_uuid, labeled, state FROM stage4_books
           WHERE library_id = ? AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
        )
        .all(p.libraryId, r0.cursor) as { calibre_uuid: string; labeled: number; state: string }[];
      const reqOf = db.prepare('SELECT url, state FROM fetch_requests WHERE id = ?');
      const slicer = new Slicer(p);
      for (const r of rows) {
        await slicer.maybeYield();
        r0.cursor = r.calibre_uuid;
        if (r.state !== 'waiting' && r.state !== 'ready' && r.state !== 'proposed') continue;
        const book = this.book(r.calibre_uuid);
        const ev = book ? this.loadOnline(p.libraryId, r.calibre_uuid) : null;
        const id = ev?.requests['bookmeter-search'];
        if (!book || !ev || !id || ev.bookmeter.accepted) continue;
        const req = reqOf.get(id) as { url: string; state: string } | undefined;
        // Still queued (its address was fixed above), in flight, or given up: nothing to redo.
        if (!req || req.state !== 'done' || !oldBookmeterSearch(req.url)) continue;
        const title = ev.query.title;
        ev.bookmeter = {};
        if (!ev.open.includes('bookmeter')) ev.open.push('bookmeter');
        // The match is checked again (afterCore) once the new answer is in.
        delete ev.requests['core-done'];
        ev.requests['bookmeter-search'] = this.deps.queue.enqueue(
          {
            site: 'bookmeter',
            key: `${BOOKMETER_SEARCH_KEY}${title}`,
            url: bookmeterSearchUrl(title),
            accept: 'text/html, */*; q=0.01',
            priority: r.labeled === 1 ? LABELED_PRIORITY : 0,
          },
          { libraryId: p.libraryId, uuid: r.calibre_uuid, step: 'bookmeter-search' },
        ).id;
        db.transaction(() => {
          this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
          db.prepare(
            `UPDATE stage4_books SET state = 'waiting', pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
          ).run(ev.open.length, Date.now(), p.libraryId, r.calibre_uuid);
        })();
        r0.books++;
      }
      if (rows.length < 200) {
        r0.phase = 'done';
        this.log(`Stage 4: Bookmeter asked again for ${r0.books} books (plain index)`);
      }
    }
    addTime(p, `bookmeter redo: ${r0.phase}`, performance.now() - t);
    this.save(p);
  }

  /**
   * Once per analysis: books whose BookWalker search found nothing before the retry existed ask
   * the simpler query (bookwalkerRetryQuery) and wait for it; everything else stays as answered
   * (Amazon was already asked or settled for them). Chunked and sliced as the other passes.
   */
  private async bookwalkerRetryStep(p: Stage4Progress): Promise<void> {
    const r0 = (p.bookwalkerRetry ??= { phase: 'books', cursor: '', books: 0 });
    if (r0.phase === 'done') return;
    const db = this.db;
    const t = performance.now();
    const rows = db
      .prepare(
        `SELECT calibre_uuid, labeled, state FROM stage4_books
         WHERE library_id = ? AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(p.libraryId, r0.cursor) as { calibre_uuid: string; labeled: number; state: string }[];
    const stateOf = db.prepare('SELECT state FROM fetch_requests WHERE id = ?');
    const slicer = new Slicer(p);
    for (const r of rows) {
      await slicer.maybeYield();
      r0.cursor = r.calibre_uuid;
      if (r.state !== 'waiting' && r.state !== 'ready' && r.state !== 'proposed') continue;
      const ev = this.book(r.calibre_uuid) ? this.loadOnline(p.libraryId, r.calibre_uuid) : null;
      const id = ev?.requests['bookwalker-search'];
      if (!ev || !id || ev.bookwalker.retried || ev.bookwalker.search_candidates) continue;
      if ((stateOf.get(id) as { state: string } | undefined)?.state !== 'gone') continue;
      const retry = bookwalkerRetryQuery(ev.query.title);
      if (!retry) continue;
      ev.bookwalker.retried = retry;
      if (!ev.open.includes('bookwalker')) ev.open.push('bookwalker');
      ev.requests['bookwalker-search'] = this.deps.queue.enqueue(
        {
          site: 'bookwalker',
          key: `search:${retry}`,
          url: `https://bookwalker.jp/search/?word=${pyQuote(retry)}`,
          priority: r.labeled === 1 ? LABELED_PRIORITY : 0,
        },
        { libraryId: p.libraryId, uuid: r.calibre_uuid, step: 'bookwalker-search' },
      ).id;
      db.transaction(() => {
        this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
        db.prepare(
          `UPDATE stage4_books SET state = 'waiting', pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
        ).run(ev.open.length, Date.now(), p.libraryId, r.calibre_uuid);
      })();
      r0.books++;
    }
    if (rows.length < 200) {
      r0.phase = 'done';
      this.log(`Stage 4: BookWalker asked again for ${r0.books} books (simpler query)`);
    }
    addTime(p, `bookwalker retry: ${r0.phase}`, performance.now() - t);
    this.save(p);
  }

  /** Moves a book on with one answer; returns the evidence (saved by the caller). */
  private onAnswer(
    p: Stage4Progress,
    book: Stage2Book,
    ev: OnlineEvidence,
    step: string,
    requestId: number,
    labeled: boolean,
  ): void {
    const q = this.deps.queue;
    const prio = labeled ? LABELED_PRIORITY : 0;
    const w = (s: string) => ({ libraryId: p.libraryId, uuid: book.uuid, step: s });
    const req = this.db
      .prepare('SELECT state, error, status FROM fetch_requests WHERE id = ?')
      .get(requestId) as {
      state: string;
      error: string | null;
      status: number | null;
    };
    const body = req.state === 'done' ? q.readAnswer(requestId) : null;
    const failed = req.state === 'failed' ? `gave up: ${req.error ?? `HTTP ${req.status}`}` : null;
    const close = (s: string) => {
      ev.open = ev.open.filter((x) => x !== s);
    };
    ev.requests[step] = requestId;
    const tb = ev.query.text_book;
    switch (step) {
      case 'amazon-search': {
        if (!body) {
          if (failed) ev.amazon.failed = failed;
          close('amazon');
          break;
        }
        const cands = parseAmazonSearch(body);
        ev.amazon.search_candidates = cands;
        const pick = pickByVolume(ev.query.title, cands.slice(0, 6), tb);
        if (!pick) {
          close('amazon');
          break;
        }
        ev.amazon.picked_from_search = true;
        q.enqueue(
          {
            site: 'amazon-dp',
            key: pick[0],
            url: `https://www.amazon.co.jp/dp/${pick[0]}`,
            priority: prio,
          },
          w('amazon-dp'),
        );
        break;
      }
      case 'amazon-dp': {
        if (body) ev.amazon.product = parseAmazonDp(body);
        else if (req.state === 'gone') ev.amazon.gone = true;
        else if (failed) ev.amazon.failed = failed;
        close('amazon');
        break;
      }
      case 'ranobedb-search': {
        const hits = body ? rdbCandidates(jload(body)) : [];
        if (failed) ev.ranobedb.failed = failed;
        if (hits.length) ev.ranobedb.search_candidates = hits;
        const pick = hits.length ? pickByVolume(ev.query.title, hits, tb) : null;
        if (pick && sim(ev.query.title, pick[1]) >= 0.7) {
          q.enqueue(
            {
              site: 'ranobedb',
              key: `book:${String(pick[0])}`,
              url: `https://ranobedb.org/api/v0/book/${String(pick[0])}`,
              priority: prio,
            },
            w('ranobedb-book'),
          );
        } else close('ranobedb');
        break;
      }
      case 'ranobedb-book': {
        if (!body) {
          if (failed) ev.ranobedb.failed = failed;
          close('ranobedb');
          break;
        }
        const raw = jload(body);
        const book4 = rdbBook(raw);
        ev.ranobedb.book = book4;
        ev.ranobedb.author_match = rdbAuthorMatch(book4, ev.query.author);
        const sid = book4.series?.id;
        if (sid !== null && sid !== undefined) {
          q.enqueue(
            {
              site: 'ranobedb',
              key: `series:${String(sid)}`,
              url: `https://ranobedb.org/api/v0/series/${String(sid)}`,
              priority: prio,
            },
            w('ranobedb-series'),
          );
        } else close('ranobedb');
        break;
      }
      case 'ranobedb-series': {
        if (body) ev.ranobedb.series = rdbSeries(jload(body));
        else if (failed) ev.ranobedb.failed = failed;
        close('ranobedb');
        break;
      }
      case 'bookwalker-search': {
        if (!body) {
          // "Not found" (HTTP 404): once more with the title up to its volume number.
          // BookWalker's search misses zero-padded or glued numbers and Roman numerals
          // ("…騎士団10", "…D×D 06", "…パラディンI"), and finds the series by its name
          // (proven 2026-11-19: 327 of 24,731 light novels RanobeDB knows).
          const retry =
            req.state === 'gone' && !ev.bookwalker.retried
              ? bookwalkerRetryQuery(ev.query.title)
              : null;
          if (retry) {
            ev.bookwalker.retried = retry;
            q.enqueue(
              {
                site: 'bookwalker',
                key: `search:${retry}`,
                url: `https://bookwalker.jp/search/?word=${pyQuote(retry)}`,
                priority: prio,
              },
              w('bookwalker-search'),
            );
            break;
          }
          if (failed) ev.bookwalker.failed = failed;
          close('bookwalker');
          break;
        }
        const items = parseBwList(body);
        ev.bookwalker.search_candidates = items.slice(0, 8);
        const pick = pickByVolume(ev.query.title, items.slice(0, 8), tb);
        if (pick && pick[0].includes('/series/')) {
          q.enqueue(
            { site: 'bookwalker', key: pick[0], url: pick[0], priority: prio },
            w('bookwalker-series'),
          );
        } else if (pick && pick[0].includes('/de')) {
          q.enqueue(
            { site: 'bookwalker', key: pick[0], url: pick[0], priority: prio },
            w('bookwalker-detail'),
          );
        } else close('bookwalker');
        break;
      }
      case 'bookwalker-series': {
        if (!body) {
          if (failed) ev.bookwalker.failed = failed;
          close('bookwalker');
          break;
        }
        const vols = parseBwList(body).filter((v) => v[0].includes('/de'));
        ev.bookwalker.series_candidates = vols.slice(0, 40);
        const pick = pickByVolume(ev.query.title, vols, tb);
        if (pick)
          q.enqueue(
            { site: 'bookwalker', key: pick[0], url: pick[0], priority: prio },
            w('bookwalker-detail'),
          );
        else close('bookwalker');
        break;
      }
      case 'bookwalker-detail': {
        const url = (
          this.db.prepare('SELECT url FROM fetch_requests WHERE id = ?').get(requestId) as {
            url: string;
          }
        ).url;
        if (body) ev.bookwalker.detail = { ...parseBwDetail(body), url };
        else if (failed) ev.bookwalker.failed = failed;
        close('bookwalker');
        break;
      }
      case 'bookmeter-search': {
        if (body) ev.bookmeter.hits = parseBookmeterSearch(body);
        else if (failed) ev.bookmeter.failed = failed;
        close('bookmeter');
        break;
      }
      case 'bookmeter-stores': {
        if (body) ev.bookmeter.stores = parseBookmeterStores(body);
        else if (failed) ev.bookmeter.failed = failed;
        close('stores');
        break;
      }
      case 'cover': {
        close('cover');
        if (!body) {
          if (ev.cover) ev.cover.failed = failed ?? req.state;
        }
        // The picture's facts are computed asynchronously by the caller (sharp).
        break;
      }
    }
  }

  /** Follow-up lookups that need the rules' decision (Bookmeter's acceptance, the Amazon cover). */
  private afterCore(
    p: Stage4Progress,
    book: Stage2Book,
    ref: RefFile,
    ev: OnlineEvidence,
    labeled: boolean,
  ): void {
    const q = this.deps.queue;
    const prio = labeled ? LABELED_PRIORITY : 0;
    const w = (s: string) => ({ libraryId: p.libraryId, uuid: book.uuid, step: s });
    const s = getSettings(this.db);
    const rec = this.record(book, ref, ev);
    const d = decideStage4(rec);
    if (ev.bookmeter.hits && ev.bookmeter.accepted === undefined) {
      const acc = acceptBookmeter(ev.bookmeter.hits, {
        title: d.values.t,
        authors: d.values.au,
        own: bookmeterOwnTexts(book, ref, d, rec.amazon?.product?.title),
      });
      ev.bookmeter.accepted = acc.hit ? { id: acc.hit.id, reason: acc.reason } : null;
      ev.bookmeter.reason = acc.reason;
      if (acc.hit) {
        ev.open.push('stores');
        q.enqueue(
          {
            site: 'bookmeter',
            key: `stores:${acc.hit.id}`,
            url: bookmeterStoresUrl(acc.hit.id),
            accept: 'application/json, text/javascript, */*; q=0.01',
            priority: prio,
          },
          w('bookmeter-stores'),
        );
      }
    }
    if (ev.cover === null) {
      const fc = this.loadRef(p.libraryId, book.uuid)?.cover ?? null;
      const side = fc ? Math.max(fc.width, fc.height) : null;
      const url = (ev.amazon.product?.cover_url as string | null | undefined) ?? null;
      if (url && d.trace.amazonIdentified && (side === null || side < s.fetch.smallCoverPx)) {
        ev.cover = { url };
        ev.open.push('cover');
        q.enqueue(
          { site: 'amazon-img', key: url, url, accept: 'image/*', priority: prio },
          w('cover'),
        );
      }
    }
  }

  private core = ['amazon', 'ranobedb', 'bookwalker', 'bookmeter'];

  /**
   * One handled answer of `from` (a lookup step, or the 'decide' / 'after-core' event) and the
   * new requests it made since `before`, per step, into the progress (the time left's rates).
   * Returns the counts now, for the next event of the same answer.
   */
  private countFollowUps(
    p: Stage4Progress,
    from: string,
    before: Record<string, number>,
  ): Record<string, number> {
    const now = { ...this.deps.queue.created };
    if (!(from in NEXT_STEPS)) return now;
    const f = (p.followUps ??= { answers: {}, made: {} });
    f.answers[from] = (f.answers[from] ?? 0) + 1;
    for (const [step, n] of Object.entries(now)) {
      const d = n - (before[step] ?? 0);
      if (d > 0) f.made[`${from}>${step}`] = (f.made[`${from}>${step}`] ?? 0) + d;
    }
    return now;
  }

  private async lookupStep(p: Stage4Progress): Promise<Stage4Progress> {
    const db = this.db;
    this.loadSnapshot(p.libraryId);
    await this.amazonSweepStep(p);
    if (p.amazonSweep?.phase === 'done') await this.bookmeterRedoStep(p);
    if (p.bookmeterRedo?.phase === 'done') await this.bookwalkerRetryStep(p);
    const t0 = performance.now();
    // 0. A site switched off answers nothing: its queued requests are given up, so the books
    // go on without that source ("Ask again" on the page re-asks them once it is back on).
    // Only Calibre's sites: the audiobook cleanup's (WP21c) have their own books and waiters.
    const off = Object.entries(getSettings(db).fetch.sites)
      .filter(([k, v]) => !v.enabled && (CALIBRE_FETCH_SITES as readonly string[]).includes(k))
      .map(([k]) => k);
    for (const site of off) {
      const ids = (
        db
          .prepare(`SELECT id FROM fetch_requests WHERE site = ? AND state = 'queued' LIMIT 1000`)
          .all(site) as {
          id: number;
        }[]
      ).map((r) => r.id);
      if (!ids.length) continue;
      const now = Date.now();
      db.transaction(() => {
        for (const id of ids) {
          db.prepare(
            `UPDATE fetch_requests SET state = 'failed', error = 'The site is switched off', finished_at = ?, updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          ).run(now, now, id);
          db.prepare('UPDATE fetch_waiters SET ready = 1 WHERE request_id = ?').run(id);
        }
      })();
    }
    addTime(p, 'lookups: switched-off sites', performance.now() - t0);
    // 1. Start the lookups of books that were read (labeled books first).
    let t = performance.now();
    const toPlan = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'read'
         ORDER BY labeled DESC LIMIT ?`,
      )
      .all(p.analysisId, PLAN_CHUNK) as { calibre_uuid: string; labeled: number }[];
    const slicer = new Slicer(p);
    for (const r of toPlan) {
      await slicer.maybeYield();
      const book = this.book(r.calibre_uuid);
      const ref = this.loadRef(p.libraryId, r.calibre_uuid);
      if (!book || !ref?.file) {
        db.prepare(
          `UPDATE stage4_books SET state = 'error', error = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
        ).run(ref?.error ?? 'not in the library any more', Date.now(), p.libraryId, r.calibre_uuid);
        continue;
      }
      this.plan(p, book, ref.file, r.labeled === 1);
    }
    if (toPlan.length) addTime(p, 'lookups: plan', performance.now() - t);
    if (toPlan.length) await yieldNow();

    // 2. Answers that arrived.
    t = performance.now();
    const ready = db
      .prepare(
        `SELECT request_id, library_id, calibre_uuid, step FROM fetch_waiters WHERE ready = 1 LIMIT ?`,
      )
      .all(ANSWER_CHUNK) as {
      request_id: number;
      library_id: string;
      calibre_uuid: string;
      step: string;
    }[];
    for (const wr of ready) {
      await slicer.maybeYield();
      if (wr.step === 'natively-page') {
        db.transaction(() => {
          this.nativelyPage(wr.request_id, wr.calibre_uuid, Date.now());
          db.prepare(
            'DELETE FROM fetch_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ? AND step = ?',
          ).run(wr.request_id, wr.library_id, wr.calibre_uuid, wr.step);
        })();
        continue;
      }
      const book = this.book(wr.calibre_uuid);
      const ev = book ? this.loadOnline(wr.library_id, wr.calibre_uuid) : null;
      const row = db
        .prepare(
          'SELECT labeled, state FROM stage4_books WHERE library_id = ? AND calibre_uuid = ?',
        )
        .get(wr.library_id, wr.calibre_uuid) as { labeled: number; state: string } | undefined;
      if (!book || !ev || !row || row.state !== 'waiting') {
        db.prepare(
          'DELETE FROM fetch_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ? AND step = ?',
        ).run(wr.request_id, wr.library_id, wr.calibre_uuid, wr.step);
        continue;
      }
      const ref = this.loadRef(wr.library_id, wr.calibre_uuid)!.file!;
      const labeled = row.labeled === 1;
      let made = { ...this.deps.queue.created };
      this.onAnswer(p, book, ev, wr.step, wr.request_id, labeled);
      made = this.countFollowUps(p, wr.step, made);
      // BookWalker and RanobeDB have answered: BookWalker settles the book, or Amazon is asked.
      if (this.decideAmazon(p, book, ref, ev, labeled))
        made = this.countFollowUps(p, 'decide', made);
      if (wr.step === 'cover' && ev.cover) {
        const img = this.deps.queue.readAnswer(wr.request_id);
        const facts = img ? await imageFacts(img).catch(() => null) : null;
        if (facts)
          Object.assign(ev.cover, { width: facts.width, height: facts.height, dhash: facts.dhash });
        else if (!ev.cover.failed) ev.cover.failed = 'not a readable picture';
      }
      if (this.core.every((s) => !ev.open.includes(s)) && !ev.requests['core-done']) {
        ev.requests['core-done'] = 1;
        this.afterCore(p, book, ref, ev, labeled);
        this.countFollowUps(p, 'after-core', made);
      }
      db.transaction(() => {
        this.saveEvidence(wr.library_id, wr.calibre_uuid, ONLINE_KIND, ev);
        db.prepare(
          'DELETE FROM fetch_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ? AND step = ?',
        ).run(wr.request_id, wr.library_id, wr.calibre_uuid, wr.step);
        db.prepare(
          `UPDATE stage4_books SET state = ?, pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
        ).run(
          ev.open.length ? 'waiting' : 'ready',
          ev.open.length,
          Date.now(),
          wr.library_id,
          wr.calibre_uuid,
        );
        // A given-up request is noted on the book, so "Ask again" on the page re-plans it.
        const st = db
          .prepare('SELECT site, state FROM fetch_requests WHERE id = ?')
          .get(wr.request_id) as {
          site: string;
          state: string;
        };
        if (st.state === 'failed') {
          db.prepare(
            `UPDATE stage4_books SET lookup_json = json_set(lookup_json, '$.failed.' || ?, 1)
             WHERE library_id = ? AND calibre_uuid = ?`,
          ).run(st.site, wr.library_id, wr.calibre_uuid);
        }
      })();
    }
    if (ready.length) addTime(p, 'lookups: answers', performance.now() - t);
    if (ready.length) await yieldNow();

    // 3. Proposals for books whose lookups are answered.
    t = performance.now();
    const done = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'ready' ORDER BY labeled DESC LIMIT ?`,
      )
      .all(p.analysisId, PROPOSE_CHUNK) as { calibre_uuid: string; labeled: number }[];
    for (const r of done) {
      await slicer.maybeYield();
      const tb = performance.now();
      await this.proposeBook(p, r.calibre_uuid);
      addTime(p, 'propose: book', performance.now() - tb);
    }
    if (done.length) addTime(p, 'lookups: propose', performance.now() - t);
    if (done.length) await yieldNow();

    // 4. Natively's sitemap and pages, the authors' readings.
    t = performance.now();
    this.natively(p);
    addTime(p, 'lookups: Natively', performance.now() - t);
    t = performance.now();
    this.readings(p);
    addTime(p, 'lookups: readings', performance.now() - t);

    // 5. The gate once the labeled books are proposed. Labeled books back in the queue after
    // the gate ran (a one-time pass asked a source again) are checked again once they are
    // proposed again (user, 2026-11-19: every change is checked on the labeled books).
    if (p.labeledDoneAt !== null && p.labeledIds.length) {
      const reopened = db
        .prepare(
          `SELECT 1 FROM stage4_books WHERE analysis_id = ? AND labeled = 1 AND state IN ('read', 'waiting', 'ready') LIMIT 1`,
        )
        .get(p.analysisId);
      if (reopened) {
        p.labeledDoneAt = null;
        p.labeledCheckedOnce = true;
        this.log('Stage 4: labeled books were reopened; they are checked again once proposed');
      }
    }
    if (p.labeledDoneAt === null && p.labeledIds.length) {
      const open = db
        .prepare(
          `SELECT 1 FROM stage4_books WHERE analysis_id = ? AND labeled = 1 AND state IN ('read', 'waiting', 'ready') LIMIT 1`,
        )
        .get(p.analysisId);
      if (!open && p.pass === 'all') {
        p.labeledDoneAt = Date.now();
        p.labeledCheckedOnce = true;
        await this.gateNow(p);
        this.log(`Stage 4: labeled books checked (${p.labeledIds.length})`);
      }
    }

    // 6. Everything answered and proposed: the final pass.
    if (p.phase === 'lookups') {
      const open = db
        .prepare(
          `SELECT 1 FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'waiting', 'ready') LIMIT 1`,
        )
        .get(p.analysisId);
      // Not before the one-time passes are through every book (they can reopen finished ones).
      const passesDone =
        p.amazonSweep?.phase === 'done' &&
        p.bookmeterRedo?.phase === 'done' &&
        p.bookwalkerRetry?.phase === 'done';
      if (!open && passesDone && this.nativelyDone() && this.readingsDone()) {
        p.phase = 'final';
        p.finalCursor = 0;
      }
    }
    return p;
  }

  // ------------------------------------------------------------ proposals

  /** The proposals of one book (also used by the gate). */
  proposalsFor(
    p: Stage4Progress,
    uuid: string,
    settings: CleanupSettings,
    calibreCover?: CalibreCoverNow | null,
    /** The AI's values; undefined = read the stored ones (when the AI step decided this book). */
    ai?: (Stage4AiValues & { asked: boolean }) | null,
  ): { proposals: Stage4Proposal[]; decision: ReturnType<typeof decideStage4> } | null {
    const book = this.book(uuid);
    const ref = this.loadRef(p.libraryId, uuid);
    const ev = this.loadOnline(p.libraryId, uuid);
    if (!book || !ref?.file || !ev) return null;
    const record = this.record(book, ref.file, ev);
    const decision = decideStage4(record);
    const applied = new Map<string, unknown>();
    const appliedLastModified = new Map<string, string | null>();
    for (const a of this.db
      .prepare(
        'SELECT field, value_json, last_modified_after FROM applied_values WHERE library_id = ? AND calibre_uuid = ?',
      )
      .all(p.libraryId, uuid) as {
      field: string;
      value_json: string;
      last_modified_after: string | null;
    }[]) {
      applied.set(a.field, JSON.parse(a.value_json));
      appliedLastModified.set(a.field, a.last_modified_after);
    }
    const readings = new Map<string, { reading: string; source: 'ndl' | 'generated' }>();
    for (const n of new Set([...decision.values.au, ...book.authors])) {
      const r = this.db
        .prepare('SELECT reading, state FROM author_readings WHERE name = ?')
        .get(n) as { reading: string | null; state: string } | undefined;
      if (r?.reading && (r.state === 'found' || r.state === 'generated')) {
        readings.set(n, { reading: r.reading, source: r.state === 'found' ? 'ndl' : 'generated' });
      }
    }
    const fc = ref.cover ?? null;
    const cover =
      ev.cover && ev.cover.width
        ? {
            fileSide: fc ? Math.max(fc.width, fc.height) : null,
            fileDhash: fc?.dhash ?? null,
            storeSide: Math.max(ev.cover.width ?? 0, ev.cover.height ?? 0),
            storeDhash: ev.cover.dhash ?? null,
            distance: hammingHex(fc?.dhash ?? null, ev.cover.dhash ?? null),
            url: ev.cover.url,
          }
        : null;
    const accepted = ev.bookmeter.accepted;
    const asin =
      (decision.trace.amazonIdentified ? (ev.amazon.product?.asin as string | null) : null) ??
      book.identifiers.amazon_jp ??
      null;
    const isbn = ev.bookmeter.stores?.isbn ?? null;
    const proposals = proposeStage4({
      book,
      extras: this.extras?.get(book.calibreId) ?? null,
      record,
      decision,
      bookmeter: accepted ? { id: accepted.id, stores: ev.bookmeter.stores ?? {} } : null,
      natively: this.nativelyFor(asin, isbn),
      readings,
      cover,
      applied,
      appliedLastModified,
      calibreCover,
      ai: ai === undefined ? storedAiValues(this.db, `${p.libraryId}:${uuid}`) : ai,
      spelling: this.snapshot ? spellingLookup(this.snapshot.names) : undefined,
      seriesSpelling: this.seriesSpelling(p),
      seriesOrder: seriesChoiceOf(this.db, p.libraryId, uuid),
      sameDistance: settings.covers.sameDistance,
      smallCoverPx: settings.fetch.smallCoverPx,
    });
    return { proposals, decision };
  }

  private spellingCache: { at: number; map: Map<string, string> } | null = null;
  /** The AI step's chosen spelling per series (series-spelling.ts), or null before it chose. */
  private seriesSpelling(p: Stage4Progress): Map<string, string> | null {
    const s = (
      p as { ai?: { seriesSpelling?: { at: number; names: Record<string, string> } | null } }
    ).ai?.seriesSpelling;
    if (!s) return null;
    if (this.spellingCache?.at !== s.at)
      this.spellingCache = { at: s.at, map: new Map(Object.entries(s.names)) };
    return this.spellingCache.map;
  }

  /**
   * Every Calibre book's series as stage 4 On would leave it, before the one-spelling choice:
   * an automatic series proposal's decided name, else Calibre's name now (WP20e).
   */
  seriesAfterOn(p: Stage4Progress): { uuid: string; after: string | null; now: string | null }[] {
    const snap = this.loadSnapshot(p.libraryId);
    const extras = this.extras;
    const proposed = new Map<string, string | null>();
    for (const r of this.db
      .prepare(
        `SELECT calibre_uuid, new_json, evidence_json FROM proposed_changes
         WHERE stage = 4 AND library_id = ? AND field = 'series' AND state = 'proposed' AND class = 'auto'`,
      )
      .all(p.libraryId) as {
      calibre_uuid: string;
      new_json: string;
      evidence_json: string | null;
    }[]) {
      const v = JSON.parse(r.new_json) as { name?: string | null } | null;
      const ev = r.evidence_json
        ? (JSON.parse(r.evidence_json) as { spelling?: { asDecided?: string | null } })
        : {};
      proposed.set(
        r.calibre_uuid,
        ev.spelling && 'asDecided' in ev.spelling
          ? (ev.spelling.asDecided ?? null)
          : (v?.name ?? null),
      );
    }
    const out: { uuid: string; after: string | null; now: string | null }[] = [];
    for (const b of snap.books.values()) {
      const now = extras?.get(b.calibreId)?.series ?? null;
      out.push({ uuid: b.uuid, after: proposed.has(b.uuid) ? proposed.get(b.uuid)! : now, now });
    }
    return out;
  }

  /**
   * Every Calibre book's series name, number and title as stage 4 On leaves them (series-order
   * follow-up): an automatic proposal's values, else what the cleanup wrote (applied_values: a
   * number written empty shows as 1 in Calibre), else Calibre's own. Spelled as chosen.
   */
  seriesStateAfterOn(
    p: Stage4Progress,
  ): Map<string, { name: string | null; index: number | null; title: string; proposed: boolean }> {
    const snap = this.loadSnapshot(p.libraryId);
    const extras = this.extras;
    const spell = this.seriesSpelling(p);
    const proposed = new Map<string, { name: string | null; index: number | null }>();
    const titles = new Map<string, string>();
    for (const r of this.db
      .prepare(
        `SELECT calibre_uuid, field, new_json FROM proposed_changes
         WHERE stage = 4 AND library_id = ? AND field IN ('series', 'title') AND state = 'proposed' AND class = 'auto'`,
      )
      .all(p.libraryId) as { calibre_uuid: string; field: string; new_json: string }[]) {
      const v = JSON.parse(r.new_json) as unknown;
      if (r.field === 'title' && typeof v === 'string') titles.set(r.calibre_uuid, v);
      else if (r.field === 'series') {
        const s = v as { name?: string | null; index?: number | null } | null;
        proposed.set(r.calibre_uuid, { name: s?.name ?? null, index: s?.index ?? null });
      }
    }
    const out = new Map<
      string,
      {
        name: string | null;
        index: number | null;
        title: string;
        proposed: boolean;
        proposedSeries?: boolean;
      }
    >();
    for (const b of snap.books.values()) {
      const ex = extras?.get(b.calibreId);
      const title = titles.get(b.uuid) ?? b.title;
      const pr = proposed.get(b.uuid);
      if (pr) {
        const name = pr.name && spell ? spellingOf(spell, pr.name) : pr.name;
        out.set(b.uuid, {
          name,
          index: name ? pr.index : null,
          title,
          proposed: true,
          proposedSeries: true,
        });
        continue;
      }
      // Calibre's number here; seriesBook reads what the cleanup wrote (one book by its key:
      // reading every written value at once took 677 ms of the server at the live size).
      const now = ex?.series ?? null;
      out.set(b.uuid, {
        name: now,
        index: now ? (ex?.seriesIndex ?? null) : null,
        title,
        proposed: titles.has(b.uuid),
      });
    }
    return out;
  }

  /**
   * One book's facts for the series order (series-order.ts), or null when stage 4 has no
   * evidence for it (then its series is Calibre's own and stays as it is).
   */
  seriesBook(
    p: Stage4Progress,
    uuid: string,
    after: { name: string | null; index: number | null; title: string; proposedSeries?: boolean },
  ): SeriesBook | null {
    if (!after.name) return null;
    const book = this.book(uuid);
    // A number the cleanup wrote empty shows as 1 in Calibre: the written value counts (not
    // when a proposal is pending: its number is the one after On).
    const written = after.proposedSeries
      ? undefined
      : (this.db
          .prepare(
            `SELECT value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = 'series'`,
          )
          .get(p.libraryId, uuid) as { value_json: string } | undefined);
    const seriesName = after.name;
    if (written) {
      const s = JSON.parse(written.value_json) as { name?: string | null; index?: number | null };
      if (s?.name && N(s.name) === N(seriesName)) after = { ...after, index: s.index ?? null };
    }
    const ref = this.loadRef(p.libraryId, uuid)?.file ?? null;
    const ev = book && ref ? this.loadOnline(p.libraryId, uuid) : null;
    const ai = storedAiValues(this.db, `${p.libraryId}:${uuid}`);
    if (!book) return null;
    const fromAi = (f: 'se' | 'ix' | 't', rulesAuto: boolean): ValueFrom => {
      const a = ai?.[f];
      if (!a) return rulesAuto ? 'store' : 'models';
      if (a.source === 'user') return 'user';
      if (a.flagged || (a.source !== 'rules' && a.source !== 'both_models')) return 'guess';
      if (a.source === 'rules') return rulesAuto ? 'store' : 'guess';
      return rulesAuto ? 'store' : 'models';
    };
    if (!ref || !ev) {
      return {
        uuid,
        calibreId: book.calibreId,
        name: seriesName,
        index: after.index,
        indexFrom: 'calibre',
        nameFrom: 'calibre',
        kind: 'full',
        own: [book.title],
        title: after.title,
        titleFrom: 'calibre',
        authors: book.authors,
        records: [],
        storeSeries: [],
        pool: [],
        date: null,
      };
    }
    const rec = this.record(book, ref, ev);
    const d = decideStage4(rec);
    // Stage 4's series is this one (its decided name, as spelled): else Calibre's own.
    const decided = (ai?.se?.value as { name?: string | null } | null)?.name ?? d.values.se ?? null;
    const spell = this.seriesSpelling(p);
    const decidedSpelled = decided && spell ? spellingOf(spell, decided) : decided;
    const ours = !!decidedSpelled && N(decidedSpelled) === N(after.name);
    const tAi = ai?.t;
    const titleFrom: SeriesBook['titleFrom'] = !tAi
      ? 'file'
      : tAi.source === 'user'
        ? 'user'
        : tAi.flagged || (tAi.source !== 'rules' && tAi.source !== 'both_models')
          ? 'guess'
          : tAi.source === 'both_models'
            ? 'models'
            : 'file';
    const colophon = nfkc(ref.colophon_text || '');
    const own = [
      ref.opf_title,
      ...[...colophon.matchAll(/[『「]([^』」]{2,80})[』」]/gu)].map((m) => m[1]),
    ].filter((t): t is string => !!t);
    const records: string[] = [];
    if (d.trace.amazonIdentified && rec.amazon?.product?.title)
      records.push(rec.amazon.product.title as string);
    if (d.trace.ranobedbIdentified && rec.ranobedb?.book?.title_orig)
      records.push(rec.ranobedb.book.title_orig as string);
    if (ev.bookwalker.detail?.title && d.trace.cleaned.bookwalker)
      records.push(ev.bookwalker.detail.title as string);
    const storeSeries: string[] = [];
    const amzSeries = (rec.amazon?.product?.series as string | undefined) ?? '';
    if (amzSeries) storeSeries.push(amzSeries.replace(/^全\d+冊中\d+番目の本\s*/u, ''));
    const rs = ev.ranobedb.series?.title_orig ?? ev.ranobedb.book?.series?.title_orig;
    if (typeof rs === 'string') storeSeries.push(rs);
    const pool: PoolEntry[] = [];
    for (const [, t] of ev.amazon.search_candidates ?? []) pool.push({ title: t, from: 'amazon' });
    for (const [, t] of ev.bookwalker.search_candidates ?? [])
      pool.push({ title: t, from: 'bookwalker' });
    for (const [, t] of ev.bookwalker.series_candidates ?? [])
      pool.push({ title: t, from: 'bookwalker' });
    for (const x of ev.ranobedb.series?.books ?? [])
      pool.push({
        title: String(x.title_orig ?? ''),
        from: 'ranobedb',
        order: typeof x.sort_order === 'number' ? x.sort_order : null,
        type: typeof x.type === 'string' ? x.type : null,
      });
    for (const [, t] of ev.ranobedb.search_candidates ?? [])
      pool.push({ title: String(t), from: 'ranobedb' });
    const kinds: Record<string, SeriesBook['kind']> = {
      full: 'full',
      sample: 'sample',
      bonus: 'bonus',
      'special edition': 'special edition',
      omnibus: 'omnibus',
    };
    return {
      uuid,
      calibreId: book.calibreId,
      name: seriesName,
      index: after.index,
      indexFrom: ours ? fromAi('ix', d.auto.ix) : 'calibre',
      nameFrom: ours ? fromAi('se', d.auto.se) : 'calibre',
      kind: kinds[d.values.kind] ?? 'full',
      own,
      title: after.title,
      titleFrom,
      authors: d.values.au,
      records,
      storeSeries,
      pool: pool.filter((e) => e.title),
      date: firstColophonDate(colophon),
    };
  }

  private writeProposals(
    p: Stage4Progress,
    book: Stage2Book,
    proposals: Stage4Proposal[],
    fields?: Set<string>,
  ): void {
    const db = this.db;
    const now = Date.now();
    // The book's own rows by the book index. Left to itself SQLite takes proposed_changes_counts
    // (four equal columns) and walks every stage-4 proposal of the field: found live 2026-11-20,
    // ~0.6 s per book mid-run and 1.9 s per book at the library's size (10 fields, PC), against
    // 0.1 ms by the book index; the final pass (8 h 38 min on the page) and every proposal during
    // the lookups blocked the server that long.
    const del = db.prepare(
      `DELETE FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE stage = 4 AND library_id = ? AND calibre_uuid = ? AND state = 'proposed' AND field = ?`,
    );
    const ins = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
    );
    const all =
      fields ??
      new Set(
        proposals
          .map((x) => x.field)
          .concat([
            'title',
            'authors',
            'illustrator',
            'series',
            'format',
            'kind',
            'description',
            'cover',
            'identifiers',
            'author_sort',
          ]),
      );
    for (const f of all) del.run(p.libraryId, book.uuid, f);
    for (const x of proposals) {
      if (fields && !fields.has(x.field)) continue;
      ins.run(
        p.libraryId,
        book.calibreId,
        book.uuid,
        x.field,
        JSON.stringify(x.old ?? null),
        JSON.stringify(x.new ?? null),
        x.source,
        JSON.stringify({ ...(x.evidence ?? {}), rules: STAGE4_RULES_VERSION }),
        x.class,
        x.reason,
        p.analysisId,
        now,
        now,
      );
    }
  }

  /**
   * Calibre's cover.jpg as it is now, read only for a book whose cover the cleanup wrote and
   * that has a store cover to consider (WP20e: the check "changed in Calibre after the cleanup
   * wrote it" compares the cover's bytes). null when it can't be read; undefined = not needed.
   */
  async calibreCoverNow(
    p: Stage4Progress,
    book: Stage2Book,
  ): Promise<CalibreCoverNow | null | undefined> {
    if (!book.hasCover) return undefined;
    const written = this.db
      .prepare(
        "SELECT 1 FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = 'cover'",
      )
      .get(p.libraryId, book.uuid);
    if (!written) return undefined;
    const ev = this.loadOnline(p.libraryId, book.uuid);
    if (!ev?.cover?.width) return undefined;
    try {
      const bytes = await readSourceFile(
        path.join(this.libraryDir(p.libraryId), book.path, 'cover.jpg'),
      );
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        dhash: await differenceHash(bytes),
      };
    } catch {
      return null;
    }
  }

  private async proposeBook(p: Stage4Progress, uuid: string): Promise<void> {
    const db = this.db;
    const settings = getSettings(db);
    const book = this.book(uuid);
    const cover = book ? await this.calibreCoverNow(p, book) : undefined;
    const res = book ? this.proposalsFor(p, uuid, settings, cover) : null;
    db.transaction(() => {
      if (book && res) {
        this.writeProposals(p, book, res.proposals);
        // The authors' readings are asked once per name.
        for (const n of new Set([...res.decision.values.au, ...book.authors])) {
          if (!n || n === 'Unknown') continue;
          db.prepare(
            `INSERT OR IGNORE INTO author_readings (name, state, updated_at) VALUES (?, 'queued', ?)`,
          ).run(n, Date.now());
        }
      }
      db.prepare(
        `UPDATE stage4_books SET state = ?, error = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
      ).run(
        res ? 'proposed' : 'error',
        res ? null : 'evidence missing',
        Date.now(),
        p.libraryId,
        uuid,
      );
    })();
  }

  // ------------------------------------------------------------ Natively

  private nativelyFor(asin: string | null, isbn13: string | null): string | null {
    if (asin) {
      const r = this.db
        .prepare('SELECT natively_id FROM natively_asins WHERE asin = ? LIMIT 1')
        .get(asin) as { natively_id: string } | undefined;
      if (r) return r.natively_id;
    }
    if (isbn13) {
      const r = this.db
        .prepare('SELECT natively_id FROM natively_books WHERE isbn13 = ? LIMIT 1')
        .get(isbn13) as { natively_id: string } | undefined;
      if (r) return r.natively_id;
    }
    return null;
  }

  private nativelyDone(): boolean {
    if (!getSettings(this.db).fetch.sites.natively.enabled) return true;
    const sitemap = this.db
      .prepare("SELECT state FROM fetch_requests WHERE site = 'natively' AND key = 'sitemap'")
      .get() as { state: string } | undefined;
    if (!sitemap || sitemap.state === 'queued' || sitemap.state === 'leased') return false;
    const open = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM fetch_requests WHERE site = 'natively' AND state IN ('queued', 'leased')",
      )
      .get() as { n: number };
    return open.n === 0;
  }

  /** One answered Natively page into the index (its ISBNs and Kindle ASINs). */
  private nativelyPage(requestId: number, nativelyId: string, now: number): void {
    const req = this.db.prepare('SELECT state FROM fetch_requests WHERE id = ?').get(requestId) as {
      state: string;
    };
    const body = req.state === 'done' ? this.deps.queue.readAnswer(requestId) : null;
    const b = body ? parseNativelyBook(body) : null;
    const isbn13 = b?.isbn13 ?? (b?.isbn10 ? isbn13From10(b.isbn10) : null);
    this.db
      .prepare(
        'UPDATE natively_books SET title = ?, isbn10 = ?, isbn13 = ?, read_at = ? WHERE natively_id = ?',
      )
      .run(b?.title ?? null, b?.isbn10 ?? null, isbn13, now, nativelyId);
    const addAsin = this.db.prepare(
      'INSERT OR IGNORE INTO natively_asins (asin, natively_id) VALUES (?, ?)',
    );
    for (const asin of b?.kindleAsins ?? []) addAsin.run(asin, nativelyId);
  }

  private natively(p: Stage4Progress): void {
    const db = this.db;
    const s = getSettings(db).fetch;
    if (!s.sites.natively.enabled) return;
    const now = Date.now();
    const sitemap = db
      .prepare(
        "SELECT id, state, finished_at FROM fetch_requests WHERE site = 'natively' AND key = 'sitemap'",
      )
      .get() as { id: number; state: string; finished_at: number | null } | undefined;
    if (!sitemap) {
      this.deps.queue.enqueue(
        {
          site: 'natively',
          key: 'sitemap',
          url: NATIVELY_SITEMAP,
          accept: 'application/xml',
          priority: 1,
        },
        null,
        now,
      );
      return;
    }
    if (sitemap.state === 'done' && sitemap.finished_at !== null) {
      if ((p.nativelyListedAt ?? 0) < sitemap.finished_at) {
        const body = this.deps.queue.readAnswer(sitemap.id);
        const pages = body ? parseNativelySitemap(body) : [];
        const ins = db.prepare(
          `INSERT INTO natively_books (natively_id, url, listed_at) VALUES (?, ?, ?)
           ON CONFLICT(natively_id) DO UPDATE SET listed_at = excluded.listed_at`,
        );
        db.transaction(() => {
          for (const pg of pages) ins.run(pg.id, pg.url, sitemap.finished_at);
        })();
        p.nativelyListedAt = sitemap.finished_at;
        this.log(`stage 4: Natively's sitemap lists ${pages.length} book pages`);
      }
      // A sitemap older than the re-read time is asked again (new Natively books).
      if (now - sitemap.finished_at > s.nativelyRereadDays * 86400_000) {
        db.prepare(
          "UPDATE fetch_requests SET state = 'queued', next_at = 0, updated_at = ? WHERE id = ?",
        ).run(now, sitemap.id);
      }
    }
    // Pages not asked yet go to the queue (in chunks, each once); their answers come back
    // through the waiters like a book's (lookupStep).
    const unqueued = db
      .prepare(`SELECT natively_id, url FROM natively_books WHERE queued_at IS NULL LIMIT ?`)
      .all(NATIVELY_ENQUEUE_CHUNK) as { natively_id: string; url: string }[];
    if (unqueued.length) {
      db.transaction(() => {
        for (const u of unqueued) {
          this.deps.queue.enqueue(
            { site: 'natively', key: u.natively_id, url: u.url, priority: 0 },
            { libraryId: NATIVELY_WAITER, uuid: u.natively_id, step: 'natively-page' },
            now,
          );
          db.prepare('UPDATE natively_books SET queued_at = ? WHERE natively_id = ?').run(
            now,
            u.natively_id,
          );
        }
      })();
    }
  }

  // ------------------------------------------------------------ readings

  private readingsDone(): boolean {
    const sudachi = getSettings(this.db).fetch.sites.sudachi.enabled;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM author_readings WHERE state IN ('queued', 'asked', 'generating')` +
          (sudachi ? ` OR state = 'not_found'` : ''),
      )
      .get() as { n: number };
    return r.n === 0;
  }

  private readings(p: Stage4Progress): void {
    const db = this.db;
    const s = getSettings(db).fetch;
    const now = Date.now();
    // Answers of NDL batches.
    for (const r of db
      .prepare(
        `SELECT DISTINCT a.request_id AS id, f.state FROM author_readings a JOIN fetch_requests f ON f.id = a.request_id
         WHERE a.state = 'asked' AND f.state IN ('done', 'gone', 'failed') LIMIT 20`,
      )
      .all() as { id: number; state: string }[]) {
      const body = r.state === 'done' ? this.deps.queue.readAnswer(r.id) : null;
      const rows = body ? parseNdl(body) : null;
      const names = (
        db
          .prepare("SELECT name FROM author_readings WHERE request_id = ? AND state = 'asked'")
          .all(r.id) as { name: string }[]
      ).map((x) => x.name);
      db.transaction(() => {
        for (const n of names) {
          const hit = rows ? ndlReading(rows, n) : null;
          if (hit) {
            db.prepare(
              `UPDATE author_readings SET state = 'found', reading = ?, source = 'ndl', authority = ?, ambiguous = ?, updated_at = ? WHERE name = ?`,
            ).run(hit.reading, hit.authority, hit.ambiguous ? 1 : 0, now, n);
          } else if (rows) {
            db.prepare(
              `UPDATE author_readings SET state = 'not_found', updated_at = ? WHERE name = ?`,
            ).run(now, n);
          } else {
            // The query failed: ask again in a later batch.
            db.prepare(
              `UPDATE author_readings SET state = 'queued', request_id = NULL, updated_at = ? WHERE name = ?`,
            ).run(now, n);
          }
        }
      })();
    }
    // New NDL batches: full ones while books are still being proposed, the rest at the end.
    const booksOpen = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'waiting', 'ready')`,
        )
        .get(p.analysisId) as { n: number }
    ).n;
    if (!s.sites.ndl.enabled) {
      // NDL switched off: its names go straight to the generated readings.
      db.prepare(
        `UPDATE author_readings SET state = 'not_found', updated_at = ? WHERE state = 'queued'`,
      ).run(now);
    } else {
      for (;;) {
        const names = (
          db
            .prepare(
              `SELECT name FROM author_readings WHERE state = 'queued' ORDER BY name LIMIT ?`,
            )
            .all(s.ndlNamesPerQuery) as { name: string }[]
        ).map((x) => x.name);
        if (!names.length || (names.length < s.ndlNamesPerQuery && booksOpen > 0)) break;
        const query = ndlQuery(names);
        const id = this.deps.queue.enqueue(
          {
            site: 'ndl',
            key: `q:${names.join('\u0001')}`,
            url: NDL_SPARQL,
            method: 'POST',
            body: `query=${encodeURIComponent(query)}`,
            accept: 'application/sparql-results+json',
            priority: 1,
          },
          null,
          now,
        ).id;
        db.transaction(() => {
          for (const n of names)
            db.prepare(
              `UPDATE author_readings SET state = 'asked', request_id = ?, updated_at = ? WHERE name = ?`,
            ).run(id, now, n);
        })();
      }
    }
    // Names NDL lacks: a generated reading from the fetcher's Sudachi, in batches.
    if (s.sites.sudachi.enabled) {
      for (const r of db
        .prepare(
          `SELECT DISTINCT a.request_id AS id, f.state FROM author_readings a JOIN fetch_requests f ON f.id = a.request_id
           WHERE a.state = 'generating' AND f.state IN ('done', 'gone', 'failed') LIMIT 20`,
        )
        .all() as { id: number; state: string }[]) {
        const body = r.state === 'done' ? this.deps.queue.readAnswer(r.id) : null;
        let got: Record<string, string> = {};
        try {
          got = body
            ? ((JSON.parse(body.toString('utf8')) as { readings?: Record<string, string> })
                .readings ?? {})
            : {};
        } catch {
          got = {};
        }
        db.transaction(() => {
          for (const [n, reading] of Object.entries(got)) {
            if (!reading) continue;
            db.prepare(
              `UPDATE author_readings SET state = 'generated', reading = ?, source = 'sudachi', generated = ?, updated_at = ?
               WHERE name = ? AND state = 'generating' AND request_id = ?`,
            ).run(reading, reading, now, n, r.id);
          }
          // A failed batch is asked again; names Sudachi couldn't read get no reading.
          db.prepare(
            `UPDATE author_readings SET state = ?, updated_at = ? WHERE request_id = ? AND state = 'generating'`,
          ).run(r.state === 'done' ? 'none' : 'not_found', now, r.id);
        })();
      }
      const waiting = (
        db
          .prepare(
            `SELECT name FROM author_readings WHERE state = 'not_found' ORDER BY name LIMIT 200`,
          )
          .all() as {
          name: string;
        }[]
      ).map((x) => x.name);
      if (waiting.length >= 200 || (waiting.length && booksOpen === 0)) {
        const id = this.deps.queue.enqueue(
          {
            site: 'sudachi',
            key: `r:${waiting.join('\u0001')}`,
            url: 'local:sudachi',
            method: 'LOCAL',
            body: JSON.stringify({ names: waiting }),
            priority: 1,
          },
          null,
          now,
        ).id;
        db.transaction(() => {
          for (const n of waiting) {
            db.prepare(
              `UPDATE author_readings SET state = 'generating', request_id = ?, updated_at = ? WHERE name = ?`,
            ).run(id, now, n);
          }
        })();
      }
    }
  }

  // ------------------------------------------------------------ final

  private async finalStep(p: Stage4Progress): Promise<Stage4Progress> {
    const rows = this.db
      .prepare(
        `SELECT calibre_uuid, calibre_id FROM stage4_books WHERE analysis_id = ? AND state = 'proposed' AND calibre_id > ?
         ORDER BY calibre_id LIMIT ?`,
      )
      .all(p.analysisId, p.finalCursor, FINAL_CHUNK) as {
      calibre_uuid: string;
      calibre_id: number;
    }[];
    if (!rows.length) {
      await this.gateNow(p);
      p.phase = 'done';
      p.finishedAt = Date.now();
      return p;
    }
    const settings = getSettings(this.db);
    const fields = new Set(['identifiers', 'author_sort']);
    const slicer = new Slicer(p);
    for (const r of rows) {
      await slicer.maybeYield();
      const book = this.book(r.calibre_uuid);
      const res = book ? this.proposalsFor(p, r.calibre_uuid, settings) : null;
      this.db.transaction(() => {
        if (book && res) this.writeProposals(p, book, res.proposals, fields);
        p.finalCursor = r.calibre_id;
        p.finalDone = (p.finalDone ?? 0) + 1;
        this.save(p);
      })();
    }
    await yieldNow();
    return p;
  }

  // ------------------------------------------------------------ gate

  /** Grades the labeled books per field (the 600 and check D apart) and pauses a field below its bar. */
  /**
   * Once, for an analysis finished before the edition check (WP20e): every book's Bookmeter
   * match is accepted again from its stored hits. A book whose match is gone is proposed again
   * (its store links); a book with another hit now waits for that hit's store list (the
   * analysis goes back to its lookups for those few).
   */
  private async bookmeterEditionsStep(p: Stage4Progress): Promise<void> {
    const r0 = (p.bookmeterEditions ??= { phase: 'books', cursor: '', changed: 0, reopened: 0 });
    if (r0.phase === 'done') return;
    const db = this.db;
    const t = performance.now();
    this.loadSnapshot(p.libraryId);
    const rows = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books
         WHERE library_id = ? AND state = 'proposed' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(p.libraryId, r0.cursor) as { calibre_uuid: string; labeled: number }[];
    const slicer = new Slicer(p);
    for (const r of rows) {
      await slicer.maybeYield();
      r0.cursor = r.calibre_uuid;
      const book = this.book(r.calibre_uuid);
      const ref = book ? this.loadRef(p.libraryId, r.calibre_uuid)?.file : null;
      const ev = book && ref ? this.loadOnline(p.libraryId, r.calibre_uuid) : null;
      if (!book || !ref || !ev?.bookmeter.hits) continue;
      const rec = this.record(book, ref, ev);
      const d = decideStage4(rec);
      const acc = acceptBookmeter(ev.bookmeter.hits, {
        title: d.values.t,
        authors: d.values.au,
        own: bookmeterOwnTexts(book, ref, d, rec.amazon?.product?.title),
      });
      if ((acc.hit?.id ?? null) === (ev.bookmeter.accepted?.id ?? null)) continue;
      r0.changed++;
      ev.bookmeter.accepted = acc.hit ? { id: acc.hit.id, reason: acc.reason } : null;
      ev.bookmeter.reason = acc.reason;
      ev.bookmeter.stores = {};
      if (acc.hit) {
        ev.open.push('stores');
        this.deps.queue.enqueue(
          {
            site: 'bookmeter',
            key: `stores:${acc.hit.id}`,
            url: bookmeterStoresUrl(acc.hit.id),
            accept: 'application/json, text/javascript, */*; q=0.01',
            priority: r.labeled === 1 ? LABELED_PRIORITY : 0,
          },
          { libraryId: p.libraryId, uuid: r.calibre_uuid, step: 'bookmeter-stores' },
        );
        db.transaction(() => {
          this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
          db.prepare(
            `UPDATE stage4_books SET state = 'waiting', pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
          ).run(ev.open.length, Date.now(), p.libraryId, r.calibre_uuid);
        })();
        r0.reopened++;
      } else {
        this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
        await this.proposeBook(p, r.calibre_uuid);
      }
    }
    if (rows.length < 200) {
      r0.phase = 'done';
      this.log(
        `Stage 4: Bookmeter's edition check changed ${r0.changed} matches (${r0.reopened} wait for another hit's store list)`,
      );
      if (r0.reopened > 0) {
        p.phase = 'lookups';
        p.finishedAt = null;
      }
    }
    addTime(p, 'bookmeter editions', performance.now() - t);
  }

  /** The fetch key (ASIN, ranobedb book:id, BookWalker URL) a stored request id asked for. */
  private requestKey(id: number | undefined): string | null {
    if (id === undefined) return null;
    const r = this.db.prepare('SELECT key FROM fetch_requests WHERE id = ?').get(id) as
      | { key: string }
      | undefined;
    return r?.key ?? null;
  }

  /**
   * Once per analysis (series-order follow-up, 2026-11-22): the Amazon, RanobeDB and BookWalker
   * picks of every finished book made again from its stored search results with the fixed
   * picker (pick.ts). Measured on a live copy: 1,051 books pick another record (273 Amazon, 16
   * RanobeDB, 902 BookWalker), almost all the volume itself where the old picker took volume 1.
   * A book whose pick changed loses the old record and waits for the new one (the analysis goes
   * back to its lookups for those; most pages are cached); the AI step then starts over and asks
   * only about books whose evidence changed.
   */
  private async repickStep(p: Stage4Progress): Promise<void> {
    const r0 = (p.repick ??= {
      phase: 'books',
      cursor: '',
      amazon: 0,
      ranobedb: 0,
      bookwalker: 0,
      reopened: 0,
    });
    if (r0.phase === 'done') return;
    const db = this.db;
    const t = performance.now();
    const rows = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books
         WHERE library_id = ? AND state = 'proposed' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(p.libraryId, r0.cursor) as { calibre_uuid: string; labeled: number }[];
    const slicer = new Slicer(p);
    for (const r of rows) {
      await slicer.maybeYield();
      r0.cursor = r.calibre_uuid;
      const ev = this.loadOnline(p.libraryId, r.calibre_uuid);
      if (!ev) continue;
      const q = this.deps.queue;
      const prio = r.labeled === 1 ? LABELED_PRIORITY : 0;
      const w = (step: string) => ({ libraryId: p.libraryId, uuid: r.calibre_uuid, step });
      const qt = ev.query.title;
      const tb = ev.query.text_book;
      const open = new Set(ev.open);
      let changed = false;

      // Amazon: the product page of the pick among the search results (as askAmazon).
      if (ev.amazon.picked_from_search && ev.amazon.search_candidates) {
        const pick = pickByVolume(qt, ev.amazon.search_candidates.slice(0, 6), tb);
        const old = this.requestKey(ev.requests['amazon-dp']);
        if (pick && old && pick[0] !== old) {
          delete ev.amazon.product;
          delete ev.amazon.gone;
          delete ev.amazon.failed;
          open.add('amazon');
          ev.requests['amazon-dp'] = q.enqueue(
            {
              site: 'amazon-dp',
              key: pick[0],
              url: `https://www.amazon.co.jp/dp/${pick[0]}`,
              priority: prio,
            },
            w('amazon-dp'),
          ).id;
          r0.amazon++;
        }
      }

      // RanobeDB: the book (then its series) of the pick, when similar enough (as the lookup).
      const hits = ev.ranobedb.search_candidates ?? [];
      if (hits.length) {
        const pick = pickByVolume(qt, hits, tb);
        const want = pick && sim(qt, pick[1]) >= 0.7 ? String(pick[0]) : null;
        const old = ev.ranobedb.book ? String(ev.ranobedb.book.id) : null;
        if (want !== old) {
          changed = true;
          delete ev.ranobedb.book;
          delete ev.ranobedb.series;
          delete ev.ranobedb.author_match;
          delete ev.ranobedb.failed;
          if (want) {
            open.add('ranobedb');
            q.enqueue(
              {
                site: 'ranobedb',
                key: `book:${want}`,
                url: `https://ranobedb.org/api/v0/book/${want}`,
                priority: prio,
              },
              w('ranobedb-book'),
            );
          }
          r0.ranobedb++;
        }
      }

      // BookWalker: the search's pick, a series list (then its pick) or a book page.
      const bwSearch = ev.bookwalker.search_candidates ?? [];
      if (bwSearch.length) {
        const s = pickByVolume(qt, bwSearch.slice(0, 8), tb);
        const oldDetail = ev.bookwalker.detail?.url ?? null;
        const oldSeries = this.requestKey(ev.requests['bookwalker-series']);
        let fetch: { url: string; step: 'bookwalker-series' | 'bookwalker-detail' } | null = null;
        if (s && s[0].includes('/series/')) {
          if (s[0] === oldSeries && ev.bookwalker.series_candidates) {
            const v = pickByVolume(qt, ev.bookwalker.series_candidates, tb);
            if (v && v[0] !== oldDetail) fetch = { url: v[0], step: 'bookwalker-detail' };
          } else if (s[0] !== oldSeries) fetch = { url: s[0], step: 'bookwalker-series' };
        } else if (s && s[0].includes('/de') && s[0] !== oldDetail) {
          fetch = { url: s[0], step: 'bookwalker-detail' };
        }
        if (fetch) {
          delete ev.bookwalker.detail;
          delete ev.bookwalker.failed;
          if (fetch.step === 'bookwalker-series') delete ev.bookwalker.series_candidates;
          open.add('bookwalker');
          q.enqueue(
            { site: 'bookwalker', key: fetch.url, url: fetch.url, priority: prio },
            w(fetch.step),
          );
          r0.bookwalker++;
        }
      }

      if (open.size === ev.open.length) {
        // Only a record dropped (RanobeDB's pick is now no match): proposed again as it is.
        if (changed) {
          this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
          await this.proposeBook(p, r.calibre_uuid);
        }
        continue;
      }
      ev.open = [...open];
      db.transaction(() => {
        this.saveEvidence(p.libraryId, r.calibre_uuid, ONLINE_KIND, ev);
        db.prepare(
          `UPDATE stage4_books SET state = 'waiting', pending = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
        ).run(ev.open.length, Date.now(), p.libraryId, r.calibre_uuid);
      })();
      r0.reopened++;
    }
    if (rows.length < 200) {
      r0.phase = 'done';
      this.log(
        `Stage 4: picks made again with the fixed picker: ${r0.reopened} books wait for another record (Amazon ${r0.amazon}, RanobeDB ${r0.ranobedb}, BookWalker ${r0.bookwalker})`,
      );
      if (r0.reopened > 0) {
        p.phase = 'lookups';
        p.finishedAt = null;
      }
    }
    addTime(p, 'repick', performance.now() - t);
  }

  // ------------------------------------------------------------ the AI step (WP20e)

  /** A book's inputs for the AI step: its sources as fetched, the rules' record and decision. */
  aiInputs(
    p: Stage4Progress,
    uuid: string,
  ): {
    book: Stage2Book;
    base: RefRecord;
    record: RefRecord;
    decision: Stage4Decision;
  } | null {
    this.loadSnapshot(p.libraryId);
    const book = this.book(uuid);
    const ref = this.loadRef(p.libraryId, uuid);
    const ev = this.loadOnline(p.libraryId, uuid);
    if (!book || !ref?.file || !ev) return null;
    const base = this.baseRecord(book, ref.file, ev);
    const record = this.record(book, ref.file, ev);
    return { book, base, record, decision: decideStage4(record) };
  }

  /** Stage 5 (WP20f): Calibre's series, number and description now (the snapshot's extras). */
  extrasOf(p: Stage4Progress, calibreId: number): Stage4Extras | null {
    this.loadSnapshot(p.libraryId);
    return this.extras?.get(calibreId) ?? null;
  }

  /** Every book's extras at once (one look at the snapshot file, not one per book). */
  extrasAll(p: Stage4Progress): ReadonlyMap<number, Stage4Extras> {
    this.loadSnapshot(p.libraryId);
    return this.extras ?? new Map();
  }

  /** Proposes a book again with the AI's decided values (from ai_values). */
  async proposeWithAi(
    p: Stage4Progress,
    uuid: string,
    ai: (Stage4AiValues & { asked: boolean }) | null,
  ): Promise<boolean> {
    this.loadSnapshot(p.libraryId);
    const book = this.book(uuid);
    if (!book) return false;
    const settings = getSettings(this.db);
    const cover = await this.calibreCoverNow(p, book);
    const res = this.proposalsFor(p, uuid, settings, cover, ai);
    if (!res) return false;
    this.db.transaction(() => this.writeProposals(p, book, res.proposals))();
    return true;
  }

  /** The labeled books in the library now: label id, the book's uuid and its label. */
  labeledBooks(p: Stage4Progress): { gid: string; uuid: string; gold: Stage4Gold }[] {
    const file = this.referenceFile();
    if (!file) return [];
    const { gold } = loadGold(file);
    if (!gold) return [];
    const snap = this.loadSnapshot(p.libraryId);
    const out: { gid: string; uuid: string; gold: Stage4Gold }[] = [];
    for (const [gid, calibreId] of mapLabeledIds(this.db, p.libraryId, Object.keys(gold))) {
      const book = snap.books.get(calibreId);
      if (book) out.push({ gid, uuid: book.uuid, gold: (gold as Record<string, Stage4Gold>)[gid] });
    }
    return out;
  }

  async gateNow(p: Stage4Progress): Promise<Record<string, unknown> | null> {
    const file = this.referenceFile();
    if (!file) return null;
    const { gold } = loadGold(file);
    if (!gold) return null;
    const settings = getSettings(this.db);
    const mapped = mapLabeledIds(this.db, p.libraryId, Object.keys(gold));
    const groups = { ABC: emptyScores(), D: emptyScores(), all: emptyScores() };
    const kind = { right: 0, all: 0 };
    let books = 0;
    const slicer = new Slicer(p);
    for (const [gid, calibreId] of mapped) {
      await slicer.maybeYield();
      const book = this.snapshot?.books.get(calibreId);
      if (!book) continue;
      const res = this.proposalsFor(p, book.uuid, settings);
      if (!res) continue;
      const g = (gold as Record<string, Stage4Gold>)[gid];
      books += 1;
      const values = res.decision.values as unknown as Record<ScoredField, unknown>;
      addScore(groups[g.sample === 'D' ? 'D' : 'ABC'], gid, values, res.decision.auto, g);
      addScore(groups.all, gid, values, res.decision.auto, g);
      kind.all += 1;
      if (g.kind === res.decision.values.kind) kind.right += 1;
    }
    const fields: Record<string, unknown> = {};
    for (const f of SCORED_FIELDS) {
      const name = FIELD_NAMES[f];
      const all = groups.all[f];
      const pct = percent(all.right, all.auto);
      const bar = stage4Bar(settings, name);
      const below = pct !== null && all.auto >= settings.gate.minBooks && pct < bar;
      fields[name] = {
        auto: all.auto,
        scored: all.scored,
        right: all.right,
        percent: pct,
        bar,
        below,
        the600: {
          auto: groups.ABC[f].auto,
          right: groups.ABC[f].right,
          percent: percent(groups.ABC[f].right, groups.ABC[f].auto),
          measured: MEASURED_V3.ABC[f],
        },
        checkD: {
          auto: groups.D[f].auto,
          right: groups.D[f].right,
          percent: percent(groups.D[f].right, groups.D[f].auto),
          measured: MEASURED_V3.D[f],
        },
        wrong: all.wrong.slice(0, 50),
      };
      if (below)
        pauseField(
          this.db,
          STAGE,
          name,
          'gate',
          `${pct!.toFixed(1)} % right on the labeled books (bar ${bar} %)`,
        );
      else resumeField(this.db, STAGE, name);
    }
    const precision = {
      gate: {
        books,
        at: Date.now(),
        fields,
        kind: { ...kind, percent: percent(kind.right, kind.all) },
      },
    };
    updateStage(this.db, STAGE, { precision });
    return precision;
  }
}

/** The texts that are the book's own for Bookmeter's edition check (acceptBookmeter). */
export function bookmeterOwnTexts(
  book: { title: string },
  ref: { opf_title?: string | null; front_text?: string | null; colophon_text?: string | null },
  d: { trace: { amazonIdentified: boolean } },
  amazonTitle?: string | null,
): (string | null | undefined)[] {
  return [
    ref.opf_title,
    book.title,
    d.trace.amazonIdentified ? amazonTitle : null,
    ref.front_text,
    ref.colophon_text,
  ];
}
