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
import { gunzipSync, gzipSync } from 'zlib';
import { snapshotFile } from '../../calibre/indexer';
import { getLibrary } from '../../calibre/libraries';
import { resolveInside, statFile } from '../../calibre/source-fs';
import { imageFacts, readFileMetadata } from '../file-metadata';
import { getSettings, stage4Bar, type CleanupSettings } from '../settings';
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
import { ASIN_RE, pickByVolume, pyQuote, queryTitle, sim } from './pick';
import { proposeStage4, type Stage4Proposal } from './proposals';
import { FetchQueue, LABELED_PRIORITY } from './queue';
import { readRefEpub, type RefFile } from './ref-epub';
import { nfkc } from './ref-text';
import type { RefRecord } from './rules-v3';
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
import { decideStage4, STAGE4_RULES_VERSION } from './stage4-rules';
import {
  NATIVELY_SITEMAP,
  NDL_SPARQL,
  acceptBookmeter,
  bookmeterSearchUrl,
  bookmeterStoresUrl,
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
  /** The answer time of the Natively sitemap whose pages are listed. */
  nativelyListedAt?: number | null;
}

/** One book's online evidence (kind 'online'), in the reference record's shape plus the store links. */
export interface OnlineEvidence {
  v: number;
  query: { title: string; author: string; text_book: boolean };
  amazon: {
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
  async maybeYield(): Promise<void> {
    if (Date.now() - this.at < SLICE_MS) return;
    await yieldNow();
    this.at = Date.now();
  }
}
const READ_CHUNK = 20;
const PLAN_CHUNK = 500;
const ANSWER_CHUNK = 200;
const PROPOSE_CHUNK = 100;
const FINAL_CHUNK = 50;
const NATIVELY_ENQUEUE_CHUNK = 2000;
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
  };
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
    this.snapshot = readStage2Snapshot(file);
    this.extras = readStage4Extras(file);
    this.byUuid = new Map([...this.snapshot.books.values()].map((b) => [b.uuid, b]));
    this.snapshotFor = file;
    return this.snapshot;
  }

  /** One unit of work; true when finished (or failed). Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      if (p.phase === 'read') {
        p = await this.readStep(p, shouldStop);
        // Books already read start their lookups while the rest of the library is read.
        await this.lookupStep(p);
      } else if (p.phase === 'lookups') {
        p = await this.lookupStep(p);
      } else if (p.phase === 'final') {
        p = await this.finalStep(p);
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
        file = await readRefEpub(epub, counted);
      } catch (err) {
        error = `read: ${String((err as Error).message ?? err).slice(0, 300)}`;
      }
      const s2 = loadFileEvidence(this.db, libraryId, book.uuid);
      const same =
        s2 && s2.path === book.filePath && s2.size === st.size && s2.mtimeMs === st.mtimeMs;
      let fc = same ? (s2.file?.cover ?? null) : null;
      if (!same && file) {
        try {
          fc = (await readFileMetadata(epub, { text: false, counted })).cover;
        } catch {
          fc = null;
        }
      }
      cover = fc ? { width: fc.width, height: fc.height, dhash: fc.dhash } : null;
      await this.pacer().take(counted.bytes);
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
    const withEpub = [...snap.books.values()].filter((b) => b.filePath !== null);
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
        p.cursor = id;
        p.readDone += 1;
        continue;
      }
      const { ev, read } = await this.readBook(libDir, p.libraryId, book);
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
      const k = `${title} ${author}`.trim();
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
        key: `search:${title}`,
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
    const d = decideStage4(this.record(book, ref, ev));
    if (ev.bookmeter.hits && ev.bookmeter.accepted === undefined) {
      const acc = acceptBookmeter(ev.bookmeter.hits, { title: d.values.t, authors: d.values.au });
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

  private async lookupStep(p: Stage4Progress): Promise<Stage4Progress> {
    const db = this.db;
    this.loadSnapshot(p.libraryId);
    // 1. Start the lookups of books that were read (labeled books first).
    const toPlan = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'read'
         ORDER BY labeled DESC LIMIT ?`,
      )
      .all(p.analysisId, PLAN_CHUNK) as { calibre_uuid: string; labeled: number }[];
    const slicer = new Slicer();
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
    if (toPlan.length) await yieldNow();

    // 2. Answers that arrived.
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
      this.onAnswer(p, book, ev, wr.step, wr.request_id, labeled);
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
    if (ready.length) await yieldNow();

    // 3. Proposals for books whose lookups are answered.
    const done = db
      .prepare(
        `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'ready' ORDER BY labeled DESC LIMIT ?`,
      )
      .all(p.analysisId, PROPOSE_CHUNK) as { calibre_uuid: string; labeled: number }[];
    for (const r of done) {
      await slicer.maybeYield();
      this.proposeBook(p, r.calibre_uuid);
    }
    if (done.length) await yieldNow();

    // 4. Natively's sitemap and pages, the authors' readings.
    this.natively(p);
    this.readings(p);

    // 5. The gate once the labeled books are proposed.
    if (p.labeledDoneAt === null && p.labeledIds.length) {
      const open = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? AND labeled = 1 AND state IN ('read', 'waiting', 'ready')`,
        )
        .get(p.analysisId) as { n: number };
      if (open.n === 0 && p.pass === 'all') {
        p.labeledDoneAt = Date.now();
        await this.gateNow(p);
      }
    }

    // 6. Everything answered and proposed: the final pass.
    if (p.phase === 'lookups') {
      const open = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'waiting', 'ready')`,
        )
        .get(p.analysisId) as { n: number };
      if (open.n === 0 && this.nativelyDone() && this.readingsDone()) {
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
  ): { proposals: Stage4Proposal[]; decision: ReturnType<typeof decideStage4> } | null {
    const book = this.book(uuid);
    const ref = this.loadRef(p.libraryId, uuid);
    const ev = this.loadOnline(p.libraryId, uuid);
    if (!book || !ref?.file || !ev) return null;
    const record = this.record(book, ref.file, ev);
    const decision = decideStage4(record);
    const applied = new Map<string, unknown>();
    for (const a of this.db
      .prepare(
        'SELECT field, value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ?',
      )
      .all(p.libraryId, uuid) as { field: string; value_json: string }[]) {
      applied.set(a.field, JSON.parse(a.value_json));
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
      spelling: this.snapshot ? spellingLookup(this.snapshot.names) : undefined,
      sameDistance: settings.covers.sameDistance,
      smallCoverPx: settings.fetch.smallCoverPx,
    });
    return { proposals, decision };
  }

  private writeProposals(
    p: Stage4Progress,
    book: Stage2Book,
    proposals: Stage4Proposal[],
    fields?: Set<string>,
  ): void {
    const db = this.db;
    const now = Date.now();
    const del = db.prepare(
      `DELETE FROM proposed_changes WHERE stage = 4 AND library_id = ? AND calibre_uuid = ? AND state = 'proposed' AND field = ?`,
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

  private proposeBook(p: Stage4Progress, uuid: string): void {
    const db = this.db;
    const settings = getSettings(db);
    const book = this.book(uuid);
    const res = book ? this.proposalsFor(p, uuid, settings) : null;
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
    const slicer = new Slicer();
    for (const r of rows) {
      await slicer.maybeYield();
      const book = this.book(r.calibre_uuid);
      const res = book ? this.proposalsFor(p, r.calibre_uuid, settings) : null;
      this.db.transaction(() => {
        if (book && res) this.writeProposals(p, book, res.proposals, fields);
        p.finalCursor = r.calibre_id;
        this.save(p);
      })();
    }
    await yieldNow();
    return p;
  }

  // ------------------------------------------------------------ gate

  /** Grades the labeled books per field (the 600 and check D apart) and pauses a field below its bar. */
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
    const slicer = new Slicer();
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
