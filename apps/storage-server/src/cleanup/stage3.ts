/**
 * Stage 3 analysis (plan section 5, WP20c): content duplicates, same text in different files.
 *
 *   text        every EPUB's text as the reader counts it (reader processes), its sketch
 *               (cache), length checked against the reader's own count, edition kind,
 *               writing direction, image entries
 *   candidates  pairs from the sketches (index in a reader process), plus the gate's pairs
 *               and image-only books with the same title and author
 *   compare     every candidate measured exactly (both ways) with the extra text of each side,
 *               then classified (stage3-rules); omnibus files found by their text
 *   quality     for books in a duplicate pair: SHA-256, cover, every picture's facts
 *   group       the better copy of each pair, sets, proposals (removals), the gate
 *
 * Runs in small steps (the service calls step() until done), paced by the shared MB/s,
 * resumes after a restart from its saved phase and cursor (saved in the same transaction as
 * the rows). Only cleanup.db and the regenerable cache are written; Calibre is read through
 * source-fs.ts.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { getLibrary } from '../calibre/libraries';
import { resolveInside, statFile } from '../calibre/source-fs';
import { tagsToCopy } from './batches';
import { readFileMetadata } from './file-metadata';
import { booksWithReaderData, findCalibreSource } from './handoff';
import { getSettings, isCustomTag } from './settings';
import { calibreNameBytes, NAME_MAX_BYTES } from './stage2-rules';
import { hashSourceFile, Pacer, readSnapshotBooks, type SnapshotBook } from './stage1';
import type { CompareResult, ComparedPair } from '../counts/book-text-child';
import { loadGatePairs, type GatePairResult, type Stage3Gate } from './stage3-gate';
import { epubImageFacts } from './stage3-images';
import { editionKind, type EditionKind } from './stage3-kinds';
import {
  bestCopy,
  classifyPair,
  decideSets,
  omnibusByText,
  type BestCopy,
  type ImageFact,
  type PairBook,
  type PairClass,
  type QualityFacts,
  type SetEdge,
} from './stage3-rules';
import { sketchToBlob } from './stage3-sketch';
import type { Outcome, Stage3Reader } from '../counts/book-text-worker';
import { getStage, updateStage } from './stages';

export type Stage3Phase = 'text' | 'candidates' | 'compare' | 'quality' | 'group' | 'done';

export interface PhaseTime {
  /** Wall time spent in the phase (ms) and the items it handled. */
  ms: number;
  items: number;
}

export interface Stage3Progress {
  analysisId: string;
  phase: Stage3Phase;
  libraryId: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  times: Partial<Record<Exclude<Stage3Phase, 'done'>, PhaseTime>>;
  /** The step that failed (kept so the analysis can resume there: cli cleanup resume 3). */
  failedPhase?: Exclude<Stage3Phase, 'done'>;
  // text
  textCursor: number;
  textTotal: number;
  textDone: number;
  /** Books actually read (not kept from an earlier analysis) and their summed read time. */
  textRead: number;
  textReadMs: number;
  /** Server time before books went to a reader process (file facts, metadata), summed. */
  textPrepMs?: number;
  /**
   * The rules version and the classifying settings the saved classes were made with
   * (STAGE3_RULES_VERSION | the duplicates settings). When they differ from the current ones,
   * the measured pairs are classified again (reclassify) without reading any book.
   */
  rulesKey?: string | null;
  /** After a reclassify: the quality step reads only the books without picture facts. */
  qualityMissingOnly?: boolean;
  textErrors: number;
  imageOnly: number;
  /** Books whose file the reader counted too, and how many lengths differ. */
  readerCompared: number;
  readerDiffering: number;
  // candidates
  candidates: number;
  indexStats: Record<string, number> | null;
  // compare
  compareTotal: number;
  compareDone: number;
  compareErrors: number;
  omnibusByText: number;
  // quality
  qualityTotal: number;
  qualityDone: number;
  qualityCursor: number;
  qualityErrors: number;
  // group
  classes: Record<string, number>;
  sets: number;
  setsWithoutKeeper: number;
  toRemove: number;
  review: number;
  removedWithData: number;
  bothWithData: number;
  tagsCopied: number;
  gate: Stage3Gate | null;
}

/** Items a phase has handled so far (books read, pairs compared or measured). */
function phaseItems(p: Stage3Progress, phase: Stage3Phase = p.phase): number {
  if (phase === 'text') return p.textDone;
  if (phase === 'candidates') return p.candidates;
  if (phase === 'compare') return p.compareDone;
  if (phase === 'quality') return p.qualityDone;
  return 0;
}

export interface Stage3Book extends SnapshotBook {
  firstAuthor: string;
}

export interface Stage3Deps {
  cleanup: Database.Database;
  /** Manga part B: the reader library this instance works on (one instance per library). */
  libraryId: string;
  main: Database.Database;
  calibreDir: string;
  cacheDir: string;
  dbDir: string | null;
  /** The reader processes (or a stand-in in tests). */
  reader: () => Stage3Reader;
  /** The counter bundle's build id: a file read with another build is read again. */
  counterBuild: string;
  log?: (m: string) => void;
}

/** Books per compare request (each read once per request). */
const BOOKS_PER_COMPARE = 8;
const COMPARE_CHUNK = 200;
const MIN_RUN = 100;
const MIN_CONTEXT = 500;
const NOT_IN_LIBRARY = 'Not checked: a copy is no longer in the library';

export function stage3CacheFile(cacheDir: string): string {
  return path.join(cacheDir, 'cleanup', 'stage3.db');
}

/** The regenerable sketch store (outside cleanup.db and its nightly snapshots). */
export function openStage3Cache(cacheDir: string): Database.Database {
  const file = stage3CacheFile(cacheDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.prepare(
    `CREATE TABLE IF NOT EXISTS sketches (
    library_id  TEXT NOT NULL,
    calibre_id  INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    build       TEXT NOT NULL,
    samples     BLOB NOT NULL,
    PRIMARY KEY (library_id, calibre_id)
  )`,
  ).run();
  return db;
}

/** Books with an EPUB, with their first author (for image-only grouping and folder names). */
export function readStage3Books(file: string): Map<number, Stage3Book> {
  const books = readSnapshotBooks(file) as Map<number, Stage3Book>;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    for (const b of books.values()) b.firstAuthor = 'Unknown';
    const seen = new Set<number>();
    for (const r of db
      .prepare(
        `SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id`,
      )
      .all() as { book: number; name: string }[]) {
      if (seen.has(r.book)) continue;
      seen.add(r.book);
      const b = books.get(r.book);
      if (b) b.firstAuthor = r.name;
    }
  } finally {
    db.close();
  }
  return books;
}

export function emptyStage3Progress(libraryId: string, now = Date.now()): Stage3Progress {
  return {
    analysisId: randomUUID(),
    phase: 'text',
    libraryId,
    startedAt: now,
    finishedAt: null,
    error: null,
    phaseStartedAt: now,
    phaseStartDone: 0,
    times: {},
    textCursor: 0,
    textTotal: 0,
    textDone: 0,
    textRead: 0,
    textReadMs: 0,
    textPrepMs: 0,
    textErrors: 0,
    imageOnly: 0,
    readerCompared: 0,
    readerDiffering: 0,
    candidates: 0,
    indexStats: null,
    compareTotal: 0,
    compareDone: 0,
    compareErrors: 0,
    omnibusByText: 0,
    qualityTotal: 0,
    qualityDone: 0,
    qualityCursor: 0,
    qualityErrors: 0,
    classes: {},
    sets: 0,
    setsWithoutKeeper: 0,
    toRemove: 0,
    review: 0,
    removedWithData: 0,
    bothWithData: 0,
    tagsCopied: 0,
    gate: null,
  };
}

interface FactRow {
  calibre_id: number;
  calibre_uuid: string;
  file_path: string;
  size: number | null;
  mtime_ms: number | null;
  counter_build: string | null;
  chars: number | null;
  reader_chars: number | null;
  samples: number | null;
  chapters_json: string | null;
  ruby: number | null;
  toc_entries: number | null;
  file_title: string | null;
  kind: EditionKind | null;
  kind_marker: string | null;
  kind_by: string | null;
  image_entries: number | null;
  image_only: number;
  error: string | null;
  quality_size: number | null;
  quality_mtime_ms: number | null;
  sha256: string | null;
  vertical: number | null;
  cover_side: number | null;
  images_json: string | null;
  quality_error: string | null;
}

export interface PairRow {
  id: number;
  a_id: number;
  a_uuid: string;
  b_id: number;
  b_uuid: string;
  source: string;
  shared: number | null;
  est_a_in_b: number | null;
  est_b_in_a: number | null;
  a_in_b: number | null;
  b_in_a: number | null;
  class: PairClass | 'image_only' | null;
  rule: string | null;
  reason: string | null;
  container: 'a' | 'b' | null;
  spread_json: string | null;
  best_json: string | null;
  keep_id: number | null;
  error: string | null;
}

/** Titles compared without width, spaces, brackets and their markers (image-only grouping). */
export function looseTitle(t: string): string {
  return t
    .normalize('NFKC')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, '')
    .replace(/[\s・:：~～\-‐ー]/g, '')
    .toLowerCase();
}

/** One book's result in the text phase. */
type TextOut = {
  row: Record<string, unknown>;
  sketch?: Buffer;
  /** The reader process's own time for the book (ms). */
  readMs?: number;
  /** Time in the server before the book went to a reader process (file facts, metadata). */
  prepMs?: number;
  reused: boolean;
};

/** One finished compare request: its pairs and the reader's answer. */
type CompareDone = {
  r: { books: Set<number>; pairs: PairRow[] };
  out: Outcome<CompareResult>;
};
/** One book's best-copy facts in the quality phase (row null: nothing to save). */
type QualityDone = { id: number; row: Record<string, unknown> | null };

/** A text step returns after this long; the books being read go on. */
const TEXT_STEP_MS = 20_000;
/** Read books are saved at least this often, or once this many are ready in cursor order. */
const TEXT_COMMIT_MS = 2_000;
const TEXT_COMMIT_BOOKS = 32;
/** Finished compare requests are saved at least every TEXT_COMMIT_MS, or once this many are done. */
const COMPARE_COMMIT_REQUESTS = 8;

/**
 * Keeps `limit` jobs in flight: the next job starts as soon as one finishes, so the reader
 * processes never wait for a group's slowest job. Ordered (the text and quality phases, which
 * resume from a cursor): results come out in the order of `ids`, always a prefix, and a job
 * that answers null (stopped) stops the pipeline there. Unordered (the compare phase, which
 * resumes from what is saved): every finished job comes out as it finishes; a stopped job is
 * left undone and stops the pipeline. A job that throws makes take() throw (the analysis
 * fails, as a failed group did before).
 */
export class WorkPipe<T> {
  stopped = false;
  inFlight = 0;
  limit = 1;
  run: (id: number) => Promise<T | null> = () => Promise.resolve(null);
  private launched = 0;
  /** Ordered: the next index to take. Both: how many jobs were taken. */
  private taken = 0;
  private readonly results = new Map<number, { value: T | null } | { error: unknown }>();
  private wake: (() => void) | null = null;
  private pacer: Pacer | null = null;
  private rate = -1;

  constructor(
    readonly analysisId: string,
    readonly total: number,
    private readonly ids: number[],
    private readonly ordered = true,
  ) {}

  setPace(bytesPerSecond: number): void {
    if (bytesPerSecond === this.rate) return;
    this.rate = bytesPerSecond;
    this.pacer = new Pacer(bytesPerSecond);
  }

  /** The pacer for a reader that takes one (the whole-file hash). */
  pacerFor(): Pacer {
    return this.pacer ?? new Pacer(0);
  }

  pace(bytes: number): Promise<void> {
    return this.pacer ? this.pacer.take(bytes) : Promise.resolve();
  }

  fill(): void {
    while (!this.stopped && this.inFlight < this.limit && this.launched < this.ids.length) {
      const id = this.ids[this.launched++];
      this.inFlight++;
      this.run(id).then(
        (value) => this.settle(id, { value }),
        (error: unknown) => this.settle(id, { error }),
      );
    }
  }

  private settle(id: number, r: { value: T | null } | { error: unknown }): void {
    this.results.set(id, r);
    this.inFlight--;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Jobs that take() would give now. */
  ready(): number {
    if (!this.ordered) {
      let n = 0;
      for (const r of this.results.values()) if ('error' in r || r.value !== null) n++;
      return n;
    }
    let n = 0;
    for (let i = this.taken; i < this.launched; i++) {
      const r = this.results.get(this.ids[i]);
      if (!r || ('value' in r && r.value === null)) break;
      n++;
    }
    return n;
  }

  take(): T[] {
    const out: T[] = [];
    if (!this.ordered) {
      for (const [id, r] of [...this.results]) {
        if ('error' in r) throw r.error;
        this.results.delete(id);
        if (r.value === null) {
          this.stopped = true;
          continue;
        }
        out.push(r.value);
        this.taken++;
      }
      return out;
    }
    while (this.taken < this.launched) {
      const id = this.ids[this.taken];
      const r = this.results.get(id);
      if (!r) break;
      if ('error' in r) throw r.error;
      if (r.value === null) {
        this.stopped = true;
        break;
      }
      this.results.delete(id);
      out.push(r.value);
      this.taken++;
    }
    return out;
  }

  launchedAll(): boolean {
    return this.launched === this.ids.length;
  }

  finished(): boolean {
    return this.taken === this.ids.length;
  }

  /** Waits for a job to finish, or `ms` at most. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(
        () => {
          this.wake = null;
          resolve();
        },
        Math.max(0, ms),
      );
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

/**
 * Resumes stage 3's failed analysis at the step that failed, keeping everything done before it
 * (the books read, the pairs measured): `cli cleanup resume 3`. The step is the one recorded at
 * the failure, or (for a failure recorded before that was kept) the first step not complete.
 * The running server picks the analysis up on its next round.
 */
export function resumeFailedStage3(
  db: Database.Database,
  libraryId: string,
): {
  ok: boolean;
  message: string;
  phase?: Stage3Phase;
} {
  const stage = getStage(db, libraryId, 3);
  const p = stage.progress as unknown as Stage3Progress | null;
  if (!p || typeof p.analysisId !== 'string') {
    return { ok: false, message: 'Stage 3 has no analysis to resume.' };
  }
  if (stage.state !== 'failed' || !p.error) {
    return { ok: false, message: `Stage 3's analysis has not failed (state: ${stage.state}).` };
  }
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM content_pairs WHERE analysis_id = ? AND class IS NULL
           AND error IS NULL`,
      )
      .get(p.analysisId) as { n: number }
  ).n;
  const phase: Exclude<Stage3Phase, 'done'> =
    p.failedPhase ??
    (p.textDone < p.textTotal
      ? 'text'
      : !p.indexStats
        ? 'candidates'
        : pending > 0
          ? 'compare'
          : p.qualityTotal === 0 || p.qualityDone < p.qualityTotal
            ? 'quality'
            : 'group');
  const was = p.error;
  p.phase = phase;
  p.error = null;
  p.finishedAt = null;
  delete p.failedPhase;
  p.phaseStartedAt = Date.now();
  p.phaseStartDone = 0;
  updateStage(db, libraryId, 3, {
    progress: p as unknown as Record<string, unknown>,
    state: 'analysing',
  });
  return {
    ok: true,
    phase,
    message: `Stage 3's analysis resumes at the ${phase} step (it had failed: ${was}). Everything done before that step is kept.`,
  };
}

/**
 * A content_pairs row `p` waiting for a decision: in review (or a duplicate without a clear
 * better copy), not decided by you or the review (in either order of the pair), and with both
 * copies still in Calibre: a copy the cleanup removed (in favour of a third copy of the same
 * book) leaves nothing to decide (2026-11-17: 365 of the 366 pairs the page still counted).
 */
// Each lookup is one index search per pair (by primary key, and by (library_id, calibre_uuid);
// the + keeps SQLite on that index): an OR or IN here scanned every decision and every applied
// removal per pair, 3.6 s on a copy of the live database.
export const STAGE3_WAITING_SQL = `(p.class = 'review' OR (p.class IN ('duplicate', 'superset') AND p.keep_id IS NULL))
  AND NOT EXISTS (SELECT 1 FROM pair_decisions d WHERE d.library_id = p.library_id
    AND d.a_uuid = p.a_uuid AND d.b_uuid = p.b_uuid)
  AND NOT EXISTS (SELECT 1 FROM pair_decisions d WHERE d.library_id = p.library_id
    AND d.a_uuid = p.b_uuid AND d.b_uuid = p.a_uuid)
  AND NOT EXISTS (SELECT 1 FROM proposed_changes c WHERE c.library_id = p.library_id
    AND c.calibre_uuid = p.a_uuid AND +c.stage IN (1, 3) AND +c.field = 'book' AND +c.state = 'applied')
  AND NOT EXISTS (SELECT 1 FROM proposed_changes c WHERE c.library_id = p.library_id
    AND c.calibre_uuid = p.b_uuid AND +c.stage IN (1, 3) AND +c.field = 'book' AND +c.state = 'applied')`;

/**
 * Records the review's decisions on stage 3 pairs (`cli cleanup decide 3 <file>`): each one
 * marked as Claude's, with its reason, never replacing a decision you made on the page. The
 * file: { "decisions": [{ "aUuid", "bUuid", "decision": "keep_both" | "remove_a" |
 * "remove_b", "note" }] }, a and b as in the pair. The running server then works out the
 * copies again (the pairs decided as removals get their file facts first).
 */
export function recordReviewDecisions(
  db: Database.Database,
  libraryId: string,
  input: unknown,
): { ok: boolean; message: string; recorded?: number; keptYours?: number } {
  const p = getStage(db, libraryId, 3).progress as unknown as Stage3Progress | null;
  if (!p || typeof p.analysisId !== 'string') {
    return { ok: false, message: 'Stage 3 has no analysis.' };
  }
  const list = (input as { decisions?: unknown })?.decisions;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, message: 'The file has no "decisions" list.' };
  }
  const valid = new Set(['keep_both', 'remove_a', 'remove_b']);
  const bad: number[] = [];
  const rows: { a: string; b: string; decision: string; note: string }[] = [];
  list.forEach((d, i) => {
    const x = d as { aUuid?: unknown; bUuid?: unknown; decision?: unknown; note?: unknown };
    if (
      typeof x.aUuid !== 'string' ||
      typeof x.bUuid !== 'string' ||
      typeof x.decision !== 'string' ||
      !valid.has(x.decision) ||
      typeof x.note !== 'string' ||
      x.note.trim() === ''
    ) {
      bad.push(i);
      return;
    }
    rows.push({ a: x.aUuid, b: x.bUuid, decision: x.decision, note: x.note.trim().slice(0, 500) });
  });
  if (bad.length > 0) {
    return {
      ok: false,
      message: `${bad.length} decisions are not valid (each needs aUuid, bUuid, a decision and a note), first at ${bad[0]}. Nothing was recorded.`,
    };
  }
  // One decision per pair: a file deciding a pair twice (in either order) would keep only the
  // last one, so it is refused as a whole (the review's own uniqueness check, 2026-11-17).
  const firstAt = new Map<string, number>();
  const twice: [number, number][] = [];
  rows.forEach((r, i) => {
    const key = [r.a, r.b].sort().join('|');
    const first = firstAt.get(key);
    if (first === undefined) firstAt.set(key, i);
    else twice.push([first, i]);
  });
  if (twice.length > 0) {
    return {
      ok: false,
      message: `${twice.length} decisions repeat a pair decided earlier in the file (first: decisions ${twice[0][0]} and ${twice[0][1]}). Nothing was recorded.`,
    };
  }
  const pairExists = db.prepare(
    `SELECT 1 FROM content_pairs WHERE analysis_id = ? AND a_uuid = ? AND b_uuid = ?`,
  );
  const missing = rows.filter((r) => !pairExists.get(p.analysisId, r.a, r.b));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${missing.length} decisions name a pair the current analysis doesn't have (e.g. ${missing[0].a} / ${missing[0].b}). Nothing was recorded.`,
    };
  }
  const yours = db.prepare(
    `SELECT 1 FROM pair_decisions WHERE library_id = ? AND decided_by = 'you'
       AND ((a_uuid = ? AND b_uuid = ?) OR (a_uuid = ? AND b_uuid = ?))`,
  );
  const drop = db.prepare(
    `DELETE FROM pair_decisions WHERE library_id = ? AND a_uuid = ? AND b_uuid = ?`,
  );
  const put = db.prepare(
    `INSERT INTO pair_decisions (library_id, a_uuid, b_uuid, decision, decided_at, decided_by, note)
     VALUES (?, ?, ?, ?, ?, 'claude', ?)
     ON CONFLICT(library_id, a_uuid, b_uuid) DO UPDATE SET decision = excluded.decision,
       decided_at = excluded.decided_at, decided_by = 'claude', note = excluded.note`,
  );
  let recorded = 0;
  let keptYours = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const r of rows) {
      if (yours.get(p.libraryId, r.a, r.b, r.b, r.a)) {
        keptYours++;
        continue;
      }
      drop.run(p.libraryId, r.b, r.a); // one decision per pair, in the pair's own order
      put.run(p.libraryId, r.a, r.b, r.decision, now, r.note);
      recorded++;
    }
    // The server classifies and chooses the copies again on its next round.
    p.rulesKey = null;
    updateStage(db, libraryId, 3, { progress: p as unknown as Record<string, unknown> });
  })();
  return {
    ok: true,
    recorded,
    keptYours,
    message: `Recorded ${recorded} review decisions${keptYours ? `; ${keptYours} pairs you had decided were left as you decided them` : ''}. The server works out the copies again on its next round.`,
  };
}

/**
 * The pair rules' version: raised when a rule changes, so a finished analysis classifies its
 * measured pairs again (reclassify) instead of reading the library again.
 *   2 (2026-11-17): one copy holding the other's text and much more goes to review; "N巻セット"
 *     and "N~M巻セット" are omnibus markers.
 *   3 (2026-11-17): same text with different artwork (another edition) is never removed
 *     automatically.
 *   4 (2026-11-17): a set with no single winner still loses the copies every other copy
 *     beats; pairs with a copy no longer in Calibre stay out of the sets.
 */
export const STAGE3_RULES_VERSION = 4;

/** What the saved classes depend on: the rules and the classifying settings. */
export function stage3RulesKey(s: ReturnType<typeof getSettings>['duplicates']): string {
  return [
    STAGE3_RULES_VERSION,
    s.bothWays,
    s.superset,
    s.reviewFloor,
    s.spreadKeepBoth,
    s.spreadIgnore,
  ].join('|');
}

/** A file's edition kind from every title it has (stage 3, P2). */
function kindForBook(
  book: Stage3Book,
  fileTitle: string | null,
  titleBefore: (uuid: string) => string | null,
) {
  return editionKind([
    fileTitle,
    book.title,
    path.posix.basename(book.filePath, '.epub'),
    titleBefore(book.uuid),
  ]);
}

export class Stage3Analysis {
  private books: Map<number, Stage3Book> | null = null;
  private booksFor: string | null = null;
  private cacheDb: Database.Database | null = null;

  constructor(private readonly deps: Stage3Deps) {}

  progress(): Stage3Progress | null {
    const p = getStage(this.deps.cleanup, this.deps.libraryId, 3)
      .progress as unknown as Stage3Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage3Progress, state?: string): void {
    updateStage(this.deps.cleanup, this.deps.libraryId, 3, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  private cache(): Database.Database {
    if (!this.cacheDb) this.cacheDb = openStage3Cache(this.deps.cacheDir);
    return this.cacheDb;
  }

  close(): void {
    this.cacheDb?.close();
    this.cacheDb = null;
  }

  /** Starts a fresh analysis (keeps the text facts and sketches of unchanged files). */
  restart(libraryId: string): Stage3Progress {
    const p = emptyStage3Progress(libraryId);
    this.books = null;
    // Pairs of earlier analyses are replaced (the proposals keep what a batch needs).
    this.deps.cleanup
      .prepare('DELETE FROM content_pairs WHERE library_id = ? AND analysis_id <> ?')
      .run(libraryId, p.analysisId);
    this.save(p, 'analysing');
    return p;
  }

  invalidate(): void {
    this.books = null;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new Error('The chosen library is not in the reader any more');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  /**
   * Calibre's books as the reader's last snapshot has them, read again whenever the indexer
   * made a new snapshot (2026-11-17: the list was read once per server run, so a copy choice
   * after removals still saw the removed copies).
   */
  loadBooks(libraryId: string): Map<number, Stage3Book> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    let key = file;
    try {
      const st = fs.statSync(file);
      key = `${file}|${st.mtimeMs}|${st.size}`;
    } catch {
      // No snapshot: reading it below says so.
    }
    if (this.books && this.booksFor === key) return this.books;
    this.books = readStage3Books(file);
    this.booksFor = key;
    return this.books;
  }

  /** One unit of work. Returns true when finished (or failed). Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    const before = p.phase;
    try {
      const started = Date.now();
      const doneBefore = phaseItems(p);
      if (p.phase === 'text') p = await this.textStep(p, shouldStop);
      else if (p.phase === 'candidates') p = await this.candidatesStep(p);
      else if (p.phase === 'compare') p = await this.compareStep(p, shouldStop);
      else if (p.phase === 'quality') p = await this.qualityStep(p, shouldStop);
      else if (p.phase === 'group') p = this.groupStep(p);
      const t = p.times[before as Exclude<Stage3Phase, 'done'>] ?? { ms: 0, items: 0 };
      t.ms += Date.now() - started;
      t.items += Math.max(0, phaseItems(p, before) - doneBefore);
      p.times[before as Exclude<Stage3Phase, 'done'>] = t;
      if (p.phase !== before) {
        p.phaseStartedAt = Date.now();
        p.phaseStartDone = 0;
      }
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.failedPhase = before;
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    }
  }

  // ---- text ----

  private readerChars(libraryId: string, uuid: string, size: number): number | null {
    try {
      const r = this.deps.main
        .prepare(
          `SELECT cc.characters, cc.file_bytes FROM book_sources bs
           JOIN char_counts cc ON cc.book_id = bs.book_id
           WHERE bs.kind = 'calibre' AND bs.library_id = ? AND bs.calibre_uuid = ?
             AND cc.status = 'ok' LIMIT 1`,
        )
        .get(libraryId, uuid) as
        | { characters: number | null; file_bytes: number | null }
        | undefined;
      if (!r || r.characters === null || r.file_bytes !== size) return null;
      return r.characters;
    } catch {
      return null;
    }
  }

  /** Whether a finished analysis's classes were made with other rules or settings. */
  needsReclassify(p: Stage3Progress): boolean {
    if (p.error) return false;
    if (p.phase !== 'done' && p.phase !== 'quality' && p.phase !== 'group') return false;
    return p.rulesKey !== stage3RulesKey(getSettings(this.deps.cleanup).duplicates);
  }

  /**
   * Classifies the measured pairs again with the current rules and settings, nothing read
   * again: the kinds from the titles (omnibus by text found again), every measured pair's class
   * from its stored measures, then the quality step (only books without facts are read; the
   * pairs decided as removals are among them) and the sets. Returns the new progress.
   */
  reclassify(): Stage3Progress | null {
    const p = this.progress();
    if (!p || p.error || (p.phase !== 'done' && p.phase !== 'quality' && p.phase !== 'group'))
      return null;
    const db = this.deps.cleanup;
    const books = this.loadBooks(p.libraryId);
    const dup = getSettings(db).duplicates;
    const oldTitle = db.prepare(
      `SELECT old_json FROM field_undo WHERE library_id = ? AND calibre_uuid = ? AND field = 'title'
       ORDER BY created_at LIMIT 1`,
    );
    const titleBefore = (uuid: string): string | null => {
      const r = oldTitle.get(p.libraryId, uuid) as { old_json: string } | undefined;
      if (!r) return null;
      try {
        const v = JSON.parse(r.old_json) as unknown;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    };
    const setKind = db.prepare(
      `UPDATE text_facts SET kind = ?, kind_marker = ?, kind_by = 'title'
       WHERE library_id = ? AND calibre_id = ?`,
    );
    const rows = db
      .prepare(
        'SELECT calibre_id, file_title FROM text_facts WHERE library_id = ? AND error IS NULL',
      )
      .all(p.libraryId) as { calibre_id: number; file_title: string | null }[];
    const update = db.prepare(
      `UPDATE content_pairs SET class = ?, rule = ?, reason = ?, container = ?, keep_id = NULL
       WHERE id = ?`,
    );
    db.transaction(() => {
      for (const r of rows) {
        const book = books.get(r.calibre_id);
        if (!book) continue;
        const k = kindForBook(book, r.file_title, titleBefore);
        setKind.run(k.kind, k.marker, p.libraryId, r.calibre_id);
      }
      const facts = this.facts(p.libraryId);
      const pairs = db
        .prepare(
          `SELECT * FROM content_pairs WHERE analysis_id = ? AND source <> 'image_only'
             AND a_in_b IS NOT NULL AND b_in_a IS NOT NULL AND error IS NULL`,
        )
        .all(p.analysisId) as PairRow[];
      for (const x of pairs) {
        const spread = x.spread_json
          ? (JSON.parse(x.spread_json) as { a: unknown; b: unknown })
          : null;
        const v = this.classify(
          x,
          {
            aInB: x.a_in_b!,
            bInA: x.b_in_a!,
            extraA: spread?.a ?? null,
            extraB: spread?.b ?? null,
          },
          facts,
          dup,
        );
        update.run(v.cls, v.rule, v.reason, v.container ?? null, x.id);
      }
    })();
    p.omnibusByText = 0;
    this.findOmnibusByText(p);
    p.phase = 'quality';
    p.qualityCursor = 0;
    p.qualityDone = 0;
    p.qualityErrors = 0;
    // Only books without picture facts are read (files changed since are caught by the check
    // before every batch, which compares each file again).
    p.qualityMissingOnly = true;
    p.qualityTotal = this.qualityBooks(p).length;
    p.finishedAt = null;
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = 0;
    p.rulesKey = stage3RulesKey(dup);
    this.qualityPipe = null;
    this.save(p, 'analysing');
    this.deps.log?.(
      `Cleanup stage 3: the measured pairs were classified again (rules ${p.rulesKey})`,
    );
    return p;
  }

  /**
   * The text phase. Books go to the reader processes one at a time as each process becomes free
   * (a pipeline kept across steps), not in groups that wait for their slowest book; results are
   * saved in cursor order, the cursor in the same transaction as the rows, so a restart resumes
   * exactly where the saved rows end. A step returns after TEXT_STEP_MS without waiting for the
   * books still being read.
   */
  private async textStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const settings = getSettings(this.deps.cleanup);
    let pipe = this.textPipe;
    if (!pipe || pipe.analysisId !== p.analysisId || pipe.stopped) {
      pipe = this.textPipe = this.openTextPipe(p);
    }
    p.textTotal = pipe.total;
    pipe.limit = Math.max(1, settings.duplicates.textWorkers) * 2;
    pipe.setPace(settings.pacing.readMbPerSecond * 1024 * 1024);
    const deadline = Date.now() + TEXT_STEP_MS;
    let lastCommit = Date.now();
    for (;;) {
      if (shouldStop()) pipe.stopped = true;
      pipe.fill();
      const ready = pipe.ready();
      if (
        ready > 0 &&
        (ready >= TEXT_COMMIT_BOOKS ||
          Date.now() - lastCommit >= TEXT_COMMIT_MS ||
          Date.now() >= deadline ||
          pipe.stopped ||
          pipe.launchedAll())
      ) {
        this.commitText(p, pipe.take());
        lastCommit = Date.now();
      }
      if (pipe.finished()) {
        this.textPipe = null;
        p.phase = 'candidates';
        return p;
      }
      if (pipe.stopped && pipe.inFlight === 0) {
        this.textPipe = null;
        return p;
      }
      if (Date.now() >= deadline) return p;
      await pipe.wait(Math.min(deadline, lastCommit + TEXT_COMMIT_MS) - Date.now());
    }
  }

  private textPipe: WorkPipe<TextOut> | null = null;

  /** A pipeline over the books after the saved cursor (stage 3's text phase). */
  private openTextPipe(p: Stage3Progress): WorkPipe<TextOut> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const dup = getSettings(this.deps.cleanup).duplicates;
    const ids = [...books.keys()].filter((id) => id > p.textCursor).sort((a, b) => a - b);
    const pipe = new WorkPipe<TextOut>(p.analysisId, books.size, ids);
    const facts = this.deps.cleanup.prepare(
      'SELECT * FROM text_facts WHERE library_id = ? AND calibre_id = ?',
    );
    const sketchRow = this.cache().prepare(
      'SELECT size, mtime_ms, build FROM sketches WHERE library_id = ? AND calibre_id = ?',
    );
    // Calibre's title before stage 2 wrote it: stage 2 removed store markers (試し読み, 合本版,
    // 購入特典 …) from titles, and the kinds still need them (decided with stage 2: the removed
    // markers are still used). Kept in stage 2's undo records.
    const oldTitle = this.deps.cleanup.prepare(
      `SELECT old_json FROM field_undo WHERE library_id = ? AND calibre_uuid = ? AND field = 'title'
       ORDER BY created_at LIMIT 1`,
    );
    const titleBefore = (uuid: string): string | null => {
      const r = oldTitle.get(p.libraryId, uuid) as { old_json: string } | undefined;
      if (!r) return null;
      try {
        const v = JSON.parse(r.old_json) as unknown;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    };
    type Out = TextOut;
    const readOne = async (book: Stage3Book): Promise<Out | null> => {
      if (pipe.stopped) return null;
      const file = resolveInside(libDir, book.filePath);
      const now = Date.now();
      const base = {
        lib: p.libraryId,
        id: book.calibreId,
        uuid: book.uuid,
        path: book.filePath,
        lm: book.lastModified,
        build: this.deps.counterBuild,
        now,
      };
      const st = await statFile(file).catch(() => null);
      if (!st) {
        return { reused: false, row: { ...base, size: null, mtime: null, error: 'file_missing' } };
      }
      const old = facts.get(p.libraryId, book.calibreId) as FactRow | undefined;
      const cached = sketchRow.get(p.libraryId, book.calibreId) as
        | { size: number; mtime_ms: number; build: string }
        | undefined;
      const kindOf = (fileTitle: string | null) => kindForBook(book, fileTitle, titleBefore);
      if (
        old &&
        old.error === null &&
        old.size === st.size &&
        old.mtime_ms === Math.round(st.mtimeMs) &&
        old.counter_build === this.deps.counterBuild &&
        cached &&
        cached.size === st.size &&
        cached.mtime_ms === Math.round(st.mtimeMs) &&
        cached.build === this.deps.counterBuild
      ) {
        const kind =
          old.kind_by === 'text'
            ? { kind: old.kind!, marker: old.kind_marker }
            : kindOf(old.file_title);
        return {
          reused: true,
          row: {
            ...base,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            reuse: 1,
            kind: kind.kind,
            marker: kind.marker,
            kindBy: old.kind_by === 'text' ? 'text' : 'title',
            readerChars: this.readerChars(p.libraryId, book.uuid, st.size),
          },
        };
      }
      const counted = { bytes: 0 };
      let fileTitle: string | null = null;
      let imageEntries: number | null = null;
      let vertical: boolean | null = null;
      try {
        const meta = await readFileMetadata(file, {
          text: false,
          cover: false,
          layout: true,
          counted,
        });
        fileTitle = meta.title;
        imageEntries = meta.layout?.images.length ?? null;
        vertical = meta.layout?.vertical ?? null;
      } catch {
        // The reader's import decides whether the file can be read at all.
      }
      const started = Date.now();
      const prepMs = started - now;
      const out = await this.deps.reader().text(file);
      // The reader process's own time for the book (not the time it waited for a free process).
      const readMs = out.ok ? out.data.durationMs : Date.now() - started;
      if (!out.ok) {
        if (out.stopped) return null;
        return {
          reused: false,
          readMs,
          prepMs,
          row: {
            ...base,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            error: `${out.code}: ${out.message}`.slice(0, 500),
            fileTitle,
            imageEntries,
          },
        };
      }
      await pipe.pace(out.data.bytesRead + counted.bytes);
      const kind = kindOf(fileTitle);
      const imageOnly =
        out.data.characters < dup.imageOnlyMaxChars && (imageEntries ?? 0) > 0 ? 1 : 0;
      const sketch = Uint32Array.from(out.data.sketch);
      return {
        reused: false,
        readMs,
        prepMs,
        sketch: sketchToBlob(sketch),
        row: {
          ...base,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          error: null,
          chars: out.data.characters,
          importChars: out.data.importCharacters,
          readerChars: this.readerChars(p.libraryId, book.uuid, st.size),
          samples: sketch.length,
          chapters: JSON.stringify(out.data.chapters),
          ruby: out.data.ruby,
          toc: out.data.tocEntries,
          fileTitle,
          kind: kind.kind,
          marker: kind.marker,
          kindBy: 'title',
          imageEntries,
          imageOnly,
          vertical: vertical === null ? null : vertical ? 1 : 0,
          readMs,
        },
      };
    };

    pipe.run = (id) => readOne(books.get(id)!);
    pipe.setPace(getSettings(this.deps.cleanup).pacing.readMbPerSecond * 1024 * 1024);
    pipe.limit = Math.max(1, dup.textWorkers) * 2;
    return pipe;
  }

  /** Saves read books (in cursor order) with the cursor and the progress, in one transaction. */
  private commitText(p: Stage3Progress, done: TextOut[]): void {
    if (done.length === 0) return;
    const cache = this.cache();
    const putSketch = cache.prepare(
      `INSERT INTO sketches (library_id, calibre_id, size, mtime_ms, build, samples)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET size = excluded.size,
         mtime_ms = excluded.mtime_ms, build = excluded.build, samples = excluded.samples`,
    );
    const dropSketch = cache.prepare(
      'DELETE FROM sketches WHERE library_id = ? AND calibre_id = ?',
    );
    cache.transaction(() => {
      for (const d of done) {
        if (d.reused) continue;
        const r = d.row;
        if (d.sketch) putSketch.run(r.lib, r.id, r.size, r.mtime, r.build, d.sketch);
        else dropSketch.run(r.lib, r.id);
      }
    })();

    const upsert = this.deps.cleanup.prepare(
      `INSERT INTO text_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
         calibre_last_modified, counter_build, chars, import_chars, reader_chars, samples,
         chapters_json, ruby, toc_entries, file_title, kind, kind_marker, kind_by, image_entries,
         image_only, vertical, read_ms, read_at, error)
       VALUES (@lib, @id, @uuid, @path, @size, @mtime, @lm, @build, @chars, @importChars,
         @readerChars, @samples, @chapters, @ruby, @toc, @fileTitle, @kind, @marker, @kindBy,
         @imageEntries, @imageOnly, @vertical, @readMs, @now, @error)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
         file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
         calibre_last_modified = excluded.calibre_last_modified, counter_build = excluded.counter_build,
         chars = excluded.chars, import_chars = excluded.import_chars,
         reader_chars = excluded.reader_chars, samples = excluded.samples,
         chapters_json = excluded.chapters_json, ruby = excluded.ruby,
         toc_entries = excluded.toc_entries, file_title = excluded.file_title, kind = excluded.kind,
         kind_marker = excluded.kind_marker, kind_by = excluded.kind_by,
         image_entries = excluded.image_entries, image_only = excluded.image_only,
         vertical = excluded.vertical, read_ms = excluded.read_ms, read_at = excluded.read_at,
         error = excluded.error,
         -- A different file loses its best-copy facts (they are read again when needed).
         quality_size = CASE WHEN excluded.size IS text_facts.quality_size
           AND excluded.mtime_ms IS text_facts.quality_mtime_ms THEN text_facts.quality_size END`,
    );
    const reuse = this.deps.cleanup.prepare(
      `UPDATE text_facts SET calibre_uuid = @uuid, file_path = @path, calibre_last_modified = @lm,
         kind = @kind, kind_marker = @marker, kind_by = @kindBy, reader_chars = @readerChars
       WHERE library_id = @lib AND calibre_id = @id`,
    );
    const nullRow = {
      chars: null,
      importChars: null,
      readerChars: null,
      samples: null,
      chapters: null,
      ruby: null,
      toc: null,
      fileTitle: null,
      kind: null,
      marker: null,
      kindBy: null,
      imageEntries: null,
      imageOnly: 0,
      vertical: null,
      readMs: null,
      error: null,
    };
    this.deps.cleanup.transaction(() => {
      for (const d of done) {
        if (d.reused) reuse.run(d.row);
        else upsert.run({ ...nullRow, ...d.row });
        const r = d.row as Record<string, unknown>;
        p.textDone++;
        if (!d.reused) {
          p.textRead++;
          p.textReadMs += d.readMs ?? 0;
          p.textPrepMs = (p.textPrepMs ?? 0) + (d.prepMs ?? 0);
        }
        if (r.error) p.textErrors++;
        p.textCursor = r.id as number;
      }
      this.save(p, 'analysing');
    })();
  }

  // ---- candidates ----

  private gateFile(): string | null {
    const s = getSettings(this.deps.cleanup);
    if (s.gate.duplicatePairsFile) return s.gate.duplicatePairsFile;
    return this.deps.dbDir
      ? path.join(this.deps.dbDir, 'cleanup', 'reference-sample', 'stage3-pairs.json')
      : null;
  }

  /**
   * A copy stage 1 (identical files) or stage 3 (same text) removed: its Calibre id → the copy
   * that stayed (the gate's pairs and labeled books were measured before those removals).
   */
  private removalMap(libraryId: string): Map<number, number> {
    const rows = this.deps.cleanup
      .prepare(
        `SELECT u.removed_calibre_id, u.kept_calibre_id FROM undo_records u
         JOIN batches b ON b.id = u.batch_id
         WHERE u.library_id = ? AND b.stage IN (1, 3) AND u.restored_at IS NULL`,
      )
      .all(libraryId) as { removed_calibre_id: number; kept_calibre_id: number }[];
    const map = new Map(rows.map((r) => [r.removed_calibre_id, r.kept_calibre_id]));
    const resolve = (id: number) => {
      let x = id;
      for (let i = 0; i < 10 && map.has(x); i++) x = map.get(x)!;
      return x;
    };
    return new Map([...map.keys()].map((k) => [k, resolve(k)]));
  }

  private facts(libraryId: string): Map<number, FactRow> {
    const rows = this.deps.cleanup
      .prepare('SELECT * FROM text_facts WHERE library_id = ?')
      .all(libraryId) as FactRow[];
    return new Map(rows.map((r) => [r.calibre_id, r]));
  }

  private async candidatesStep(p: Stage3Progress): Promise<Stage3Progress> {
    const books = this.loadBooks(p.libraryId);
    const facts = this.facts(p.libraryId);
    const s = getSettings(this.deps.cleanup);
    const present = [...books.keys()].filter((id) => {
      const f = facts.get(id);
      return f && f.error === null && f.image_only === 0 && (f.samples ?? 0) > 0;
    });
    // Make sure the sketches are on disk before the reader process opens the cache.
    this.cache().pragma('wal_checkpoint(PASSIVE)');
    const out = await this.deps.reader().index({
      cacheFile: stage3CacheFile(this.deps.cacheDir),
      libraryId: p.libraryId,
      ids: present,
      commonBooks: s.duplicates.commonWindowBooks,
      minShared: 2,
      minEstimate: 0.05,
    });
    if (!out.ok) {
      if (out.stopped) return p;
      throw new Error(`The candidate index failed: ${out.message}`);
    }
    p.indexStats = out.data.stats as unknown as Record<string, number>;

    const insert = this.deps.cleanup.prepare(
      `INSERT OR IGNORE INTO content_pairs (analysis_id, library_id, a_id, a_uuid, b_id, b_uuid,
         source, shared, est_a_in_b, est_b_in_a)
       VALUES (@analysis, @lib, @a, @aUuid, @b, @bUuid, @source, @shared, @estA, @estB)`,
    );
    const pairs: Record<string, unknown>[] = [];
    for (const c of out.data.pairs) {
      const a = books.get(c.a);
      const b = books.get(c.b);
      if (!a || !b) continue;
      pairs.push({
        analysis: p.analysisId,
        lib: p.libraryId,
        a: c.a,
        aUuid: a.uuid,
        b: c.b,
        bUuid: b.uuid,
        source: 'index',
        shared: c.shared,
        estA: c.estAInB,
        estB: c.estBInA,
      });
    }

    // The gate's pairs are measured even if the index didn't find them.
    const gateFile = this.gateFile();
    const gate = gateFile ? loadGatePairs(gateFile) : { pairs: null, error: null };
    if (gate.pairs) {
      const map = this.removalMap(p.libraryId);
      const have = new Set(pairs.map((x) => `${x.a}:${x.b}`));
      for (const g of gate.pairs) {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        if (ga === gb) continue;
        const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
        if (have.has(`${x}:${y}`)) continue;
        const a = books.get(x);
        const b = books.get(y);
        if (!a || !b) continue;
        have.add(`${x}:${y}`);
        pairs.push({
          analysis: p.analysisId,
          lib: p.libraryId,
          a: x,
          aUuid: a.uuid,
          b: y,
          bUuid: b.uuid,
          source: 'gate',
          shared: null,
          estA: null,
          estB: null,
        });
      }
    }

    // Image-only books with the same title and first author: the review list (never auto).
    const groups = new Map<string, number[]>();
    for (const [id, f] of facts) {
      if (f.image_only !== 1 || !books.has(id)) continue;
      const b = books.get(id)!;
      const key = `${looseTitle(b.title)}|${b.firstAuthor.normalize('NFKC').replace(/\s/g, '')}`;
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    p.imageOnly = [...facts.values()].filter(
      (f) => f.image_only === 1 && books.has(f.calibre_id),
    ).length;
    for (const ids of groups.values()) {
      ids.sort((x, y) => x - y);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          pairs.push({
            analysis: p.analysisId,
            lib: p.libraryId,
            a: ids[i],
            aUuid: books.get(ids[i])!.uuid,
            b: ids[j],
            bUuid: books.get(ids[j])!.uuid,
            source: 'image_only',
            shared: null,
            estA: null,
            estB: null,
          });
        }
      }
    }

    const settings = s.duplicates;
    const decideByKind = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET class = ?, rule = ?, reason = ?, measured_at = ?
       WHERE analysis_id = ? AND a_id = ? AND b_id = ?`,
    );
    this.deps.cleanup.transaction(() => {
      for (const x of pairs) insert.run(x);
      // Decided without reading the text: image-only pairs and a preview or store-bonus
      // story against another kind (never a duplicate whatever the overlap).
      const now = Date.now();
      for (const x of pairs) {
        if (x.source === 'image_only') {
          decideByKind.run(
            'review',
            'image_only',
            'Picture books with the same title and author (compared by their pictures)',
            now,
            p.analysisId,
            x.a,
            x.b,
          );
          continue;
        }
        const fa = facts.get(x.a as number);
        const fb = facts.get(x.b as number);
        if (!fa || !fb || fa.error || fb.error) continue;
        const v = classifyPair(
          { calibreId: fa.calibre_id, kind: fa.kind ?? 'full', chars: fa.chars ?? 0 },
          { calibreId: fb.calibre_id, kind: fb.kind ?? 'full', chars: fb.chars ?? 0 },
          { aInB: 0, bInA: 0, extraA: null, extraB: null },
          settings,
        );
        if (v.cls === 'never' && (v.rule === 'sample' || v.rule === 'bonus')) {
          decideByKind.run(v.cls, v.rule, v.reason, now, p.analysisId, x.a, x.b);
        }
      }
      p.candidates = pairs.length;
      p.compareTotal = (
        this.deps.cleanup
          .prepare(
            'SELECT COUNT(*) AS n FROM content_pairs WHERE analysis_id = ? AND class IS NULL',
          )
          .get(p.analysisId) as { n: number }
      ).n;
      p.phase = 'compare';
      // The classes are made from here on with these rules and settings (a change later makes
      // the finished analysis classify again; the copy choice never stamps this itself).
      p.rulesKey = stage3RulesKey(getSettings(this.deps.cleanup).duplicates);
      this.save(p, 'analysing');
    })();
    this.deps.log?.(
      `Cleanup stage 3: ${pairs.length} candidate pairs (${out.data.stats.postings} samples of ${out.data.stats.books} books, index ${out.data.stats.ms} ms)`,
    );
    return p;
  }

  // ---- compare ----

  /**
   * The compare phase: every candidate pair measured exactly. Pairs go to the reader processes in
   * requests of at most BOOKS_PER_COMPARE books (built as before: COMPARE_CHUNK pairs at a time,
   * each pair into the first request with room), and the next request starts as soon as a
   * process is free. A finished request is saved at once (a pair is done when its class or error
   * is set, so the phase resumes from what is saved); a step returns after STEP_MS without
   * waiting for the requests still running.
   */
  private async compareStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const settings = getSettings(this.deps.cleanup);
    let pipe = this.comparePipe;
    if (!pipe || pipe.analysisId !== p.analysisId || pipe.stopped) {
      pipe = this.comparePipe = this.openComparePipe(p);
      if (!pipe) {
        this.findOmnibusByText(p);
        p.phase = 'quality';
        p.qualityTotal = this.qualityBooks(p).length;
        return p;
      }
    }
    pipe.limit = Math.max(1, settings.duplicates.textWorkers) * 2;
    pipe.setPace(settings.pacing.readMbPerSecond * 1024 * 1024);
    const deadline = Date.now() + TEXT_STEP_MS;
    let lastCommit = Date.now();
    for (;;) {
      if (shouldStop()) pipe.stopped = true;
      pipe.fill();
      const ready = pipe.ready();
      if (
        ready > 0 &&
        (ready >= COMPARE_COMMIT_REQUESTS ||
          Date.now() - lastCommit >= TEXT_COMMIT_MS ||
          Date.now() >= deadline ||
          pipe.stopped ||
          pipe.launchedAll())
      ) {
        this.commitCompare(p, pipe.take());
        lastCommit = Date.now();
      }
      if (pipe.finished() || (pipe.stopped && pipe.inFlight === 0)) {
        // Finished: the next step finds nothing left to measure and moves on.
        this.comparePipe = null;
        return p;
      }
      if (Date.now() >= deadline) return p;
      await pipe.wait(Math.min(deadline, lastCommit + TEXT_COMMIT_MS) - Date.now());
    }
  }

  private comparePipe: WorkPipe<CompareDone> | null = null;
  /** The facts the compare phase classifies with (kinds and lengths; fixed during the phase). */
  private compareFacts: Map<number, FactRow> | null = null;

  /** A pipeline over the pairs not measured yet, or null when there are none. */
  private openComparePipe(p: Stage3Progress): WorkPipe<CompareDone> | null {
    const pending = this.deps.cleanup
      .prepare(
        `SELECT * FROM content_pairs WHERE analysis_id = ? AND class IS NULL AND error IS NULL
         ORDER BY a_id, b_id`,
      )
      .all(p.analysisId) as PairRow[];
    if (pending.length === 0) return null;
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    this.compareFacts = this.facts(p.libraryId);

    // Requests of at most BOOKS_PER_COMPARE books each, built COMPARE_CHUNK pairs at a time.
    const requests: { books: Set<number>; pairs: PairRow[] }[] = [];
    for (let at = 0; at < pending.length; at += COMPARE_CHUNK) {
      const chunk: { books: Set<number>; pairs: PairRow[] }[] = [];
      for (const pair of pending.slice(at, at + COMPARE_CHUNK)) {
        let req = chunk.find(
          (r) =>
            r.books.size + (r.books.has(pair.a_id) ? 0 : 1) + (r.books.has(pair.b_id) ? 0 : 1) <=
            BOOKS_PER_COMPARE,
        );
        if (!req) {
          req = { books: new Set(), pairs: [] };
          chunk.push(req);
        }
        req.books.add(pair.a_id);
        req.books.add(pair.b_id);
        req.pairs.push(pair);
      }
      requests.push(...chunk);
    }
    const pipe = new WorkPipe<CompareDone>(
      p.analysisId,
      requests.length,
      requests.map((_, i) => i),
      false,
    );
    pipe.run = async (i) => {
      if (pipe.stopped) return null;
      const r = requests[i];
      const list = [...r.books]
        .filter((id) => books.has(id))
        .map((id) => ({ key: id, file: resolveInside(libDir, books.get(id)!.filePath) }));
      const out = await this.deps.reader().compare(
        list,
        r.pairs.map((x) => [x.a_id, x.b_id] as [number, number]),
        { minRun: MIN_RUN, minContext: MIN_CONTEXT },
      );
      if (out.ok) await pipe.pace(out.data.bytesRead);
      else if (out.stopped) return null;
      return { r, out };
    };
    return pipe;
  }

  /** Saves finished compare requests (their pairs' measures and classes) with the progress. */
  private commitCompare(p: Stage3Progress, results: CompareDone[]): void {
    if (results.length === 0) return;
    const settings = getSettings(this.deps.cleanup);
    const facts = this.compareFacts ?? this.facts(p.libraryId);
    const update = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET a_in_b = @aInB, b_in_a = @bInA, class = @cls, rule = @rule,
         reason = @reason, container = @container, spread_json = @spread, measured_at = @now,
         error = @error WHERE id = @id`,
    );
    const now = Date.now();
    this.deps.cleanup.transaction(() => {
      for (const res of results) {
        const { r, out } = res;
        if (!out.ok) {
          for (const pair of r.pairs) {
            update.run({
              id: pair.id,
              aInB: null,
              bInA: null,
              cls: null,
              rule: null,
              reason: null,
              container: null,
              spread: null,
              now,
              error: `${out.code}: ${out.message}`.slice(0, 500),
            });
            p.compareErrors++;
          }
          continue;
        }
        const data: CompareResult = out.data;
        const byKey = new Map<string, ComparedPair>(data.pairs.map((x) => [`${x.a}:${x.b}`, x]));
        const failed = new Map(data.failed.map((f) => [f.key, f.message]));
        for (const pair of r.pairs) {
          const m = byKey.get(`${pair.a_id}:${pair.b_id}`);
          if (!m) {
            const why = failed.get(pair.a_id) ?? failed.get(pair.b_id) ?? 'not compared';
            update.run({
              id: pair.id,
              aInB: null,
              bInA: null,
              cls: null,
              rule: null,
              reason: null,
              container: null,
              spread: null,
              now,
              error: `Couldn't read a copy: ${why}`.slice(0, 500),
            });
            p.compareErrors++;
            continue;
          }
          const v = this.classify(pair, m, facts, settings.duplicates);
          update.run({
            id: pair.id,
            aInB: m.aInB,
            bInA: m.bInA,
            cls: v.cls,
            rule: v.rule,
            reason: v.reason,
            container: v.container ?? null,
            spread: JSON.stringify({ a: m.extraA, b: m.extraB }),
            now,
            error: null,
          });
          p.compareDone++;
        }
      }
      this.save(p, 'analysing');
    })();
  }

  private pairBook(f: FactRow | undefined, id: number): PairBook {
    return { calibreId: id, kind: f?.kind ?? 'full', chars: f?.chars ?? 0 };
  }

  private classify(
    pair: { a_id: number; b_id: number },
    m: { aInB: number; bInA: number; extraA: unknown; extraB: unknown },
    facts: Map<number, FactRow>,
    s: ReturnType<typeof getSettings>['duplicates'],
  ) {
    return classifyPair(
      this.pairBook(facts.get(pair.a_id), pair.a_id),
      this.pairBook(facts.get(pair.b_id), pair.b_id),
      m as Parameters<typeof classifyPair>[2],
      s,
    );
  }

  /** P2: a book that holds two or more books that share nothing is an omnibus. */
  private findOmnibusByText(p: Stage3Progress): void {
    const s = getSettings(this.deps.cleanup).duplicates;
    const facts = this.facts(p.libraryId);
    const pairs = this.deps.cleanup
      .prepare(`SELECT * FROM content_pairs WHERE analysis_id = ? AND source <> 'image_only'`)
      .all(p.analysisId) as PairRow[];
    const overlapping = new Set<string>();
    const holds = new Map<number, number[]>();
    for (const x of pairs) {
      const most = Math.max(x.a_in_b ?? x.est_a_in_b ?? 0, x.b_in_a ?? x.est_b_in_a ?? 0);
      if (most >= s.reviewFloor) overlapping.add(`${x.a_id}:${x.b_id}`);
      if (x.a_in_b === null || x.b_in_a === null) continue;
      // A held by B: A's text is (almost) all in B, but B's not all in A.
      if (x.a_in_b >= s.superset && x.b_in_a < s.bothWays)
        holds.set(x.b_id, [...(holds.get(x.b_id) ?? []), x.a_id]);
      if (x.b_in_a >= s.superset && x.a_in_b < s.bothWays)
        holds.set(x.a_id, [...(holds.get(x.a_id) ?? []), x.b_id]);
    }
    const overlap = (x: number, y: number) =>
      overlapping.has(`${Math.min(x, y)}:${Math.max(x, y)}`);
    const changed: number[] = [];
    for (const [container, held] of holds) {
      const f = facts.get(container);
      if (!f || f.kind === 'omnibus' || f.kind === 'sample' || f.kind === 'bonus') continue;
      const heldBooks = held.map((id) => this.pairBook(facts.get(id), id));
      if (omnibusByText(heldBooks, overlap)) changed.push(container);
    }
    if (changed.length === 0) return;
    const setKind = this.deps.cleanup.prepare(
      `UPDATE text_facts SET kind = 'omnibus', kind_by = 'text',
         kind_marker = 'holds several books' WHERE library_id = ? AND calibre_id = ?`,
    );
    const update = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET class = ?, rule = ?, reason = ?, container = ? WHERE id = ?`,
    );
    this.deps.cleanup.transaction(() => {
      for (const id of changed) setKind.run(p.libraryId, id);
      const now = this.facts(p.libraryId);
      const ids = new Set(changed);
      for (const x of pairs) {
        if (!ids.has(x.a_id) && !ids.has(x.b_id)) continue;
        if (x.a_in_b === null || x.b_in_a === null) continue;
        const spread = x.spread_json
          ? (JSON.parse(x.spread_json) as { a: unknown; b: unknown })
          : null;
        const v = this.classify(
          x,
          { aInB: x.a_in_b, bInA: x.b_in_a, extraA: spread?.a ?? null, extraB: spread?.b ?? null },
          now,
          s,
        );
        update.run(v.cls, v.rule, v.reason, v.container ?? null, x.id);
      }
    })();
    p.omnibusByText = changed.length;
    this.deps.log?.(`Cleanup stage 3: ${changed.length} omnibus files found by their text`);
  }

  // ---- quality ----

  /** Books whose best-copy facts are needed: both sides of duplicate pairs, image-only pairs. */
  private qualityBooks(p: Stage3Progress): number[] {
    const all = this.qualityBooksAll(p);
    if (!p.qualityMissingOnly) return all;
    const has = new Set(
      (
        this.deps.cleanup
          .prepare(
            `SELECT calibre_id FROM text_facts WHERE library_id = ? AND sha256 IS NOT NULL
               AND quality_size IS NOT NULL`,
          )
          .all(p.libraryId) as { calibre_id: number }[]
      ).map((r) => r.calibre_id),
    );
    return all.filter((id) => !has.has(id));
  }

  private qualityBooksAll(p: Stage3Progress): number[] {
    const rows = this.deps.cleanup
      .prepare(
        `WITH decided AS (
           SELECT c.a_id, c.b_id FROM content_pairs c JOIN pair_decisions d
             ON d.library_id = c.library_id AND d.decision IN ('remove_a', 'remove_b')
            AND ((d.a_uuid = c.a_uuid AND d.b_uuid = c.b_uuid)
              OR (d.a_uuid = c.b_uuid AND d.b_uuid = c.a_uuid))
           WHERE c.analysis_id = ?)
         SELECT a_id AS id FROM content_pairs WHERE analysis_id = ?
           AND (class IN ('duplicate', 'superset') OR source = 'image_only')
         UNION SELECT b_id FROM content_pairs WHERE analysis_id = ?
           AND (class IN ('duplicate', 'superset') OR source = 'image_only')
         UNION SELECT a_id FROM decided UNION SELECT b_id FROM decided
         ORDER BY id`,
      )
      .all(p.analysisId, p.analysisId, p.analysisId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * The quality phase (best-copy facts: whole-file SHA-256, layout, cover, pictures) for the books
   * of duplicate pairs. The next book starts as soon as one finishes; results are saved in
   * cursor order with the cursor, so a restart resumes where the saved rows end. A step returns
   * after STEP_MS without waiting for the books still being read.
   */
  private async qualityStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const settings = getSettings(this.deps.cleanup);
    let pipe = this.qualityPipe;
    if (!pipe || pipe.analysisId !== p.analysisId || pipe.stopped) {
      pipe = this.qualityPipe = this.openQualityPipe(p);
    }
    p.qualityTotal = pipe.total;
    pipe.limit = Math.max(4, settings.duplicates.textWorkers * 2);
    pipe.setPace(settings.pacing.readMbPerSecond * 1024 * 1024);
    const deadline = Date.now() + TEXT_STEP_MS;
    let lastCommit = Date.now();
    for (;;) {
      if (shouldStop()) pipe.stopped = true;
      pipe.fill();
      const ready = pipe.ready();
      if (
        ready > 0 &&
        (ready >= TEXT_COMMIT_BOOKS ||
          Date.now() - lastCommit >= TEXT_COMMIT_MS ||
          Date.now() >= deadline ||
          pipe.stopped ||
          pipe.launchedAll())
      ) {
        this.commitQuality(p, pipe.take());
        lastCommit = Date.now();
      }
      if (pipe.finished()) {
        this.qualityPipe = null;
        p.phase = 'group';
        return p;
      }
      if (pipe.stopped && pipe.inFlight === 0) {
        this.qualityPipe = null;
        return p;
      }
      if (Date.now() >= deadline) return p;
      await pipe.wait(Math.min(deadline, lastCommit + TEXT_COMMIT_MS) - Date.now());
    }
  }

  private qualityPipe: WorkPipe<QualityDone> | null = null;

  /** A pipeline over the quality books after the saved cursor. */
  private openQualityPipe(p: Stage3Progress): WorkPipe<QualityDone> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const all = this.qualityBooks(p);
    const ids = all.filter((id) => id > p.qualityCursor);
    const facts = this.facts(p.libraryId);
    const pipe = new WorkPipe<QualityDone>(p.analysisId, all.length, ids);
    type Q = QualityDone;
    const one = async (id: number): Promise<Q | null> => {
      if (pipe.stopped) return null;
      const book = books.get(id);
      const f = facts.get(id);
      if (!book || !f) return { id, row: null };
      const file = resolveInside(libDir, book.filePath);
      const st = await statFile(file).catch(() => null);
      if (!st) return { id, row: { id, error: 'The file is gone' } };
      const mtime = Math.round(st.mtimeMs);
      if (f.quality_size === st.size && f.quality_mtime_ms === mtime && f.sha256) {
        return { id, row: null };
      }
      const started = Date.now();
      try {
        const counted = { bytes: 0 };
        const meta = await readFileMetadata(file, {
          text: false,
          cover: true,
          layout: true,
          counted,
        });
        const hashed = await hashSourceFile(file, pipe.pacerFor(), () => pipe.stopped);
        if (!hashed) return null;
        const images = await epubImageFacts(
          file,
          (meta.layout?.images ?? []).map((i) => i.entry),
          counted,
        );
        await pipe.pace(counted.bytes);
        return {
          id,
          row: {
            id,
            size: st.size,
            mtime,
            sha: hashed.sha256,
            vertical:
              meta.layout?.vertical === null || meta.layout?.vertical === undefined
                ? null
                : meta.layout.vertical
                  ? 1
                  : 0,
            cover: meta.cover ? Math.max(meta.cover.width, meta.cover.height) : null,
            images: JSON.stringify(images),
            ms: Date.now() - started,
            error: null,
          },
        };
      } catch (err) {
        return { id, row: { id, error: (err as Error).message.slice(0, 500) } };
      }
    };
    pipe.run = one;
    return pipe;
  }

  /** Saves quality facts (in cursor order) with the cursor and the progress. */
  private commitQuality(p: Stage3Progress, done: QualityDone[]): void {
    if (done.length === 0) return;
    const put = this.deps.cleanup.prepare(
      `UPDATE text_facts SET quality_size = @size, quality_mtime_ms = @mtime, sha256 = @sha,
         vertical = @vertical, cover_side = @cover, images_json = @images, quality_ms = @ms,
         quality_at = @now, quality_error = NULL WHERE library_id = @lib AND calibre_id = @id`,
    );
    const fail = this.deps.cleanup.prepare(
      `UPDATE text_facts SET quality_error = ?, quality_at = ? WHERE library_id = ? AND calibre_id = ?`,
    );
    const now = Date.now();
    this.deps.cleanup.transaction(() => {
      for (const d of done) {
        if (d.row && d.row.error) {
          fail.run(d.row.error, now, p.libraryId, d.id);
          p.qualityErrors++;
        } else if (d.row) {
          put.run({ ...d.row, now, lib: p.libraryId });
        }
        p.qualityDone++;
        p.qualityCursor = d.id;
      }
      this.save(p, 'analysing');
    })();
  }

  // ---- group ----

  private qualityOf(f: FactRow, book: Stage3Book, customTags: string[]): QualityFacts {
    return {
      calibreId: f.calibre_id,
      chars: f.chars ?? 0,
      images: f.images_json ? (JSON.parse(f.images_json) as ImageFact[]) : [],
      ruby: f.ruby ?? 0,
      tocEntries: f.toc_entries ?? 0,
      vertical: f.vertical === null ? null : f.vertical === 1,
      coverSide: f.cover_side,
      customTags: book.tags.filter((t) => isCustomTag(t, customTags)).length,
      addedAt: book.timestamp,
    };
  }

  private groupStep(p: Stage3Progress): Stage3Progress {
    const db = this.deps.cleanup;
    const settings = getSettings(db);
    const books = this.loadBooks(p.libraryId);
    const facts = this.facts(p.libraryId);
    const pairs = db
      .prepare('SELECT * FROM content_pairs WHERE analysis_id = ?')
      .all(p.analysisId) as PairRow[];
    const decisions = new Map(
      (
        db
          .prepare(
            'SELECT a_uuid, b_uuid, decision, decided_by, note FROM pair_decisions WHERE library_id = ?',
          )
          .all(p.libraryId) as {
          a_uuid: string;
          b_uuid: string;
          decision: string;
          decided_by: string;
          note: string | null;
        }[]
      ).map((d) => [`${d.a_uuid}|${d.b_uuid}`, d.decision]),
    );
    const decidedBy = new Map(
      (
        db
          .prepare(
            'SELECT a_uuid, b_uuid, decided_by, note FROM pair_decisions WHERE library_id = ?',
          )
          .all(p.libraryId) as {
          a_uuid: string;
          b_uuid: string;
          decided_by: string;
          note: string | null;
        }[]
      ).flatMap((d) => {
        const v = { by: d.decided_by, note: d.note };
        return [
          [`${d.a_uuid}|${d.b_uuid}`, v],
          [`${d.b_uuid}|${d.a_uuid}`, v],
        ] as [string, { by: string; note: string | null }][];
      }),
    );
    const decisionOf = (x: PairRow): string | null => {
      const direct = decisions.get(`${x.a_uuid}|${x.b_uuid}`);
      if (direct) return direct;
      const flipped = decisions.get(`${x.b_uuid}|${x.a_uuid}`);
      if (flipped === 'remove_a') return 'remove_b';
      if (flipped === 'remove_b') return 'remove_a';
      return flipped ?? null;
    };

    const updateBest = db.prepare(
      `UPDATE content_pairs SET best_json = ?, keep_id = ?, class = ?, rule = ?, reason = ? WHERE id = ?`,
    );
    const edges: SetEdge[] = [];
    const pairOf = new Map<string, PairRow>();
    const userDecided = new Map<string, { by: string; note: string | null }>();
    const opts = {
      imageMatchDistance: settings.duplicates.imageMatchDistance,
      coverLargerPercent: settings.covers.largerPercent,
    };
    // A copy no longer in Calibre (removed by an earlier batch, or by hand) leaves nothing to
    // decide in its pairs: they stay out of the sets. As a "can't compare" pair, it made every
    // set it was in look undecided after the removals (79 became 7,953 in the 2026-11-17
    // rehearsal, nothing more removed).
    const present = (id: number, uuid: string) => books.get(id)?.uuid === uuid;
    db.transaction(() => {
      for (const x of pairs) {
        if (!present(x.a_id, x.a_uuid) || !present(x.b_id, x.b_uuid)) continue;
        const decision = decisionOf(x);
        const key = `${x.a_id}:${x.b_id}`;
        pairOf.set(key, x);
        if (decision === 'keep_both') {
          updateBest.run(
            x.best_json,
            null,
            'keep_both',
            decidedBy.get(`${x.a_uuid}|${x.b_uuid}`)?.by === 'claude' ? 'review' : 'user',
            decidedBy.get(`${x.a_uuid}|${x.b_uuid}`)?.by === 'claude'
              ? `Kept both in the review: ${decidedBy.get(`${x.a_uuid}|${x.b_uuid}`)?.note ?? ''}`
              : 'You chose to keep both copies',
            x.id,
          );
          x.class = 'keep_both';
          continue;
        }
        if (decision === 'remove_a' || decision === 'remove_b') {
          const keep = decision === 'remove_a' ? x.b_id : x.a_id;
          updateBest.run(x.best_json, keep, x.class ?? 'review', x.rule, x.reason, x.id);
          edges.push({ a: x.a_id, b: x.b_id, keep });
          userDecided.set(
            key,
            decidedBy.get(`${x.a_uuid}|${x.b_uuid}`) ?? { by: 'you', note: null },
          );
          continue;
        }
        if (x.class !== 'duplicate' && x.class !== 'superset') continue;
        const fa = facts.get(x.a_id);
        const fb = facts.get(x.b_id);
        const ba = books.get(x.a_id);
        const bb = books.get(x.b_id);
        if (
          !fa ||
          !fb ||
          !ba ||
          !bb ||
          fa.quality_error ||
          fb.quality_error ||
          !fa.sha256 ||
          !fb.sha256
        ) {
          const best = {
            keep: null,
            by: 'tradeoff',
            measures: [],
            reason: "A copy's pictures couldn't be read",
          };
          updateBest.run(JSON.stringify(best), null, x.class, x.rule, x.reason, x.id);
          edges.push({ a: x.a_id, b: x.b_id, keep: null });
          continue;
        }
        const best: BestCopy = bestCopy(
          this.qualityOf(fa, ba, settings.customTags),
          this.qualityOf(fb, bb, settings.customTags),
          { ...opts, superset: x.class === 'superset' ? (x.container ?? undefined) : undefined },
        );
        const keep = best.keep === 'a' ? x.a_id : best.keep === 'b' ? x.b_id : null;
        x.best_json = JSON.stringify(best);
        updateBest.run(x.best_json, keep, x.class, x.rule, x.reason, x.id);
        // The removals below carry this comparison in their evidence.
        x.keep_id = keep;
        edges.push({ a: x.a_id, b: x.b_id, keep });
      }
    })();

    const sets = decideSets(edges);
    const readerBook = (uuid: string) =>
      findCalibreSource(this.deps.main, p.libraryId, uuid)?.bookId;
    const allReader: string[] = [];
    for (const set of sets) {
      for (const id of set.members) {
        const b = books.get(id);
        const rb = b ? readerBook(b.uuid) : undefined;
        if (rb) allReader.push(rb);
      }
    }
    const withData = booksWithReaderData(this.deps.main, allReader);
    const active = new Set(
      (
        db
          .prepare(
            `SELECT calibre_uuid AS uuid FROM proposed_changes
             WHERE stage IN (1, 3) AND library_id = ? AND state IN ('queued', 'applied', 'undone', 'kept')
             UNION SELECT restored_uuid AS uuid FROM undo_records
             WHERE library_id = ? AND restored_uuid IS NOT NULL`,
          )
          .all(p.libraryId, p.libraryId) as { uuid: string }[]
      ).map((r) => r.uuid),
    );
    const insert = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, state, decided_by, decided_at, analysis_id,
         created_at, updated_at)
       VALUES (3, @lib, @id, @uuid, 'book', '"present"', '"removed"', 'stage3:text', @evidence,
         'auto', 'proposed', @by, @decidedAt, @analysis, @now, @now)`,
    );
    const markPair = db.prepare(
      `UPDATE content_pairs SET class = 'review', rule = ?, reason = ? WHERE id = ?`,
    );
    let toRemove = 0;
    let setsWithoutKeeper = 0;
    let removedWithData = 0;
    let bothWithData = 0;
    let tagsCopied = 0;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `DELETE FROM proposed_changes WHERE stage = 3 AND library_id = ?
           AND state IN ('proposed', 'skipped') AND id NOT IN (SELECT change_id FROM batch_items)`,
      ).run(p.libraryId);
      db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = 'Replaced by a new analysis',
           updated_at = ? WHERE stage = 3 AND library_id = ? AND state = 'proposed'`,
      ).run(now, p.libraryId);
      for (const set of sets) {
        if (set.keeper === null) setsWithoutKeeper++;
        for (const { id, keep: keepId } of set.removals) {
          const keep = books.get(keepId);
          const keepFacts = facts.get(keepId);
          const copy = books.get(id);
          const copyFacts = facts.get(id);
          if (!keep || !keepFacts || !copy || !copyFacts || active.has(copy.uuid)) continue;
          const keptReader = readerBook(keep.uuid);
          const keptHasData = keptReader ? withData.has(keptReader) : false;
          const key = `${Math.min(id, keepId)}:${Math.max(id, keepId)}`;
          const pair = pairOf.get(key)!;
          const removedReader = readerBook(copy.uuid);
          const removedHasData = removedReader ? withData.has(removedReader) : false;
          const evidence = {
            sha256: copyFacts.sha256,
            size: copyFacts.quality_size ?? copyFacts.size,
            setSize: set.members.length,
            rule: 'stage3',
            title: copy.title,
            kept: {
              calibreId: keep.calibreId,
              uuid: keep.uuid,
              title: keep.title,
              firstAuthor: keep.firstAuthor,
              tags: keep.tags,
              formats: keep.formats,
              addedAt: keep.timestamp,
              lastModified: keep.lastModified,
              readerData: keptHasData,
              sha256: keepFacts.sha256,
              filePath: keep.filePath,
              size: keepFacts.quality_size ?? keepFacts.size,
              mtimeMs: keepFacts.quality_mtime_ms ?? keepFacts.mtime_ms,
              chars: keepFacts.chars,
              kind: keepFacts.kind,
            },
            removed: {
              calibreId: copy.calibreId,
              uuid: copy.uuid,
              title: copy.title,
              tags: copy.tags,
              customTags: copy.tags.filter((t) => isCustomTag(t, settings.customTags)),
              formats: copy.formats,
              extraFormats: copy.formats.filter((f) => !keep.formats.includes(f)),
              addedAt: copy.timestamp,
              lastModified: copy.lastModified,
              filePath: copy.filePath,
              readerData: removedHasData,
              size: copyFacts.quality_size ?? copyFacts.size,
              mtimeMs: copyFacts.quality_mtime_ms ?? copyFacts.mtime_ms,
              chars: copyFacts.chars,
              kind: copyFacts.kind,
            },
            stage3: {
              pairId: pair.id,
              class: pair.class,
              rule: pair.rule,
              reason: pair.reason,
              /** Share of the removed copy's text found in the kept one, and the other way. */
              removedInKept: pair.a_id === id ? pair.a_in_b : pair.b_in_a,
              keptInRemoved: pair.a_id === id ? pair.b_in_a : pair.a_in_b,
              best: pair.best_json ? (JSON.parse(pair.best_json) as BestCopy) : null,
              byUser: userDecided.get(key)?.by === 'you',
              /** Decided in the review: who ('you' on the page, 'claude') and the reason. */
              decidedBy: userDecided.get(key)?.by ?? null,
              decisionNote: userDecided.get(key)?.note ?? null,
            },
          };
          // P7: copying tags writes the kept copy, which renames its folder (every write
          // renames): a name the disk would refuse goes to review instead.
          const copied = tagsToCopy(
            evidence as unknown as Parameters<typeof tagsToCopy>[0],
            settings.customTags,
          );
          if (copied.length > 0) {
            const bytes = calibreNameBytes(keep.calibreId, keep.title, keep.firstAuthor);
            if (bytes > NAME_MAX_BYTES) {
              markPair.run(
                'name_too_long',
                `Your tags would go to the copy that stays, but its folder name would be too long for Calibre's library (${bytes} bytes; the disk takes ${NAME_MAX_BYTES})`,
                pair.id,
              );
              continue;
            }
            tagsCopied++;
          }
          if (removedHasData && keptHasData) bothWithData++;
          else if (removedHasData) removedWithData++;
          toRemove++;
          insert.run({
            lib: p.libraryId,
            id: copy.calibreId,
            uuid: copy.uuid,
            evidence: JSON.stringify(evidence),
            by: userDecided.has(key)
              ? userDecided.get(key)?.by === 'claude'
                ? 'claude'
                : 'user'
              : null,
            decidedAt: userDecided.has(key) ? now : null,
            analysis: p.analysisId,
            now,
          });
        }
      }
    })();

    const classes: Record<string, number> = {};
    for (const r of db
      .prepare(
        `SELECT COALESCE(class, CASE WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END) AS c,
                COUNT(*) AS n FROM content_pairs WHERE analysis_id = ? GROUP BY c`,
      )
      .all(p.analysisId) as { c: string; n: number }[]) {
      classes[r.c] = r.n;
    }
    p.classes = classes;
    p.sets = sets.length;
    p.setsWithoutKeeper = setsWithoutKeeper;
    p.toRemove = toRemove;
    p.review = this.reviewCount(p.analysisId);
    p.removedWithData = removedWithData;
    p.bothWithData = bothWithData;
    p.tagsCopied = tagsCopied;
    p.gate = this.evaluateGate(p);
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(
      `Cleanup stage 3: analysis done: ${toRemove} copies to remove, ${p.review} pairs to review, gate ${p.gate.passed ? 'passed' : 'not passed'}`,
    );
    return p;
  }

  /**
   * Pairs waiting for a decision: review, image-only, and duplicates without a clear better
   * copy, without the pairs already decided (on the page or in the review): a removal decided
   * keeps its class "review" with the copy to keep set.
   */
  reviewCount(analysisId: string): number {
    return (
      this.deps.cleanup
        .prepare(
          `SELECT COUNT(*) AS n FROM content_pairs p WHERE p.analysis_id = ?
             AND ${STAGE3_WAITING_SQL}`,
        )
        .get(analysisId) as { n: number }
    ).n;
  }

  // ---- gate ----

  labeledFile(): string | null {
    const s = getSettings(this.deps.cleanup);
    if (s.gate.labeledBooksFile) return s.gate.labeledBooksFile;
    return this.deps.dbDir
      ? path.join(this.deps.dbDir, 'cleanup', 'reference-sample', 'gold800.json')
      : null;
  }

  evaluateGate(p: Stage3Progress): Stage3Gate {
    const problems: string[] = [];
    const facts = this.facts(p.libraryId);
    const map = this.removalMap(p.libraryId);
    const s = getSettings(this.deps.cleanup).duplicates;
    const gate: Stage3Gate = {
      checkedAt: Date.now(),
      passed: false,
      problems,
      pairs: null,
      spread: null,
      kinds: null,
      textLength: null,
    };

    // 1. The measured pairs.
    const file = this.gateFile();
    const loaded = file
      ? loadGatePairs(file)
      : { pairs: null, error: 'No file for the measured pairs is set' };
    if (!loaded.pairs) {
      problems.push(`The measured duplicate pairs: ${loaded.error}`);
    } else {
      const rows = this.deps.cleanup.prepare(
        'SELECT * FROM content_pairs WHERE analysis_id = ? AND a_id = ? AND b_id = ?',
      );
      const results: GatePairResult[] = [];
      let same = 0;
      for (const g of loaded.pairs) {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        if (ga === gb) {
          same++;
          continue;
        }
        const swap = ga > gb;
        const [x, y] = swap ? [gb, ga] : [ga, gb];
        const row = rows.get(p.analysisId, x, y) as PairRow | undefined;
        let got: string | null = null;
        let ours: { aInB: number; bInA: number } | null = null;
        let note: string | null = null;
        if (!row) note = NOT_IN_LIBRARY;
        else if (row.error) note = row.error;
        else if (row.class === 'never' && row.a_in_b === null) got = 'never';
        else if (row.a_in_b !== null && row.b_in_a !== null) {
          // The class before the spread check, from our numbers and our kinds.
          const base = this.classify(
            row,
            { aInB: row.a_in_b, bInA: row.b_in_a, extraA: null, extraB: null },
            facts,
            s,
          );
          got = base.cls;
          ours = swap
            ? { aInB: row.b_in_a, bInA: row.a_in_b }
            : { aInB: row.a_in_b, bInA: row.b_in_a };
        } else note = 'Not measured';
        results.push({
          key: g.key,
          group: g.group,
          a: g.a,
          b: g.b,
          expected: g.expected,
          got,
          measured: g.measured,
          ours,
          foundByIndex: row?.source === 'index',
          note,
        });
      }
      // A pair with a copy no longer in the library can't be measured: listed, not failed.
      const gone = results.filter((r) => r.note === NOT_IN_LIBRARY).length;
      const checked = results.length - gone;
      // Compared by outcome: removable (same text, one holds the other), review, or no action
      // (never the same book, different books): "never" and "different" both keep both copies.
      const outcome = (c: string | null) =>
        c === 'duplicate' || c === 'superset'
          ? 'remove'
          : c === 'review'
            ? 'review'
            : c === 'never' || c === 'different'
              ? 'none'
              : c;
      const asMeasured = results.filter(
        (r) => r.got !== null && outcome(r.got) === outcome(r.expected),
      ).length;
      gate.pairs = {
        file: file!,
        total: loaded.pairs.length,
        sameAfterStage1: same,
        notInLibrary: gone,
        checked,
        asMeasured,
        results,
      };
      if (asMeasured < checked) {
        problems.push(`${checked - asMeasured} of ${checked} measured pairs come out differently`);
      }
      const missed = results.filter(
        (r) =>
          (r.expected === 'duplicate' || r.expected === 'superset') &&
          r.got === r.expected &&
          !r.foundByIndex,
      );
      if (missed.length > 0)
        problems.push(`${missed.length} expected duplicates were not found by the index`);

      // 2. The spread anchors.
      const shareOf = (g: (typeof loaded.pairs)[number]): number | null => {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
        const row = rows.get(p.analysisId, x, y) as PairRow | undefined;
        if (!row?.spread_json) return null;
        const sp = JSON.parse(row.spread_json) as {
          a?: { interleavedShare: number };
          b?: { interleavedShare: number };
        };
        return Math.max(sp.a?.interleavedShare ?? 0, sp.b?.interleavedShare ?? 0);
      };
      const spread = loaded.pairs.filter((g) => g.anchor === 'spread').map(shareOf);
      const flat = loaded.pairs.filter((g) => g.anchor === 'not_spread').map(shareOf);
      if (
        spread.length &&
        flat.length &&
        spread.every((x) => x !== null) &&
        flat.every((x) => x !== null)
      ) {
        const lo = Math.min(...(spread as number[]));
        const hi = Math.max(...(flat as number[]));
        gate.spread = {
          ok: lo > hi,
          detail: `Commentary edition ${(100 * lo).toFixed(1)} % extra inside the chapters; editions without: at most ${(100 * hi).toFixed(1)} %`,
        };
        if (!gate.spread.ok)
          problems.push('The spread measure does not separate the inspected editions');
      } else {
        gate.spread = { ok: null, detail: 'The inspected editions were not all measured' };
      }
    }

    // 3 and 4. The labeled books.
    const labeled = this.labeledFile();
    type Label = { kind?: string; fmt?: string };
    let gold: Record<string, Label> | null = null;
    try {
      gold = labeled
        ? (JSON.parse(fs.readFileSync(labeled, 'utf8')) as Record<string, Label>)
        : null;
    } catch {
      gold = null;
    }
    if (!gold) {
      problems.push(`The labeled books: can't read ${labeled ?? '(no file set)'}`);
    } else {
      const missed: { id: number; label: string; got: string }[] = [];
      let guards = 0;
      let imageOnly = 0;
      const imageOnlyMissed: number[] = [];
      let compared = 0;
      let equal = 0;
      const differing: { id: number; ours: number; reader: number }[] = [];
      for (const [key, label] of Object.entries(gold)) {
        const id = map.get(Number(key)) ?? Number(key);
        const f = facts.get(id);
        if (!f || f.error) continue;
        const want = label.kind === 'special edition' ? 'special' : label.kind;
        if (want === 'sample' || want === 'bonus' || want === 'omnibus') {
          guards++;
          if (f.kind !== want) missed.push({ id, label: want, got: f.kind ?? 'none' });
        }
        if (label.fmt === 'image-only') {
          imageOnly++;
          if (f.image_only !== 1) imageOnlyMissed.push(id);
        }
        if (f.reader_chars !== null && f.chars !== null) {
          compared++;
          if (f.reader_chars === f.chars) equal++;
          else differing.push({ id, ours: f.chars, reader: f.reader_chars });
        }
      }
      gate.kinds = {
        guards,
        recognized: guards - missed.length,
        missed,
        imageOnly,
        imageOnlyRecognized: imageOnly - imageOnlyMissed.length,
        imageOnlyMissed,
      };
      gate.textLength = { compared, equal, differing };
      if (missed.length)
        problems.push(
          `${missed.length} labeled previews, bonus stories or omnibus files not recognized`,
        );
      if (imageOnlyMissed.length)
        problems.push(`${imageOnlyMissed.length} labeled image-only books not recognized`);
      if (differing.length)
        problems.push(
          `${differing.length} labeled books' text length differs from the reader's count`,
        );
    }
    // Library-wide: stage 3's text length against the reader's own count of the same file.
    const books = this.loadBooks(p.libraryId);
    let compared = 0;
    let differing = 0;
    for (const f of facts.values()) {
      if (!books.has(f.calibre_id) || f.error || f.reader_chars === null || f.chars === null)
        continue;
      compared++;
      if (f.reader_chars !== f.chars) differing++;
    }
    p.readerCompared = compared;
    p.readerDiffering = differing;
    const alarm = getSettings(this.deps.cleanup).reviewAlarmPercent;
    if (compared > 0 && (100 * differing) / compared > alarm) {
      problems.push(
        `${differing} of ${compared} books' text length differs from the reader's own count (more than ${alarm} %)`,
      );
    }
    gate.passed = problems.length === 0;
    return gate;
  }
}
