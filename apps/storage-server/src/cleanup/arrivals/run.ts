/**
 * The Calibre library's new arrivals (WP20g, plan sections 10 and 11; plan approved 2026-11-22):
 * books added by hand in Calibre and EPUBs imported from the source folders, through stages 1-5
 * with the cleanup's own rules, gates and guards.
 *
 * A run, its phases resumable and each with its bar (the run's progress in calibre_arrival_runs):
 *
 *   scan      each source folder walked (read only), the catalog brought up to date
 *   archives  zip/rar/7z and split sets listed and their EPUBs unpacked into _extracted/ by the
 *             linking sidecar (in Preview too)
 *   identify  each new settled EPUB read (title and authors as its OPF says them; an EPUB the
 *             reader's import can't open is "Not imported"); other formats listed. Hashed only
 *             when its size is one of a file you removed (else when compare or an add needs it)
 *   compare   each against the library: identical files (stage 1's file_facts), the same text
 *             (compare.ts: stage 3's reader, index and rules), the better copy (stage 3's order)
 *   plan      what would be added. Preview ends its import here; a folder's first run is a
 *             Preview whatever the mode; runs that start after it add when the card is On
 *   add       (On) add batches through the apply sidecar (calibredb add)
 *   index     the reader's index shows the added books; each added EPUB checked against its file
 *   stages    the run's books (added now, and books added by hand in Calibre once settled)
 *             through stage 1 → stage 3 → their removals → stage 2 → its write → stage 4 (the
 *             lookups, the AI check with J, one spelling and the order of their series) → its
 *             write → stage 5 → its write, each write through the stage's own batch planner with
 *             the run's analysis id; in Preview the proposals are made and nothing is written
 *   check     every field written compared with Calibre's metadata.db (the reader's snapshot)
 *   report    the run's summary, the digest line, an alert when it found new review items
 *
 * Re-run, don't fork: every decision is the stages' own code (stage passes, compare.ts, stage 4's
 * arrivalView, stage4-ai.ts, stage5-pass.ts). Where the Calibre version differs from the
 * audiobooks' stage 7: the stages are run on the run's books instead of re-analysing the library
 * (53,000 books: a re-analysis stats every EPUB and measures every pair again), duplicates are
 * decided before a file is added, and writes go in the cleanup's stage order with the reader's
 * index between them.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { snapshotFile } from '../../calibre/indexer';
import { getLibrary } from '../../calibre/libraries';
import { resolveInside, statFile } from '../../calibre/source-fs';
import type { Stage3Reader } from '../../counts/book-text-worker';
import type { AiRunner } from '../../ai/runner';
import type { DiskLock } from '../disk-lock';
import { readFileMetadata } from '../file-metadata';
import { getSettings, type ArrivalPair } from '../settings';
import {
  hashSourceFile,
  Pacer,
  readSnapshotBooks,
  readSnapshotPresence,
  type SnapshotBook,
} from '../stage1';
import type { Stage2Analysis } from '../stage2';
import type { Stage2Batches } from '../stage2-batches';
import type { BatchService } from '../batches';
import { calibreNameBytes, NAME_MAX_BYTES } from '../stage2-rules';
import { fitTitle, UNKNOWN_ID } from '../title-fit';
import { getStage } from '../stages';
import type { Stage4Analysis, Stage4Progress } from '../stage4/analysis';
import { arrivalAnalysisId } from '../stage4/analysis';
import { clockNow, nextScheduledRun, scheduledRunDue } from '../audio/arrivals-schedule';
import { ArrivalBatches } from './add-batches';
import { BookArchives } from './archives';
import { classifyName, settled, sniffFormat, walkSource } from './catalog';
import { groupUnits, neededOthers } from './measure-plan';
import {
  BOOKS_PER_COMPARE,
  buildLibraryLookup,
  candidatePairsOf,
  copyNewSketches,
  copySketchAs,
  dropCrossSketches,
  dropNewSketches,
  judgePair,
  libraryQuality,
  measurePairs,
  qualityOfFile,
  readNewText,
  saveLibraryText,
  type CompareDeps,
  type MeasuredPair,
  type NewText,
  type Quality,
} from './compare';
import { SourcePacer, hashSource, insideSources, lstatSource, sourcesWritable } from './sources-fs';
import {
  hasReaderData,
  libraryHashesOfSize,
  proposeStage3Removal,
  stage1Pass,
  stage2Pass,
  statBooks,
  type PassDeps,
  type PassReview,
} from './stage-passes';
import { ArrivalStage4Ai, emptyArrivalAi, type ArrivalAiProgress, type JGate } from './stage4-ai';
import { ArrivalStage5, emptyStage5Pass, type Stage5PassProgress } from './stage5-pass';
import { MOVE_STAGE } from '../field-stages';
import type { MovePass } from '../move/pass';
import { waitsForCount } from '../move/select';
import { getMoveState, moveArrivalsAnalysisId } from '../move/state';

export const DISK_OWNER = 'calibreArrivals';
/** The linking sidecar's archive batches hold the disk under their own name. */
export const ARCHIVE_OWNER = 'calibreArrivalsArchives';

export type RunPhase =
  | 'scan'
  | 'archives'
  | 'identify'
  | 'compare'
  | 'plan'
  | 'add'
  | 'index'
  | 'stage1'
  | 'stage3'
  | 'removals'
  | 'stage2'
  | 'write2'
  | 'stage4'
  | 'ai'
  | 'write4'
  | 'stage5'
  | 'write5'
  | 'check'
  | 'move'
  | 'report'
  | 'done';

/** Stage 1's parts on the run's books: their files' sizes, then the library's of those sizes. */
const STAGE1_PARTS = ['stat', 'match'] as const;
/** The AI step's parts while the models answer: the first pair, then the stronger pair. */
const AI_PARTS = ['cheap', 'strong'] as const;

/**
 * WP20g run 7 (2026-11-26): a run's books that stage 4 never read (the read was cut by a restart
 * before stage4Read existed) go through stages 4-5 and the move in a new run of their own, which
 * starts at stage 4 (stages 1-3 and 2's write were done for them in the first run). One time, by
 * `cli cleanup arrivals-continue <run>`; refused while a run goes on.
 */
export function continueArrivalsStage4(
  db: Database.Database,
  fromRunId: number,
  present: (libraryId: string) => Map<number, string>,
): { runId: number; books: number } {
  // One run at a time across the libraries (manga part B).
  const going = db
    .prepare('SELECT current_run FROM calibre_arrivals_state WHERE current_run IS NOT NULL LIMIT 1')
    .get() as { current_run: number } | undefined;
  if (going) throw new Error(`Run ${going.current_run} is going on`);
  const from = db
    .prepare('SELECT state, mode, progress_json FROM calibre_arrival_runs WHERE id = ?')
    .get(fromRunId) as { state: string; mode: string; progress_json: string } | undefined;
  if (!from || from.state !== 'done' || from.mode !== 'on')
    throw new Error(`Run ${fromRunId} is not a finished On run`);
  const fp = JSON.parse(from.progress_json) as RunProgress;
  if (!fp.libraryId) throw new Error('The run has no library');
  // Manga part B: the run's own library's state row.
  const state = db
    .prepare('SELECT mode FROM calibre_arrivals_state WHERE library_id = ?')
    .get(fp.libraryId) as { mode: string } | undefined;
  if (!state) throw new Error('No new-arrivals state');
  if (state.mode !== 'on') throw new Error('New arrivals must be On');
  const books = present(fp.libraryId);
  const read = new Set(
    (
      db
        .prepare('SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ?')
        .all(arrivalAnalysisId(fromRunId)) as { calibre_uuid: string }[]
    ).map((r) => r.calibre_uuid),
  );
  const pick = (ids: number[]) =>
    ids.filter((id) => {
      const uuid = books.get(id);
      return uuid !== undefined && !read.has(uuid);
    });
  const p = emptyProgress();
  p.phase = 'stage4';
  p.libraryId = fp.libraryId;
  p.pairs = fp.pairs.map((x) => ({ ...x, firstRun: false }));
  p.scope = { import: pick(fp.scope.import), hand: pick(fp.scope.hand) };
  p.followUp = `stage4:${fromRunId}`;
  p.indexSeen = true;
  const n = p.scope.import.length + p.scope.hand.length;
  if (!n) throw new Error(`Every book of run ${fromRunId} was read by stage 4`);
  const runId = db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json, library_id)
           VALUES ('now', 'on', 'running', 'stage4', ?, ?, ?)`,
        )
        .run(Date.now(), JSON.stringify(p), fp.libraryId).lastInsertRowid,
    );
    db.prepare(
      'UPDATE calibre_arrivals_state SET current_run = ?, updated_at = ? WHERE library_id = ? AND current_run IS NULL',
    ).run(id, Date.now(), fp.libraryId);
    return id;
  })();
  return { runId, books: n };
}

export const RUN_PHASES: readonly RunPhase[] = [
  'scan',
  'archives',
  'identify',
  'compare',
  'plan',
  'add',
  'index',
  'stage1',
  'stage3',
  'removals',
  'stage2',
  'write2',
  'stage4',
  'ai',
  'write4',
  'stage5',
  'write5',
  'check',
  'move',
  'report',
  'done',
];

/** A phase's own count of what it has done and has in all (for the bar). */
export interface PhaseCount {
  done: number;
  total: number;
  /** Bytes for the reading phases (the time left goes by bytes there). */
  bytesDone?: number;
  bytesTotal?: number;
}

/** The compare phase's stages (each resumable from the catalog). */
export type CompareStage = 'library' | 'identical' | 'text' | 'pairs' | 'measure' | 'decide';
/** The compare step's parts in the order they run (the card shows "part N of 6"). */
export const COMPARE_STAGES: CompareStage[] = [
  'library',
  'identical',
  'text',
  'pairs',
  'measure',
  'decide',
];

/** What the compare phase keeps in a new file's catalog row (facts_json). */
export interface CompareFacts {
  title?: string | null;
  text?: {
    chars: number;
    importChars: number;
    kind: NewText['kind'];
    marker: string | null;
    imageOnly: boolean;
    error: string | null;
    ruby: number;
    toc: number;
    samples: number;
    fileTitle: string | null;
    vertical: boolean | null;
    imageEntries: number;
  };
  /** Candidate pairs this book owns (the other copy's key). */
  cands?: number[];
  /**
   * Library pairs measured while the book was read (the library lookup): the library books
   * measured and their verdicts. Only those the whole index proposes count (`covered`).
   */
  early?: { measured: number[]; verdicts: MeasuredPair[] };
  /** The candidates whose verdict came from `early` (not measured again). */
  covered?: number[];
  verdicts?: MeasuredPair[];
  measured?: boolean;
  compared?: boolean;
  /** Manga part B: the other libraries this file was checked against, and those verdicts. */
  crossChecked?: string[];
  crossVerdicts?: (MeasuredPair & { library: string })[];
  [k: string]: unknown;
}

/** A catalog file the run added to Calibre. */
interface AddedFile {
  id: number;
  sha256: string;
  size: number;
  /** When the add phase ended (every index-step check of the book came after it). */
  decided_at: number;
  facts_json: string | null;
}

export interface RunProgress {
  phase: RunPhase;
  phaseStartedAt: number;
  phaseStartDone: number;
  /** Time spent per phase (ms), waits for the disk left out. */
  times: Record<string, number>;
  counts: Partial<Record<RunPhase, PhaseCount>>;
  waiting: string | null;
  pairs: { key: string; source: string; libraryId: string; firstRun: boolean }[];
  libraryId: string | null;
  /**
   * Manga part B: the other libraries a new copy is checked against (identical files, same
   * text). Absent in a run made before (it checks its own library only, as it did).
   */
  otherLibraries?: string[];
  /** The run's books (Calibre ids) by where they came from. */
  scope: { import: number[]; hand: number[] };
  /** Pairs measured in compare: file id -> the library copy it lost to or beat. */
  betterOf: Record<string, { calibreId: number; uuid: string; pair: Record<string, unknown> }>;
  /** The compare phase's stage and its own start (the bar's pace). */
  cmp?: { stage: CompareStage; cursor: number; startedAt: number; startDone: number };
  /**
   * Manga part B: the check against the other libraries after the run's own (p.otherLibraries):
   * which library, its part, the cursor, and its candidate pairs (new book, library book).
   */
  cross?: {
    at: number;
    stage: 'library' | 'identical' | 'text' | 'measure' | 'decide';
    cursor: number;
    pairs?: { a: number; b: number }[];
  };
  /**
   * The part of another phase that runs in parts counted on their own (stage 1's file sizes,
   * then its same-size books; the AI's first pair, then the stronger pair), with its own start
   * (the bar's pace). WP20g run 7, 2026-11-25: steps without a count showed no time left and
   * the bar jumped from step to step.
   */
  part?: { name: string; index: number; count: number; startedAt: number; startDone: number };
  /**
   * Since when the run waits for another stage's analysis. The bar shows no time left meanwhile,
   * and the wait is taken out of the pace when the run goes on (WP20g, 2026-11-24: a two-hour
   * wait for stage 2 showed "about 82 h left").
   */
  waitingSince?: number;
  /** The index step saw every added book in the reader's snapshot (its slices skip the check). */
  indexSeen?: boolean;
  reviews: number;
  stage4: Stage4Progress | null;
  ai: ArrivalAiProgress | null;
  s5: Stage5PassProgress | null;
  jGate: JGate | null;
  /** Batches the run planned per stage (ids), and what they wrote. */
  /** Why a run started besides its trigger: 'settle' (files waiting to settle have settled). */
  followUp?: string;
  writes: Record<
    string,
    {
      batches: string[];
      applied: number;
      failed: number;
      /** Proposed but not written: a field paused by its gate (held as for the cleanup). */
      held?: number;
      heldWhy?: string | null;
    }
  >;
  check: { fields: number; same: number; differ: { calibreId: number; field: string }[] } | null;
  /**
   * Manga part A: the run's books tagged マンガ or 画像のみ after stage 5's tags were written,
   * moved to the manga library in the same run (its card's mode: Preview lists, On moves).
   */
  move?: {
    tagged: number;
    auto: number;
    held: Record<string, number>;
    batches: string[];
    moved: number;
    note: string | null;
  } | null;
  /** When the move step began waiting for the reader to count the run's tagged books. */
  moveCountWaitSince?: number | null;
  /**
   * Stage 4 has read every book of the run (WP20g run 7, 2026-11-26: the read was one pass with
   * no record of its end, and a restart in it left ~10,000 books unread and never looked up).
   */
  stage4Read?: boolean;
  cost: number;
}

export interface RunReport {
  mode: 'analyse' | 'on';
  outcomes: Record<string, number>;
  formats: Record<string, number>;
  added: number;
  hand: number;
  written: Record<string, number>;
  held?: Record<string, number>;
  reviews: number;
  newReview: number;
  bestGuesses: number;
  existingSeriesChanges: number;
  aiCost: number;
  check: RunProgress['check'];
  /** Estimates for On (Preview): books to add, the AI's cost and the time. */
  estimate: { books: number; aiUsd: number; seconds: number } | null;
}

export interface ArrivalsDeps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string | null;
  cacheDir: string;
  /** CLEANUP_BOOK_SOURCES_DIR: /mnt/disk1/data/torrents, read only (null = the import is off). */
  sourcesDir: string | null;
  diskLock: DiskLock;
  batches: BatchService;
  /** Manga part B: each library's own stage 2 and stage 4 (CleanupService.lp()). */
  stage2: (libraryId: string) => Stage2Analysis | null;
  stage2Batches: Stage2Batches;
  stage4Batches: Stage2Batches;
  stage5Batches: Stage2Batches;
  analysis4: (libraryId: string) => Stage4Analysis | null;
  runner: AiRunner;
  reader: () => Stage3Reader;
  counterBuild: string;
  targetLibrary: () => string | null;
  /**
   * Manga part B: the Calibre libraries the cleanup works on, the primary one first (each has its
   * own runs, mode and baseline; one run at a time across them). Absent: the primary one only.
   */
  libraries?: () => string[];
  /** Whether a stage's own analysis is running (an arrivals run never overlaps one). */
  libraryBusy: () => string | null;
  /** Asks the reader's index to copy metadata.db at once (books were added). */
  wantIngest: (libraryId: string) => void;
  /** Whether the linking sidecar has been seen lately (archives wait for it). */
  linkSidecarOnline: () => boolean;
  /**
   * The user's fields of a copy that a better new copy replaces are copied onto it (calibre
   * metadata editing): returns the edit's batch, or null.
   */
  carry?: (libraryId: string, fromUuid: string, toUuid: string) => string | null;
  /** The source folders must be mounted read-only (tests on a writable temp folder: false). */
  requireReadOnlySources?: boolean;
  /** The safety checks (stage 0) every write waits for, as the stages' own writes do. */
  checksPass?: (libraryId: string) => { ok: boolean; failing: string[] };
  /**
   * Manga part A: the move pass (its card's mode and target) and why its write must wait now.
   * Without it the run has no move phase (it goes from the check to the report).
   */
  move?: () => {
    pass: MovePass;
    writeWait: (lib: string, target: string) => string | null;
  } | null;
  log?: (m: string) => void;
}

interface StateRow {
  mode: 'off' | 'analyse' | 'on';
  pause_reason: string | null;
  pause_detail: string | null;
  paused_at: number | null;
  last_scheduled_day: string | null;
  run_now: number;
  current_run: number | null;
  baseline_at: number | null;
  hand_checked_at: number | null;
}

interface RunRow {
  id: number;
  /** Manga part B (v38): the library the run works on. */
  library_id: string | null;
  trigger: 'schedule' | 'now' | 'hand';
  mode: 'analyse' | 'on';
  state: 'running' | 'done' | 'failed' | 'stopped';
  phase: RunPhase;
  started_at: number;
  progress_json: string;
}

export class RunStop extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function pairKeyOf(p: ArrivalPair): string {
  return `${p.id}|${p.source}`;
}

function emptyProgress(): RunProgress {
  const now = Date.now();
  return {
    phase: 'scan',
    phaseStartedAt: now,
    phaseStartDone: 0,
    times: {},
    counts: {},
    waiting: null,
    pairs: [],
    libraryId: null,
    scope: { import: [], hand: [] },
    betterOf: {},
    reviews: 0,
    stage4: null,
    ai: null,
    s5: null,
    jGate: null,
    writes: {},
    check: null,
    cost: 0,
  };
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Library books measured with a new book while its text is read (the rest wait for the
 * measure stage; a compare request reads at most 8 books, the new one included). */
const EARLY_MAX_BOOKS = 7;

/**
 * The compare's reading and measuring keep every reader process busy for up to this long under
 * one hold of the disk lock (a new book starts as soon as one finishes), then let the books in
 * flight finish; they stop sooner when another job waits for the disk. Batches of a fixed count
 * left the processes idle while each batch's slowest book finished (WP20g stop 2: 120-640 % CPU).
 */
const STREAM_MS = 5 * 60_000;
/** How often the bar's progress is saved while the reading or measuring goes on. */
const PROGRESS_SAVE_MS = 15_000;

/**
 * The same text as another copy with neither copy better on every measure (stage 3's trade-off):
 * not added (user, 2026-11-24, after checking 5 of the Preview's 1,887: 99.7-100 % of the text in
 * common both ways, only the pictures' size and compression and the cover's size differed). Of
 * two new copies, the one with the lower catalog id stays (otherKey > -id: a library book's key
 * is positive, and a lower id is a larger negative key).
 */
export function sameTextNoWinner(verdicts: MeasuredPair[], id: number): MeasuredPair | undefined {
  return verdicts.find((v) => v.cls === 'duplicate' && v.keep === null && v.otherKey > -id);
}

/** The detail of a new book not added because of `sameTextNoWinner`. */
export function sameTextDetail(v: MeasuredPair): string {
  const why = v.best?.reason ? `; ${v.best.reason}` : '';
  return v.otherKey > 0
    ? `The same text as Calibre book ${v.otherKey}; neither copy is better on every measure${why}`
    : `The same text as ${-v.otherKey} in this run; neither copy is better on every measure${why}`;
}

/**
 * Runs `fn` on the items with up to `limit` in flight, the next item as soon as one finishes
 * (stage 3's pipeline, not groups that wait for their slowest). False when stopped on the way;
 * a job that throws makes the whole call throw.
 */
export async function inPool<T>(
  items: T[],
  limit: number,
  shouldStop: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<boolean> {
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (next < items.length) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return !stopped;
}

/** A run without new books goes from one write to the next (the stages have no books). */
const NEXT_WRITE = { write2: 'write4', write4: 'write5', write5: 'check' } as const;

/**
 * Manga part B: the keys a hand-added book's sketch takes under another library (negative, apart
 * from the source files' -id keys, which stay far below this).
 */
const HAND_CROSS_KEY = 1_000_000_000;

export class BookArrivals {
  readonly addBatches: ArrivalBatches;
  readonly archives: BookArchives;
  /** Stage 4's AI check and stage 5 for new books, per library (made on first use). */
  private readonly ai4s = new Map<string, ArrivalStage4Ai | null>();
  private readonly s5s = new Map<string, ArrivalStage5 | null>();
  private stepping = false;
  private stopRequested = false;
  private readonly log: (m: string) => void;

  private readonly settleCheckedAt = new Map<string, number>();
  /** The compare stage's pace was started in this process. */
  /** The library lookup file this process built, per run (null: the reader has none). */
  private lookup: { run: number; file: string | null } | null = null;
  /** The sizes two or more new files share (the identical stage's hash-on-need), per run. */
  private sharedSizes: { run: number; sizes: Set<number> } | null = null;
  private cmpPaced = false;

  constructor(private readonly deps: ArrivalsDeps) {
    this.log = deps.log ?? (() => {});
    this.addBatches = new ArrivalBatches(deps.cleanup);
    this.archives = new BookArchives(deps.cleanup, (key) => this.rootOf(key));
  }

  /** The library's stage 4 analysis, its arrival view saved in the run (never over its progress). */
  private a4(libraryId: string): Stage4Analysis | null {
    const a4 = this.deps.analysis4(libraryId);
    if (a4 && !this.ai4s.has(libraryId)) {
      a4.setArrivalSink((p) => this.saveStage4View(p));
      this.ai4s.set(
        libraryId,
        new ArrivalStage4Ai({
          db: this.deps.cleanup,
          runner: this.deps.runner,
          analysis: a4,
          log: this.log,
        }),
      );
      this.s5s.set(
        libraryId,
        new ArrivalStage5({ db: this.deps.cleanup, runner: this.deps.runner, analysis: a4 }),
      );
    }
    return a4;
  }

  private ai4Of(libraryId: string): ArrivalStage4Ai | null {
    return this.a4(libraryId) ? (this.ai4s.get(libraryId) ?? null) : null;
  }

  private s5Of(libraryId: string): ArrivalStage5 | null {
    return this.a4(libraryId) ? (this.s5s.get(libraryId) ?? null) : null;
  }

  /** The libraries whose arrivals run, the primary one first. */
  libraries(): string[] {
    const libs = this.deps.libraries?.() ?? [];
    if (libs.length) return libs;
    const primary = this.deps.targetLibrary();
    return primary ? [primary] : [];
  }

  /**
   * The library a call is about: the one named, else the current run's, else the primary one
   * ('' when there is none: its state reads as Off).
   */
  private libOr(libraryId?: string | null): string {
    if (libraryId) return libraryId;
    const r = this.db
      .prepare(
        'SELECT library_id FROM calibre_arrivals_state WHERE current_run IS NOT NULL LIMIT 1',
      )
      .get() as { library_id: string } | undefined;
    return r?.library_id ?? this.deps.targetLibrary() ?? '';
  }
  /** The Calibre library a source folder pair adds to. */
  private pairLibrary(pairKey: string): string {
    const r = this.db
      .prepare('SELECT library_id FROM calibre_arrival_pairs WHERE pair_key = ?')
      .get(pairKey) as { library_id: string } | undefined;
    return r?.library_id ?? '';
  }

  private get db(): Database.Database {
    return this.deps.cleanup;
  }

  // ---------------------------------------------------------------- state

  /** A library's state (its row is made on first read: Off). */
  state(libraryId?: string | null): StateRow {
    const lib = this.libOr(libraryId);
    // A row the migration could not give a library (no ttsu.db to ask) is the first library's.
    if (
      lib !== '' &&
      !this.db.prepare('SELECT 1 FROM calibre_arrivals_state WHERE library_id = ?').get(lib)
    )
      this.db
        .prepare("UPDATE calibre_arrivals_state SET library_id = ? WHERE library_id = ''")
        .run(lib);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO calibre_arrivals_state (library_id, updated_at) VALUES (?, 0)',
      )
      .run(lib);
    return this.db
      .prepare('SELECT * FROM calibre_arrivals_state WHERE library_id = ?')
      .get(lib) as StateRow;
  }

  private setState(
    fields: Partial<Record<keyof StateRow, unknown>>,
    libraryId?: string | null,
  ): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const lib = this.libOr(libraryId);
    this.state(lib);
    this.db
      .prepare(
        `UPDATE calibre_arrivals_state SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE library_id = @lib`,
      )
      .run({ ...fields, now: Date.now(), lib });
  }

  /** The source folder of a pair, relative to the sources mount (and to the sidecar's torrents/). */
  rootOf(pairKey: string): string | null {
    const p = this.db
      .prepare('SELECT source FROM calibre_arrival_pairs WHERE pair_key = ?')
      .get(pairKey) as { source: string } | undefined;
    return p?.source ?? null;
  }

  /** Why the import can't run (the run still checks the books added by hand). */
  importProblem(): string | null {
    if (!this.deps.sourcesDir)
      return 'The source folders are not mounted (CLEANUP_BOOK_SOURCES_DIR)';
    if (!fs.existsSync(this.deps.sourcesDir))
      return `The source folders are missing: ${this.deps.sourcesDir}`;
    return null;
  }

  setMode(mode: 'off' | 'analyse' | 'on', libraryId?: string | null): void {
    const lib = this.libOr(libraryId);
    this.setState({ mode }, lib);
    if (mode === 'off') {
      // Off stops the run that is going too (WP20g stop 2: it went on while Off).
      const run = this.currentRun();
      if (run && this.runLibrary(run) === lib) {
        this.stopRequested = true;
        this.finish(run.id, run.p, 'stopped', 'Stopped: new arrivals set Off');
      }
    }
  }

  /** Run now: queued behind a run of another library (one run at a time). */
  requestRun(libraryId?: string | null): void {
    const lib = this.libOr(libraryId);
    const s = this.state(lib);
    if (s.mode === 'off') throw new Error('New arrivals are Off: set Preview or On first');
    if (s.current_run !== null) throw new Error('A run is going on');
    this.setState({ run_now: 1 }, lib);
  }

  /** Stops the current run where it is (its batches already handed out finish on their own). */
  stopRun(): void {
    const run = this.currentRun();
    if (!run) return;
    const lib = this.runLibrary(run);
    this.stopRequested = true;
    this.finish(run.id, run.p, 'stopped', 'Stopped on the page');
    // Nothing starts again by itself (WP20g stop 2: a scheduled run that was due started at
    // once): the due scheduled run counts as done; follow-ups wait for the next run.
    const a = getSettings(this.db).arrivals;
    const now = Date.now();
    if (
      scheduledRunDue(
        now,
        { arrivalsTime: a.time, arrivalsQuietStart: a.quietStart, arrivalsQuietEnd: a.quietEnd },
        this.state(lib).last_scheduled_day,
        this.zone(),
      )
    )
      this.setState({ last_scheduled_day: clockNow(now, this.zone()).day }, lib);
  }

  /** The latest run was stopped (on the page or by Off): only a scheduled run or Run now next. */
  private lastStopped(libraryId: string): boolean {
    const r = this.db
      .prepare(
        'SELECT state FROM calibre_arrival_runs WHERE library_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(libraryId) as { state: string } | undefined;
    return r?.state === 'stopped';
  }

  resume(libraryId?: string | null): void {
    this.setState({ pause_reason: null, pause_detail: null, paused_at: null }, libraryId);
  }

  private pause(reason: string, detail: string, libraryId: string): void {
    this.setState(
      {
        pause_reason: reason,
        pause_detail: detail.slice(0, 1000),
        paused_at: Date.now(),
      },
      libraryId,
    );
    this.log(`New arrivals paused (${reason}): ${detail}`);
  }

  /** The pairs as set, each recorded on first sight (a changed folder is a new pair). */
  private syncPairs(target: string, now = Date.now()): RunProgress['pairs'] {
    const s = getSettings(this.db);
    const out: RunProgress['pairs'] = [];
    for (const p of s.arrivals.pairs) {
      const key = pairKeyOf(p);
      this.db
        .prepare(
          `INSERT INTO calibre_arrival_pairs (pair_key, pair_id, source, library_id, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(pair_key) DO NOTHING`,
        )
        .run(key, p.id, p.source, p.libraryId, now);
      const r = this.db
        .prepare('SELECT * FROM calibre_arrival_pairs WHERE pair_key = ?')
        .get(key) as { first_done_at: number | null };
      // Manga part B: a run takes its own library's pairs (each library has its runs).
      if (p.libraryId !== target) continue;
      out.push({
        key,
        source: p.source,
        libraryId: p.libraryId,
        firstRun: r.first_done_at === null,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- runs

  /**
   * The new arrivals are done with the books the reader's index first saw before this time
   * (series-arrivals.md 3.2), across the cleanup's libraries (manga part B: the earliest of
   * theirs, so a book is never taken as done while any library's run is open). Per library:
   * Off: every book (Infinity); a run open: none (-Infinity); else that library's last run's
   * end (the run that added a book, or the one that took in a book added by hand, ended after
   * it was seen). Read only.
   */
  doneBefore(): number {
    let out = Infinity;
    for (const lib of this.libraries()) {
      const s = this.db
        .prepare('SELECT mode, current_run FROM calibre_arrivals_state WHERE library_id = ?')
        .get(lib) as { mode: string; current_run: number | null } | undefined;
      if (!s || s.mode === 'off') continue;
      if (s.current_run !== null) return -Infinity;
      const r = this.db
        .prepare('SELECT MAX(finished_at) AS at FROM calibre_arrival_runs WHERE library_id = ?')
        .get(lib) as { at: number | null };
      out = Math.min(out, r.at ?? -Infinity);
    }
    return out;
  }

  /** The run going on, of whichever library (one at a time). */
  currentRun(): (RunRow & { p: RunProgress }) | null {
    const s = this.db
      .prepare(
        'SELECT current_run FROM calibre_arrivals_state WHERE current_run IS NOT NULL LIMIT 1',
      )
      .get() as { current_run: number } | undefined;
    if (!s) return null;
    const r = this.db
      .prepare('SELECT * FROM calibre_arrival_runs WHERE id = ?')
      .get(s.current_run) as RunRow | undefined;
    return r ? { ...r, p: JSON.parse(r.progress_json) as RunProgress } : null;
  }

  /** A run's library: its own (a run made before manga part B: the progress's, else the primary). */
  runLibrary(run: { library_id?: string | null; p: RunProgress }): string {
    return run.library_id ?? run.p.libraryId ?? this.deps.targetLibrary() ?? '';
  }

  private save(runId: number, p: RunProgress): void {
    this.db
      .prepare('UPDATE calibre_arrival_runs SET phase = ?, progress_json = ? WHERE id = ?')
      .run(p.phase, JSON.stringify(p), runId);
  }

  private saveStage4View(view: Stage4Progress): void {
    const run = this.currentRun();
    if (!run || view.analysisId !== arrivalAnalysisId(run.id)) return;
    run.p.stage4 = view;
    this.save(run.id, run.p);
  }

  private next(runId: number, p: RunProgress, phase: RunPhase): void {
    const t = Date.now();
    p.times[p.phase] = (p.times[p.phase] ?? 0) + (t - p.phaseStartedAt);
    p.phase = phase;
    p.phaseStartedAt = t;
    p.phaseStartDone = 0;
    p.waiting = null;
    delete p.part;
    this.save(runId, p);
  }

  /** This phase's part (a new part counts from its own start). */
  private setPart(p: RunProgress, name: string, parts: readonly string[]): void {
    if (parts.length < 2) return;
    if (p.part?.name === name) return;
    p.part = {
      name,
      index: Math.max(0, parts.indexOf(name)),
      count: parts.length,
      startedAt: Date.now(),
      startDone: 0,
    };
  }

  private lastPassSave = 0;

  /** A long pass's progress into the phase's count, saved at most every 5 s for the card. */
  private passProgress(
    runId: number,
    p: RunProgress,
    parts: readonly string[],
    name: string,
    done: number,
    total: number,
  ): void {
    this.setPart(p, name, parts);
    const c = this.count(p, p.phase);
    c.done = done;
    c.total = total;
    const t = Date.now();
    if (t - this.lastPassSave >= 5000) {
      this.lastPassSave = t;
      this.save(runId, p);
    }
  }

  /** The run's changes of these stages written so far, of those it will write (class auto). */
  private writeCount(
    p: RunProgress,
    phase: RunPhase,
    stages: number[],
    libraryId: string,
    runId: number,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage IN (${stages.map(() => '?').join(', ')}) AND library_id = ? AND analysis_id = ?
           AND class = 'auto' GROUP BY state`,
      )
      .all(...stages, libraryId, arrivalAnalysisId(runId)) as { state: string; n: number }[];
    const c = this.count(p, phase);
    c.total = rows.reduce((a, r) => a + r.n, 0);
    c.done = rows
      .filter((r) => r.state !== 'proposed' && r.state !== 'queued')
      .reduce((a, r) => a + r.n, 0);
  }

  /** The time zone the schedule uses (blank: the server's). */
  zone(): string | undefined {
    return getSettings(this.db).arrivals.timeZone || undefined;
  }

  nextRunAt(libraryId?: string | null, now = Date.now()): number | null {
    const s = this.state(libraryId);
    if (s.mode === 'off') return null;
    const a = getSettings(this.db).arrivals;
    return nextScheduledRun(
      now,
      { arrivalsTime: a.time, arrivalsQuietStart: a.quietStart, arrivalsQuietEnd: a.quietEnd },
      s.last_scheduled_day,
      this.zone(),
    );
  }

  /** Starts a run when one is due: Run now, the daily time, or books added by hand settled. */
  maybeStart(target: string | null = this.deps.targetLibrary(), now = Date.now()): number | null {
    if (!target || !this.deps.calibreDir) return null;
    const s = this.state(target);
    if (s.mode === 'off' || s.pause_reason || s.current_run !== null) return null;
    // One run at a time across the libraries.
    if (this.currentRun()) return null;
    const a = getSettings(this.db).arrivals;
    const sched = {
      arrivalsTime: a.time,
      arrivalsQuietStart: a.quietStart,
      arrivalsQuietEnd: a.quietEnd,
    };
    let trigger: RunRow['trigger'] | null = null;
    let followUp: string | null = null;
    if (s.run_now) trigger = 'now';
    else if (scheduledRunDue(now, sched, s.last_scheduled_day, this.zone())) trigger = 'schedule';
    else if (
      !this.lastStopped(target) &&
      (s.hand_checked_at === null || now - s.hand_checked_at >= a.handCheckMinutes * 60_000) &&
      this.handSettled(target, now).length > 0
    )
      trigger = 'hand';
    // Files waiting to settle that have settled since: a follow-up run looks at them now instead
    // of at the next day's run (checked at most once a minute).
    else if (!this.lastStopped(target) && now - (this.settleCheckedAt.get(target) ?? 0) >= 60_000) {
      this.settleCheckedAt.set(target, now);
      if (this.settledWaiting(target, now)) {
        trigger = 'now';
        followUp = 'settle';
      }
    }
    if (s.hand_checked_at === null || now - s.hand_checked_at >= a.handCheckMinutes * 60_000)
      this.setState({ hand_checked_at: now }, target);
    if (!trigger) return null;
    const busy = this.deps.libraryBusy();
    if (busy) return null;
    const mode = s.mode === 'on' ? 'on' : 'analyse';
    const p = emptyProgress();
    p.libraryId = target;
    // Manga part B: a run made now checks new copies against the other libraries too (a run made
    // before has no such field and works as it did: run 7).
    p.otherLibraries = this.libraries().filter((l) => l !== target);
    if (followUp) p.followUp = followUp;
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json, library_id)
           VALUES (?, ?, 'running', 'scan', ?, ?, ?)`,
        )
        .run(trigger, mode, now, JSON.stringify(p), target).lastInsertRowid,
    );
    this.setState(
      {
        current_run: id,
        run_now: 0,
        ...(trigger === 'schedule' ? { last_scheduled_day: clockNow(now, this.zone()).day } : {}),
      },
      target,
    );
    this.log(
      `New arrivals: run ${id} started (${followUp ? 'files settled' : trigger}, ${mode === 'on' ? 'On' : 'Preview'})`,
    );
    return id;
  }

  stop(): void {
    this.stopRequested = true;
  }

  // ---------------------------------------------------------------- books added by hand

  /**
   * An added book's EPUB hashed in Calibre: kept in stage 1's file_facts as stage 1 would keep it
   * (path, size, mtime, SHA-256), so stage 1's pass reuses it instead of reading the file again.
   */
  private keepLibraryHash(
    libraryId: string,
    b: SnapshotBook,
    st: { size: number; mtimeMs: number },
    sha256: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO file_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
           calibre_last_modified, sha256, stat_at, hashed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
           file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
           calibre_last_modified = excluded.calibre_last_modified, sha256 = excluded.sha256,
           stat_at = excluded.stat_at, hashed_at = excluded.hashed_at, error = NULL`,
      )
      .run(
        libraryId,
        b.calibreId,
        b.uuid,
        b.filePath,
        st.size,
        st.mtimeMs,
        b.lastModified,
        sha256,
        now,
        now,
      );
  }

  /** The run's added books (Calibre id) and the catalog file each came from (by primary key). */
  private addedFiles(runId: number): Map<number, AddedFile> {
    const rows = this.db
      .prepare(
        `SELECT i.calibre_id, f.id, f.sha256, f.size, f.decided_at, f.facts_json FROM calibre_arrival_batch_items i
         JOIN calibre_arrival_batches b ON b.id = i.batch_id
         JOIN calibre_arrival_files f ON f.id = i.file_id
         WHERE b.run_id = ? AND b.kind = 'add' AND i.state = 'added' AND i.calibre_id IS NOT NULL
         ORDER BY f.id`,
      )
      .all(runId) as (AddedFile & { calibre_id: number })[];
    const m = new Map<number, AddedFile>();
    for (const r of rows) if (!m.has(r.calibre_id)) m.set(r.calibre_id, r);
    return m;
  }

  /** A book of the scope not among the run's add items (none expected): the catalog scanned. */
  private addedFileByScan(calibreId: number): AddedFile | undefined {
    return this.db
      .prepare(
        `SELECT id, sha256, size, decided_at, facts_json FROM calibre_arrival_files WHERE json_extract(facts_json, '$.addedAs.calibreId') = ?`,
      )
      .get(calibreId) as AddedFile | undefined;
  }

  private snapshotBooks(libraryId: string): Map<number, SnapshotBook> {
    return readSnapshotBooks(snapshotFile(this.deps.cacheDir, libraryId));
  }

  /**
   * The baseline (every book present before the first run) and the books added since: a book not
   * known is new (added by hand), unless an Undo brought it back.
   */
  private recordNewBooks(libraryId: string, now = Date.now()): void {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (!fs.existsSync(file)) return;
    const presence = readSnapshotPresence(file);
    // Manga part B: each library's own baseline (its first look), never another library's.
    const s = this.state(libraryId);
    const ins = this.db.prepare(
      `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(library_id, calibre_id) DO NOTHING`,
    );
    if (s.baseline_at === null) {
      this.db.transaction(() => {
        for (const [uuid, b] of presence) ins.run(libraryId, b.calibreId, uuid, 'baseline', now);
      })();
      this.setState({ baseline_at: now }, libraryId);
      return;
    }
    const known = new Set(
      (
        this.db
          .prepare('SELECT calibre_id FROM calibre_known_books WHERE library_id = ?')
          .all(libraryId) as { calibre_id: number }[]
      ).map((r) => r.calibre_id),
    );
    const restored = new Set(
      (
        this.db
          .prepare(
            `SELECT restored_uuid FROM undo_records WHERE library_id = ? AND restored_uuid IS NOT NULL`,
          )
          .all(libraryId) as { restored_uuid: string }[]
      ).map((r) => r.restored_uuid),
    );
    this.db.transaction(() => {
      for (const [uuid, b] of presence) {
        if (known.has(b.calibreId)) continue;
        ins.run(libraryId, b.calibreId, uuid, restored.has(uuid) ? 'undo' : 'hand', now);
      }
    })();
  }

  /** Books added by hand, unchanged in Calibre for the settle time, not in a run yet. */
  handSettled(libraryId: string, now = Date.now()): SnapshotBook[] {
    this.recordNewBooks(libraryId, now);
    const minutes = getSettings(this.db).arrivals.handCheckMinutes;
    const rows = this.db
      .prepare(
        `SELECT calibre_id, added_at FROM calibre_known_books INDEXED BY calibre_known_books_waiting
         WHERE library_id = ? AND origin = 'hand' AND run_id IS NULL`,
      )
      .all(libraryId) as { calibre_id: number; added_at: number }[];
    // Books a Preview run took in were only shown: the first On run takes them in again and
    // analyses them as they are then (a Preview's proposals are never written later).
    if (this.state(libraryId).mode === 'on')
      rows.push(
        ...(this.db
          .prepare(
            `SELECT k.calibre_id, k.added_at FROM calibre_known_books k INDEXED BY calibre_known_books_waiting
             JOIN calibre_arrival_runs r ON r.id = k.run_id
             WHERE k.library_id = ? AND k.origin = 'hand' AND k.run_id IS NOT NULL AND r.mode = 'analyse'`,
          )
          .all(libraryId) as { calibre_id: number; added_at: number }[]),
      );
    if (!rows.length) return [];
    const books = this.snapshotBooks(libraryId);
    return rows
      .filter((r) => now - r.added_at >= minutes * 60_000)
      .map((r) => books.get(r.calibre_id))
      .filter((b): b is SnapshotBook => {
        if (!b) return false;
        const lm = b.lastModified ? Date.parse(b.lastModified.replace(' ', 'T')) : NaN;
        return !Number.isFinite(lm) || now - lm >= minutes * 60_000;
      });
  }

  // ---------------------------------------------------------------- the step

  /** One unit of the current run. Returns 'more' (call again), 'wait' or 'idle'. Never throws. */
  async step(): Promise<'more' | 'wait' | 'idle'> {
    if (this.stepping) return 'wait';
    this.stepping = true;
    this.stopRequested = false;
    const shouldStop = () => this.stopRequested;
    let run = this.currentRun();
    // No run goes on while Off (a run started before Off was set is stopped here too).
    if (run && this.state(this.runLibrary(run)).mode === 'off') {
      this.finish(run.id, run.p, 'stopped', 'Stopped: new arrivals set Off');
      this.stepping = false;
      return 'idle';
    }
    try {
      if (!run) {
        let id: number | null = null;
        // A library whose Run now was pressed goes first (one run at a time across them).
        const libs = this.libraries();
        const asked = libs.filter((l) => this.state(l).run_now);
        for (const lib of [...asked, ...libs.filter((l) => !asked.includes(l))]) {
          id = this.maybeStart(lib);
          if (id !== null) break;
        }
        if (id === null) return 'idle';
        run = this.currentRun()!;
      }
      const p = run.p;
      const r = await this.phaseStep(run, p, shouldStop);
      this.save(run.id, p);
      return r;
    } catch (err) {
      if (run) {
        const p = run.p;
        const stop = err instanceof RunStop;
        const msg = (err as Error).message ?? String(err);
        this.finish(run.id, p, 'failed', msg);
        this.pause(stop ? (err as RunStop).reason : 'failed', msg, this.runLibrary(run));
      }
      this.log(`New arrivals: ${(err as Error).message}`);
      return 'idle';
    } finally {
      this.deps.diskLock.release(DISK_OWNER);
      this.stepping = false;
    }
  }

  private async withDisk<T>(
    p: RunProgress,
    fn: () => Promise<T>,
    shouldStop: () => boolean,
  ): Promise<T | null> {
    if (!this.deps.diskLock.tryAcquire(DISK_OWNER, 'calibre')) {
      const ok = await this.deps.diskLock.acquire(DISK_OWNER, 'calibre', shouldStop);
      if (!ok) return null;
    }
    try {
      return await fn();
    } finally {
      this.deps.diskLock.release(DISK_OWNER);
    }
  }

  private count(p: RunProgress, phase: RunPhase): PhaseCount {
    return (p.counts[phase] ??= { done: 0, total: 0 });
  }

  private async phaseStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'idle'> {
    const libraryId = p.libraryId ?? this.runLibrary(run);
    if (!libraryId || !this.deps.calibreDir)
      throw new RunStop('setup', 'The library to clean is not chosen');
    p.libraryId = libraryId;
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new RunStop('setup', 'The library is not in the reader any more');
    const libDir = path.join(this.deps.calibreDir, lib.folder);
    const settings = getSettings(this.db);
    const busy = this.deps.libraryBusy();
    if (busy && p.phase !== 'scan' && p.phase !== 'archives') {
      p.waiting = `Waiting for ${busy}`;
      p.waitingSince ??= Date.now();
      return 'wait';
    }
    if (p.waitingSince !== undefined) {
      // The wait is not this phase's work: its pace counts from as far on as the wait took.
      const waited = Date.now() - p.waitingSince;
      p.phaseStartedAt += waited;
      if (p.cmp) p.cmp.startedAt += waited;
      if (p.part) p.part.startedAt += waited;
      delete p.waitingSince;
    }
    // A stage set Off is not run for the arrivals either: the run waits for it (as the
    // audiobooks' stage 7 waits for its stages).
    const stageOf: Partial<Record<RunPhase, number>> = {
      stage1: 1,
      stage3: 3,
      stage2: 2,
      write2: 2,
      stage4: 4,
      ai: 4,
      write4: 4,
      stage5: 5,
      write5: 5,
    };
    const st = stageOf[p.phase];
    // A run without new books only writes what earlier runs held: a stage that is Off is passed.
    if (st !== undefined && this.emptyScope(p) && /^write/.test(p.phase)) {
      if (getStage(this.db, libraryId, st).mode === 'off') {
        this.next(run.id, p, NEXT_WRITE[p.phase as 'write2' | 'write4' | 'write5']);
        return 'more';
      }
    } else if (st !== undefined && getStage(this.db, libraryId, st).mode === 'off') {
      p.waiting = `Waiting: stage ${st} is Off (set it to Preview or On)`;
      return 'wait';
    }
    switch (p.phase) {
      case 'scan': {
        p.pairs = this.syncPairs(libraryId);
        if (this.importProblem() || !p.pairs.length) {
          this.next(run.id, p, 'identify');
          return 'more';
        }
        if (
          this.deps.requireReadOnlySources !== false &&
          this.deps.sourcesDir &&
          (await sourcesWritable(this.deps.sourcesDir))
        )
          throw new RunStop(
            'setup',
            'The source folders are mounted writable: mount them read-only',
          );
        const c = this.count(p, 'scan');
        c.total = p.pairs.length;
        for (const pair of p.pairs.slice(c.done)) {
          const root = insideSources(this.deps.sourcesDir!, pair.source) as string;
          if (!fs.existsSync(root)) {
            p.waiting = `The source folder ${pair.source} is missing`;
            c.done++;
            continue;
          }
          const t = await this.withDisk(
            p,
            () => walkSource(this.db, pair.key, root, { shouldStop }),
            shouldStop,
          );
          if (!t) return 'wait';
          c.done++;
          c.bytesTotal = (c.bytesTotal ?? 0) + t.bytes;
          this.log(
            `New arrivals: ${pair.source}: ${t.files} files, ${t.newVersions} new or changed`,
          );
        }
        this.next(run.id, p, 'archives');
        return 'more';
      }
      case 'archives': {
        const settleMs = settings.arrivals.settleMinutes * 60_000;
        const now = Date.now();
        if (p.phaseStartDone === 0) {
          this.archives.sync(
            p.pairs.map((x) => x.key),
            (r) => settled(r, now, settleMs),
          );
          p.phaseStartDone = 1;
        }
        const o = this.archives.open();
        const c = this.count(p, 'archives');
        c.total = Math.max(c.total, o.list + o.extract + c.done);
        if (o.list + o.extract === 0) {
          this.next(run.id, p, 'identify');
          return 'more';
        }
        if (!this.linkReady()) {
          p.waiting = 'Waiting for the linking sidecar (ttsu-cleanup-link) to unpack the archives';
          return 'wait';
        }
        p.waiting = `Unpacking archives: ${o.list} to list, ${o.extract} entries to unpack`;
        c.done = c.total - (o.list + o.extract);
        return 'wait';
      }
      case 'identify':
        return this.identifyStep(run, p, libraryId, shouldStop);
      case 'compare':
        return this.compareStep(run, p, libraryId, libDir, shouldStop);
      case 'plan': {
        this.planStep(run, p);
        // Preview adds nothing; the books added by hand are taken in at the index step.
        this.next(run.id, p, run.mode === 'on' ? 'add' : 'index');
        return 'more';
      }
      case 'add':
        return this.addStep(run, p, libraryId, shouldStop);
      case 'index':
        return this.indexStep(run, p, libraryId, libDir, shouldStop);
      case 'stage1': {
        const scope = this.scopeBooks(p, libraryId);
        if (!scope.length) {
          this.next(run.id, p, 'stage2');
          return 'more';
        }
        const books = this.snapshotBooks(libraryId);
        const res = await this.withDisk(
          p,
          () =>
            stage1Pass(
              this.passDeps(run.id, libraryId, libDir, p, STAGE1_PARTS),
              scope,
              books,
              shouldStop,
            ),
          shouldStop,
        );
        if (!res) return 'wait';
        this.addReviews(run.id, res.reviews);
        this.count(p, 'stage1').total = scope.length;
        this.count(p, 'stage1').done = scope.length;
        this.next(run.id, p, 'stage3');
        return 'more';
      }
      case 'stage3':
        return this.stage3Step(run, p, libraryId, libDir, shouldStop);
      case 'removals': {
        if (run.mode !== 'on') {
          this.next(run.id, p, 'stage2');
          return 'more';
        }
        const id = arrivalAnalysisId(run.id);
        this.writeCount(p, 'removals', [1, 3], libraryId, run.id);
        if (this.checksWait(p)) return 'wait';
        for (const stage of [1, 3] as const) {
          const r =
            stage === 1
              ? await this.deps.batches.planStage1(libraryId, shouldStop, id)
              : await this.deps.batches.planStage3(libraryId, shouldStop, id);
          if (r.batch) {
            (p.writes[`s${stage}`] ??= { batches: [], applied: 0, failed: 0 }).batches.push(
              r.batch.id,
            );
            p.waiting = `Removing copies (stage ${stage})`;
            return 'wait';
          }
          if (r.reason) {
            p.waiting = r.reason;
            return 'wait';
          }
        }
        if (this.deps.batches.open()) {
          p.waiting = 'A batch is being applied';
          return 'wait';
        }
        this.next(run.id, p, 'stage2');
        return 'more';
      }
      case 'stage2': {
        const uuids = this.scopeUuids(p, libraryId);
        const stage2 = this.deps.stage2(libraryId);
        if (stage2 && uuids.length) {
          const n = await this.withDisk(
            p,
            () =>
              stage2Pass(
                this.passDeps(run.id, libraryId, libDir, p, ['read']),
                stage2,
                uuids,
                shouldStop,
              ),
            shouldStop,
          );
          if (n === null) return 'wait';
          this.count(p, 'stage2').done = uuids.length;
          this.count(p, 'stage2').total = uuids.length;
        }
        this.next(run.id, p, 'write2');
        return 'more';
      }
      case 'write2':
        return this.writeStep(run, p, libraryId, 2, this.emptyScope(p) ? 'write4' : 'stage4');
      case 'stage4':
        return this.stage4Step(run, p, libraryId, shouldStop);
      case 'ai':
        return this.aiStep(run, p, libraryId, shouldStop);
      case 'write4':
        return this.writeStep(run, p, libraryId, 4, this.emptyScope(p) ? 'write5' : 'stage5');
      case 'stage5': {
        const uuids = this.stage4Uuids(p);
        const s5 = this.s5Of(libraryId);
        if (!s5 || !p.stage4 || !uuids.length) {
          this.next(run.id, p, 'write5');
          return 'more';
        }
        p.s5 ??= emptyStage5Pass();
        const r = await s5.step(p.stage4, p.s5, uuids, shouldStop);
        p.cost = (p.ai?.cost ?? 0) + (p.s5.cost ?? 0);
        const c5 = this.count(p, 'stage5');
        // Two questions a book while the models answer, then the books decided.
        c5.total = p.s5.phase === 'models' ? p.s5.keys.length * 2 : uuids.length;
        c5.done =
          p.s5.phase === 'models'
            ? p.s5.pending === undefined
              ? 0
              : Math.max(0, c5.total - p.s5.pending)
            : p.s5.decided;
        p.waiting = p.s5.wait;
        if (r === 'done') this.next(run.id, p, 'write5');
        return r === 'done' ? 'more' : r;
      }
      case 'write5':
        return this.writeStep(run, p, libraryId, 5, 'check');
      case 'check':
        return this.checkStep(run, p, libraryId);
      case 'move':
        return this.moveStep(run, p, libraryId, shouldStop);
      case 'report': {
        this.finish(run.id, p, 'done', null);
        return 'idle';
      }
      default:
        return 'idle';
    }
  }

  private passDeps(
    runId: number,
    libraryId: string,
    libDir: string,
    p?: RunProgress,
    parts: readonly string[] = [],
  ): PassDeps {
    return {
      progress: p
        ? (name, done, total) => this.passProgress(runId, p, parts, name, done, total)
        : undefined,
      cleanup: this.db,
      main: this.deps.main,
      libraryId,
      libDir,
      analysisId: arrivalAnalysisId(runId),
      carry: this.deps.carry
        ? (from: string, to: string) => this.deps.carry!(libraryId, from, to)
        : undefined,
    };
  }

  private compareDeps(
    libraryId: string,
    libDir: string,
    books?: Map<number, SnapshotBook>,
  ): CompareDeps {
    const b = books ?? this.snapshotBooks(libraryId);
    return {
      cleanup: this.db,
      cacheDir: this.deps.cacheDir,
      libraryId,
      libDir,
      reader: this.deps.reader(),
      books: b,
      log: this.log,
    };
  }

  // ---------------------------------------------------------------- identify

  private sourcePath(pairKey: string, rel: string): string {
    const root = this.rootOf(pairKey);
    if (!root || !this.deps.sourcesDir) throw new Error('The source folder is not known');
    return insideSources(insideSources(this.deps.sourcesDir, root) as string, rel) as string;
  }

  private async identifyStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'idle'> {
    const settings = getSettings(this.db);
    const settleMs = settings.arrivals.settleMinutes * 60_000;
    const keys = p.pairs.map((x) => x.key);
    const c = this.count(p, 'identify');
    if (!keys.length) {
      this.next(run.id, p, 'compare');
      return 'more';
    }
    const ph = keys.map(() => '?').join(', ');
    if (p.phaseStartDone === 0) {
      this.markRemovedByYou(libraryId);
      p.phaseStartDone = 1;
    }
    // Book formats and silent kinds first (no reading).
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE calibre_arrival_files SET outcome = 'not_imported', run_id = ?, decided_at = ?,
           detail = COALESCE(detail, 'Only EPUB is imported')
         WHERE pair_key IN (${ph}) AND kind = 'book' AND outcome = 'pending' AND gone_at IS NULL`,
      )
      .run(run.id, now, ...keys);
    this.db
      .prepare(
        `UPDATE calibre_arrival_files SET outcome = 'skipped', run_id = ?, decided_at = ?,
           detail = 'An archive: its EPUBs are unpacked into _extracted/'
         WHERE pair_key IN (${ph}) AND kind IN ('archive', 'volume') AND outcome = 'pending' AND gone_at IS NULL`,
      )
      .run(run.id, now, ...keys);
    // Files not settled yet wait, all at once (a folder's first look sees every file for the first
    // time: WP20g stop 2, 98,572 EPUBs): "seen for the first time" or "changed lately".
    if (p.phaseStartDone === 1) {
      this.db
        .prepare(
          `UPDATE calibre_arrival_files SET outcome = 'waiting', run_id = ?, decided_at = ?,
             detail = CASE WHEN mtime_ms > ? THEN 'Changed in the last minutes (waits to settle)'
               ELSE 'Seen for the first time (looked at once unchanged for the settle time)' END
           WHERE outcome = 'pending' AND pair_key IN (${ph}) AND kind = 'epub' AND gone_at IS NULL
             AND (first_seen_at > ? OR mtime_ms > ?)`,
        )
        .run(run.id, now, now - settleMs, ...keys, now - settleMs, now - settleMs);
      p.phaseStartDone = 2;
    }
    const pending = this.db
      .prepare(
        `SELECT id, pair_key, rel_path, size, mtime_ms, first_seen_at, archive_id, outcome FROM calibre_arrival_files
         INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN ('pending', 'waiting') AND pair_key IN (${ph}) AND kind = 'epub' AND gone_at IS NULL
           AND NOT (outcome = 'waiting' AND run_id IS ?)
         ORDER BY id LIMIT 50`,
      )
      .all(...keys, run.id) as {
      id: number;
      pair_key: string;
      rel_path: string;
      size: number;
      mtime_ms: number;
      first_seen_at: number;
      archive_id: number | null;
      outcome: string;
    }[];
    const todo = pending.filter((f) => settled(f, now, settleMs));
    // Files not settled stay 'waiting' (looked at again next run); none left to read: next.
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = ?, sha256 = COALESCE(?, sha256), hashed_at = COALESCE(?, hashed_at),
         detail = ?, facts_json = COALESCE(?, facts_json), run_id = ?, decided_at = ? WHERE id = ?`,
    );
    // Marked with this run, so the next slice reads the files after them.
    for (const f of pending)
      if (!todo.includes(f))
        set.run(
          'waiting',
          null,
          null,
          'Changed in the last minutes (waits to settle)',
          null,
          run.id,
          now,
          f.id,
        );
    if (!pending.length) {
      this.next(run.id, p, 'compare');
      return 'more';
    }
    // A slice with nothing settled: on to the next slice (they were marked with this run).
    if (!todo.length) return 'more';
    if (c.total === 0) {
      const t = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_arrival_files
           WHERE outcome = 'pending' AND pair_key IN (${ph}) AND kind = 'epub' AND gone_at IS NULL`,
        )
        .get(...keys) as { n: number };
      // Counted by files: the OPF is read, not the whole file.
      c.total = t.n;
    }
    const pacer = new SourcePacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    // Files you removed, by size: only a file of one of these sizes is hashed here (the rest
    // are hashed when the comparison or an add needs it; WP20g stop 2: hashing every file read
    // 988 GB for nothing).
    const removed = new Map<number, Set<string>>();
    for (const r of this.db
      .prepare(
        `SELECT size, sha256 FROM calibre_arrival_files WHERE outcome = 'removed_by_you' AND sha256 IS NOT NULL`,
      )
      .all() as { size: number; sha256: string }[])
      removed.set(r.size, (removed.get(r.size) ?? new Set()).add(r.sha256));
    const res = await this.withDisk(
      p,
      async () => {
        for (const f of todo) {
          if (shouldStop()) return false;
          const file = this.sourcePath(f.pair_key, f.rel_path);
          const st = await lstatSource(file);
          // An unpacked file's mtime is when the sidecar wrote it (its row settles with its archive).
          if (!st || st.size !== f.size || (f.archive_id === null && st.mtimeMs !== f.mtime_ms)) {
            set.run(
              'waiting',
              null,
              null,
              'Changed since it was seen',
              null,
              run.id,
              Date.now(),
              f.id,
            );
            continue;
          }
          let h: { sha256: string } | null = null;
          if (removed.has(f.size)) {
            h = await hashSource(file, pacer, shouldStop);
            if (!h) return false;
          }
          c.done++;
          if (h && removed.get(f.size)!.has(h.sha256)) {
            set.run(
              'removed_by_you',
              h.sha256,
              Date.now(),
              'You removed this book from Calibre',
              null,
              run.id,
              Date.now(),
              f.id,
            );
            continue;
          }
          let facts: {
            title: string | null;
            authors: string[];
            nameBytes: number;
            addTitle?: string;
            fit?: { step: string; rules: string[] };
          } | null = null;
          let problem: string | null = null;
          try {
            const meta = await readFileMetadata(file, { text: false, cover: false });
            const title = meta.title ?? path.posix.basename(f.rel_path, '.epub');
            const authors = (meta.creators ?? [])
              .filter((x: { role?: string | null }) => !x.role || x.role === 'aut')
              .map((x: { name: string }) => x.name);
            // The id is not known before the add: the longest one the library can reach soon (worst case).
            facts = {
              title,
              authors,
              nameBytes: calibreNameBytes(UNKNOWN_ID, title, authors[0] ?? 'Unknown'),
            };
            // Names Calibre's import would make too long for the disk (it would keep a record
            // without the file): the title the add gives instead, fitted (title-fit.ts). A title
            // that fits is added as the file has it (user, 2026-11-22).
            if (facts.nameBytes > NAME_MAX_BYTES) {
              const fit = fitTitle(title, {
                calibreId: UNKNOWN_ID,
                firstAuthor: authors[0] ?? 'Unknown',
                authors,
              });
              if (fit.step !== 'none' && fit.step !== 'author_too_long') {
                facts.addTitle = fit.title;
                facts.fit = { step: fit.step, rules: fit.rules };
                facts.nameBytes = fit.bytesAfter;
              }
            }
          } catch (err) {
            problem = `The reader can't open it: ${(err as Error).message}`.slice(0, 300);
          }
          if (problem || !facts) {
            set.run(
              'unreadable',
              h?.sha256 ?? null,
              h ? Date.now() : null,
              problem,
              null,
              run.id,
              Date.now(),
              f.id,
            );
            continue;
          }
          if (facts.fit && (facts.fit.step === 'shortened' || facts.fit.step === 'cut')) {
            this.db
              .prepare(
                `INSERT OR REPLACE INTO calibre_title_fits (arrival_file_id, library_id, stage, original,
                   written, step, rules_json, created_at, updated_at)
                 VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                f.id,
                this.pairLibrary(f.pair_key),
                facts.title ?? '',
                facts.addTitle,
                facts.fit.step,
                JSON.stringify(facts.fit.rules),
                Date.now(),
                Date.now(),
              );
          }
          if (facts.nameBytes > NAME_MAX_BYTES) {
            // Only a first author too long on its own is left (bad data): held, as before.
            set.run(
              'too_long',
              h?.sha256 ?? null,
              h ? Date.now() : null,
              "The first author is too long for a folder name in Calibre's library",
              JSON.stringify(facts),
              run.id,
              Date.now(),
              f.id,
            );
            this.addReview(run.id, `too_long:${f.id}`, 'too_long', f.id, null, null, {
              title: facts.title,
            });
            continue;
          }
          set.run(
            'pending',
            h?.sha256 ?? null,
            h ? Date.now() : null,
            null,
            JSON.stringify(facts),
            run.id,
            Date.now(),
            f.id,
          );
          // Read: handed to compare from here.
          this.db
            .prepare(`UPDATE calibre_arrival_files SET outcome = 'new' WHERE id = ?`)
            .run(f.id);
        }
        return true;
      },
      shouldStop,
    );
    if (res === null || res === false) return 'wait';
    await yieldNow();
    return 'more';
  }

  /**
   * Deleted on purpose stays deleted (decided 2026-11-17): a book the import added that is gone
   * from Calibre without the cleanup removing it (a stage-1/3 batch, an add's Undo) was removed
   * by you; its file (and any file with the same SHA-256) is never added again.
   */
  markRemovedByYou(libraryId: string): number {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (!fs.existsSync(file)) return 0;
    const presence = readSnapshotPresence(file);
    const present = new Set([...presence.values()].map((x) => x.calibreId));
    const rows = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome = 'added' AND (calibre_library_id = ? OR calibre_library_id IS NULL)`,
      )
      // Manga part B: the books added to this library only (another library's are not in its
      // snapshot and were never removed).
      .all(libraryId) as { id: number; calibre_id: number; calibre_uuid: string }[];
    const byCleanup = this.db.prepare(
      `SELECT 1 FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND field = 'book' AND state = 'applied' LIMIT 1`,
    );
    const undone = this.db.prepare(
      `SELECT 1 FROM calibre_arrival_batch_items i JOIN calibre_arrival_batches b ON b.id = i.batch_id
       WHERE b.kind = 'undo_add' AND i.calibre_uuid = ? AND i.state = 'removed' LIMIT 1`,
    );
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = ?, detail = ?, decided_at = ? WHERE id = ?`,
    );
    let n = 0;
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of rows) {
        if (present.has(r.calibre_id)) continue;
        if (byCleanup.get(libraryId, r.calibre_uuid)) continue;
        if (undone.get(r.calibre_uuid)) {
          set.run('undone', 'Taken out again by Undo (not added again by itself)', now, r.id);
          continue;
        }
        set.run(
          'removed_by_you',
          'You removed this book from Calibre: it is never added again',
          now,
          r.id,
        );
        n++;
      }
    })();
    return n;
  }

  // ---------------------------------------------------------------- compare

  /** A copy's quality facts for judgePair (new books from their file, library books stage 3's). */
  private qualityOf(
    cd: CompareDeps,
    news: Map<number, NewText>,
    qCache: Map<number, Quality | null>,
    srcPacer: SourcePacer,
  ): (k: number) => Promise<Quality | null> {
    return async (k: number) => {
      if (qCache.has(k)) return qCache.get(k)!;
      const n = news.get(k);
      const q = n
        ? await qualityOfFile(n.file, {
            calibreId: k,
            chars: n.chars,
            ruby: n.ruby,
            tocEntries: n.toc,
            customTags: 0,
            addedAt: Date.now(),
            pacer: srcPacer,
            cache: this.db,
          })
        : await libraryQuality(cd, k, srcPacer);
      qCache.set(k, q);
      return q;
    };
  }

  /**
   * The new EPUBs compared with the library, in slices that keep their results in the catalog
   * (facts_json), so a restart goes on where it stopped and the bar counts every book (WP20g
   * stop 2: 98,572 EPUBs, one uninterrupted call that counted nothing until its end). Stages:
   *   library    library books stages 1 and 3 never read (ensureLibraryFacts)
   *   identical  identical to a library EPUB (stage 1's hashes), then identical among themselves
   *   text       each new book's text and sketch (stage 3's reader), kept as facts.text
   *   pairs      the candidate index over every sketch; each pair kept with one of its new books
   *   measure    each new book's pairs measured and judged; verdicts kept with the new books
   *   decide     each new book's outcome from its verdicts
   */
  private async compareStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    libDir: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'idle'> {
    const keys = p.pairs.map((x) => x.key);
    if (!keys.length) {
      this.next(run.id, p, 'plan');
      return 'more';
    }
    const ph = keys.map(() => '?').join(', ');
    p.cmp ??= { stage: 'library', cursor: 0, startedAt: Date.now(), startDone: 0 };
    const cmp = p.cmp;
    const c = this.count(p, 'compare');
    // The bar's pace from this stage's start in this process (a restart begins a new pace).
    if (!this.cmpPaced) {
      cmp.startedAt = Date.now();
      cmp.startDone = c.done;
      this.cmpPaced = true;
    }
    const stage = (next: CompareStage, done: number, total: number) => {
      Object.assign(cmp, { stage: next, cursor: 0, startedAt: Date.now(), startDone: done });
      c.done = done;
      c.total = total;
    };
    const books = this.snapshotBooks(libraryId);
    const cd = this.compareDeps(libraryId, libDir, books);
    const pd = this.passDeps(run.id, libraryId, libDir);
    const settings = getSettings(this.db);
    const srcPacer = new SourcePacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    type Row = {
      id: number;
      pair_key: string;
      rel_path: string;
      size: number;
      sha256: string | null;
      facts_json: string | null;
    };
    const facts = (r: { facts_json: string | null }) =>
      (r.facts_json ? JSON.parse(r.facts_json) : {}) as CompareFacts;
    const setFacts = this.db.prepare(
      'UPDATE calibre_arrival_files SET facts_json = ? WHERE id = ?',
    );
    const rows = (where: string, limit: number, ...args: unknown[]) =>
      this.db
        .prepare(
          `SELECT id, pair_key, rel_path, size, sha256, facts_json FROM calibre_arrival_files
           INDEXED BY calibre_arrival_files_outcome
           WHERE outcome = 'new' AND pair_key IN (${ph}) AND gone_at IS NULL
             AND json_extract(facts_json, '$.compared') IS NULL ${where}
           ORDER BY id LIMIT ${limit}`,
        )
        .all(...keys, ...args) as Row[];
    const countNew = (where = '') =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
             WHERE outcome = 'new' AND pair_key IN (${ph}) AND gone_at IS NULL
             AND json_extract(facts_json, '$.compared') IS NULL ${where}`,
          )
          .get(...keys) as { n: number }
      ).n;
    const newText = (r: Row): NewText => {
      const t = facts(r).text!;
      return {
        key: -r.id,
        file: this.sourcePath(r.pair_key, r.rel_path),
        chars: t.chars,
        importChars: t.importChars,
        kind: t.kind,
        marker: t.marker,
        imageOnly: t.imageOnly,
        ruby: t.ruby,
        toc: t.toc,
        vertical: t.vertical,
        imageEntries: [],
        fileTitle: t.fileTitle,
        samples: t.samples,
        error: t.error,
      };
    };
    const slice = async <T>(fn: () => Promise<T>) => this.withDisk(p, fn, shouldStop);

    if (cmp.stage === 'library') {
      p.waiting = 'Reading library books stages 1 and 3 have not read yet';
      const ok = await slice(() => this.ensureLibraryFacts(cd, pd, books, srcPacer, shouldStop));
      if (ok === null || ok === false) return 'wait';
      stage('identical', 0, countNew());
      return 'more';
    }

    if (cmp.stage === 'identical') {
      const libPacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
      const set = this.db.prepare(
        `UPDATE calibre_arrival_files SET outcome = 'identical', detail = ?, calibre_id = ?, calibre_uuid = ?,
           decided_at = ? WHERE id = ?`,
      );
      const part = rows('AND id > ?', 200, cmp.cursor);
      // A file needs its SHA-256 only when a library EPUB or another new file has its size. The
      // new files' shared sizes are read once per run and process (one pass over the new files,
      // not one per file).
      if (this.sharedSizes?.run !== run.id)
        this.sharedSizes = {
          run: run.id,
          sizes: new Set(
            (
              this.db
                .prepare(
                  `SELECT size FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
                   WHERE outcome = 'new' AND pair_key IN (${ph}) AND gone_at IS NULL
                     AND json_extract(facts_json, '$.compared') IS NULL
                   GROUP BY size HAVING COUNT(*) > 1`,
                )
                .all(...keys) as { size: number }[]
            ).map((r) => r.size),
          ),
        };
      const shared = this.sharedSizes.sizes;
      const setSha = this.db.prepare(
        'UPDATE calibre_arrival_files SET sha256 = ?, hashed_at = ? WHERE id = ?',
      );
      if (!part.length) {
        // Identical among themselves: the first of each SHA-256 stays.
        const dupes = this.db
          .prepare(
            `SELECT id, sha256 FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
             WHERE outcome = 'new' AND pair_key IN (${ph}) AND gone_at IS NULL AND sha256 IS NOT NULL
             AND json_extract(facts_json, '$.compared') IS NULL ORDER BY id`,
          )
          .all(...keys) as { id: number; sha256: string }[];
        const first = new Map<string, number>();
        const now = Date.now();
        this.db.transaction(() => {
          for (const d of dupes) {
            const f = first.get(d.sha256);
            if (f === undefined) first.set(d.sha256, d.id);
            else set.run(`The same file as ${f} in this run`, null, null, now, d.id);
          }
        })();
        stage('text', countNew(`AND json_extract(facts_json, '$.text') IS NOT NULL`), countNew());
        return 'more';
      }
      p.waiting = 'Looking for identical copies in the library';
      const ok = await slice(async () => {
        for (const f of part) {
          if (shouldStop()) return false;
          const same = await libraryHashesOfSize(pd, books, f.size, libPacer, shouldStop);
          if (shouldStop()) return false;
          let sha = f.sha256;
          if (!sha && (same.length || shared.has(f.size))) {
            const file = this.sourcePath(f.pair_key, f.rel_path);
            const st = await lstatSource(file);
            const h =
              st && st.size === f.size ? await hashSource(file, srcPacer, shouldStop) : null;
            if (!h && shouldStop()) return false;
            if (h) {
              sha = h.sha256;
              setSha.run(sha, Date.now(), f.id);
            }
          }
          const hit = sha ? same.find((x) => x.sha256 === sha) : undefined;
          if (hit)
            set.run(
              `The same file as Calibre book ${hit.calibreId}`,
              hit.calibreId,
              books.get(hit.calibreId)!.uuid,
              Date.now(),
              f.id,
            );
          cmp.cursor = f.id;
          c.done++;
        }
        return true;
      });
      if (ok === null || ok === false) return 'wait';
      return 'more';
    }

    // Several books in flight across the reader processes, as stage 3 reads them (textWorkers ×
    // 2; WP20g stop 2: one at a time used one of six processes).
    const inFlight = Math.max(1, settings.duplicates.textWorkers) * 2;
    // No new book once the stream's time is up, another job waits for the disk, or the run stops.
    const streamEnd = Date.now() + STREAM_MS;
    const endStream = () =>
      shouldStop() ||
      Date.now() > streamEnd ||
      this.deps.diskLock.state().waiting.some((w) => w.owner !== DISK_OWNER);
    let savedAt = Date.now();
    const saveNow = () => {
      if (Date.now() - savedAt < PROGRESS_SAVE_MS) return;
      savedAt = Date.now();
      this.save(run.id, p);
    };

    if (cmp.stage === 'text') {
      const part = rows(`AND json_extract(facts_json, '$.text') IS NULL`, inFlight * 40);
      if (!part.length) {
        stage('pairs', 0, 0);
        return 'more';
      }
      // The library's lookup, once per run and process (a reader process reads it from the
      // file): each book is measured against its library candidates while its text is open.
      if (this.lookup?.run !== run.id) {
        p.waiting = 'Preparing the lookup of the library books';
        const file = path.join(cd.cacheDir, `arrivals-lookup-${libraryId}`);
        let built: { books: number } | null = null;
        try {
          built = await buildLibraryLookup(cd, file);
        } catch (err) {
          this.log?.(`new arrivals: no library lookup (${(err as Error).message})`);
        }
        this.lookup = { run: run.id, file: built ? file : null };
        return 'more';
      }
      const lookupFile = this.lookup.file;
      p.waiting = `Reading the new books and measuring them against the library (${c.done.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')})`;
      const qCache = new Map<number, Quality | null>();
      const ok = await slice(() =>
        inPool(part, inFlight, endStream, async (f) => {
          const old = facts(f);
          const t = await readNewText(
            cd,
            -f.id,
            this.sourcePath(f.pair_key, f.rel_path),
            [old.title ?? null],
            srcPacer,
            lookupFile ? { index: lookupFile, maxBooks: EARLY_MAX_BOOKS } : null,
          );
          old.text = {
            chars: t.chars,
            importChars: t.importChars,
            kind: t.kind,
            marker: t.marker,
            imageOnly: t.imageOnly,
            error: t.error,
            ruby: t.ruby,
            toc: t.toc,
            samples: t.samples,
            fileTitle: t.fileTitle,
            vertical: t.vertical,
            imageEntries: t.imageEntries.length,
          };
          if (t.early && !t.error) {
            // Judged as the measure stage judges a library pair (the same functions, the book
            // as the measure stage builds it from these facts).
            const own = newText({ ...f, facts_json: JSON.stringify(old) });
            const news = new Map<number, NewText>([[-f.id, own]]);
            const quality = this.qualityOf(cd, news, qCache, srcPacer);
            const verdicts: MeasuredPair[] = [];
            for (const m of t.early.pairs)
              verdicts.push(await judgePair(cd, -f.id, m.b, m, news, quality));
            old.early = { measured: t.early.pairs.map((m) => m.b), verdicts };
          }
          // Kept as each book is read (a restart reads only the books not kept yet).
          setFacts.run(JSON.stringify(old), f.id);
          c.done++;
          saveNow();
        }),
      );
      // false: the stream ended (its time, another job's turn at the disk, or a stop).
      if (ok === null || shouldStop()) return 'wait';
      return 'more';
    }

    if (cmp.stage === 'pairs') {
      p.waiting = 'Finding the library books with the same text';
      const all = rows('', 1_000_000);
      const news = all.map(newText);
      const pairs = await candidatePairsOf(cd, news);
      // Each pair kept with one new book (the first new key), measured once.
      const own = new Map<number, number[]>();
      for (const pr of pairs) {
        const owner = pr.a < 0 ? pr.a : pr.b;
        const other = owner === pr.a ? pr.b : pr.a;
        own.set(owner, [...(own.get(owner) ?? []), other]);
      }
      // A library pair measured while the book was read counts only when the whole index
      // proposes it (the lookup finds at least those, sometimes more); the rest is measured in
      // the measure stage as before. A book with every pair covered is measured already.
      this.db.transaction(() => {
        for (const r of all) {
          const fx = facts(r);
          const cands = own.get(-r.id) ?? [];
          const early = new Set(fx.early?.measured ?? []);
          const covered = cands.filter((o) => o > 0 && early.has(o));
          const inCovered = new Set(covered);
          fx.cands = cands;
          fx.covered = covered;
          fx.verdicts = (fx.early?.verdicts ?? []).filter((v) => inCovered.has(v.otherKey));
          if (cands.length > 0 && covered.length === cands.length) fx.measured = true;
          else delete fx.measured;
          setFacts.run(JSON.stringify(fx), r.id);
        }
      })();
      stage(
        'measure',
        0,
        countNew(
          `AND json_array_length(facts_json, '$.cands') > 0 AND json_extract(facts_json, '$.measured') IS NULL`,
        ),
      );
      return 'more';
    }

    if (cmp.stage === 'measure') {
      const byId = this.db.prepare(
        `SELECT id, pair_key, rel_path, size, sha256, facts_json FROM calibre_arrival_files WHERE id = ?`,
      );
      // Settled: a new book with a verdict that the other copy is as good or better. Its outcome
      // is a duplicate named by its first such verdict; later verdicts only come after it
      // (measure-plan.ts), so pairs between settled books, or of a settled book and a library
      // book, are not measured (WP20g, 2026-11-24: 27,240 of 101,644 pairs at the start).
      const settled = (key: number) => {
        if (key > 0) return false;
        const r = byId.get(-key) as Row | undefined;
        return !!r && (facts(r).verdicts ?? []).some((v) => v.keep === 'other');
      };
      // The plan over every owner still to measure (read in pages, the server answering between
      // them): owners grouped with the copies they share, so each file is read once per group.
      // Grouped over all of them, not a page: the copies of a book are often far apart in the
      // catalog (on the live run's 55,932 owners: 54 % of the readings against 72 % by pages).
      const owners: { owner: number; others: number[] }[] = [];
      const known = new Map<number, boolean>();
      const settledNow = (key: number) => {
        let v = known.get(key);
        if (v === undefined) known.set(key, (v = settled(key)));
        return v;
      };
      for (let after = 0; ; ) {
        const page = rows(
          `AND json_array_length(facts_json, '$.cands') > 0
             AND json_extract(facts_json, '$.measured') IS NULL AND id > ?`,
          2000,
          after,
        );
        if (!page.length) break;
        for (const f of page) {
          const fx = facts(f);
          const covered = new Set(fx.covered ?? []);
          const others = (fx.cands ?? []).filter((o) => !covered.has(o));
          owners.push({ owner: f.id, others: neededOthers(f.id, others, settledNow) });
        }
        after = page[page.length - 1].id;
        await yieldNow();
        if (shouldStop()) return 'wait';
      }
      if (!owners.length) {
        stage('decide', 0, countNew(`AND json_extract(facts_json, '$.compared') IS NULL`));
        return 'more';
      }
      p.waiting = `Measuring the pairs with the same text (${c.done.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')} books)`;
      const qCache = new Map<number, Quality | null>();
      const units = groupUnits(owners, BOOKS_PER_COMPARE);
      const ok = await slice(() =>
        inPool(units, inFlight, endStream, async (u) => {
          // Settled again now: other units finish meanwhile.
          const pairs0 = u.pairs.filter((pr) => !(settled(pr.a) && (pr.b > 0 || settled(pr.b))));
          const news = new Map<number, NewText>();
          for (const pr of pairs0)
            for (const k of [pr.a, pr.b])
              if (k < 0 && !news.has(k)) {
                const r = byId.get(-k) as Row | undefined;
                if (r && facts(r).text) news.set(k, newText(r));
              }
          const pairs = pairs0.filter((pr) => news.has(pr.a) && (pr.b > 0 || news.has(pr.b)));
          const measured = pairs.length ? await measurePairs(cd, news, pairs) : [];
          const quality = this.qualityOf(cd, news, qCache, srcPacer);
          const add = new Map<number, MeasuredPair[]>();
          for (const m of measured) {
            if (!m.m) continue;
            for (const k of [m.pair.a, m.pair.b].filter((x) => news.has(x))) {
              const other = k === m.pair.a ? m.pair.b : m.pair.a;
              add.set(k, [
                ...(add.get(k) ?? []),
                await judgePair(cd, k, other, m.m, news, quality),
              ]);
            }
          }
          // The verdicts and the owners' "measured" marks in one transaction: units finish out
          // of order, and a restart measures again only the owners not marked (never twice).
          this.db.transaction(() => {
            for (const [k, vs] of add) {
              const r = byId.get(-k) as Row;
              const fx = facts(r);
              fx.verdicts = [...(fx.verdicts ?? []), ...vs];
              setFacts.run(JSON.stringify(fx), r.id);
            }
            for (const id of u.owners) {
              const own = facts(byId.get(id) as Row);
              own.measured = true;
              setFacts.run(JSON.stringify(own), id);
            }
          })();
          c.done += u.owners.length;
          saveNow();
        }),
      );
      // false: the stream ended (its time, another job's turn at the disk, or a stop).
      if (ok === null || shouldStop()) return 'wait';
      return 'more';
    }

    // decide
    const part = rows(`AND json_extract(facts_json, '$.compared') IS NULL`, 500);
    if (!part.length) {
      // Manga part B: then against the other libraries (a run made before has none: run 7).
      if ((p.otherLibraries ?? []).length) {
        const r = await this.crossStep(run, p, keys, shouldStop);
        if (r !== 'done') return r;
      }
      p.cmp = undefined;
      this.next(run.id, p, 'plan');
      return 'more';
    }
    p.waiting = `Deciding each new book (${c.done.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')})`;
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = ?, detail = ?, calibre_id = ?, calibre_uuid = ?,
         facts_json = ?, decided_at = ?, run_id = ${run.id} WHERE id = ?`,
    );
    for (const f of part) {
      const fx = facts(f);
      const vs = fx.verdicts ?? [];
      fx.compared = true;
      const factsPlus = JSON.stringify(fx);
      const lostTo = vs.find((v) => v.keep === 'other');
      const tie = lostTo ? undefined : sameTextNoWinner(vs, f.id);
      const beat = vs.filter((v) => v.keep === 'new' && v.otherKey > 0);
      if (tie) {
        const isLib = tie.otherKey > 0;
        set.run(
          'duplicate',
          sameTextDetail(tie),
          isLib ? tie.otherKey : null,
          isLib ? (books.get(tie.otherKey)?.uuid ?? null) : null,
          factsPlus,
          Date.now(),
          f.id,
        );
      } else if (lostTo) {
        const isLib = lostTo.otherKey > 0;
        const b = isLib ? books.get(lostTo.otherKey) : null;
        set.run(
          'duplicate',
          isLib
            ? `The same text as Calibre book ${lostTo.otherKey}, which is as good or better (${lostTo.reason})`
            : `The same text as ${-lostTo.otherKey} in this run, which is better`,
          isLib ? lostTo.otherKey : null,
          b?.uuid ?? null,
          factsPlus,
          Date.now(),
          f.id,
        );
      } else if (beat.length && books.get(beat[0].otherKey)) {
        const target = beat[0];
        const b = books.get(target.otherKey)!;
        const pair = {
          aInB: target.aInB,
          bInA: target.bInA,
          cls: target.cls,
          rule: target.rule,
          reason: target.reason,
          best: target.best,
        };
        if (hasReaderData(pd, b.uuid)) {
          set.run(
            'better_review',
            `Better than Calibre book ${target.otherKey}, which has your reading data`,
            target.otherKey,
            b.uuid,
            factsPlus,
            Date.now(),
            f.id,
          );
          this.addReview(
            run.id,
            `better:${f.id}:${b.uuid}`,
            'better_copy',
            f.id,
            target.otherKey,
            b.uuid,
            {
              pair,
              title: b.title,
            },
          );
        } else {
          // The pair stays with the file: the run that adds it (maybe a later one) proposes
          // the older copy's removal from it.
          set.run(
            'better',
            `Better than Calibre book ${target.otherKey} (${target.reason}); added, then the older copy is removed`,
            target.otherKey,
            b.uuid,
            JSON.stringify({ ...fx, better: pair }),
            Date.now(),
            f.id,
          );
          p.betterOf[String(f.id)] = { calibreId: target.otherKey, uuid: b.uuid, pair };
        }
      } else {
        set.run('new', null, null, null, factsPlus, Date.now(), f.id);
      }
      c.done++;
    }
    await yieldNow();
    return 'more';
  }

  /**
   * Manga part B (answer 3 at stop 0): the files still new after their own library's check are
   * checked against each other library: identical files (stage 1's hashes of that library), then
   * the same text (that library's candidate index and stage 3's measure and best copy). A file
   * that is a copy of a book there is recorded (identical or duplicate), never added; a file
   * better than that library's copy goes to review (nothing is removed from one library because
   * of a book in another). Resumable: the part and the cursor are kept in the run.
   */
  private async crossStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    keys: string[],
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'done'> {
    const others = p.otherLibraries ?? [];
    p.cross ??= { at: 0, stage: 'library', cursor: 0 };
    const x = p.cross;
    const nextLibrary = () => {
      x.at++;
      x.stage = 'library';
      x.cursor = 0;
      delete x.pairs;
    };
    if (x.at >= others.length) return 'done';
    const lib = others[x.at];
    const row = getLibrary(this.deps.main, lib);
    if (!row || !this.deps.calibreDir || !fs.existsSync(snapshotFile(this.deps.cacheDir, lib))) {
      nextLibrary();
      return 'more';
    }
    const name = row.name || row.folder;
    const libDir = path.join(this.deps.calibreDir, row.folder);
    const books = this.snapshotBooks(lib);
    const cd = this.compareDeps(lib, libDir, books);
    const pd = this.passDeps(run.id, lib, libDir);
    const settings = getSettings(this.db);
    const srcPacer = new SourcePacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const ph = keys.map(() => '?').join(', ');
    type Row = {
      id: number;
      pair_key: string;
      rel_path: string;
      size: number;
      sha256: string | null;
      facts_json: string | null;
    };
    const facts = (r: { facts_json: string | null }) =>
      (r.facts_json ? JSON.parse(r.facts_json) : {}) as CompareFacts;
    // The files of this run's folders still new after their own check, not checked against lib.
    const still = (after: number, limit: number) =>
      (
        this.db
          .prepare(
            `SELECT id, pair_key, rel_path, size, sha256, facts_json FROM calibre_arrival_files
             INDEXED BY calibre_arrival_files_outcome
             WHERE outcome = 'new' AND pair_key IN (${ph}) AND gone_at IS NULL AND id > ?
               AND json_extract(facts_json, '$.compared') = 1
             ORDER BY id LIMIT ${limit}`,
          )
          .all(...keys, after) as Row[]
      ).filter((r) => !(facts(r).crossChecked ?? []).includes(lib));
    const setFacts = this.db.prepare(
      'UPDATE calibre_arrival_files SET facts_json = ? WHERE id = ?',
    );
    const slice = async <T>(fn: () => Promise<T>) => this.withDisk(p, fn, shouldStop);

    if (x.stage === 'library') {
      p.waiting = `Reading the books of ${name} that stages 1 and 3 have not read yet`;
      const ok = await slice(() => this.ensureLibraryFacts(cd, pd, books, srcPacer, shouldStop));
      if (ok === null || ok === false) return 'wait';
      x.stage = 'identical';
      x.cursor = 0;
      return 'more';
    }

    if (x.stage === 'identical') {
      const part = still(x.cursor, 200);
      if (!part.length) {
        x.stage = 'text';
        x.cursor = 0;
        return 'more';
      }
      p.waiting = `Looking for identical copies in ${name}`;
      const libPacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
      const set = this.db.prepare(
        `UPDATE calibre_arrival_files SET outcome = 'identical', detail = ?, calibre_id = ?,
           calibre_uuid = ?, calibre_library_id = ?, decided_at = ?, run_id = ? WHERE id = ?`,
      );
      const setSha = this.db.prepare(
        'UPDATE calibre_arrival_files SET sha256 = ?, hashed_at = ? WHERE id = ?',
      );
      const ok = await slice(async () => {
        for (const r of part) {
          if (shouldStop()) return false;
          const same = await libraryHashesOfSize(pd, books, r.size, libPacer, shouldStop);
          let sha = r.sha256;
          if (!sha && same.length) {
            const file = this.sourcePath(r.pair_key, r.rel_path);
            const st = await lstatSource(file);
            const h =
              st && st.size === r.size ? await hashSource(file, srcPacer, shouldStop) : null;
            if (!h && shouldStop()) return false;
            if (h) {
              sha = h.sha256;
              setSha.run(sha, Date.now(), r.id);
            }
          }
          const hit = sha ? same.find((s) => s.sha256 === sha) : undefined;
          if (hit)
            set.run(
              `The same file as ${name} book ${hit.calibreId}`,
              hit.calibreId,
              books.get(hit.calibreId)!.uuid,
              lib,
              Date.now(),
              run.id,
              r.id,
            );
          x.cursor = r.id;
        }
        return true;
      });
      if (ok === null || ok === false) return 'wait';
      return 'more';
    }

    const newText = (r: Row): NewText => {
      const t = facts(r).text!;
      return {
        key: -r.id,
        file: this.sourcePath(r.pair_key, r.rel_path),
        chars: t.chars,
        importChars: t.importChars,
        kind: t.kind,
        marker: t.marker,
        imageOnly: t.imageOnly,
        ruby: t.ruby,
        toc: t.toc,
        vertical: t.vertical,
        imageEntries: [],
        fileTitle: t.fileTitle,
        samples: t.samples,
        error: t.error,
      };
    };

    if (x.stage === 'text') {
      p.waiting = `Finding the books of ${name} with the same text`;
      const all = still(0, 1_000_000).filter((r) => facts(r).text && !facts(r).text!.error);
      const news = all.map(newText);
      // The new books' sketches are under the run's own library; the other library's index
      // compares them once they are under it too (dropped again when the run finishes).
      copyNewSketches(
        cd,
        p.libraryId ?? '',
        news.map((n) => n.key),
      );
      const pairs = news.length ? await candidatePairsOf(cd, news) : [];
      // Only a new book with a book of that library: two new books were compared already.
      x.pairs = pairs.filter((pr) => pr.a < 0 !== pr.b < 0);
      x.stage = 'measure';
      x.cursor = 0;
      return 'more';
    }

    if (x.stage === 'measure') {
      const pairs = x.pairs ?? [];
      if (x.cursor >= pairs.length) {
        x.stage = 'decide';
        x.cursor = 0;
        return 'more';
      }
      p.waiting = `Measuring the pairs with the same text in ${name} (${x.cursor} of ${pairs.length})`;
      const chunk = pairs.slice(x.cursor, x.cursor + 20);
      const byId = this.db.prepare(
        'SELECT id, pair_key, rel_path, size, sha256, facts_json FROM calibre_arrival_files WHERE id = ?',
      );
      const ok = await slice(async () => {
        const news = new Map<number, NewText>();
        for (const pr of chunk)
          for (const k of [pr.a, pr.b])
            if (k < 0 && !news.has(k)) {
              const r = byId.get(-k) as Row | undefined;
              if (r && facts(r).text) news.set(k, newText(r));
            }
        const measured = await measurePairs(
          cd,
          news,
          chunk.filter((pr) => news.has(pr.a < 0 ? pr.a : pr.b)),
        );
        const quality = this.qualityOf(cd, news, new Map(), srcPacer);
        const add = new Map<number, (MeasuredPair & { library: string })[]>();
        for (const m of measured) {
          if (!m.m) continue;
          const k = m.pair.a < 0 ? m.pair.a : m.pair.b;
          const other = k === m.pair.a ? m.pair.b : m.pair.a;
          const v = await judgePair(cd, k, other, m.m, news, quality);
          add.set(k, [...(add.get(k) ?? []), { ...v, library: lib }]);
        }
        this.db.transaction(() => {
          for (const [k, vs] of add) {
            const r = byId.get(-k) as Row;
            const fx = facts(r);
            fx.crossVerdicts = [...(fx.crossVerdicts ?? []), ...vs];
            setFacts.run(JSON.stringify(fx), r.id);
          }
        })();
        return true;
      });
      if (ok === null || ok === false) return 'wait';
      x.cursor += chunk.length;
      this.save(run.id, p);
      return 'more';
    }

    // decide: each file still new, by its verdicts against this library.
    const part = still(x.cursor, 500);
    if (!part.length) {
      nextLibrary();
      return 'more';
    }
    p.waiting = `Deciding each new book against ${name}`;
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = ?, detail = ?, calibre_id = ?, calibre_uuid = ?,
         calibre_library_id = ?, facts_json = ?, decided_at = ?, run_id = ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const r of part) {
        const fx = facts(r);
        const vs = (fx.crossVerdicts ?? []).filter((v) => v.library === lib);
        fx.crossChecked = [...(fx.crossChecked ?? []), lib];
        const json = JSON.stringify(fx);
        const lostTo = vs.find((v) => v.keep === 'other');
        const tie = lostTo ? undefined : sameTextNoWinner(vs, r.id);
        const beat = vs.find((v) => v.keep === 'new' && books.get(v.otherKey));
        const named = lostTo ?? tie;
        if (named && books.get(named.otherKey)) {
          set.run(
            'duplicate',
            lostTo
              ? `The same text as ${name} book ${lostTo.otherKey}, which is as good or better (${lostTo.reason})`
              : `The same text as ${name} book ${named.otherKey}; neither copy is better on every measure`,
            named.otherKey,
            books.get(named.otherKey)!.uuid,
            lib,
            json,
            Date.now(),
            run.id,
            r.id,
          );
        } else if (beat) {
          const b = books.get(beat.otherKey)!;
          set.run(
            'better_review',
            `Better than ${name} book ${beat.otherKey} (${beat.reason}): a copy in the other library is never replaced by itself`,
            beat.otherKey,
            b.uuid,
            lib,
            json,
            Date.now(),
            run.id,
            r.id,
          );
          this.addReview(
            run.id,
            `cross:${r.id}:${b.uuid}`,
            'cross_copy',
            r.id,
            beat.otherKey,
            b.uuid,
            {
              pair: {
                aInB: beat.aInB,
                bInA: beat.bInA,
                cls: beat.cls,
                rule: beat.rule,
                reason: beat.reason,
                best: beat.best,
              },
              title: b.title,
              library: lib,
              libraryName: name,
            },
            lib,
          );
        } else setFacts.run(json, r.id);
        x.cursor = r.id;
      }
    })();
    return 'more';
  }

  /**
   * The library's books without stage 1's file facts or stage 3's text facts (books added since
   * those stages' analyses) are stated and read now, so a new file is compared with every book.
   * At most 2,000 a run (the rest the next run); false when stopped.
   */
  private async ensureLibraryFacts(
    cd: CompareDeps,
    pd: PassDeps,
    books: Map<number, SnapshotBook>,
    pacer: SourcePacer,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    const has = (table: string) =>
      new Set(
        (
          this.db
            .prepare(`SELECT calibre_id FROM ${table} WHERE library_id = ?`)
            .all(pd.libraryId) as { calibre_id: number }[]
        ).map((r) => r.calibre_id),
      );
    const facts = has('file_facts');
    const noFacts = [...books.values()].filter((b) => !facts.has(b.calibreId)).slice(0, 2000);
    if (noFacts.length) await statBooks(pd, noFacts);
    const text = has('text_facts');
    const noText = [...books.values()].filter((b) => !text.has(b.calibreId)).slice(0, 2000);
    for (const b of noText) {
      if (shouldStop()) return false;
      const file = resolveInside(pd.libDir, b.filePath) as string;
      const st = await statFile(file);
      if (!st) continue;
      const t = await readNewText(cd, b.calibreId, file, [b.title], pacer);
      saveLibraryText(
        cd,
        {
          calibreId: b.calibreId,
          uuid: b.uuid,
          filePath: b.filePath,
          lastModified: b.lastModified,
        },
        st,
        this.deps.counterBuild,
        t,
      );
    }
    return true;
  }

  // ---------------------------------------------------------------- plan, add, index

  private planStep(run: RunRow & { p: RunProgress }, p: RunProgress): void {
    const now = Date.now();
    this.reapplySameText(
      run.id,
      p.pairs.map((x) => x.key),
      p.libraryId,
    );
    for (const pair of p.pairs) {
      // A folder's first run (its Preview) is done once every file in it was looked at; from
      // then on it stays done (files a later download leaves waiting don't undo it). Runs that
      // start after that add from the folder when the card is On (WP20g stop 2: the first look
      // marked 98,572 EPUBs as waiting; "Add these" removed by the user, On is the go-ahead).
      const row = this.db
        .prepare('SELECT first_done_at FROM calibre_arrival_pairs WHERE pair_key = ?')
        .get(pair.key) as { first_done_at: number | null } | undefined;
      if (row?.first_done_at != null) continue;
      if (this.waitingFiles(pair.key) > 0) {
        this.db
          .prepare(
            'UPDATE calibre_arrival_pairs SET first_run_id = COALESCE(first_run_id, ?) WHERE pair_key = ?',
          )
          .run(run.id, pair.key);
        continue;
      }
      this.db
        .prepare(
          `UPDATE calibre_arrival_pairs SET first_run_id = COALESCE(first_run_id, ?), first_done_at = ?
           WHERE pair_key = ?`,
        )
        .run(run.id, now, pair.key);
    }
  }

  /** A folder's books and archives not looked at yet (waiting to settle, or not read yet). */
  waitingFiles(pairKey: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
           WHERE outcome IN ('pending', 'waiting') AND pair_key = ? AND gone_at IS NULL
             AND kind IN ('epub', 'archive', 'volume')`,
        )
        .get(pairKey) as { n: number }
    ).n;
  }

  /**
   * Whether some file of a folder set up now, waiting to settle, has settled (a follow-up run
   * looks at it; a folder no longer set up never starts one).
   */
  private settledWaiting(libraryId: string, now: number): boolean {
    const a = getSettings(this.db).arrivals;
    const keys = a.pairs.filter((x) => x.libraryId === libraryId).map((x) => `${x.id}|${x.source}`);
    if (!keys.length) return false;
    const settleMs = a.settleMinutes * 60_000;
    return !!this.db
      .prepare(
        `SELECT 1 FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN ('pending', 'waiting') AND pair_key IN (${keys.map(() => '?').join(', ')})
           AND gone_at IS NULL AND kind IN ('epub', 'archive', 'volume')
           AND first_seen_at <= ? AND mtime_ms <= ? LIMIT 1`,
      )
      .get(...keys, now - settleMs, now - settleMs);
  }

  /**
   * The files a run adds: new and better copies of folders whose first run (a Preview) finished
   * before this run started; a folder's first run never adds, whatever the mode.
   */
  private filesToAdd(run: RunRow & { p: RunProgress }, p: RunProgress): number[] {
    const ready = p.pairs
      .map((x) => x.key)
      .filter((k) => {
        const r = this.db
          .prepare('SELECT first_done_at FROM calibre_arrival_pairs WHERE pair_key = ?')
          .get(k) as { first_done_at: number | null } | undefined;
        return r?.first_done_at != null && r.first_done_at < run.started_at;
      });
    if (!ready.length) return [];
    const ph = ready.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT id FROM calibre_arrival_files WHERE outcome IN ('new', 'better') AND pair_key IN (${ph})
             AND gone_at IS NULL AND json_extract(facts_json, '$.compared') IS NOT NULL AND id NOT IN (SELECT file_id FROM calibre_arrival_batch_items i
               JOIN calibre_arrival_batches b ON b.id = i.batch_id WHERE b.kind = 'add' AND i.state <> 'failed')
           ORDER BY id`,
        )
        .all(...ready) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Why a write (an add, a removal, a field write) must wait: the safety checks. */
  private checksWait(p: RunProgress): boolean {
    const c = this.deps.checksPass?.(p.libraryId ?? this.deps.targetLibrary() ?? '');
    if (c && !c.ok) {
      p.waiting = `Waiting for the safety checks: ${c.failing.join('; ')}`;
      return true;
    }
    return false;
  }

  private async addStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const c = this.count(p, 'add');
    if (c.total === 0 && this.checksWait(p)) return 'wait';
    if (c.total === 0 && !this.addBatches.busy(run.id)) {
      let ids = this.filesToAdd(run, p);
      if (!ids.length) {
        this.next(run.id, p, 'index');
        return 'more';
      }
      // A book is hashed when it is added (the sidecar checks the copy it is sent against it,
      // and the check step the library's copy), in slices under the disk lock.
      const unhashed = this.db
        .prepare(
          `SELECT id, pair_key, rel_path, size, mtime_ms, archive_id FROM calibre_arrival_files
           WHERE id IN (SELECT value FROM json_each(?)) AND sha256 IS NULL ORDER BY id LIMIT 50`,
        )
        .all(JSON.stringify(ids)) as {
        id: number;
        pair_key: string;
        rel_path: string;
        size: number;
        mtime_ms: number;
        archive_id: number | null;
      }[];
      if (unhashed.length) {
        p.waiting = 'Reading the books to add';
        const pacer = new SourcePacer(getSettings(this.db).pacing.readMbPerSecond * 1024 * 1024);
        const setSha = this.db.prepare(
          'UPDATE calibre_arrival_files SET sha256 = ?, hashed_at = ? WHERE id = ?',
        );
        const changed = this.db.prepare(
          `UPDATE calibre_arrival_files SET outcome = 'waiting', detail = 'Changed since it was seen',
             run_id = ?, decided_at = ? WHERE id = ?`,
        );
        const ok = await this.withDisk(
          p,
          async () => {
            for (const f of unhashed) {
              if (shouldStop()) return false;
              const file = this.sourcePath(f.pair_key, f.rel_path);
              const st = await lstatSource(file);
              // As identify: an unpacked file's mtime is when the sidecar wrote it.
              if (
                !st ||
                st.size !== f.size ||
                (f.archive_id === null && st.mtimeMs !== f.mtime_ms)
              ) {
                // Looked at again (identify, compare) by the next run.
                changed.run(run.id, Date.now(), f.id);
                continue;
              }
              const h = await hashSource(file, pacer, shouldStop);
              if (!h) return false;
              setSha.run(h.sha256, Date.now(), f.id);
            }
            return true;
          },
          shouldStop,
        );
        if (ok === null || ok === false) return 'wait';
        return 'more';
      }
      ids = this.filesToAdd(run, p);
      if (!ids.length) {
        this.next(run.id, p, 'index');
        return 'more';
      }
      this.addBatches.planAdds(run.id, libraryId, ids);
      c.total = ids.length;
    }
    const counts = this.addBatches.counts(run.id);
    c.done = (counts.added ?? 0) + (counts.failed ?? 0);
    if (this.addBatches.busy(run.id)) {
      p.waiting = 'Adding books to Calibre (the apply sidecar)';
      return 'wait';
    }
    // Every item ended: the catalog takes the results.
    const rows = this.db
      .prepare(
        `SELECT i.file_id, i.state, i.calibre_id, i.calibre_uuid, i.detail FROM calibre_arrival_batch_items i
         JOIN calibre_arrival_batches b ON b.id = i.batch_id WHERE b.run_id = ? AND b.kind = 'add'`,
      )
      .all(run.id) as {
      file_id: number;
      state: string;
      calibre_id: number | null;
      calibre_uuid: string | null;
      detail: string | null;
    }[];
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.state === 'added' && r.calibre_id !== null && r.calibre_uuid) {
          this.db
            .prepare(
              `UPDATE calibre_arrival_files SET outcome = CASE WHEN outcome = 'better' THEN 'better' ELSE 'added' END,
                 calibre_id = CASE WHEN outcome = 'better' THEN calibre_id ELSE ? END,
                 calibre_uuid = CASE WHEN outcome = 'better' THEN calibre_uuid ELSE ? END,
                 facts_json = json_set(COALESCE(facts_json, '{}'), '$.addedAs', json(?)), decided_at = ? WHERE id = ?`,
            )
            .run(
              r.calibre_id,
              r.calibre_uuid,
              JSON.stringify({ calibreId: r.calibre_id, uuid: r.calibre_uuid }),
              now,
              r.file_id,
            );
          this.db
            .prepare(
              `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, file_id, added_at, run_id)
               VALUES (?, ?, ?, 'import', ?, ?, ?)
               ON CONFLICT(library_id, calibre_id) DO UPDATE SET origin = 'import', file_id = excluded.file_id,
                 run_id = excluded.run_id`,
            )
            .run(libraryId, r.calibre_id, r.calibre_uuid, r.file_id, now, run.id);
          p.scope.import.push(r.calibre_id);
        } else if (r.state === 'failed') {
          this.addReview(run.id, `add_failed:${r.file_id}`, 'add_failed', r.file_id, null, null, {
            detail: r.detail,
          });
        }
      }
    })();
    this.deps.wantIngest(libraryId);
    this.next(run.id, p, 'index');
    return 'more';
  }

  private async indexStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    libDir: string,
    shouldStop: () => boolean = () => false,
  ): Promise<'more' | 'wait'> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (p.scope.import.length && !p.indexSeen) {
      const presence = fs.existsSync(file) ? readSnapshotPresence(file) : new Map();
      const ids = new Set([...presence.values()].map((x: { calibreId: number }) => x.calibreId));
      const missing = p.scope.import.filter((id) => !ids.has(id));
      if (missing.length) {
        this.deps.wantIngest(libraryId);
        p.waiting = `Waiting for the reader's library index to show the ${missing.length} added books`;
        return 'wait';
      }
      p.indexSeen = true;
    }
    // The added books: each one's EPUB checked against the file it came from, and its text facts
    // carried over (stage 3 compares later arrivals with it). In slices with a bar; a book already
    // checked (inCalibre, written in the same synchronous step as its text) is not read again.
    // Each book's catalog file comes from the run's own add items (WP20g run 7: a lookup per book
    // scanned the whole catalog, 1.85 s each at 194,351 rows, the server blocked meanwhile).
    const added = this.addedFiles(run.id);
    const books = this.snapshotBooks(libraryId);
    const cd = this.compareDeps(libraryId, libDir, books);
    const settings = getSettings(this.db);
    const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const c = this.count(p, 'index');
    c.total = p.scope.import.length;
    c.done = 0;
    const sliceEnd = Date.now() + 30_000;
    let open = 0;
    for (const id of p.scope.import) {
      const f = added.get(id) ?? this.addedFileByScan(id);
      if (!f) {
        c.done++;
        continue;
      }
      const facts = f.facts_json ? JSON.parse(f.facts_json) : {};
      const b = books.get(id);
      const checked = facts.inCalibre as
        | { sameBytes: boolean; sha256: string | null; mtimeMs?: number | null }
        | undefined;
      // Checked before its hash was kept for stage 1 (run 7, before this change): kept now when the
      // file has not changed since the add phase ended (every check came after that).
      if (checked && (checked.mtimeMs !== undefined || !checked.sha256 || !b)) {
        c.done++;
        continue;
      }
      if (!b) {
        c.done++;
        continue;
      }
      if (Date.now() > sliceEnd || shouldStop()) {
        open++;
        continue;
      }
      const epub = resolveInside(libDir, b.filePath);
      if (checked) {
        const st = await statFile(epub);
        const kept = !!st && st.size === f.size && st.mtimeMs <= f.decided_at;
        if (kept) this.keepLibraryHash(libraryId, b, st, checked.sha256!);
        this.db
          .prepare(
            `UPDATE calibre_arrival_files SET facts_json = json_set(facts_json, '$.inCalibre.mtimeMs', ?) WHERE id = ?`,
          )
          .run(kept ? st.mtimeMs : null, f.id);
        c.done++;
        continue;
      }
      const st = await statFile(epub);
      const h = st ? await hashSourceFile(epub, pacer) : null;
      const after = h ? await statFile(epub) : null;
      // The hash is kept for stage 1 (its file_facts) only when the file did not change while read:
      // stage 1 then never reads the added books again (WP20g run 7: 430 GB, about 3 hours).
      const stable = !!st && !!after && after.size === st.size && after.mtimeMs === st.mtimeMs;
      const same = !!h && h.sha256 === f.sha256;
      if (stable && h) this.keepLibraryHash(libraryId, b, st, h.sha256);
      this.db
        .prepare(
          `UPDATE calibre_arrival_files SET facts_json = json_set(COALESCE(facts_json, '{}'), '$.inCalibre', json(?)) WHERE id = ?`,
        )
        .run(
          JSON.stringify({
            sameBytes: same,
            sha256: h?.sha256 ?? null,
            mtimeMs: stable ? st.mtimeMs : null,
          }),
          f.id,
        );
      if (st && facts.text) {
        saveLibraryText(
          cd,
          { calibreId: id, uuid: b.uuid, filePath: b.filePath, lastModified: b.lastModified },
          st,
          this.deps.counterBuild,
          {
            ...facts.text,
            key: -f.id,
            file: epub,
            imageEntries: [],
            error: facts.text.error ?? null,
          } as NewText,
          -f.id,
        );
      }
      c.done++;
    }
    if (open) {
      p.waiting = `Checking the added books in Calibre: ${c.done.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')}`;
      this.save(run.id, p);
      return 'more';
    }
    // The added files' sketches now live under their Calibre ids.
    dropNewSketches(
      cd,
      p.scope.import.flatMap((id) => {
        const f = added.get(id) ?? this.addedFileByScan(id);
        return f ? [-f.id] : [];
      }),
    );
    // The books added by hand, settled: in this run's scope.
    const hand = this.handSettled(libraryId);
    const now = Date.now();
    for (const b of hand) {
      this.db
        .prepare(
          'UPDATE calibre_known_books SET run_id = ?, settled_at = ? WHERE library_id = ? AND calibre_id = ?',
        )
        .run(run.id, now, libraryId, b.calibreId);
      p.scope.hand.push(b.calibreId);
    }
    const ins = this.db.prepare(
      `INSERT INTO calibre_arrival_books (run_id, library_id, calibre_id, calibre_uuid, origin, file_id)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, library_id, calibre_id) DO NOTHING`,
    );
    for (const id of p.scope.import) {
      const b = books.get(id);
      if (b) ins.run(run.id, libraryId, id, b.uuid, 'import', null);
    }
    for (const b of hand) ins.run(run.id, libraryId, b.calibreId, b.uuid, 'hand', null);
    // No new book in Calibre: stages 1-5 have nothing to do (and nothing waits for them); an On
    // run still writes the changes earlier runs held (a field paused by its gate, resumed since).
    this.next(
      run.id,
      p,
      !this.emptyScope(p)
        ? 'stage1'
        : run.mode === 'on' &&
            [2, 4, 5].some((st) => this.heldAnalyses(st, libraryId, run.id).length)
          ? 'write2'
          : 'check',
    );
    return 'more';
  }

  private scopeBooks(p: RunProgress, libraryId: string): SnapshotBook[] {
    const books = this.snapshotBooks(libraryId);
    return [...p.scope.import, ...p.scope.hand]
      .map((id) => books.get(id))
      .filter((b): b is SnapshotBook => !!b);
  }

  private scopeUuids(p: RunProgress, libraryId: string): string[] {
    return this.scopeBooks(p, libraryId).map((b) => b.uuid);
  }

  // ---------------------------------------------------------------- stage 3

  private async stage3Step(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    libDir: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const books = this.snapshotBooks(libraryId);
    const pd = this.passDeps(run.id, libraryId, libDir);
    const facts = (id: number) =>
      this.db
        .prepare(
          'SELECT size, mtime_ms, sha256 FROM file_facts WHERE library_id = ? AND calibre_id = ?',
        )
        .get(libraryId, id) as
        | { size: number; mtime_ms: number; sha256: string | null }
        | undefined;
    const withFile = async (b: SnapshotBook) => {
      await statBooks(pd, [b]);
      let f = facts(b.calibreId);
      if (f && !f.sha256) {
        await libraryHashesOfSize(pd, books, f.size, new Pacer(0), shouldStop);
        f = facts(b.calibreId);
      }
      return f?.sha256 ? { ...b, sha256: f.sha256, size: f.size, mtimeMs: f.mtime_ms } : null;
    };
    // The copies stage 1 removes in this run are not stage 3's books, as in the cleanup's own
    // order (stage 3 analyses the library after stage 1's removals): proposing them again would
    // find them gone at the removal and pause stage 3.
    const goneBy1 = new Set(
      (
        this.db
          .prepare(
            `SELECT calibre_id FROM proposed_changes
             WHERE stage = 1 AND library_id = ? AND analysis_id = ? AND class = 'auto' AND field = 'book'
               AND state IN ('proposed', 'queued', 'applied')`,
          )
          .all(libraryId, pd.analysisId) as { calibre_id: number }[]
      ).map((r) => r.calibre_id),
    );
    const ok = await this.withDisk(
      p,
      async () => {
        // The better imports: the older library copy goes (it has no reader data: checked again).
        // The better copies this run added (compared in this run or an earlier Preview).
        const added = new Set(p.scope.import);
        const better = (
          this.db
            .prepare(
              `SELECT id, calibre_id, calibre_uuid, facts_json FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
               WHERE outcome = 'better' AND gone_at IS NULL`,
            )
            .all() as {
            id: number;
            calibre_id: number;
            calibre_uuid: string;
            facts_json: string | null;
          }[]
        ).filter((r) => {
          const f = r.facts_json ? JSON.parse(r.facts_json) : {};
          return f.addedAs && added.has(f.addedAs.calibreId);
        });
        for (const r of better)
          p.betterOf[String(r.id)] = {
            calibreId: r.calibre_id,
            uuid: r.calibre_uuid,
            pair: (JSON.parse(r.facts_json!).better ?? {}) as Record<string, unknown>,
          };
        for (const [fileId, x] of Object.entries(p.betterOf)) {
          const row = this.db
            .prepare('SELECT facts_json FROM calibre_arrival_files WHERE id = ?')
            .get(Number(fileId)) as {
            facts_json: string | null;
          };
          const added = row?.facts_json ? JSON.parse(row.facts_json).addedAs : null;
          const kept = added ? books.get(added.calibreId) : null;
          const old = books.get(x.calibreId);
          if (!kept || !old || old.uuid !== x.uuid) continue;
          if (goneBy1.has(old.calibreId) || goneBy1.has(kept.calibreId)) continue;
          if (hasReaderData(pd, old.uuid)) {
            this.addReview(
              run.id,
              `better:${fileId}:${old.uuid}`,
              'better_copy',
              Number(fileId),
              old.calibreId,
              old.uuid,
              { pair: x.pair, title: old.title },
            );
            continue;
          }
          const a = await withFile(old);
          const k = await withFile(kept);
          if (a && k) proposeStage3Removal(pd, a, k, x.pair);
        }
        // Books added by hand: compared with the library as stage 3 compares every book.
        const hand = p.scope.hand
          .filter((id) => !goneBy1.has(id))
          .map((id) => books.get(id))
          .filter((b): b is SnapshotBook => !!b);
        if (!hand.length) return true;
        const cd = this.compareDeps(libraryId, libDir, books);
        const pacer = new SourcePacer(getSettings(this.db).pacing.readMbPerSecond * 1024 * 1024);
        const news = new Map<number, NewText>();
        for (const b of hand) {
          if (shouldStop()) return false;
          const file = resolveInside(libDir, b.filePath) as string;
          const t = await readNewText(cd, b.calibreId, file, [b.title], pacer);
          news.set(b.calibreId, t);
          const st = await statFile(file);
          if (st)
            saveLibraryText(
              cd,
              {
                calibreId: b.calibreId,
                uuid: b.uuid,
                filePath: b.filePath,
                lastModified: b.lastModified,
              },
              st,
              this.deps.counterBuild,
              t,
            );
        }
        const pairs = await candidatePairsOf(cd, [...news.values()]);
        const measured = await measurePairs(cd, news, pairs);
        const quality = async (k: number) => libraryQuality(cd, k, pacer);
        // A pair you or the review already decided in stage 3 stays as decided (stage 3's own
        // waiting list leaves it out the same way; WP20g stop 1: 4 of 16 pairs).
        // Two primary-key lookups (an OR here scanned every decision: lessons 3).
        const decision = this.db.prepare(
          'SELECT 1 FROM pair_decisions WHERE library_id = ? AND a_uuid = ? AND b_uuid = ?',
        );
        for (const m of measured) {
          if (!m.m) continue;
          const k = news.has(m.pair.a) ? m.pair.a : m.pair.b;
          const other = k === m.pair.a ? m.pair.b : m.pair.a;
          const ua = books.get(k)?.uuid;
          const ub = books.get(other)?.uuid;
          if (ua && ub && (decision.get(libraryId, ua, ub) || decision.get(libraryId, ub, ua)))
            continue;
          const v = await judgePair(cd, k, other, m.m, news, quality);
          if (v.keep === null || goneBy1.has(other)) continue;
          const removed = books.get(v.keep === 'new' ? other : k);
          const kept = books.get(v.keep === 'new' ? k : other);
          if (!removed || !kept) continue;
          const pair = {
            aInB: v.aInB,
            bInA: v.bInA,
            cls: v.cls,
            rule: v.rule,
            reason: v.reason,
            best: v.best,
          };
          // A new copy never takes the place of a library book with reader data: review.
          if (v.keep === 'new' && !news.has(removed.calibreId) && hasReaderData(pd, removed.uuid)) {
            this.addReview(
              run.id,
              `better:${kept.uuid}:${removed.uuid}`,
              'better_copy',
              null,
              removed.calibreId,
              removed.uuid,
              { pair, newId: kept.calibreId, title: removed.title },
            );
            continue;
          }
          const a = await withFile(removed);
          const kk = await withFile(kept);
          if (a && kk) proposeStage3Removal(pd, a, kk, pair);
        }
        // Manga part B (answer 3): the same books against the other libraries, review only.
        for (const other of p.otherLibraries ?? []) {
          if (shouldStop()) return false;
          await this.crossHand(run.id, libraryId, other, hand, news, pacer, shouldStop);
        }
        return true;
      },
      shouldStop,
    );
    if (ok === null || ok === false) return 'wait';
    this.next(run.id, p, 'removals');
    return 'more';
  }

  /**
   * Manga part B (answer 3 at stop 0): books added by hand to this library, checked against
   * another library: the same file (stage 1's hashes there) or the same text (that library's
   * candidate index, stage 3's measure and rules). A match is a 'cross_copy' review item, never a
   * removal (nothing leaves one library because of a book in another).
   */
  private async crossHand(
    runId: number,
    libraryId: string,
    other: string,
    hand: SnapshotBook[],
    own: Map<number, NewText>,
    pacer: SourcePacer,
    shouldStop: () => boolean,
  ): Promise<void> {
    const row = getLibrary(this.deps.main, other);
    if (!row || !this.deps.calibreDir || !fs.existsSync(snapshotFile(this.deps.cacheDir, other)))
      return;
    const name = row.name || row.folder;
    const libDir = path.join(this.deps.calibreDir, row.folder);
    const ownDir = path.join(this.deps.calibreDir, getLibrary(this.deps.main, libraryId)!.folder);
    const books = this.snapshotBooks(other);
    const cd = this.compareDeps(other, libDir, books);
    const pd = this.passDeps(runId, other, libDir);
    const review = (b: SnapshotBook, there: SnapshotBook, detail: Record<string, unknown>) =>
      this.addReview(
        runId,
        `cross:${b.uuid}:${there.uuid}`,
        'cross_copy',
        null,
        there.calibreId,
        there.uuid,
        { ...detail, title: there.title, newId: b.calibreId, library: other, libraryName: name },
        other,
      );
    const found = new Set<number>();
    // The same file.
    const libPacer = new Pacer(getSettings(this.db).pacing.readMbPerSecond * 1024 * 1024);
    for (const b of hand) {
      if (shouldStop()) return;
      const file = resolveInside(ownDir, b.filePath) as string;
      const st = await statFile(file);
      if (!st) continue;
      const same = await libraryHashesOfSize(pd, books, st.size, libPacer, shouldStop);
      if (!same.length) continue;
      const h = await hashSource(file, pacer, shouldStop);
      const hit = h ? same.find((s) => s.sha256 === h.sha256) : undefined;
      if (hit && books.get(hit.calibreId)) {
        review(b, books.get(hit.calibreId)!, {
          reason: `The same file as ${name} book ${hit.calibreId}`,
        });
        found.add(b.calibreId);
      }
    }
    // The same text: the hand books' sketches under the other library, at keys of their own.
    const keyOf = (calibreId: number) => -(HAND_CROSS_KEY + calibreId);
    const news = new Map<number, NewText>();
    for (const b of hand) {
      const t = own.get(b.calibreId);
      if (!t || t.error || t.imageOnly || found.has(b.calibreId)) continue;
      copySketchAs(cd, libraryId, b.calibreId, keyOf(b.calibreId));
      news.set(keyOf(b.calibreId), { ...t, key: keyOf(b.calibreId) });
    }
    if (!news.size) return;
    try {
      const pairs = (await candidatePairsOf(cd, [...news.values()])).filter(
        (pr) => pr.a < 0 !== pr.b < 0,
      );
      if (!pairs.length) return;
      const measured = await measurePairs(cd, news, pairs);
      const quality = this.qualityOf(cd, news, new Map(), pacer);
      for (const m of measured) {
        if (!m.m || shouldStop()) continue;
        const k = m.pair.a < 0 ? m.pair.a : m.pair.b;
        const otherKey = k === m.pair.a ? m.pair.b : m.pair.a;
        const v = await judgePair(cd, k, otherKey, m.m, news, quality);
        if (v.cls !== 'duplicate' && v.cls !== 'superset') continue;
        const b = hand.find((x) => keyOf(x.calibreId) === k);
        const there = books.get(otherKey);
        if (!b || !there) continue;
        review(b, there, {
          reason: `The same text as ${name} book ${otherKey} (${v.reason})`,
          pair: {
            aInB: v.aInB,
            bInA: v.bInA,
            cls: v.cls,
            rule: v.rule,
            reason: v.reason,
            best: v.best,
          },
        });
      }
    } finally {
      dropCrossSketches(cd);
    }
  }

  // ---------------------------------------------------------------- stage 4

  private stage4Uuids(p: RunProgress): string[] {
    if (!p.stage4) return [];
    return (
      this.db
        .prepare(
          `SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ? AND state = 'proposed' ORDER BY calibre_id`,
        )
        .all(p.stage4.analysisId) as { calibre_uuid: string }[]
    ).map((r) => r.calibre_uuid);
  }

  private async stage4Step(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const a4 = this.a4(libraryId);
    const lib4 = a4?.progress() ?? null;
    if (!a4 || !lib4 || lib4.phase !== 'done') {
      if (a4 && lib4 && lib4.phase !== 'done') {
        p.waiting = "Waiting for stage 4's own analysis to finish";
        return 'wait';
      }
      this.next(run.id, p, 'stage5');
      return 'more';
    }
    const uuids = this.scopeUuids(p, libraryId);
    if (!uuids.length) {
      this.next(run.id, p, 'stage5');
      return 'more';
    }
    if (!p.stage4) {
      p.stage4 = a4.arrivalView(lib4, run.id);
      this.save(run.id, p);
    }
    if (!p.stage4Read) {
      // Resumable: only the books without a row of this run's view yet.
      const seen = new Set(
        (
          this.db
            .prepare('SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ?')
            .all(p.stage4.analysisId) as { calibre_uuid: string }[]
        ).map((r) => r.calibre_uuid),
      );
      const unread = uuids.filter((u) => !seen.has(u));
      const n = await this.withDisk(
        p,
        () => a4.arrivalRead(p.stage4!, unread, shouldStop),
        shouldStop,
      );
      if (n === null || shouldStop()) return 'wait';
      p.stage4Read = true;
      this.save(run.id, p);
    }
    const done = await a4.arrivalStep(p.stage4);
    const counts = a4.arrivalCounts(p.stage4);
    const c = this.count(p, 'stage4');
    c.total = uuids.length;
    c.done = (counts.proposed ?? 0) + (counts.error ?? 0);
    if (!done) {
      p.waiting = `Looking the new books up online (${c.done} of ${c.total})`;
      return 'wait';
    }
    this.next(run.id, p, 'ai');
    return 'more';
  }

  private async aiStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const a4 = this.a4(libraryId);
    const ai4 = this.ai4Of(libraryId);
    if (!ai4 || !a4 || !p.stage4) {
      this.next(run.id, p, 'write4');
      return 'more';
    }
    const design = getSettings(this.db).ai.booksArrivalsDesign;
    if (design !== 'E' && !p.jGate) {
      const lib4 = a4.progress();
      if (lib4) {
        const g = await ai4.jGate(lib4, design, shouldStop);
        if (!g.gate) {
          p.waiting =
            g.wait ?? `Asking the stronger pair about the labeled books (the ${design} gate)`;
          return 'wait';
        }
        p.jGate = g.gate;
        this.log(
          `New arrivals: the ${design} gate on the labeled books ${g.gate.passed ? 'passed' : `is below its bar on ${g.gate.below.join(', ')} (E decides those fields)`}`,
        );
      }
    }
    p.ai ??= emptyArrivalAi(design);
    const uuids = this.stage4Uuids(p);
    const r = await ai4.step(p.stage4, p.ai, uuids, p.jGate, shouldStop);
    p.cost = p.ai.cost;
    p.waiting = p.ai.wait;
    const c = this.count(p, 'ai');
    if (p.ai.phase === 'cheap' || p.ai.phase === 'strong') {
      // While the models answer: their questions (two a book), each pair counted on its own.
      this.setPart(p, p.ai.phase, p.ai.design === 'E' ? ['cheap'] : AI_PARTS);
      c.total = (p.ai.phase === 'cheap' ? p.ai.keys.length : p.ai.strongKeys.length) * 2;
      c.done = p.ai.pending === undefined ? 0 : Math.max(0, c.total - p.ai.pending);
    } else {
      c.total = uuids.length;
      c.done = p.ai.decided;
    }
    if (r === 'done') this.next(run.id, p, 'write4');
    return r === 'done' ? 'more' : r;
  }

  // ---------------------------------------------------------------- writes

  private async writeStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    stage: 2 | 4 | 5,
    nextPhase: RunPhase,
  ): Promise<'more' | 'wait'> {
    if (run.mode !== 'on') {
      this.next(run.id, p, nextPhase);
      return 'more';
    }
    const planner =
      stage === 2
        ? this.deps.stage2Batches
        : stage === 4
          ? this.deps.stage4Batches
          : this.deps.stage5Batches;
    const w = (p.writes[`s${stage}`] ??= { batches: [], applied: 0, failed: 0 });
    this.writeCount(p, p.phase, [stage], libraryId, run.id);
    if (this.checksWait(p)) return 'wait';
    if (this.deps.batches.open()) {
      p.waiting = 'A batch is being applied';
      return 'wait';
    }
    const r = await planner.plan(libraryId, { analysisId: arrivalAnalysisId(run.id) });
    if (r.batch) {
      w.batches.push(r.batch.id);
      p.waiting = `Writing stage ${stage}'s changes to Calibre`;
      return 'wait';
    }
    // Changes an earlier run held (a field its gate paused, resumed since): written now, through
    // the same planner and its checks (a book changed in Calibre since is skipped).
    for (const older of this.heldAnalyses(stage, libraryId, run.id)) {
      const o = await planner.plan(libraryId, { analysisId: older });
      if (o.batch) {
        w.batches.push(o.batch.id);
        p.waiting = `Writing stage ${stage}'s changes an earlier run held`;
        return 'wait';
      }
    }
    let heldWhy: string | null = null;
    if (r.reason && r.reason !== 'A batch is being applied') {
      // Nothing left to write is no reason; a pause (a field, the library changed) waits.
      if (!/nothing|paused/i.test(r.reason)) {
        p.waiting = r.reason;
        return 'wait';
      }
      if (/paused/i.test(r.reason)) heldWhy = r.reason;
    }
    const counts = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage = ? AND library_id = ? AND analysis_id = ? GROUP BY state`,
      )
      .all(stage, libraryId, arrivalAnalysisId(run.id)) as { state: string; n: number }[];
    w.applied = counts.find((x) => x.state === 'applied')?.n ?? 0;
    w.failed = counts.find((x) => x.state === 'skipped')?.n ?? 0;
    // What stays proposed is held (a field its gate paused): said in the run and its report.
    w.held = counts.find((x) => x.state === 'proposed')?.n ?? 0;
    w.heldWhy = w.held ? heldWhy : null;
    if (w.held)
      this.deps.log?.(
        `New arrivals: run ${run.id}: ${w.held} stage-${stage} changes held${heldWhy ? ` (${heldWhy})` : ''}`,
      );
    // Books already in Calibre whose series choice this run changed: proposed under stage 4's own
    // analysis once the run's own changes are written, so stage 4's own On writes the sure ones
    // (they had waited for the next rules deploy; the user, 2026-11-25).
    const so = stage === 4 ? p.ai?.series : null;
    if (so?.existing?.length && (so.existingDone ?? 0) < so.existing.length) {
      const lib4 = this.a4(libraryId)?.progress();
      const ai4 = this.ai4Of(libraryId);
      if (lib4 && ai4) {
        const all = await ai4.proposeExisting(lib4, so, () => false);
        this.save(run.id, p);
        if (!all) {
          p.waiting = `Proposing the series changes of books already in the library (${so.existingDone} of ${so.existing.length})`;
          return 'more';
        }
        this.deps.log?.(
          `New arrivals: run ${run.id}: ${so.existing.length} books already in the library proposed again for their series (stage 4's own On writes the sure ones)`,
        );
      }
    }
    this.deps.wantIngest(libraryId);
    this.next(run.id, p, nextPhase);
    return 'more';
  }

  private emptyScope(p: RunProgress): boolean {
    return p.scope.import.length + p.scope.hand.length === 0;
  }

  /**
   * Earlier On runs with stage changes still proposed (held by a paused field), oldest first. A
   * Preview run's proposals are only shown, and a failed run's are never written later.
   */
  private heldAnalyses(stage: number, libraryId: string, runId: number): string[] {
    const ids = (
      this.db
        .prepare(
          `SELECT DISTINCT analysis_id FROM proposed_changes INDEXED BY proposed_changes_counts
           WHERE stage = ? AND library_id = ? AND state = 'proposed' AND class = 'auto'
             AND analysis_id LIKE 'arrivals:%' AND analysis_id <> ?`,
        )
        .all(stage, libraryId, arrivalAnalysisId(runId)) as { analysis_id: string }[]
    )
      .map((r) => Number(r.analysis_id.slice('arrivals:'.length)))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
    // A failed run (a gate that failed, an error) is never written from later either.
    const row = this.db.prepare('SELECT mode, state FROM calibre_arrival_runs WHERE id = ?');
    return ids
      .filter((id) => {
        const r = row.get(id) as { mode: string; state: string } | undefined;
        return r?.mode === 'on' && r.state !== 'failed';
      })
      .map((id) => arrivalAnalysisId(id));
  }

  /** Every field the run wrote compared with Calibre's metadata.db as the reader copied it. */
  private checkStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
  ): 'more' | 'wait' {
    if (run.mode !== 'on') {
      this.next(run.id, p, 'move');
      return 'more';
    }
    const id = arrivalAnalysisId(run.id);
    const applied = this.db
      .prepare(
        `SELECT calibre_id, calibre_uuid, field, new_json, updated_at FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage IN (2, 4, 5) AND library_id = ? AND analysis_id = ? AND state = 'applied'`,
      )
      .all(libraryId, id) as {
      calibre_id: number;
      calibre_uuid: string;
      field: string;
      new_json: string;
      updated_at: number;
    }[];
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    const lastWrite = applied.reduce((m, r) => Math.max(m, r.updated_at), 0);
    if (applied.length && (!st || st.mtimeMs < lastWrite)) {
      this.deps.wantIngest(libraryId);
      p.waiting = "Waiting for the reader's index to copy Calibre's metadata.db after the writes";
      return 'wait';
    }
    const books = this.snapshotBooks(libraryId);
    const differ: { calibreId: number; field: string }[] = [];
    let same = 0;
    for (const r of applied) {
      const b = books.get(r.calibre_id);
      const v = JSON.parse(r.new_json) as unknown;
      let ok = true;
      if (!b) ok = false;
      else if (r.field === 'title') ok = typeof v === 'string' && b.title === v;
      else if (r.field === 'tags') {
        const ch = v as { add?: string[]; remove?: string[] };
        const tags = new Set(b.tags.map((t) => t.toLowerCase()));
        ok =
          (ch.add ?? []).every((t) => tags.has(t.toLowerCase())) &&
          (ch.remove ?? []).every((t) => !tags.has(t.toLowerCase()));
      }
      if (ok) same++;
      else differ.push({ calibreId: r.calibre_id, field: r.field });
    }
    p.check = { fields: applied.length, same, differ: differ.slice(0, 200) };
    this.next(run.id, p, 'move');
    return 'more';
  }

  /**
   * Manga part A: the run's books that stage 5 tagged マンガ or 画像のみ move to the manga library
   * in this run, through the move's own rules and batches (move/pass.ts, move-batches.ts) under
   * `move:arrivals:<run>`. The move card's mode decides: Off passes, Preview lists what would
   * move (proposes nothing: a Preview's proposals are never written), On moves. A book the rules
   * hold waits on the card's held list, like the library's.
   */
  private async moveStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const mv = this.deps.move?.() ?? null;
    const mode = mv ? getMoveState(this.db).mode : 'off';
    const uuids = new Set(this.scopeUuids(p, libraryId));
    const target = mv?.pass.targetLibrary() ?? null;
    // Manga part B: only a run of the move's source library moves its manga (never the manga
    // library's own run into itself).
    if (!mv || mode === 'off' || !target || uuids.size === 0 || libraryId === target) {
      p.move =
        mv && uuids.size > 0
          ? {
              tagged: 0,
              auto: 0,
              held: {},
              batches: [],
              moved: 0,
              note: !target
                ? 'The manga library is not in the reader'
                : libraryId === target
                  ? null
                  : mode === 'off'
                    ? 'The move is Off'
                    : null,
            }
          : (p.move ?? null);
      this.next(run.id, p, 'report');
      return 'more';
    }
    if (run.mode === 'on' && p.writes.s5?.batches.length) {
      // The tags stage 5 wrote must be in the reader's copy before the move reads them.
      const file = snapshotFile(this.deps.cacheDir, libraryId);
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      const lastBatch = p.writes.s5.batches
        .map((id) => this.deps.batches.get(id)?.finishedAt ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      if (!st || st.mtimeMs < lastBatch) {
        this.deps.wantIngest(libraryId);
        p.waiting = "Waiting for the reader's index to copy Calibre's metadata.db after the tags";
        return 'wait';
      }
    }
    const analysisId = moveArrivalsAnalysisId(run.id);
    if (!p.move || p.move.batches === undefined) {
      const { decisions } = mv.pass.decide(libraryId);
      const mine = decisions.filter((d) => uuids.has(d.candidate.uuid));
      // The reader counts new books in the background after its index (about 7,000-8,000 an
      // hour on the NAS): a book it hasn't counted yet would be held as "no count", so an On run
      // waits for the counts first, at most settings.move.arrivalsCountWaitMinutes.
      const uncounted = mine.filter(waitsForCount).length;
      if (run.mode === 'on' && mode === 'on' && uncounted > 0) {
        const since = (p.moveCountWaitSince ??= Date.now());
        const limit = getSettings(this.db).move.arrivalsCountWaitMinutes * 60_000;
        if (Date.now() - since < limit) {
          p.waiting = `Waiting for the reader to count ${uncounted.toLocaleString('en-US')} of the ${mine.length.toLocaleString('en-US')} manga and image-only books before moving them`;
          return 'wait';
        }
        this.deps.log?.(
          `New arrivals: run ${run.id}: ${uncounted} tagged books still uncounted after the wait; they are held for review`,
        );
      }
      p.waiting = null;
      const held: Record<string, number> = {};
      for (const d of mine) if (d.hold) held[d.hold] = (held[d.hold] ?? 0) + 1;
      p.move = {
        tagged: mine.length,
        auto: mine.filter((d) => !d.hold).length,
        held,
        batches: [],
        moved: 0,
        note: null,
      };
      if (run.mode === 'on' && mode === 'on' && mine.length > 0)
        mv.pass.propose(libraryId, target, analysisId, mine);
    }
    if (run.mode !== 'on' || mode !== 'on' || p.move.auto === 0) {
      if (run.mode === 'on' && mode !== 'on' && p.move.tagged > 0)
        p.move.note = 'The move is in Preview: these books stay until it is On';
      this.next(run.id, p, 'report');
      return 'more';
    }
    const left = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_move
           WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND state IN ('proposed', 'queued')
             AND class = 'auto'`,
        )
        .get(libraryId, analysisId) as { n: number }
    ).n;
    const cm = this.count(p, 'move');
    cm.total = p.move.auto;
    // Each moved book's proposal is applied as it moves (move-batches.ts), so this counts
    // inside an open batch too; it runs before the wait on that batch so the bar moves.
    cm.done = Math.max(0, p.move.auto - left);
    const wait = mv.writeWait(libraryId, target);
    if (wait) {
      p.waiting = wait;
      return 'wait';
    }
    if (left === 0) {
      p.move.moved = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_move
             WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'applied'`,
          )
          .get(libraryId, analysisId) as { n: number }
      ).n;
      if (this.deps.batches.moves.awaitingIngest()) {
        p.waiting = "Waiting for the reader's index to take in the move";
        return 'wait';
      }
      this.next(run.id, p, 'report');
      return 'more';
    }
    const { batch, reason } = await this.deps.batches.moves.plan(
      libraryId,
      target,
      analysisId,
      shouldStop,
    );
    if (batch) {
      p.move.batches.push(batch.id);
      p.waiting = 'Moving manga to the manga library';
    } else p.waiting = reason;
    return 'wait';
  }

  // ---------------------------------------------------------------- reviews and the report

  private addReview(
    runId: number,
    key: string,
    kind: 'better_copy' | 'archive' | 'add_failed' | 'too_long' | 'cross_copy',
    fileId: number | null,
    calibreId: number | null,
    uuid: string | null,
    detail: Record<string, unknown>,
    /** Manga part B: the library of the Calibre book named (another than the file's own). */
    libraryId: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO calibre_arrival_reviews (review_key, kind, file_id, calibre_id, calibre_uuid, detail_json, run_id, created_at, calibre_library_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_key) DO NOTHING`,
      )
      .run(
        key,
        kind,
        fileId,
        calibreId,
        uuid,
        JSON.stringify(detail),
        runId,
        Date.now(),
        libraryId,
      );
  }

  private addReviews(runId: number, reviews: PassReview[]): void {
    for (const r of reviews)
      this.addReview(
        runId,
        `better:${r.newUuid}:${r.libraryUuid}`,
        'better_copy',
        null,
        r.libraryId,
        r.libraryUuid,
        {
          ...r.detail,
          newId: r.newId,
          stage: r.stage,
        },
      );
  }

  /** A review choice (applied by the next run; better copies: keep the library's / add / both). */
  decide(reviewId: number, decision: string): void {
    const r = this.db
      .prepare('SELECT kind FROM calibre_arrival_reviews WHERE id = ?')
      .get(reviewId) as { kind: string } | undefined;
    if (!r) throw new Error('No such review item');
    const allowed: Record<string, string[]> = {
      better_copy: ['keep_library', 'add_new', 'keep_both', 'clear'],
      // Manga part B: a copy of another library's book: recorded only (nothing is removed from
      // one library because of another; you act in Calibre).
      cross_copy: ['keep_library', 'keep_both', 'seen', 'clear'],
      archive: ['seen', 'clear'],
      add_failed: ['retry', 'seen', 'clear'],
      too_long: ['seen', 'clear'],
    };
    if (!allowed[r.kind]?.includes(decision))
      throw new Error(`Not a choice for this item: ${decision}`);
    this.db
      .prepare(
        'UPDATE calibre_arrival_reviews SET decision = ?, decided_at = ?, applied_at = NULL WHERE id = ?',
      )
      .run(decision === 'clear' ? null : decision, Date.now(), reviewId);
    if (r.kind === 'add_failed' && decision === 'retry') {
      // Looked at again by the next run (the add is planned again only on this choice).
      this.db
        .prepare(
          `UPDATE calibre_arrival_files SET outcome = 'new' WHERE id = (SELECT file_id FROM calibre_arrival_reviews WHERE id = ?)`,
        )
        .run(reviewId);
      this.db
        .prepare(
          `DELETE FROM calibre_arrival_batch_items WHERE state = 'failed' AND file_id = (SELECT file_id FROM calibre_arrival_reviews WHERE id = ?)`,
        )
        .run(reviewId);
    }
  }

  private finish(
    runId: number,
    p: RunProgress,
    state: 'done' | 'failed' | 'stopped',
    error: string | null,
  ): void {
    const t = Date.now();
    p.times[p.phase] = (p.times[p.phase] ?? 0) + (t - p.phaseStartedAt);
    const run = this.db
      .prepare('SELECT mode FROM calibre_arrival_runs WHERE id = ?')
      .get(runId) as { mode: 'analyse' | 'on' };
    // Sketches of source files that will not be added (copies, not imported) leave the cache;
    // those that may still be added stay until they are.
    try {
      const decided = (
        this.db
          .prepare(
            `SELECT id FROM calibre_arrival_files INDEXED BY calibre_arrival_files_run
             WHERE run_id = ? AND outcome NOT IN ('new', 'better')`,
          )
          .all(runId) as { id: number }[]
      ).map((r) => -r.id);
      if (decided.length && p.libraryId && this.deps.calibreDir)
        dropNewSketches(
          { cleanup: this.db, cacheDir: this.deps.cacheDir, libraryId: p.libraryId } as CompareDeps,
          decided,
        );
      // Manga part B: the copies under the other libraries (the check across them) go too.
      for (const lib of p.otherLibraries ?? [])
        dropCrossSketches({
          cleanup: this.db,
          cacheDir: this.deps.cacheDir,
          libraryId: lib,
        } as CompareDeps);
    } catch (err) {
      this.log(`New arrivals: the cache's sketches were not tidied: ${(err as Error).message}`);
    }
    const report = this.report(runId, p, run.mode);
    p.phase = 'done';
    this.db
      .prepare(
        `UPDATE calibre_arrival_runs SET state = ?, phase = 'done', finished_at = ?, progress_json = ?, report_json = ?, error = ?
         WHERE id = ?`,
      )
      .run(state, t, JSON.stringify(p), JSON.stringify(report), error, runId);
    // The run's own library (its row: a run made before manga part B is the primary library's).
    const owner = this.db
      .prepare('SELECT library_id FROM calibre_arrivals_state WHERE current_run = ?')
      .get(runId) as { library_id: string } | undefined;
    if (owner) this.setState({ current_run: null }, owner.library_id);
    this.log(
      `New arrivals: run ${runId} ${state}: ${report.added} added, ${report.outcomes.identical ?? 0} identical, ${report.outcomes.duplicate ?? 0} same text, ${report.outcomes.not_imported ?? 0} not imported, ${report.newReview} new to review`,
    );
  }

  /**
   * Books decided as new before `sameTextNoWinner` (the 2026-11-24 Preview) are decided again
   * with it, before anything is planned or added: a new book with the same text as another copy
   * and no clear winner is a duplicate. Only books still 'new'; once per plan step.
   */
  reapplySameText(runId: number, pairKeys?: string[], libraryId?: string | null): number {
    // Manga part B: the run's own folders (each library's runs decide their own files).
    const keys = pairKeys ?? [];
    const rows = (
      pairKeys
        ? keys.length
          ? this.db
              .prepare(
                `SELECT id, facts_json FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
                 WHERE outcome = 'new' AND pair_key IN (${keys.map(() => '?').join(', ')})
                   AND gone_at IS NULL AND json_extract(facts_json, '$.compared') = 1`,
              )
              .all(...keys)
          : []
        : this.db
            .prepare(
              `SELECT id, facts_json FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
               WHERE outcome = 'new' AND gone_at IS NULL AND json_extract(facts_json, '$.compared') = 1`,
            )
            .all()
    ) as { id: number; facts_json: string }[];
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = 'duplicate', detail = ?, calibre_id = ?,
         calibre_uuid = ?, decided_at = ?, run_id = ? WHERE id = ? AND outcome = 'new'`,
    );
    let n = 0;
    const lib = this.libraryOfRuns(libraryId);
    this.db.transaction(() => {
      for (const r of rows) {
        const tie = sameTextNoWinner(
          (JSON.parse(r.facts_json) as CompareFacts).verdicts ?? [],
          r.id,
        );
        if (!tie) continue;
        const uuid = tie.otherKey > 0 ? (lib?.get(tie.otherKey)?.uuid ?? null) : null;
        set.run(
          sameTextDetail(tie),
          tie.otherKey > 0 ? tie.otherKey : null,
          uuid,
          Date.now(),
          runId,
          r.id,
        );
        n++;
      }
    })();
    if (n)
      this.log(`New arrivals: ${n} books with the same text as another copy decided as duplicates`);
    return n;
  }

  private libraryOfRuns(of?: string | null): Map<number, SnapshotBook> | null {
    const libraryId = of ?? this.deps.targetLibrary();
    return libraryId ? this.snapshotBooks(libraryId) : null;
  }

  report(runId: number, p: RunProgress, mode: 'analyse' | 'on'): RunReport {
    const outcomes: Record<string, number> = {};
    const formats: Record<string, number> = {};
    // The files this run looked at or decided (a folder's first look can span runs: files read
    // by one run are decided by a later one; WP20g, 2026-11-24: run 6's report was empty).
    const started = (
      this.db.prepare('SELECT started_at FROM calibre_arrival_runs WHERE id = ?').get(runId) as {
        started_at: number;
      }
    ).started_at;
    for (const r of this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM calibre_arrival_files
         WHERE (run_id = ? OR decided_at >= ?) AND gone_at IS NULL GROUP BY outcome`,
      )
      .all(runId, started) as { outcome: string; n: number }[])
      outcomes[r.outcome] = r.n;
    for (const r of this.db
      .prepare(
        `SELECT COALESCE(format, kind) AS f, COUNT(*) AS n FROM calibre_arrival_files
         WHERE (run_id = ? OR decided_at >= ?) AND gone_at IS NULL GROUP BY f`,
      )
      .all(runId, started) as { f: string; n: number }[])
      formats[r.f] = r.n;
    const newReview = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM calibre_arrival_reviews WHERE run_id = ?')
        .get(runId) as { n: number }
    ).n;
    const written: Record<string, number> = {};
    const held: Record<string, number> = {};
    for (const [k, w] of Object.entries(p.writes)) {
      written[k] = w.applied;
      if (w.held) held[k] = w.held;
    }
    const toAdd = (outcomes.new ?? 0) + (outcomes.better ?? 0);
    const est =
      mode === 'analyse'
        ? {
            books: toAdd,
            // Measured per book: E $0.00067 (plan section 6), J's stronger pair on 44 % of the
            // labeled books at $0.0105 each, stage 5 with Sonnet AND Sol $0.0051 (WP20g stop 1:
            // Sonnet by batch, Sol one call each).
            aiUsd: Math.round(toAdd * (0.00067 + 0.44 * 0.0105 + 0.0051) * 100) / 100,
            // About 1.5 s per add, 1 s per book of the stages' writes, Amazon's ~3,600 answers a
            // day at about 0.9 per book (lessons 4): the lookups decide.
            seconds: Math.round(toAdd * 1.5 + toAdd * 1 + (toAdd * 0.9 * 86400) / 3600),
          }
        : null;
    return {
      mode,
      outcomes,
      formats,
      added: p.scope.import.length,
      hand: p.scope.hand.length,
      written,
      held,
      reviews: (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM calibre_arrival_reviews WHERE decision IS NULL')
          .get() as { n: number }
      ).n,
      newReview,
      bestGuesses: p.ai?.series?.guesses ?? 0,
      existingSeriesChanges: p.ai?.series?.existingChanged ?? 0,
      aiCost: p.cost,
      check: p.check,
      estimate: est,
    };
  }

  // ---------------------------------------------------------------- the linking sidecar

  /** The linking sidecar's version and when it was last seen (link_sidecar_status). */
  private linkSidecar(): { version: string | null; seenAt: number | null } {
    try {
      const r = this.db
        .prepare(
          'SELECT version, last_seen_at FROM link_sidecar_status ORDER BY last_seen_at DESC LIMIT 1',
        )
        .get() as { version: string | null; last_seen_at: number | null } | undefined;
      return { version: r?.version ?? null, seenAt: r?.last_seen_at ?? null };
    } catch {
      return { version: null, seenAt: null };
    }
  }

  /** Whether the linking sidecar (1.4.0 or newer: book archives) was seen in the last 90 s. */
  linkReady(now = Date.now()): boolean {
    const s = this.linkSidecar();
    if (!s.seenAt || now - s.seenAt > 90_000 || !s.version) return false;
    const [a, b] = s.version.split('.').map(Number);
    return a > 1 || (a === 1 && b >= 4);
  }

  /**
   * The linking sidecar's heartbeat when the audiobook cleanup isn't set up (its stage 6 records
   * it otherwise): the same row, so the import's archives know the sidecar is there.
   */
  linkHeartbeat(body: {
    sidecarId: string;
    runId: string | null;
    version: string | null;
    problem: string | null;
    info: Record<string, unknown> | null;
  }): { active: boolean; pollSeconds: number } {
    this.db
      .prepare(
        `INSERT INTO link_sidecar_status (id, sidecar_id, run_id, version, last_seen_at, problem, info_json)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sidecar_id = excluded.sidecar_id, run_id = excluded.run_id,
           version = excluded.version, last_seen_at = excluded.last_seen_at,
           problem = excluded.problem, info_json = excluded.info_json`,
      )
      .run(
        body.sidecarId,
        body.runId,
        body.version,
        Date.now(),
        body.problem,
        body.info ? JSON.stringify(body.info) : null,
      );
    const active = this.archivesActive();
    return { active, pollSeconds: active ? 1 : 15 };
  }

  /** The run is unpacking archives (the sidecar should poll quickly). */
  archivesActive(): boolean {
    const run = this.currentRun();
    return (
      run?.p.phase === 'archives' && this.archives.open().list + this.archives.open().extract > 0
    );
  }

  /** The next archive batch for the linking sidecar (only during a run's archives phase). */
  archiveClaim(): unknown {
    if (!this.archivesActive() || !this.linkReady()) return null;
    if (!this.deps.diskLock.tryAcquire(ARCHIVE_OWNER, 'calibre')) return null;
    const b = this.archives.claim();
    if (!b) this.deps.diskLock.release(ARCHIVE_OWNER);
    return b;
  }

  archiveReport(batchId: number, results: Parameters<BookArchives['report']>[1]): unknown {
    try {
      return this.archives.report(batchId, results);
    } finally {
      this.deps.diskLock.release(ARCHIVE_OWNER);
    }
  }

  /** A file of an add batch, for the apply sidecar (read only, from the sources mount). */
  fileForItem(itemId: number): { path: string; size: number; sha256: string } {
    const { fileId } = this.addBatches.fileOf(itemId);
    const f = this.db
      .prepare('SELECT pair_key, rel_path, size, sha256 FROM calibre_arrival_files WHERE id = ?')
      .get(fileId) as {
      pair_key: string;
      rel_path: string;
      size: number;
      sha256: string;
    };
    return { path: this.sourcePath(f.pair_key, f.rel_path), size: f.size, sha256: f.sha256 };
  }

  /** The sniffer, for files without an extension found in an archive's listing (unused there). */
  static sniff(head: Buffer | null): string {
    return sniffFormat(head);
  }

  /** Whether `name` would be imported (for tests and the page's help). */
  static kindOf(name: string): string {
    return classifyName(name).kind;
  }
}
