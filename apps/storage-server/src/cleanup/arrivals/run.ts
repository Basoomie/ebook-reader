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
 *   identify  each new settled EPUB hashed and read (title and authors as its OPF says them; an
 *             EPUB the reader's import can't open is "Not imported"); other formats listed
 *   compare   each against the library: identical files (stage 1's file_facts), the same text
 *             (compare.ts: stage 3's reader, index and rules), the better copy (stage 3's order)
 *   plan      what would be added. Preview ends its import here; a folder's first run is a
 *             Preview whatever the mode, and adds only after "Add these"
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
import { getStage } from '../stages';
import type { Stage4Analysis, Stage4Progress } from '../stage4/analysis';
import { arrivalAnalysisId } from '../stage4/analysis';
import { clockNow, nextScheduledRun, scheduledRunDue } from '../audio/arrivals-schedule';
import { ArrivalBatches } from './add-batches';
import { BookArchives } from './archives';
import { classifyName, settled, sniffFormat, walkSource } from './catalog';
import {
  candidatePairsOf,
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
  | 'report'
  | 'done';

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

export interface RunProgress {
  phase: RunPhase;
  phaseStartedAt: number;
  phaseStartDone: number;
  /** Time spent per phase (ms), waits for the disk left out. */
  times: Record<string, number>;
  counts: Partial<Record<RunPhase, PhaseCount>>;
  waiting: string | null;
  pairs: { key: string; source: string; libraryId: string; firstRun: boolean; approved: boolean }[];
  libraryId: string | null;
  /** The run's books (Calibre ids) by where they came from. */
  scope: { import: number[]; hand: number[] };
  /** Pairs measured in compare: file id -> the library copy it lost to or beat. */
  betterOf: Record<string, { calibreId: number; uuid: string; pair: Record<string, unknown> }>;
  reviews: number;
  stage4: Stage4Progress | null;
  ai: ArrivalAiProgress | null;
  s5: Stage5PassProgress | null;
  jGate: JGate | null;
  /** Batches the run planned per stage (ids), and what they wrote. */
  writes: Record<string, { batches: string[]; applied: number; failed: number }>;
  check: { fields: number; same: number; differ: { calibreId: number; field: string }[] } | null;
  cost: number;
}

export interface RunReport {
  mode: 'analyse' | 'on';
  outcomes: Record<string, number>;
  formats: Record<string, number>;
  added: number;
  hand: number;
  written: Record<string, number>;
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
  stage2: Stage2Analysis | null;
  stage2Batches: Stage2Batches;
  stage4Batches: Stage2Batches;
  stage5Batches: Stage2Batches;
  analysis4: Stage4Analysis | null;
  runner: AiRunner;
  reader: () => Stage3Reader;
  counterBuild: string;
  targetLibrary: () => string | null;
  /** Whether a stage's own analysis is running (an arrivals run never overlaps one). */
  libraryBusy: () => string | null;
  /** Asks the reader's index to copy metadata.db at once (books were added). */
  wantIngest: (libraryId: string) => void;
  /** Whether the linking sidecar has been seen lately (archives wait for it). */
  linkSidecarOnline: () => boolean;
  /** The source folders must be mounted read-only (tests on a writable temp folder: false). */
  requireReadOnlySources?: boolean;
  /** The safety checks (stage 0) every write waits for, as the stages' own writes do. */
  checksPass?: () => { ok: boolean; failing: string[] };
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

export class BookArrivals {
  readonly addBatches: ArrivalBatches;
  readonly archives: BookArchives;
  private readonly ai4: ArrivalStage4Ai | null;
  private readonly s5: ArrivalStage5 | null;
  private stepping = false;
  private stopRequested = false;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: ArrivalsDeps) {
    this.log = deps.log ?? (() => {});
    this.addBatches = new ArrivalBatches(deps.cleanup);
    this.archives = new BookArchives(deps.cleanup, (key) => this.rootOf(key));
    this.ai4 = deps.analysis4
      ? new ArrivalStage4Ai({
          db: deps.cleanup,
          runner: deps.runner,
          analysis: deps.analysis4,
          log: this.log,
        })
      : null;
    this.s5 = deps.analysis4
      ? new ArrivalStage5({ db: deps.cleanup, runner: deps.runner, analysis: deps.analysis4 })
      : null;
    if (deps.analysis4) {
      // An arrival view of stage 4 is saved in the run, never over the library's progress.
      deps.analysis4.setArrivalSink((p) => this.saveStage4View(p));
    }
  }

  private get db(): Database.Database {
    return this.deps.cleanup;
  }

  // ---------------------------------------------------------------- state

  state(): StateRow {
    return this.db.prepare('SELECT * FROM calibre_arrivals_state WHERE id = 1').get() as StateRow;
  }

  private setState(fields: Partial<Record<keyof StateRow, unknown>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(
        `UPDATE calibre_arrivals_state SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = 1`,
      )
      .run({ ...fields, now: Date.now() });
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

  setMode(mode: 'off' | 'analyse' | 'on'): void {
    this.setState({ mode });
    if (mode === 'off') this.stopRequested = true;
  }

  requestRun(): void {
    const s = this.state();
    if (s.mode === 'off') throw new Error('New arrivals are Off: set Preview or On first');
    if (s.current_run !== null) throw new Error('A run is going on');
    this.setState({ run_now: 1 });
  }

  /** Stops the current run where it is (its batches already handed out finish on their own). */
  stopRun(): void {
    const run = this.currentRun();
    if (!run) return;
    this.stopRequested = true;
    this.finish(run.id, run.p, 'stopped', 'Stopped on the page');
  }

  resume(): void {
    this.setState({ pause_reason: null, pause_detail: null, paused_at: null });
  }

  private pause(reason: string, detail: string): void {
    this.setState({
      pause_reason: reason,
      pause_detail: detail.slice(0, 1000),
      paused_at: Date.now(),
    });
    this.log(`New arrivals paused (${reason}): ${detail}`);
  }

  /** A pair's first run has been through its Preview: its adds are allowed from now on. */
  approvePair(pairKey: string): void {
    const p = this.db
      .prepare('SELECT first_done_at FROM calibre_arrival_pairs WHERE pair_key = ?')
      .get(pairKey) as { first_done_at: number | null } | undefined;
    if (!p) throw new Error('No such source folder');
    if (!p.first_done_at) throw new Error('Its first run (the Preview) has not finished yet');
    this.db
      .prepare('UPDATE calibre_arrival_pairs SET approved_at = ? WHERE pair_key = ?')
      .run(Date.now(), pairKey);
  }

  /** The pairs as set, each recorded on first sight (a changed folder is a new pair). */
  private syncPairs(now = Date.now()): RunProgress['pairs'] {
    const s = getSettings(this.db);
    const target = this.deps.targetLibrary();
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
        .get(key) as {
        first_done_at: number | null;
        approved_at: number | null;
      };
      // Stages 1-5 run in the library the cleanup cleans: a pair into another library waits for
      // the English follow-up (plan section 11).
      if (p.libraryId !== target) continue;
      out.push({
        key,
        source: p.source,
        libraryId: p.libraryId,
        firstRun: r.first_done_at === null,
        approved: r.approved_at !== null,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- runs

  currentRun(): (RunRow & { p: RunProgress }) | null {
    const s = this.state();
    if (s.current_run === null) return null;
    const r = this.db
      .prepare('SELECT * FROM calibre_arrival_runs WHERE id = ?')
      .get(s.current_run) as RunRow | undefined;
    return r ? { ...r, p: JSON.parse(r.progress_json) as RunProgress } : null;
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
    this.save(runId, p);
  }

  /** The time zone the schedule uses (blank: the server's). */
  zone(): string | undefined {
    return getSettings(this.db).arrivals.timeZone || undefined;
  }

  nextRunAt(now = Date.now()): number | null {
    const s = this.state();
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
  maybeStart(now = Date.now()): number | null {
    const s = this.state();
    if (s.mode === 'off' || s.pause_reason || s.current_run !== null) return null;
    const target = this.deps.targetLibrary();
    if (!target || !this.deps.calibreDir) return null;
    const a = getSettings(this.db).arrivals;
    const sched = {
      arrivalsTime: a.time,
      arrivalsQuietStart: a.quietStart,
      arrivalsQuietEnd: a.quietEnd,
    };
    let trigger: RunRow['trigger'] | null = null;
    if (s.run_now) trigger = 'now';
    else if (scheduledRunDue(now, sched, s.last_scheduled_day, this.zone())) trigger = 'schedule';
    else if (
      (s.hand_checked_at === null || now - s.hand_checked_at >= a.handCheckMinutes * 60_000) &&
      this.handSettled(target, now).length > 0
    )
      trigger = 'hand';
    if (s.hand_checked_at === null || now - s.hand_checked_at >= a.handCheckMinutes * 60_000)
      this.setState({ hand_checked_at: now });
    if (!trigger) return null;
    const busy = this.deps.libraryBusy();
    if (busy) return null;
    const mode = s.mode === 'on' ? 'on' : 'analyse';
    const p = emptyProgress();
    p.libraryId = target;
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO calibre_arrival_runs (trigger, mode, state, phase, started_at, progress_json)
           VALUES (?, ?, 'running', 'scan', ?, ?)`,
        )
        .run(trigger, mode, now, JSON.stringify(p)).lastInsertRowid,
    );
    this.setState({
      current_run: id,
      run_now: 0,
      ...(trigger === 'schedule' ? { last_scheduled_day: clockNow(now, this.zone()).day } : {}),
    });
    this.log(`New arrivals: run ${id} started (${trigger}, ${mode === 'on' ? 'On' : 'Preview'})`);
    return id;
  }

  stop(): void {
    this.stopRequested = true;
  }

  // ---------------------------------------------------------------- books added by hand

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
    const s = this.state();
    const ins = this.db.prepare(
      `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(library_id, calibre_id) DO NOTHING`,
    );
    if (s.baseline_at === null) {
      this.db.transaction(() => {
        for (const [uuid, b] of presence) ins.run(libraryId, b.calibreId, uuid, 'baseline', now);
      })();
      this.setState({ baseline_at: now });
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
    try {
      if (!run) {
        const id = this.maybeStart();
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
        this.pause(stop ? (err as RunStop).reason : 'failed', msg);
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
    const libraryId = p.libraryId ?? this.deps.targetLibrary();
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
      return 'wait';
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
    if (st !== undefined && getStage(this.db, st).mode === 'off') {
      p.waiting = `Waiting: stage ${st} is Off (set it to Preview or On)`;
      return 'wait';
    }
    switch (p.phase) {
      case 'scan': {
        p.pairs = this.syncPairs();
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
        return this.addStep(run, p, libraryId);
      case 'index':
        return this.indexStep(run, p, libraryId, libDir);
      case 'stage1': {
        const scope = this.scopeBooks(p, libraryId);
        if (!scope.length) {
          this.next(run.id, p, 'stage2');
          return 'more';
        }
        const books = this.snapshotBooks(libraryId);
        const res = await this.withDisk(
          p,
          () => stage1Pass(this.passDeps(run.id, libraryId, libDir), scope, books, shouldStop),
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
        if (this.deps.stage2 && uuids.length) {
          const n = await this.withDisk(
            p,
            () =>
              stage2Pass(
                this.passDeps(run.id, libraryId, libDir),
                this.deps.stage2!,
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
        return this.writeStep(run, p, libraryId, 2, 'stage4');
      case 'stage4':
        return this.stage4Step(run, p, libraryId, shouldStop);
      case 'ai':
        return this.aiStep(run, p, libraryId, shouldStop);
      case 'write4':
        return this.writeStep(run, p, libraryId, 4, 'stage5');
      case 'stage5': {
        const uuids = this.stage4Uuids(p);
        if (!this.s5 || !p.stage4 || !uuids.length) {
          this.next(run.id, p, 'write5');
          return 'more';
        }
        p.s5 ??= emptyStage5Pass();
        const r = await this.s5.step(p.stage4, p.s5, uuids, shouldStop);
        p.cost = (p.ai?.cost ?? 0) + (p.s5.cost ?? 0);
        p.waiting = p.s5.wait;
        if (r === 'done') this.next(run.id, p, 'write5');
        return r === 'done' ? 'more' : r;
      }
      case 'write5':
        return this.writeStep(run, p, libraryId, 5, 'check');
      case 'check':
        return this.checkStep(run, p, libraryId);
      case 'report': {
        this.finish(run.id, p, 'done', null);
        return 'idle';
      }
      default:
        return 'idle';
    }
  }

  private passDeps(runId: number, libraryId: string, libDir: string): PassDeps {
    return {
      cleanup: this.db,
      main: this.deps.main,
      libraryId,
      libDir,
      analysisId: arrivalAnalysisId(runId),
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
    if (!todo.length) {
      this.next(run.id, p, 'compare');
      return 'more';
    }
    if (c.total === 0) {
      const t = this.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM calibre_arrival_files
           WHERE outcome = 'pending' AND pair_key IN (${ph}) AND kind = 'epub' AND gone_at IS NULL`,
        )
        .get(...keys) as { n: number; b: number };
      c.total = t.n;
      c.bytesTotal = t.b;
      c.bytesDone = 0;
    }
    const pacer = new SourcePacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const removed = new Set(
      (
        this.db
          .prepare(
            `SELECT sha256 FROM calibre_arrival_files WHERE outcome = 'removed_by_you' AND sha256 IS NOT NULL`,
          )
          .all() as { sha256: string }[]
      ).map((r) => r.sha256),
    );
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
          const h = await hashSource(file, pacer, shouldStop);
          if (!h) return false;
          c.done++;
          c.bytesDone = (c.bytesDone ?? 0) + f.size;
          if (removed.has(h.sha256)) {
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
          let facts: { title: string | null; authors: string[]; nameBytes: number } | null = null;
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
              nameBytes: calibreNameBytes(9_999_999, title, authors[0] ?? 'Unknown'),
            };
          } catch (err) {
            problem = `The reader can't open it: ${(err as Error).message}`.slice(0, 300);
          }
          if (problem || !facts) {
            set.run('unreadable', h.sha256, Date.now(), problem, null, run.id, Date.now(), f.id);
            continue;
          }
          if (facts.nameBytes > NAME_MAX_BYTES) {
            set.run(
              'too_long',
              h.sha256,
              Date.now(),
              "Too long for a folder name in Calibre's library",
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
            h.sha256,
            Date.now(),
            null,
            JSON.stringify(facts),
            run.id,
            Date.now(),
            f.id,
          );
          // Read: handed to compare from here (outcome 'pending' with a hash).
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
         WHERE outcome = 'added'`,
      )
      .all() as { id: number; calibre_id: number; calibre_uuid: string }[];
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
    const files = this.db
      .prepare(
        `SELECT id, pair_key, rel_path, size, mtime_ms, sha256, facts_json FROM calibre_arrival_files
         INDEXED BY calibre_arrival_files_outcome
         WHERE outcome = 'new' AND pair_key IN (${ph}) AND run_id = ? AND gone_at IS NULL ORDER BY id`,
      )
      .all(...keys, run.id) as {
      id: number;
      pair_key: string;
      rel_path: string;
      size: number;
      mtime_ms: number;
      sha256: string;
      facts_json: string | null;
    }[];
    const c = this.count(p, 'compare');
    c.total = files.length;
    if (!files.length) {
      this.next(run.id, p, 'plan');
      return 'more';
    }
    const books = this.snapshotBooks(libraryId);
    const cd = this.compareDeps(libraryId, libDir, books);
    const pd = this.passDeps(run.id, libraryId, libDir);
    const settings = getSettings(this.db);
    const libPacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const srcPacer = new SourcePacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const set = this.db.prepare(
      `UPDATE calibre_arrival_files SET outcome = ?, detail = ?, calibre_id = ?, calibre_uuid = ?,
         facts_json = COALESCE(?, facts_json), decided_at = ? WHERE id = ?`,
    );
    const done = await this.withDisk(
      p,
      async () => {
        // 0. Library books stage 1 or 3 never read (added since their analyses): their file
        // facts and text first, as those stages would have read them.
        if (!(await this.ensureLibraryFacts(cd, pd, books, srcPacer, shouldStop))) return false;
        // 1. Identical to a library EPUB (stage 1's facts, hashed now where unknown).
        const left: typeof files = [];
        for (const f of files) {
          if (shouldStop()) return false;
          const same = await libraryHashesOfSize(pd, books, f.size, libPacer, shouldStop);
          const hit = same.find((x) => x.sha256 === f.sha256);
          if (hit) {
            const b = books.get(hit.calibreId)!;
            set.run(
              'identical',
              `The same file as Calibre book ${hit.calibreId}`,
              hit.calibreId,
              b.uuid,
              null,
              Date.now(),
              f.id,
            );
            c.done++;
          } else left.push(f);
        }
        // 2. Identical among themselves: the first stays.
        const bySha = new Map<string, number>();
        const rest: typeof files = [];
        for (const f of left) {
          const first = bySha.get(f.sha256);
          if (first !== undefined) {
            set.run(
              'identical',
              `The same file as ${first} in this run`,
              null,
              null,
              null,
              Date.now(),
              f.id,
            );
            c.done++;
          } else {
            bySha.set(f.sha256, f.id);
            rest.push(f);
          }
        }
        // 3. The same text (stage 3's reader, index and rules).
        const news = new Map<number, NewText>();
        for (const f of rest) {
          if (shouldStop()) return false;
          const facts = f.facts_json ? (JSON.parse(f.facts_json) as { title?: string | null }) : {};
          const t = await readNewText(
            cd,
            -f.id,
            this.sourcePath(f.pair_key, f.rel_path),
            [facts.title ?? null],
            srcPacer,
          );
          news.set(-f.id, t);
        }
        const pairs = await candidatePairsOf(cd, [...news.values()]);
        const measured = await measurePairs(cd, news, pairs);
        const qCache = new Map<number, Quality | null>();
        const quality = async (k: number) => {
          if (qCache.has(k)) return qCache.get(k)!;
          let q: Quality | null;
          const n = news.get(k);
          if (n) {
            q = await qualityOfFile(n.file, {
              calibreId: k,
              chars: n.chars,
              ruby: n.ruby,
              tocEntries: n.toc,
              customTags: 0,
              addedAt: Date.now(),
              pacer: srcPacer,
            });
          } else q = await libraryQuality(cd, k, srcPacer);
          qCache.set(k, q);
          return q;
        };
        const verdicts = new Map<number, MeasuredPair[]>();
        for (const m of measured) {
          if (!m.m) continue;
          const keysNew = [m.pair.a, m.pair.b].filter((k) => news.has(k));
          for (const k of keysNew) {
            const other = k === m.pair.a ? m.pair.b : m.pair.a;
            const v = await judgePair(cd, k, other, m.m, news, quality);
            verdicts.set(k, [...(verdicts.get(k) ?? []), v]);
          }
        }
        for (const f of rest) {
          const key = -f.id;
          const t = news.get(key)!;
          const vs = verdicts.get(key) ?? [];
          const factsPlus = JSON.stringify({
            ...(f.facts_json ? JSON.parse(f.facts_json) : {}),
            text: {
              chars: t.chars,
              kind: t.kind,
              imageOnly: t.imageOnly,
              error: t.error,
              ruby: t.ruby,
              toc: t.toc,
              samples: t.samples,
              fileTitle: t.fileTitle,
              vertical: t.vertical,
              imageEntries: t.imageEntries.length,
              marker: t.marker,
              importChars: t.importChars,
            },
          });
          const lostTo = vs.find((v) => v.keep === 'other');
          const beat = vs.filter((v) => v.keep === 'new' && v.otherKey > 0);
          if (lostTo) {
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
          } else if (beat.length) {
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
                { pair, title: b.title },
              );
            } else {
              // The pair stays with the file: the run that adds it (maybe a later one) proposes
              // the older copy's removal from it.
              set.run(
                'better',
                `Better than Calibre book ${target.otherKey} (${target.reason}); added, then the older copy is removed`,
                target.otherKey,
                b.uuid,
                JSON.stringify({ ...JSON.parse(factsPlus), better: pair }),
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
        return true;
      },
      shouldStop,
    );
    if (done === null || done === false) return 'wait';
    this.next(run.id, p, 'plan');
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
    for (const pair of p.pairs) {
      if (pair.firstRun) {
        this.db
          .prepare(
            `UPDATE calibre_arrival_pairs SET first_run_id = COALESCE(first_run_id, ?), first_done_at = COALESCE(first_done_at, ?)
             WHERE pair_key = ?`,
          )
          .run(run.id, now, pair.key);
      }
    }
  }

  /** The files a run adds: new and better copies of pairs whose first run was approved. */
  private filesToAdd(_run: RunRow & { p: RunProgress }, p: RunProgress): number[] {
    // Only from folders whose first run (a Preview) you approved with "Add these".
    const approved = p.pairs
      .map((x) => x.key)
      .filter(
        (k) =>
          (
            this.db
              .prepare('SELECT approved_at FROM calibre_arrival_pairs WHERE pair_key = ?')
              .get(k) as { approved_at: number | null } | undefined
          )?.approved_at != null,
      );
    if (!approved.length) return [];
    const ph = approved.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT id FROM calibre_arrival_files WHERE outcome IN ('new', 'better') AND pair_key IN (${ph})
             AND gone_at IS NULL AND id NOT IN (SELECT file_id FROM calibre_arrival_batch_items i
               JOIN calibre_arrival_batches b ON b.id = i.batch_id WHERE b.kind = 'add' AND i.state <> 'failed')
           ORDER BY id`,
        )
        .all(...approved) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Why a write (an add, a removal, a field write) must wait: the safety checks. */
  private checksWait(p: RunProgress): boolean {
    const c = this.deps.checksPass?.();
    if (c && !c.ok) {
      p.waiting = `Waiting for the safety checks: ${c.failing.join('; ')}`;
      return true;
    }
    return false;
  }

  private addStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
  ): 'more' | 'wait' {
    const c = this.count(p, 'add');
    if (c.total === 0 && this.checksWait(p)) return 'wait';
    if (c.total === 0 && !this.addBatches.busy(run.id)) {
      const ids = this.filesToAdd(run, p);
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
  ): Promise<'more' | 'wait'> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (p.scope.import.length) {
      const presence = fs.existsSync(file) ? readSnapshotPresence(file) : new Map();
      const ids = new Set([...presence.values()].map((x: { calibreId: number }) => x.calibreId));
      const missing = p.scope.import.filter((id) => !ids.has(id));
      if (missing.length) {
        this.deps.wantIngest(libraryId);
        p.waiting = `Waiting for the reader's library index to show the ${missing.length} added books`;
        return 'wait';
      }
    }
    // The added books: each one's EPUB checked against the file it came from, and its text facts
    // carried over (stage 3 compares later arrivals with it).
    const books = this.snapshotBooks(libraryId);
    const cd = this.compareDeps(libraryId, libDir, books);
    const settings = getSettings(this.db);
    const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    for (const id of p.scope.import) {
      const b = books.get(id);
      const f = this.db
        .prepare(
          `SELECT id, sha256, facts_json FROM calibre_arrival_files WHERE calibre_id = ? OR json_extract(facts_json, '$.addedAs.calibreId') = ?`,
        )
        .get(id, id) as { id: number; sha256: string; facts_json: string | null } | undefined;
      if (!b || !f) continue;
      const epub = resolveInside(libDir, b.filePath);
      const st = await statFile(epub);
      const h = st ? await hashSourceFile(epub, pacer) : null;
      const facts = f.facts_json ? JSON.parse(f.facts_json) : {};
      const same = !!h && h.sha256 === f.sha256;
      this.db
        .prepare(
          `UPDATE calibre_arrival_files SET facts_json = json_set(COALESCE(facts_json, '{}'), '$.inCalibre', json(?)) WHERE id = ?`,
        )
        .run(JSON.stringify({ sameBytes: same, sha256: h?.sha256 ?? null }), f.id);
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
    }
    // The added files' sketches now live under their Calibre ids.
    dropNewSketches(
      cd,
      p.scope.import.flatMap((id) => {
        const f = this.db
          .prepare(
            `SELECT id FROM calibre_arrival_files WHERE json_extract(facts_json, '$.addedAs.calibreId') = ?`,
          )
          .get(id) as { id: number } | undefined;
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
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, calibre_id) DO NOTHING`,
    );
    for (const id of p.scope.import) {
      const b = books.get(id);
      if (b) ins.run(run.id, libraryId, id, b.uuid, 'import', null);
    }
    for (const b of hand) ins.run(run.id, libraryId, b.calibreId, b.uuid, 'hand', null);
    this.next(run.id, p, 'stage1');
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
        const hand = p.scope.hand.map((id) => books.get(id)).filter((b): b is SnapshotBook => !!b);
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
        for (const m of measured) {
          if (!m.m) continue;
          const k = news.has(m.pair.a) ? m.pair.a : m.pair.b;
          const other = k === m.pair.a ? m.pair.b : m.pair.a;
          const v = await judgePair(cd, k, other, m.m, news, quality);
          if (v.keep === null) continue;
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
        return true;
      },
      shouldStop,
    );
    if (ok === null || ok === false) return 'wait';
    this.next(run.id, p, 'removals');
    return 'more';
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
    const a4 = this.deps.analysis4;
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
      const n = await this.withDisk(
        p,
        () => a4.arrivalRead(p.stage4!, uuids, shouldStop),
        shouldStop,
      );
      if (n === null) return 'wait';
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
    _libraryId: string,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait'> {
    const a4 = this.deps.analysis4;
    if (!this.ai4 || !a4 || !p.stage4) {
      this.next(run.id, p, 'write4');
      return 'more';
    }
    const design = getSettings(this.db).ai.booksArrivalsDesign;
    if (design !== 'E' && !p.jGate) {
      const lib4 = a4.progress();
      if (lib4) {
        const g = await this.ai4.jGate(lib4, design, shouldStop);
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
    const r = await this.ai4.step(p.stage4, p.ai, uuids, p.jGate, shouldStop);
    p.cost = p.ai.cost;
    p.waiting = p.ai.wait;
    const c = this.count(p, 'ai');
    c.total = uuids.length;
    c.done = p.ai.decided;
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
    if (r.reason && r.reason !== 'A batch is being applied') {
      // Nothing left to write is no reason; a pause (a field, the library changed) waits.
      if (!/nothing|paused/i.test(r.reason)) {
        p.waiting = r.reason;
        return 'wait';
      }
    }
    const counts = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage = ? AND library_id = ? AND analysis_id = ? GROUP BY state`,
      )
      .all(stage, libraryId, arrivalAnalysisId(run.id)) as { state: string; n: number }[];
    w.applied = counts.find((x) => x.state === 'applied')?.n ?? 0;
    w.failed = counts.find((x) => x.state === 'skipped')?.n ?? 0;
    this.deps.wantIngest(libraryId);
    this.next(run.id, p, nextPhase);
    return 'more';
  }

  /** Every field the run wrote compared with Calibre's metadata.db as the reader copied it. */
  private checkStep(
    run: RunRow & { p: RunProgress },
    p: RunProgress,
    libraryId: string,
  ): 'more' | 'wait' {
    if (run.mode !== 'on') {
      this.next(run.id, p, 'report');
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
    this.next(run.id, p, 'report');
    return 'more';
  }

  // ---------------------------------------------------------------- reviews and the report

  private addReview(
    runId: number,
    key: string,
    kind: 'better_copy' | 'archive' | 'add_failed' | 'too_long',
    fileId: number | null,
    calibreId: number | null,
    uuid: string | null,
    detail: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO calibre_arrival_reviews (review_key, kind, file_id, calibre_id, calibre_uuid, detail_json, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_key) DO NOTHING`,
      )
      .run(key, kind, fileId, calibreId, uuid, JSON.stringify(detail), runId, Date.now());
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
    this.setState({ current_run: null });
    this.log(
      `New arrivals: run ${runId} ${state}: ${report.added} added, ${report.outcomes.identical ?? 0} identical, ${report.outcomes.duplicate ?? 0} same text, ${report.outcomes.not_imported ?? 0} not imported, ${report.newReview} new to review`,
    );
  }

  report(runId: number, p: RunProgress, mode: 'analyse' | 'on'): RunReport {
    const outcomes: Record<string, number> = {};
    const formats: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_run
         WHERE run_id = ? GROUP BY outcome`,
      )
      .all(runId) as { outcome: string; n: number }[])
      outcomes[r.outcome] = r.n;
    for (const r of this.db
      .prepare(
        `SELECT COALESCE(format, kind) AS f, COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_run
         WHERE run_id = ? GROUP BY f`,
      )
      .all(runId) as { f: string; n: number }[])
      formats[r.f] = r.n;
    const newReview = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM calibre_arrival_reviews WHERE run_id = ?')
        .get(runId) as { n: number }
    ).n;
    const written: Record<string, number> = {};
    for (const [k, w] of Object.entries(p.writes)) written[k] = w.applied;
    const toAdd = (outcomes.new ?? 0) + (outcomes.better ?? 0);
    const est =
      mode === 'analyse'
        ? {
            books: toAdd,
            // Measured per book (plan section 6 and WP20f stop 1): E $0.00067, J's stronger pair
            // on about half the books ($0.0137 at list price), stage 5 $0.00057.
            aiUsd: Math.round(toAdd * (0.00067 + 0.5 * 0.0137 + 0.00057) * 100) / 100,
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
