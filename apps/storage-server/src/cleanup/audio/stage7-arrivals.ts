/**
 * Audiobook stage 7: the daily new arrivals (WP21f-1, plan section 9). Once a day at the set
 * time (or Run now) a run:
 *
 *   stage1    runs stage 1 again (the walk of /torrents and the library; hashes taken over)
 *   archives  lists the archives under the torrents that are settled and new, and unpacks each one
 *             holding audio into torrents/audiobooks/japanese/_extracted/<archive path>/ through
 *             the linking sidecar (create-only; the archive is only read). Preview unpacks too
 *             (user, 2026-11-20): nothing is linked, and stop 2 shows the real result.
 *   stage1b   stage 1 again when anything was unpacked (the new files join the walk)
 *   stages    stages 2-5 run again (stage 2 is started; 3-5 follow by themselves; every gate is
 *             scored again: a failed gate stops the run before anything is linked)
 *   ebooks    stage 8 (WP21g): the recordings paired with their Calibre ebooks (stage8-ebooks.ts);
 *             its values join the plan and the library changes only when stage 8 is On
 *   classify  every recording against the library by inode (arrivals-classify.ts)
 *   plan      the new books (stage 6's plan; folders against the library as it is: arrivals-plan.ts).
 *             Preview ends here.
 *   walk_before, build, walk_after, check   (On) the sidecar makes the new folders, links and
 *             metadata.json files under the shared disk lock (Calibre first); then the check:
 *             every link the planned inode, every metadata.json the planned bytes, the torrents
 *             unchanged but for the links made (and _extracted), every existing book unchanged
 *   abs       Audiobookshelf shows the new books? (GET-only; the nudge only when switched on)
 *   report    counts, cost, times, lock waits; the review items new this run
 *
 * Every phase is resumable (CA Appdata Backup stops ttsu-storage at 00:00 NAS time), shows its
 * progress with time left, and waits while a Calibre job uses the disk.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { expectedListCost, runSpend } from '../../ai/spend';
import { designCounts, upgradeTargets } from '../ai-decide/values';
import { modeOf as modeOfModel } from '../../ai/runner';
import type { AiSettings } from '../../ai/settings';
import { AbsClient } from './abs-client';
import { AbsWatchNotifier } from './abs-watch-notifier';
import { getAudioStage, pauseAudioStage, resumeAudioStage, updateAudioStage } from './audio-stages';
import { hashFile, insideRoot, lstatEntry, readSmall, ReadPacer } from './audio-source-fs';
import {
  classifyArrivals,
  everLinkedInodes,
  loadClassifyInputs,
  type ArrivalOutcome,
  type ClassifyResult,
} from './arrivals-classify';
import {
  ARRIVAL_AREA_FOLDERS,
  planArrivals,
  type ArrivalPlan,
  type ExistingTree,
} from './arrivals-plan';
import { clockNow, nextScheduledRun, scheduledRunDue } from './arrivals-schedule';
import { compareManifests, compareNewTree, walkTree, type ManifestEntry } from './build-check';
import { gatesPassed, loadPlanInputs, stageIds } from './build-inputs';
import { planBuildSliced } from './build-plan';
import { AUDIO_EXTS } from './walk';
import { librarySwitched } from './switch-state';
import {
  LIBRARY_BATCH_BASE,
  LibraryChanges,
  type ChangesProgress,
  type LibraryBatch,
  type LibraryOpResult,
} from './library-changes';
import type { SwitchReader } from './stage6-switch';
import { STAGE8, type AudioStage8, type Stage8Progress } from './stage8-ebooks';

export const STAGE7 = 7;
/** Batch ids of stage 7 start here (never a build's or the switch's). */
export const ARRIVAL_BATCH_BASE = 2_000_000_000;
/** The sidecar version that can add new books and unpack archives. */
export const ARRIVAL_SIDECAR_VERSION = '1.2.0';
const OWNER = DISK_OWNERS.audio7;
const HOLD_MS = 2000;

export type Stage7Phase =
  | 'stage1'
  | 'archives'
  | 'stage1b'
  | 'stages'
  | 'ebooks'
  | 'classify'
  | 'plan'
  | 'walk_before'
  | 'build'
  | 'walk_after'
  | 'check'
  | 'changes'
  | 'abs'
  | 'report'
  | 'done';

export interface Stage7Progress {
  runId: number;
  trigger: 'schedule' | 'now';
  mode: 'analyse' | 'on';
  phase: Stage7Phase;
  startedAt: number;
  finishedAt: number | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, { ms: number; items: number }>;
  /**
   * Time the current phase spent waiting for Calibre (the disk lock, a walk's pauses, the
   * check's waits): not work, so `setPhase` leaves it out of `phaseTimes` (WP21f-2; the card's
   * time line counted it). Missing in runs saved before.
   */
  phaseWaitMs?: number;
  /** WP21f-2: the changes to books already in the library (library-changes.ts), once begun. */
  changes?: ChangesProgress;
  /** When the current wait for Calibre started (closed by `waitForCalibre(p, false)`). */
  calibreWaitSince?: number | null;
  /** Analysis ids of stages 1/2 when the run asked them to run again. */
  asked: { s1?: string | null; s1b?: string | null; s2?: string | null };
  archives: {
    total: number;
    waiting: number;
    toList: number;
    listed: number;
    entries: number;
    bytes: number;
    extracted: number;
    extractedBytes: number;
    thisRun: number;
    problems: Record<string, number>;
  };
  classify: (ClassifyResult['counts'] & { unlinkedKnown: number }) | null;
  plan: ArrivalPlan['counts'] | null;
  build: {
    total: number;
    done: number;
    failed: number;
    batches: number;
    startedAt: number | null;
    lockWaitMs: number;
    /** When the build started waiting for the disk (its wait counts until it gets it). */
    waitSince?: number | null;
    yields: number;
    firstFailure: string | null;
  };
  walks: Record<string, { entries: number; ms: number; pausedMs: number }>;
  /** The walk going on (its bar). */
  walk?: { root: string; done: number; total: number; startedAt: number } | null;
  check: Stage7Check | null;
  abs: {
    library: string | null;
    before: number | null;
    after: number | null;
    found: number;
    missing: number;
    valuesOk: number;
    valuesDiffer: number;
    nudged: number;
    waitingSince: number | null;
    error: string | null;
    precedence: string | null;
  };
  waiting: string | null;
  error: string | null;
}

export interface Stage7Check {
  passed: boolean;
  lines: string[];
}

export interface Stage7Deps {
  db: Database.Database;
  /** The shared AI provider settings (prices, modes: the upgrade's estimate). */
  aiSettings: () => AiSettings;
  roots: { torrents: string; library: string; media: string | null };
  lock: DiskLock;
  /** Starts a stage's analysis again (the service's "Run the analysis again"). */
  reanalyse: (stage: 1 | 2) => void;
  /** Audiobookshelf, or null when it isn't set up. */
  abs: () => { baseUrl: string; apiKey: string; timeoutMs: number } | null;
  fetchImpl?: typeof fetch;
  /** Stage 8 (WP21g): the pairs with the Calibre ebooks (absent: no Calibre library). */
  stage8?: AudioStage8 | null;
  /** The server's time zone (tests); default: the process's. */
  timeZone?: string;
  now?: () => number;
  log?: (m: string) => void;
}

export interface ArrivalBatchOp {
  id: number;
  kind: 'folder' | 'link' | 'pdf' | 'metadata';
  dst: string;
  src: { rel: string; raw: string | null } | null;
  size: number | null;
  mtimeMs: number | null;
  dev: number | null;
  ino: number | null;
  bytes: string | null;
  book?: string | null;
  planned?: string[] | null;
  entry?: { name: string; size: number; encoding: 'utf8' | 'cp932' } | null;
}

export interface ArrivalBatch {
  id: number;
  kind: 'arrival' | 'list' | 'extract';
  leaseSeconds: number;
  ops: ArrivalBatchOp[];
}

export interface ArrivalOpResult {
  id: number;
  ok: boolean;
  error?: string | null;
  existed?: boolean;
  dev?: number;
  ino?: number;
  absRewrote?: boolean;
  entries?: { name: string; kind: 'file' | 'dir' | 'link' | 'other'; size: number }[];
  encoding?: 'utf8' | 'cp932';
  listProblem?: string | null;
  bytes?: number;
}

function emptyProgress(
  runId: number,
  trigger: Stage7Progress['trigger'],
  mode: Stage7Progress['mode'],
  now: number,
): Stage7Progress {
  return {
    runId,
    trigger,
    mode,
    phase: 'stage1',
    startedAt: now,
    finishedAt: null,
    phaseStartedAt: now,
    phaseStartDone: 0,
    phaseTimes: {},
    asked: {},
    archives: {
      total: 0,
      waiting: 0,
      toList: 0,
      listed: 0,
      entries: 0,
      bytes: 0,
      extracted: 0,
      extractedBytes: 0,
      thisRun: 0,
      problems: {},
    },
    classify: null,
    plan: null,
    build: {
      total: 0,
      done: 0,
      failed: 0,
      batches: 0,
      startedAt: null,
      lockWaitMs: 0,
      yields: 0,
      firstFailure: null,
    },
    walks: {},
    check: null,
    abs: {
      library: null,
      before: null,
      after: null,
      found: 0,
      missing: 0,
      valuesOk: 0,
      valuesDiffer: 0,
      nudged: 0,
      waitingSince: null,
      error: null,
      precedence: null,
    },
    waiting: null,
    error: null,
  };
}

/** The stage row's own state: the schedule and the last run. */
interface Stage7Row {
  lastScheduledDay?: string | null;
  runNow?: boolean;
  currentRun?: number | null;
  lastRun?: number | null;
}

/** A run stops with a pause reason of its own (a failed gate). */
export class Stage7Stop extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the cleanup's library mount (CLEANUP_AUDIO_LIBRARY_DIR, media/audiobooks/japanese
 * mounted by itself) is the folder named japanese now. A mount keeps the folder it was given when
 * the container started: after the switch renamed japanese to japanese-old (and deleted it), the
 * mount still shows that folder until ttsu-storage is restarted, and stage 1 would read the old
 * library (found by the e2e). Compared with japanese seen through the media mount (the parent,
 * which follows the renames). Null when they agree or there is no media mount.
 */
export async function staleLibraryMount(roots: {
  library: string;
  media: string | null;
}): Promise<string | null> {
  if (!roots.media) return null;
  const lib = await lstatEntry(roots.library).catch(() => null);
  if (!lib) return `The library folder ${roots.library} can't be read: restart ttsu-storage`;
  const cur = await lstatEntry(path.join(roots.media, ARRIVAL_AREA_FOLDERS.main)).catch(() => null);
  if (!cur)
    return `media/audiobooks/${ARRIVAL_AREA_FOLDERS.main} can't be read through ${roots.media}`;
  if (lib.dev === cur.dev && lib.ino === cur.ino && lib.nlink > 0) return null;
  return `The library mount (${roots.library}) still shows the folder from before the switch (renamed or deleted since): restart ttsu-storage, then run again`;
}
const gz = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v)));
const ungz = <T>(b: Buffer): T => JSON.parse(gunzipSync(b).toString('utf8')) as T;

/** Compares two dotted versions ("1.10.0" > "1.9.0"). */
export function versionAtLeast(v: string | null, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** An archive entry that is unpacked: a regular file whose every part is an allowed name. */
export function entrySkip(name: string): string | null {
  const parts = name.replace(/^\.\//, '').split('/');
  if (parts[0] === '__MACOSX') return 'macOS metadata';
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'not a safe path';
  if (parts.some((p) => p.startsWith('.'))) return 'hidden';
  if (parts.some((p) => Buffer.byteLength(p, 'utf8') > 255)) return 'name too long';
  if (
    parts.some(
      (p) =>
        p.includes('\\') || [...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
    )
  )
    return 'not an allowed name';
  return null;
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

/** What a failed listing means (bsdtar's message). */
export function listProblemState(
  rel: string,
  problem: string,
): 'not_archive' | 'password' | 'names' | 'failed' {
  const base = rel.split('/').pop() ?? rel;
  if (base.startsWith('._')) return 'not_archive';
  if (/passphrase|encrypt|password/i.test(problem)) return 'password';
  if (/encodings|names can.t be read/i.test(problem)) return 'names';
  if (/unrecognized archive format|not an archive/i.test(problem)) return 'not_archive';
  return 'failed';
}

export class AudioStage7 {
  private running: Promise<void> | null = null;
  private handing = false;
  private nextCache: { at: number; value: number } | null = null;
  private reader: SwitchReader | null = null;
  /** WP21f-2: changes to books already in the library (a step of every run, after the arrivals). */
  readonly changes: LibraryChanges;

  constructor(private readonly deps: Stage7Deps) {
    this.changes = new LibraryChanges({
      db: deps.db,
      media: deps.roots.media,
      lock: deps.lock,
      abs: deps.abs,
      fetchImpl: deps.fetchImpl,
      reader: () => this.reader,
      tree: () => this.existingTree(),
      plan: () => this.currentPlan(this.deps.stage8?.overlay() ?? null),
      sidecarVersion: () => {
        const r = deps.db
          .prepare('SELECT version, last_seen_at FROM link_sidecar_status WHERE id = 1')
          .get() as { version: string | null; last_seen_at: number | null } | undefined;
        return { version: r?.version ?? null, lastSeen: r?.last_seen_at ?? null };
      },
      now: deps.now,
      log: deps.log,
    });
  }

  /** WP21f-2: the reader's side (its hold, scan, links and a ttsu.db snapshot), from the server. */
  attachReader(reader: SwitchReader): void {
    this.reader = reader;
  }

  /**
   * Every unit's plan now (stage 6's plan code on the current analysis), with stage 8's values
   * when given (On: the overlay; its Preview: its values).
   */
  private async currentPlan(ebook: Map<string, Record<string, unknown>> | null = null) {
    const { ids } = stageIds(this.db);
    if (!ids) throw new Error('Stages 1-5 are not done');
    const inputs = await loadPlanInputs(this.db, ids, {
      readerWritten: [],
      libraryFolder: ARRIVAL_AREA_FOLDERS.main,
      ebook,
    });
    return (await planBuildSliced(inputs)).books.filter(
      (b) => b.state === 'build' || b.state === 'pending',
    );
  }

  /** The library changes of this run (their own mode: off skips them). */
  private async changesStep(p: Stage7Progress, stop: () => boolean): Promise<'wait' | 'more'> {
    const next = p.mode === 'on' ? 'abs' : 'report';
    const s = getSettings(this.db).audiobooks;
    if (s.libraryChanges === 'off' || !this.deps.roots.media) {
      this.setPhase(p, next);
      return 'more';
    }
    p.changes ??= this.changes.start(
      p.mode === 'on' && s.libraryChanges === 'on' ? 'on' : 'analyse',
    );
    const r = await this.changes.step(p.runId, p.changes, stop);
    this.save(p);
    if (r === 'done') {
      this.setPhase(p, next);
      return 'more';
    }
    if (typeof r === 'object') {
      this.save(p);
      pauseAudioStage(this.db, STAGE7, 'failed', r.pause);
      return 'wait';
    }
    return r;
  }
  private get db(): Database.Database {
    return this.deps.db;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(m: string): void {
    this.deps.log?.(`Audiobooks stage 7: ${m}`);
  }

  // -------------------------------------------------------------------------------------------
  // state

  private row(): Stage7Row {
    return getAudioStage(this.db, STAGE7).progress as Stage7Row;
  }

  private saveRow(r: Stage7Row): void {
    updateAudioStage(this.db, STAGE7, { progress: r as unknown as Record<string, unknown> });
  }

  current(): Stage7Progress | null {
    const id = this.row().currentRun;
    if (!id) return null;
    return this.runProgress(id);
  }

  runProgress(id: number): Stage7Progress | null {
    const r = this.db
      .prepare('SELECT progress_json FROM audio_arrival_runs WHERE id = ?')
      .get(id) as { progress_json: string } | undefined;
    return r ? (JSON.parse(r.progress_json) as Stage7Progress) : null;
  }

  lastRun(): { progress: Stage7Progress; report: Record<string, unknown> | null } | null {
    const id = this.row().currentRun ?? this.row().lastRun;
    if (!id) return null;
    const r = this.db
      .prepare('SELECT progress_json, report_json FROM audio_arrival_runs WHERE id = ?')
      .get(id) as { progress_json: string; report_json: string | null } | undefined;
    if (!r) return null;
    return {
      progress: JSON.parse(r.progress_json) as Stage7Progress,
      report: r.report_json ? (JSON.parse(r.report_json) as Record<string, unknown>) : null,
    };
  }

  private save(p: Stage7Progress): void {
    this.db
      .prepare('UPDATE audio_arrival_runs SET phase = ?, progress_json = ? WHERE id = ?')
      .run(p.phase, JSON.stringify(p), p.runId);
    updateAudioStage(this.db, STAGE7, { state: p.phase });
  }

  private setPhase(p: Stage7Progress, phase: Stage7Phase, items = 0): void {
    this.waitForCalibre(p, false);
    const now = this.now();
    const t = (p.phaseTimes[p.phase] ??= { ms: 0, items: 0 });
    t.ms += Math.max(0, now - p.phaseStartedAt - (p.phaseWaitMs ?? 0));
    t.items += items;
    p.phaseWaitMs = 0;
    p.phase = phase;
    p.phaseStartedAt = now;
    p.phaseStartDone = 0;
    p.waiting = null;
    this.save(p);
    this.log(phase);
  }

  /** The schedule's time zone: the setting, else the server's (tests: deps.timeZone). */
  zone(): string | undefined {
    return getSettings(this.db).audiobooks.arrivalsTimeZone || this.deps.timeZone;
  }

  isRunning(): boolean {
    return this.current() !== null;
  }

  /** Run now (refused while a run is going). */
  requestRun(): void {
    if (this.current()) throw new Error('A run is going on; wait for it to finish');
    const st = getAudioStage(this.db, STAGE7);
    if (st.mode === 'off') throw new Error('Stage 7 is Off: set it to Preview or On first');
    this.saveRow({ ...this.row(), runNow: true });
  }

  /** The next scheduled start (cached a minute: it is shown on a polled page). */
  nextRunAt(): number | null {
    if (getAudioStage(this.db, STAGE7).mode === 'off') return null;
    const now = this.now();
    if (this.nextCache && now - this.nextCache.at < 60_000) return this.nextCache.value;
    const s = getSettings(this.db).audiobooks;
    const value = nextScheduledRun(now, s, this.row().lastScheduledDay ?? null, this.zone());
    this.nextCache = { at: now, value };
    return value;
  }

  /** Starts a run when one is due (the service calls this every round). Returns the run, if any. */
  maybeStart(): Stage7Progress | null {
    const cur = this.current();
    if (cur) return cur;
    const st = getAudioStage(this.db, STAGE7);
    if (st.mode === 'off' || st.pauseReason) return null;
    const row = this.row();
    const now = this.now();
    const s = getSettings(this.db).audiobooks;
    let trigger: Stage7Progress['trigger'] | null = null;
    if (row.runNow) trigger = 'now';
    else if (scheduledRunDue(now, s, row.lastScheduledDay ?? null, this.zone()))
      trigger = 'schedule';
    if (!trigger) return null;
    const mode = st.mode === 'on' ? 'on' : 'analyse';
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO audio_arrival_runs (trigger, mode, state, phase, started_at, progress_json)
           VALUES (?, ?, 'running', 'stage1', ?, '{}')`,
        )
        .run(trigger, mode, now).lastInsertRowid,
    );
    const p = emptyProgress(id, trigger, mode, now);
    this.save(p);
    this.saveRow({
      ...row,
      runNow: false,
      currentRun: id,
      lastScheduledDay:
        trigger === 'schedule' ? clockNow(now, this.zone()).day : (row.lastScheduledDay ?? null),
    });
    this.nextCache = null;
    this.log(`run ${id} started (${trigger}, ${mode === 'on' ? 'On' : 'Preview'})`);
    return p;
  }

  /** Stops the current run (stage switched Off): it ends as stopped. */
  stopRun(reason: string): void {
    const p = this.current();
    if (!p) return;
    this.finish(p, 'stopped', reason);
  }

  private finish(
    p: Stage7Progress,
    state: 'done' | 'failed' | 'stopped',
    error: string | null,
  ): void {
    const now = this.now();
    p.finishedAt = now;
    p.error = error;
    if (state !== 'done') p.waiting = error;
    this.giveBack();
    this.db
      .prepare(
        'UPDATE audio_arrival_runs SET state = ?, phase = ?, progress_json = ?, finished_at = ?, error = ? WHERE id = ?',
      )
      .run(state, p.phase, JSON.stringify(p), now, error, p.runId);
    this.saveRow({ ...this.row(), currentRun: null, lastRun: p.runId });
    updateAudioStage(this.db, STAGE7, { state: state === 'done' ? 'ready' : state });
    this.log(`run ${p.runId} ${state}${error ? `: ${error}` : ''}`);
  }

  // -------------------------------------------------------------------------------------------
  // the loop

  /**
   * One step of the current run. `stop` turns true when the stage is switched off. Returns
   * 'done' when the run ended, 'wait' when it waits for something (sleep a little), 'more'.
   */
  async step(stop: () => boolean): Promise<'done' | 'wait' | 'more'> {
    // Steps never overlap: a second caller while one runs waits (and says who it was).
    if (this.stepping) {
      this.log(
        `a step was asked while one runs (it waits): ${(new Error().stack ?? '')
          .split(/\r?\n/)
          .slice(2, 7)
          .map((l) => l.trim())
          .join(' < ')}`,
      );
      return 'wait';
    }
    this.stepping = true;
    try {
      return await this.stepOnce(stop);
    } finally {
      this.stepping = false;
    }
  }

  private stepping = false;

  private async stepOnce(stop: () => boolean): Promise<'done' | 'wait' | 'more'> {
    const p = this.current();
    if (!p) return 'done';
    try {
      switch (p.phase) {
        case 'stage1':
        case 'stage1b':
          return await this.stage1Step(p);
        case 'archives':
          return await this.archivesStep(p, stop);
        case 'stages':
          return this.stagesStep(p);
        case 'ebooks':
          return await this.ebooksStep(p, stop);
        case 'classify':
          await this.classifyStep(p, stop);
          return 'more';
        case 'plan':
          await this.planStep(p);
          return 'more';
        case 'walk_before':
        case 'walk_after':
          return await this.walkStep(p, stop);
        case 'build':
          return await this.buildStep(p, stop);
        case 'check':
          await this.checkStep(p, stop);
          return 'more';
        case 'changes':
          return await this.changesStep(p, stop);
        case 'abs':
          return await this.absStep(p);
        case 'report':
          this.reportStep(p);
          return 'done';
        case 'done':
          return 'done';
      }
    } catch (err) {
      this.giveBack();
      const m = (err as Error).message.slice(0, 500);
      this.finish(p, 'failed', m);
      pauseAudioStage(this.db, STAGE7, err instanceof Stage7Stop ? err.reason : 'failed', m);
      return 'done';
    }
  }

  // stage 1 (twice when archives were unpacked) -----------------------------------------------

  private async stage1Step(p: Stage7Progress): Promise<'wait' | 'more'> {
    const key = p.phase === 'stage1' ? 's1' : 's1b';
    if (p.asked[key] === undefined) {
      const stale = await staleLibraryMount(this.deps.roots);
      if (stale) throw new Stage7Stop('library_mount', stale);
    }
    const s1 = getAudioStage(this.db, 1);
    const prog = s1.progress as { analysisId?: string; phase?: string; error?: string | null };
    if (s1.mode === 'off') {
      p.waiting = 'Waiting: stage 1 is Off (set stages 1-5 to Preview)';
      this.save(p);
      return 'wait';
    }
    if (p.asked[key] === undefined) {
      p.asked[key] = prog.analysisId ?? null;
      this.save(p);
      this.deps.reanalyse(1);
      return 'wait';
    }
    if (prog.analysisId === p.asked[key] || prog.phase !== 'done') {
      p.waiting = 'Stage 1 is listing and hashing (see its card)';
      this.save(p);
      return 'wait';
    }
    if (prog.error) throw new Error(`Stage 1 failed: ${prog.error}`);
    this.setPhase(p, p.phase === 'stage1' ? 'archives' : 'stages');
    return 'more';
  }

  // archives ----------------------------------------------------------------------------------

  /** The archives under the torrents (stage 1's walk) into audio_archives; changed ones start over. */
  private syncArchives(): void {
    const db = this.db;
    const now = this.now();
    const rows = db
      .prepare(
        `SELECT rel_path, rel_path_raw, size, mtime_ms, dev, ino FROM audio_files
         WHERE root = 'torrents' AND kind = 'archive' AND gone_at IS NULL`,
      )
      .all() as {
      rel_path: string;
      rel_path_raw: string | null;
      size: number;
      mtime_ms: number;
      dev: number;
      ino: number;
    }[];
    const get = db.prepare('SELECT id, size, mtime_ms, dev, ino FROM audio_archives WHERE rel = ?');
    const ins = db.prepare(
      `INSERT INTO audio_archives (rel, raw, size, mtime_ms, dev, ino, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
    );
    const reset = db.prepare(
      `UPDATE audio_archives SET raw = ?, size = ?, mtime_ms = ?, dev = ?, ino = ?, state = 'new',
         detail = NULL, encoding = NULL, entries = NULL, audio_entries = NULL, bytes = NULL,
         audio_bytes = NULL, listed_at = NULL, extracted_at = NULL, updated_at = ? WHERE id = ?`,
    );
    db.transaction(() => {
      for (const r of rows) {
        const cur = get.get(r.rel_path) as
          | { id: number; size: number; mtime_ms: number; dev: number; ino: number }
          | undefined;
        if (!cur) ins.run(r.rel_path, r.rel_path_raw, r.size, r.mtime_ms, r.dev, r.ino, now);
        else if (
          cur.size !== r.size ||
          cur.mtime_ms !== r.mtime_ms ||
          cur.ino !== r.ino ||
          cur.dev !== r.dev
        ) {
          db.prepare('DELETE FROM audio_archive_entries WHERE archive_id = ?').run(cur.id);
          reset.run(r.rel_path_raw, r.size, r.mtime_ms, r.dev, r.ino, now, cur.id);
        }
      }
    })();
  }

  private settledArchives(): { id: number }[] {
    const settle = getSettings(this.db).audiobooks.arrivalsSettleMinutes * 60_000;
    return this.db
      .prepare(`SELECT id FROM audio_archives WHERE state = 'new' AND mtime_ms <= ? ORDER BY id`)
      .all(this.now() - settle) as { id: number }[];
  }

  private refreshArchiveCounts(p: Stage7Progress): void {
    const db = this.db;
    const settle = getSettings(db).audiobooks.arrivalsSettleMinutes * 60_000;
    const a = p.archives;
    const states = db
      .prepare('SELECT state, COUNT(*) AS n FROM audio_archives GROUP BY state')
      .all() as {
      state: string;
      n: number;
    }[];
    a.total = states.reduce((s, r) => s + r.n, 0);
    a.problems = {};
    for (const r of states)
      if (['failed', 'password', 'no_audio', 'not_archive', 'names'].includes(r.state))
        a.problems[r.state] = r.n;
    a.waiting = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM audio_archives WHERE state = 'new' AND mtime_ms > ?`)
        .get(this.now() - settle) as {
        n: number;
      }
    ).n;
    a.toList =
      (
        db.prepare(`SELECT COUNT(*) AS n FROM audio_archives WHERE state = 'new'`).get() as {
          n: number;
        }
      ).n - a.waiting;
    const e = db
      .prepare(
        `SELECT e.state, COUNT(*) AS n, COALESCE(SUM(e.size), 0) AS b FROM audio_archive_entries e
         JOIN audio_archives a ON a.id = e.archive_id
         WHERE a.state IN ('listed', 'extracted', 'failed', 'password') AND e.skip IS NULL GROUP BY e.state`,
      )
      .all() as { state: string; n: number; b: number }[];
    a.entries = e.reduce((s, r) => s + r.n, 0);
    a.bytes = e.reduce((s, r) => s + r.b, 0);
    a.extracted = e.find((r) => r.state === 'done')?.n ?? 0;
    a.extractedBytes = e.find((r) => r.state === 'done')?.b ?? 0;
    a.listed = (
      db.prepare(`SELECT COUNT(*) AS n FROM audio_archives WHERE listed_at IS NOT NULL`).get() as {
        n: number;
      }
    ).n;
  }

  private async archivesStep(p: Stage7Progress, stop: () => boolean): Promise<'wait' | 'more'> {
    if (p.phaseStartDone === 0) {
      this.syncArchives();
      p.phaseStartDone = 1;
    }
    this.refreshArchiveCounts(p);
    this.expireLeases();
    const listing = this.settledArchives().length > 0;
    const extracting =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_archive_entries e JOIN audio_archives a ON a.id = e.archive_id
             WHERE a.state = 'listed' AND e.state IN ('planned', 'claimed')`,
          )
          .get() as { n: number }
      ).n > 0;
    if (!listing && !extracting) {
      // Archives whose every entry is done are extracted; nothing claimed is left.
      this.closeArchives(p);
      this.giveBack();
      this.refreshArchiveCounts(p);
      this.setPhase(p, p.archives.thisRun > 0 ? 'stage1b' : 'stages', p.archives.thisRun);
      return 'more';
    }
    if (!this.sidecarReady()) {
      p.waiting = `Waiting for the linking sidecar ${ARRIVAL_SIDECAR_VERSION} or newer (it lists and unpacks the archives)`;
      this.save(p);
      return 'wait';
    }
    if (extracting && !listing) {
      // Unpacking reads and writes a lot: under the shared lock, in turns, Calibre first.
      if (stop()) return 'wait';
      await this.holdTurn(p, stop);
    } else this.giveBack();
    this.waitForCalibre(p, listing && this.deps.lock.calibreBusy());
    p.waiting = listing
      ? this.deps.lock.calibreBusy()
        ? 'Waiting while the Calibre cleanup uses the disk'
        : 'The linking sidecar is listing the archives (read only)'
      : this.handing
        ? 'The linking sidecar is unpacking archives into _extracted/'
        : 'Waiting for the disk (Calibre first)';
    this.save(p);
    return 'wait';
  }

  /** Archives whose entries are all done or skipped are extracted; a failed entry fails it. */
  private closeArchives(p: Stage7Progress): void {
    const db = this.db;
    for (const a of db.prepare(`SELECT id FROM audio_archives WHERE state = 'listed'`).all() as {
      id: number;
    }[]) {
      const left = db
        .prepare(
          `SELECT state, COUNT(*) AS n FROM audio_archive_entries WHERE archive_id = ? AND skip IS NULL GROUP BY state`,
        )
        .all(a.id) as { state: string; n: number }[];
      const n = (s: string) => left.find((r) => r.state === s)?.n ?? 0;
      if (n('planned') + n('claimed') > 0) continue;
      const failed = n('failed');
      db.prepare(
        `UPDATE audio_archives SET state = ?, extracted_at = ?, updated_at = ?, detail = COALESCE(detail, ?) WHERE id = ?`,
      ).run(
        failed ? 'failed' : 'extracted',
        this.now(),
        this.now(),
        failed ? `${failed} entries could not be unpacked` : null,
        a.id,
      );
      if (failed) this.review('archive', `archive:${a.id}`, null, a.id, p.runId);
    }
  }

  // stage 8 ------------------------------------------------------------------------------------

  /**
   * Stage 8 (WP21g) inside the run: its pass (one stat when nothing changed), then the plan. A
   * failed gate stops the run only when stage 8 is On (its values would be written); in Preview
   * stage 8 pauses and the run goes on without its values.
   */
  private async ebooksStep(p: Stage7Progress, stop: () => boolean): Promise<'wait' | 'more'> {
    const s8 = this.deps.stage8;
    const st = getAudioStage(this.db, STAGE8);
    if (!s8 || st.mode === 'off' || st.pauseReason) {
      this.setPhase(p, 'classify');
      return 'more';
    }
    const prog = s8.progress();
    if (!prog || prog.runId !== p.runId) s8.begin(p.runId);
    const r = await s8.step(stop, () => this.ebookPreview(p));
    if (r === 'done') {
      this.setPhase(p, 'classify');
      return 'more';
    }
    if (typeof r === 'object') {
      if (s8.mode() === 'on') throw new Stage7Stop('ebook_gate', r.stop);
      pauseAudioStage(this.db, STAGE8, 'failed', r.stop);
      this.setPhase(p, 'classify');
      return 'more';
    }
    p.waiting = s8.progress()?.waiting ?? null;
    this.save(p);
    return r;
  }

  /** Stage 8's Preview: the library changes its values would make (nothing written). */
  private async ebookPreview(p: Stage7Progress): Promise<Stage8Progress['preview']> {
    const s8 = this.deps.stage8!;
    if (!this.deps.roots.media) return null;
    const without = await this.currentPlan(null);
    const withV = await this.currentPlan(s8.values());
    const r = await this.changes.dryRun(withV, without, (done, total, waiting) => {
      const prog = s8.progress();
      if (prog) {
        prog.done = done;
        prog.total = total;
        prog.waiting = waiting;
        updateAudioStage(this.db, STAGE8, { progress: prog as unknown as Record<string, unknown> });
      }
      p.waiting = waiting;
    });
    const unitOf = this.db.prepare('SELECT unit_key FROM audio_library_books WHERE id = ?');
    const counts = { changes: 0, metadata: 0, moves: 0, held: 0, reviews: 0, at: this.now() };
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM audio_ebook_preview').run();
      const put = this.db.prepare(
        `INSERT INTO audio_ebook_preview (book_id, unit_key, folder_from, folder_to, fields_json, reviews_json, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ch of r.changes) {
        if (ch.skipped) continue;
        counts.changes++;
        if (ch.metadataNew) counts.metadata++;
        if (ch.folderTo) counts.moves++;
        if (ch.reviews.some((x) => x.kind === 'ebook_series_listening')) counts.held++;
        if (ch.reviews.length) counts.reviews++;
        put.run(
          ch.bookId,
          (unitOf.get(ch.bookId) as { unit_key: string | null } | undefined)?.unit_key ?? null,
          ch.folderFrom,
          ch.folderTo,
          JSON.stringify([...ch.fields, ...ch.conflicts.map((c) => ({ ...c, conflict: true }))]),
          JSON.stringify(ch.reviews),
          p.runId,
          counts.at,
        );
      }
    })();
    return counts;
  }

  // stages 2-5 --------------------------------------------------------------------------------

  private stagesStep(p: Stage7Progress): 'wait' | 'more' {
    for (const n of [2, 3, 4, 5]) {
      const st = getAudioStage(this.db, n);
      if (st.mode === 'off') {
        p.waiting = `Waiting: stage ${n} is Off (set stages 1-5 to Preview)`;
        this.save(p);
        return 'wait';
      }
    }
    if (p.asked.s2 === undefined) {
      p.asked.s2 =
        (getAudioStage(this.db, 2).progress as { analysisId?: string }).analysisId ?? null;
      this.save(p);
      this.deps.reanalyse(2);
      return 'wait';
    }
    const s2 = getAudioStage(this.db, 2).progress as { analysisId?: string };
    const { ids, problem } = stageIds(this.db);
    if (!ids || s2.analysisId === p.asked.s2 || ids.s2 === p.asked.s2) {
      const paused = [2, 3, 4, 5].map((n) => getAudioStage(this.db, n)).find((s) => s.pauseReason);
      p.waiting = paused
        ? `Waiting: stage ${paused.stage} is paused (${paused.pauseDetail ?? paused.pauseReason})`
        : (problem ?? 'Stages 2-5 are analysing (see their cards)');
      this.save(p);
      return 'wait';
    }
    const gates = gatesPassed(this.db);
    if (!gates.passed)
      throw new Stage7Stop(
        'gate',
        `Stage ${gates.failed.join(', ')}'s gate on the labeled books did not pass: nothing is added`,
      );
    this.setPhase(p, 'ebooks');
    return 'more';
  }

  // classify ----------------------------------------------------------------------------------

  /** `dev:ino` of the audio files in media/audiobooks/japanese-generated (read only). */
  private async generatedInodes(
    stop: () => boolean,
  ): Promise<{ inodes: Set<string>; entries: ManifestEntry[] }> {
    const media = this.deps.roots.media;
    if (!media) return { inodes: new Set(), entries: [] };
    const root = path.join(media, ARRIVAL_AREA_FOLDERS.ai);
    const w = await walkTree(root, {
      shouldStop: stop,
      shouldPause: () => this.deps.lock.calibreBusy(),
    });
    const entries = w?.entries ?? [];
    return {
      inodes: new Set(
        entries.filter((e) => !e.isDir && isAudioName(e.rel)).map((e) => `${e.dev}:${e.ino}`),
      ),
      entries,
    };
  }

  /**
   * The designs stage 5 decides each recording with (Stage5Deps.designs): the new arrivals get
   * the arrivals' setting (default J); a book stage 7 built keeps the design it was built with.
   * Empty before the switch (the library-wide runs stay E).
   */
  designsFor(stage4Id: string): Map<string, 'E' | 'F' | 'J'> {
    const out = new Map<string, 'E' | 'F' | 'J'>();
    if (!librarySwitched(this.db)) return out;
    const s4 = getAudioStage(this.db, 4).progress as { analysisId?: string; stage3Id?: string };
    const s3 = getAudioStage(this.db, 3).progress as { analysisId?: string; stage1Id?: string };
    if (s4.analysisId !== stage4Id || !s4.stage3Id || !s3.stage1Id) return out;
    const s = getSettings(this.db);
    const input = loadClassifyInputs(
      this.db,
      { s1: s3.stage1Id, s3: s4.stage3Id, s4: stage4Id },
      { generatedInodes: everLinkedInodes(this.db), now: this.now(), settleMs: 0 },
    );
    for (const o of classifyArrivals(input).outcomes)
      if (o.outcome === 'new' || o.outcome === 'waiting' || o.outcome === 'held')
        out.set(o.unitKey, s.ai.arrivalsDesign);
    // A book stage 7 built keeps its design (its recording's key may have changed since).
    const builtDesign = new Map<string, 'E' | 'F' | 'J'>();
    for (const r of this.db
      .prepare(
        `SELECT o.dev, o.ino, b.design FROM audio_arrival_ops o JOIN audio_arrival_books b ON b.id = o.book_id
         WHERE b.state = 'built' AND o.state = 'done' AND o.kind = 'link'`,
      )
      .all() as { dev: number; ino: number; design: 'E' | 'F' | 'J' }[])
      builtDesign.set(`${r.dev}:${r.ino}`, r.design);
    if (builtDesign.size)
      for (const u of input.units) {
        for (const k of u.copyKeys) {
          const c = input.copies.get(k);
          const d = c?.fileIds
            .map((id) => input.files.get(id))
            .map((f) => (f ? builtDesign.get(`${f.dev}:${f.ino}`) : undefined))
            .find((x) => x !== undefined);
          if (d) out.set(u.key, d);
        }
      }
    return out;
  }

  private async classifyStep(p: Stage7Progress, stop: () => boolean): Promise<void> {
    const { ids } = stageIds(this.db);
    if (!ids) throw new Error('Stages 1-5 are not done');
    const gen = await this.generatedInodes(stop);
    const s = getSettings(this.db).audiobooks;
    const input = loadClassifyInputs(this.db, ids, {
      generatedInodes: gen.inodes,
      now: this.now(),
      settleMs: s.arrivalsSettleMinutes * 60_000,
    });
    const r = classifyArrivals(input);
    const designs = new Map(
      (
        this.db
          .prepare(`SELECT item_key, design FROM ai_item_designs WHERE stage = 'audio5'`)
          .all() as {
          item_key: string;
          design: string;
        }[]
      ).map((x) => [x.item_key, x.design]),
    );
    const db = this.db;
    db.transaction(() => {
      db.prepare('DELETE FROM audio_arrivals WHERE run_id = ?').run(p.runId);
      const put = db.prepare(
        `INSERT INTO audio_arrivals (run_id, unit_key, name, outcome, reason, design, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const o of r.outcomes) {
        if (o.outcome === 'existing') continue;
        put.run(
          p.runId,
          o.unitKey,
          o.name,
          o.outcome,
          o.reason,
          designs.get(o.unitKey) ?? 'E',
          JSON.stringify({ arrivals: o.arrivals, link: o.link, linked: o.linked }),
        );
        if (o.outcome === 'better')
          this.review('better_copy', `better:${o.arrivals.sort().join(',')}`, o, null, p.runId);
        if (o.outcome === 'held')
          this.review('held', `held:${o.link.sort().join(',')}`, o, null, p.runId);
      }
    })();
    // A held arrival that now plays, a better copy that is gone: their review items are resolved.
    this.resolveGone(p.runId, r.outcomes);
    p.classify = { ...r.counts, unlinkedKnown: r.unlinkedKnown };
    this.setPhase(p, 'plan', r.outcomes.length);
  }

  private review(
    kind: 'better_copy' | 'archive' | 'held' | 'abs_missing',
    key: string,
    o: ArrivalOutcome | null,
    archiveId: number | null,
    runId: number,
  ): void {
    const title = o
      ? o.name
      : archiveId !== null
        ? ((
            this.db.prepare('SELECT rel FROM audio_archives WHERE id = ?').get(archiveId) as
              | { rel: string }
              | undefined
          )?.rel ?? key)
        : key;
    const detail = o
      ? { reason: o.reason, arrivals: o.arrivals, linked: o.linked, link: o.link }
      : archiveId !== null
        ? (this.db
            .prepare(
              'SELECT state, detail, entries, audio_entries FROM audio_archives WHERE id = ?',
            )
            .get(archiveId) as object)
        : {};
    this.db
      .prepare(
        `INSERT INTO audio_arrival_reviews (review_key, kind, unit_key, title, detail_json, first_run_id, last_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_key) DO UPDATE SET title = excluded.title, detail_json = excluded.detail_json,
           last_run_id = excluded.last_run_id, unit_key = excluded.unit_key, resolved_at = NULL`,
      )
      .run(key, kind, o?.unitKey ?? null, title, JSON.stringify(detail), runId, runId);
  }

  private resolveGone(runId: number, outcomes: ArrivalOutcome[]): void {
    const live = new Set<string>();
    for (const o of outcomes) {
      if (o.outcome === 'better') live.add(`better:${[...o.arrivals].sort().join(',')}`);
      if (o.outcome === 'held') live.add(`held:${[...o.link].sort().join(',')}`);
    }
    const now = this.now();
    for (const r of this.db
      .prepare(
        `SELECT id, review_key FROM audio_arrival_reviews WHERE resolved_at IS NULL AND kind IN ('better_copy', 'held')`,
      )
      .all() as { id: number; review_key: string }[])
      if (!live.has(r.review_key))
        this.db
          .prepare('UPDATE audio_arrival_reviews SET resolved_at = ?, last_run_id = ? WHERE id = ?')
          .run(now, runId, r.id);
  }

  // plan --------------------------------------------------------------------------------------

  /** The library's folders as they are (stage 1's walk of japanese/ and the walk of -generated/). */
  private async existingTree(): Promise<ExistingTree> {
    const dirs = new Set<string>();
    const bookDirs = new Set<string>();
    const add = (rel: string, isFile: boolean) => {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      if (isFile && parts.length > 1) bookDirs.add(parts.slice(0, -1).join('/'));
    };
    const lib = ARRIVAL_AREA_FOLDERS.main;
    for (const r of this.db
      .prepare(`SELECT rel_path FROM audio_files WHERE root = 'library' AND gone_at IS NULL`)
      .all() as { rel_path: string }[])
      add(`${lib}/${r.rel_path}`, true);
    dirs.add(lib);
    const gen = await this.generatedInodes(() => false);
    dirs.add(ARRIVAL_AREA_FOLDERS.ai);
    for (const e of gen.entries) {
      const rel = `${ARRIVAL_AREA_FOLDERS.ai}/${e.rel}`;
      if (e.isDir) dirs.add(rel);
      else add(rel, true);
    }
    // Narrators of the books built by stage 6 (named japanese-new/… then) and stage 7.
    const narrators = new Map<string, string | null>();
    const p6 = getAudioStage(this.db, 6).progress as { analysisId?: string };
    const liveFolder = (f: string) =>
      f
        .replace(/^japanese-new\//, 'japanese/')
        .replace(/^japanese-generated-new\//, 'japanese-generated/');
    const rows = [
      ...(p6.analysisId
        ? (this.db
            .prepare(
              `SELECT folder, metadata FROM audio_build_books WHERE analysis_id = ? AND state IN ('build', 'pending')`,
            )
            .all(p6.analysisId) as { folder: string; metadata: Buffer }[])
        : []),
      ...(this.db
        .prepare(`SELECT folder, metadata FROM audio_arrival_books WHERE state = 'built'`)
        .all() as {
        folder: string;
        metadata: Buffer;
      }[]),
    ];
    for (const r of rows) {
      try {
        const m = JSON.parse(r.metadata.toString('utf8')) as { narrators?: string[] };
        narrators.set(liveFolder(r.folder), m.narrators?.[0] ?? null);
      } catch {
        narrators.set(liveFolder(r.folder), null);
      }
    }
    return { dirs, bookDirs, narrators };
  }

  private async planStep(p: Stage7Progress): Promise<void> {
    const db = this.db;
    const { ids } = stageIds(db);
    if (!ids) throw new Error('Stages 1-5 are not done');
    const arrivals = db
      .prepare(
        `SELECT unit_key, detail_json, design FROM audio_arrivals WHERE run_id = ? AND outcome = 'new'`,
      )
      .all(p.runId) as { unit_key: string; detail_json: string; design: string }[];
    const linkCopies = new Set<string>();
    const designOf = new Map<string, string>();
    for (const a of arrivals) {
      for (const k of (JSON.parse(a.detail_json) as { link: string[] }).link) linkCopies.add(k);
      designOf.set(a.unit_key, a.design);
    }
    db.prepare(`DELETE FROM audio_arrival_ops WHERE run_id = ?`).run(p.runId);
    db.prepare(`DELETE FROM audio_arrival_books WHERE run_id = ? AND state = 'planned'`).run(
      p.runId,
    );
    // Plans of earlier Preview runs are history only as their report.
    db.prepare(
      `DELETE FROM audio_arrival_ops WHERE book_id IN (SELECT id FROM audio_arrival_books WHERE state = 'planned')`,
    ).run();
    db.prepare(`DELETE FROM audio_arrival_books WHERE state = 'planned'`).run();
    if (linkCopies.size === 0) {
      p.plan = planArrivals([], {
        dirs: new Set(),
        bookDirs: new Set(),
        narrators: new Map(),
      }).counts;
      // Nothing new: the report still shows ABS's item count before and after the run.
      if (p.mode === 'on') p.abs.before = await this.absItemCount(p).catch(() => null);
      this.setPhase(p, 'changes');
      return;
    }
    const inputs = await loadPlanInputs(db, ids, {
      readerWritten: [],
      libraryFolder: ARRIVAL_AREA_FOLDERS.main,
      ebook: this.deps.stage8?.overlay() ?? null,
    });
    const full = await planBuildSliced(inputs);
    const chosen = full.books.filter((b) => linkCopies.has(b.copyKey) && b.state === 'build');
    const tree = await this.existingTree();
    const plan = planArrivals(chosen, tree);
    // Every planned source re-checked (size, mtime, inode): a changed file waits for the next run.
    const changed = new Set<number>();
    for (let i = 0; i < plan.books.length; i++) {
      for (const f of [...plan.books[i].files, ...plan.books[i].pdfs]) {
        const src = inputs.files.get(f.fileId);
        if (!src) {
          changed.add(i);
          continue;
        }
        const st = await lstatEntry(insideRoot(this.deps.roots.torrents, src.rel, src.raw)).catch(
          () => null,
        );
        if (
          !st ||
          st.size !== src.size ||
          Math.floor(st.mtimeMs) !== src.mtimeMs ||
          st.ino !== src.ino
        )
          changed.add(i);
      }
    }
    const put = db.prepare(
      `INSERT INTO audio_arrival_books (run_id, unit_key, copy_key, area, state, folder, base_folder, author,
         series, title, notes_json, files, pdfs, metadata, design)
       VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const putOp = db.prepare(
      `INSERT INTO audio_arrival_ops (run_id, book_id, kind, dst, book_folder, src_file_id, src_rel, src_raw,
         size, mtime_ms, dev, ino) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids2: number[] = [];
    db.transaction(() => {
      plan.books.forEach((b, i) => {
        if (changed.has(i)) {
          db.prepare(
            `UPDATE audio_arrivals SET outcome = 'waiting', reason = 'A file changed since the walk (still downloading or being copied)'
             WHERE run_id = ? AND unit_key = ?`,
          ).run(p.runId, b.unitKey);
          ids2.push(-1);
          return;
        }
        ids2.push(
          Number(
            put.run(
              p.runId,
              b.unitKey,
              b.copyKey,
              b.area,
              b.folder,
              b.baseFolder,
              b.author,
              b.series,
              b.title,
              JSON.stringify({ notes: b.notes, planned: b.planned, narrator: b.narrator }),
              b.files.length,
              b.pdfs.length,
              b.metadata,
              designOf.get(b.unitKey) ?? 'E',
            ).lastInsertRowid,
          ),
        );
      });
      for (const o of plan.ops) {
        const bookId = ids2[o.book];
        if (bookId < 0) continue;
        const b = plan.books[o.book];
        const f = o.srcFileId !== null ? inputs.files.get(o.srcFileId) : null;
        putOp.run(
          p.runId,
          bookId,
          o.kind,
          o.dst,
          b.folder,
          o.srcFileId,
          f?.rel ?? null,
          f?.raw ?? null,
          f?.size ?? null,
          f?.mtimeMs ?? null,
          f?.dev ?? null,
          f?.ino ?? null,
        );
      }
    })();
    const kept = plan.books.filter((_, i) => !changed.has(i));
    p.plan = { ...plan.counts, books: kept.length };
    p.build.total = (
      db.prepare('SELECT COUNT(*) AS n FROM audio_arrival_ops WHERE run_id = ?').get(p.runId) as {
        n: number;
      }
    ).n;
    if (changed.size && p.classify) {
      p.classify.new -= changed.size;
      p.classify.waiting += changed.size;
    }
    // Preview ends with the plan; On builds (when there is anything to build).
    if (p.mode !== 'on') this.setPhase(p, 'changes', kept.length);
    else if (p.build.total === 0) {
      // Nothing to build: the report still shows ABS's item count before and after the run.
      p.abs.before = await this.absItemCount(p).catch(() => null);
      this.setPhase(p, 'changes', 0);
    } else {
      p.abs.before = await this.absItemCount(p).catch(() => null);
      this.setPhase(p, 'walk_before', kept.length);
    }
  }

  // walks, build, check -----------------------------------------------------------------------

  private async walkStep(p: Stage7Progress, stop: () => boolean): Promise<'wait' | 'more'> {
    const phase = p.phase === 'walk_before' ? 'before' : 'after';
    const media = this.deps.roots.media;
    const roots: [string, string][] = [
      ['torrents', this.deps.roots.torrents],
      ['library', this.deps.roots.library],
      ...(media
        ? ([['generated', path.join(media, ARRIVAL_AREA_FOLDERS.ai)]] as [string, string][])
        : []),
    ];
    for (const [name, dir] of roots) {
      const have = this.db
        .prepare('SELECT 1 FROM audio_arrival_walks WHERE run_id = ? AND phase = ? AND root = ?')
        .get(p.runId, phase, name);
      if (have) continue;
      const t = this.now();
      p.waiting = this.deps.lock.calibreBusy()
        ? 'Waiting while the Calibre cleanup uses the disk'
        : `Listing the ${name === 'torrents' ? 'torrents' : name === 'library' ? 'library' : 'AI books'} (${phase} the build)`;
      p.walk = {
        root: name,
        done: 0,
        total: this.walkEstimate(p.runId, phase, name),
        startedAt: t,
      };
      this.save(p);
      let last = 0;
      const w = await walkTree(dir, {
        shouldStop: stop,
        shouldPause: () => this.deps.lock.calibreBusy(),
        onEntries: (n) => {
          p.walk!.done = n;
          if (this.now() - last > 2000) {
            last = this.now();
            this.save(p);
          }
        },
      });
      if (!w) return 'wait';
      this.db
        .prepare(
          'INSERT INTO audio_arrival_walks (run_id, phase, root, entries, data) VALUES (?, ?, ?, ?, ?)',
        )
        .run(p.runId, phase, name, w.entries.length, gz(w.entries));
      p.walks[`${phase}:${name}`] = {
        entries: w.entries.length,
        ms: this.now() - t,
        pausedMs: w.pausedMs,
      };
      p.phaseWaitMs = (p.phaseWaitMs ?? 0) + w.pausedMs;
      this.save(p);
    }
    this.setPhase(p, phase === 'before' ? 'build' : 'check');
    return 'more';
  }

  /**
   * How many entries a walk will list (for its bar): the walk before's count for the walk after;
   * before the build, stage 1's files of that root and their folders.
   */
  private walkEstimate(runId: number, phase: 'before' | 'after', root: string): number {
    if (phase === 'after') {
      const r = this.db
        .prepare(
          `SELECT entries FROM audio_arrival_walks WHERE run_id = ? AND phase = 'before' AND root = ?`,
        )
        .get(runId, root) as { entries: number } | undefined;
      if (r) return r.entries;
    }
    if (root === 'generated') return 0;
    const dirs = new Set<string>();
    let files = 0;
    for (const r of this.db
      .prepare(`SELECT rel_path FROM audio_files WHERE root = ? AND gone_at IS NULL`)
      .all(root) as { rel_path: string }[]) {
      files++;
      const parts = r.rel_path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return files + dirs.size;
  }

  private walkOf(runId: number, phase: 'before' | 'after', root: string): ManifestEntry[] {
    const r = this.db
      .prepare('SELECT data FROM audio_arrival_walks WHERE run_id = ? AND phase = ? AND root = ?')
      .get(runId, phase, root) as { data: Buffer } | undefined;
    return r ? ungz<ManifestEntry[]>(r.data) : [];
  }

  /**
   * Opens (`waiting` true) or closes the current phase's wait for Calibre; a closed wait is left
   * out of the phase's time. Safe to call repeatedly with the same answer.
   */
  private waitForCalibre(p: Stage7Progress, waiting: boolean): void {
    const now = this.now();
    if (waiting) p.calibreWaitSince ??= now;
    else if (p.calibreWaitSince != null) {
      p.phaseWaitMs = (p.phaseWaitMs ?? 0) + (now - p.calibreWaitSince);
      p.calibreWaitSince = null;
    }
  }

  /** Takes the disk lock for a turn (Calibre first); counts the wait. */
  private async holdTurn(p: Stage7Progress, stop: () => boolean): Promise<void> {
    const lock = this.deps.lock;
    if (lock.holds(OWNER) && lock.shouldYield(OWNER) && !this.inFlight()) {
      lock.release(OWNER);
      this.handing = false;
      p.build.yields++;
    }
    if (!lock.holds(OWNER)) {
      // The wait counts from its start to the turn that gets the disk (the loop's pauses
      // between turns included).
      p.build.waitSince ??= this.now();
      const got = await Promise.race([
        lock.acquire(OWNER, 'audio', stop),
        sleep(HOLD_MS).then(() => false),
      ]);
      if (!got && !lock.holds(OWNER)) return;
    }
    if (p.build.waitSince) {
      const waited = this.now() - p.build.waitSince;
      p.build.lockWaitMs += waited;
      p.phaseWaitMs = (p.phaseWaitMs ?? 0) + waited;
      p.build.waitSince = null;
    }
    this.handing = lock.holds(OWNER) && !lock.shouldYield(OWNER);
  }

  private async buildStep(p: Stage7Progress, stop: () => boolean): Promise<'wait' | 'more'> {
    this.expireLeases();
    this.refreshBuild(p);
    if (p.build.failed > 0) {
      const m = p.build.firstFailure ?? 'An operation failed';
      pauseAudioStage(this.db, STAGE7, 'build_failed', m);
      this.giveBack();
      return 'wait';
    }
    if (p.build.done >= p.build.total) {
      this.giveBack();
      this.db
        .prepare(
          `UPDATE audio_arrival_books SET state = 'built', built_at = ? WHERE run_id = ? AND state = 'planned'`,
        )
        .run(this.now(), p.runId);
      this.setPhase(p, 'walk_after', p.build.done);
      return 'more';
    }
    if (!this.sidecarReady()) {
      p.waiting = `Waiting for the linking sidecar ${ARRIVAL_SIDECAR_VERSION} or newer`;
      this.save(p);
      return 'wait';
    }
    await this.holdTurn(p, stop);
    p.waiting = this.handing
      ? 'Adding the new books (folders, links, metadata.json)'
      : 'Waiting for the disk (Calibre first)';
    this.save(p);
    return 'wait';
  }

  private refreshBuild(p: Stage7Progress): void {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM audio_arrival_ops WHERE run_id = ? GROUP BY state')
      .all(p.runId) as { state: string; n: number }[];
    const n = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    p.build.done = n('done');
    p.build.failed = n('failed');
  }

  private async checkStep(p: Stage7Progress, stop: () => boolean): Promise<void> {
    const lines: string[] = [];
    let passed = true;
    const ops = this.db
      .prepare(
        `SELECT o.kind, o.dst, o.dev, o.ino, o.src_rel, o.book_id, o.result_json FROM audio_arrival_ops o WHERE o.run_id = ?`,
      )
      .all(p.runId) as {
      kind: 'folder' | 'link' | 'pdf' | 'metadata';
      dst: string;
      dev: number | null;
      ino: number | null;
      src_rel: string | null;
      book_id: number;
      result_json: string | null;
    }[];
    // 1. The new folders: every planned entry as planned, nothing extra in the new books' folders.
    const books = this.db
      .prepare(
        `SELECT id, folder, metadata, area FROM audio_arrival_books WHERE run_id = ? AND state = 'built'`,
      )
      .all(p.runId) as { id: number; folder: string; metadata: Buffer; area: string }[];
    const media = this.deps.roots.media;
    if (!media)
      throw new Error('CLEANUP_AUDIO_MEDIA_DIR is not set: the new folders can’t be checked');
    let entriesOk = 0;
    let wrong = 0;
    let extra = 0;
    let metaOk = 0;
    let metaAbs = 0;
    const sampleSize = getSettings(this.db).audiobooks.buildRehashSample;
    p.walk = { root: 'check', done: 0, total: books.length + sampleSize, startedAt: this.now() };
    this.save(p);
    for (const b of books) {
      p.walk.done++;
      const w = await walkTree(path.join(media, ...b.folder.split('/')), {
        shouldStop: stop,
        shouldPause: () => this.deps.lock.calibreBusy(),
      });
      const entries = (w?.entries ?? []).map((e) => ({ ...e, rel: `${b.folder}/${e.rel}` }));
      const planned = ops
        .filter((o) => o.book_id === b.id && o.dst !== b.folder && o.dst.startsWith(b.folder + '/'))
        .map((o) => ({ kind: o.kind, dst: o.dst, dev: o.dev, ino: o.ino }));
      const r = compareNewTree(
        entries.filter((e) => !/^cover\.(jpe?g|png|webp)$/i.test(e.rel.split('/').pop() ?? '')),
        planned,
      );
      entriesOk += r.links.ok + r.pdfs.ok + r.folders.ok + r.metadata.present;
      wrong += r.wrongCount;
      extra += r.extraCount;
      const meta = await readSmall(insideRoot(media, `${b.folder}/metadata.json`), 1024 * 1024);
      if (meta && meta.equals(b.metadata)) metaOk++;
      else if (meta) metaAbs++; // Audiobookshelf rewrote it in its own form after its scan
    }
    lines.push(
      `New books: ${books.length}; planned entries in place ${entriesOk}, wrong ${wrong}, extra ${extra}`,
    );
    lines.push(`metadata.json: ${metaOk} as planned, ${metaAbs} rewritten by Audiobookshelf`);
    if (wrong || extra) passed = false;
    // 2. The torrents: unchanged but for the links made (and nothing new outside _extracted).
    const linksTo = new Map<string, number>();
    for (const o of ops)
      if ((o.kind === 'link' || o.kind === 'pdf') && o.src_rel)
        linksTo.set(o.src_rel, (linksTo.get(o.src_rel) ?? 0) + 1);
    const t = compareManifests(
      this.walkOf(p.runId, 'before', 'torrents'),
      this.walkOf(p.runId, 'after', 'torrents'),
      linksTo,
    );
    const tAdded = t.added.filter((a) => !a.startsWith('_extracted/'));
    lines.push(
      `Torrents: ${t.counts.added} added (${tAdded.length} outside _extracted), ${t.counts.removed} removed, ${t.counts.changed} changed, ${t.linkedAsPlanned} linked as planned, ${t.counts.nlinkWrong} link counts wrong`,
    );
    if (tAdded.length || t.counts.removed || t.counts.changed || t.counts.nlinkWrong)
      passed = false;
    // 3. The library: every existing entry unchanged; new entries only the new books'; folders
    // above a new book may have a new mtime (a folder was made in them).
    const madeIn = new Set<string>();
    for (const o of ops) {
      const parts = o.dst.split('/');
      for (let i = 1; i < parts.length; i++) madeIn.add(parts.slice(0, i).join('/'));
    }
    for (const [root, prefix] of [
      ['library', ARRIVAL_AREA_FOLDERS.main],
      ['generated', ARRIVAL_AREA_FOLDERS.ai],
    ] as const) {
      const before = this.walkOf(p.runId, 'before', root);
      const after = this.walkOf(p.runId, 'after', root);
      const d = compareManifests(before, after, new Map());
      const plannedPaths = new Set(ops.map((o) => o.dst));
      // WP21f-2: the reader writes its AI books into japanese-generated/ at any time: a new file
      // there with no other name (link count 1: never one of ours, which are hard links to the
      // torrents) is the reader's, and so are the folders it made for it and their mtimes.
      const readerOwn = new Set<string>();
      if (root === 'generated')
        for (const e of after)
          if (!e.isDir && e.nlink === 1) {
            const parts = e.rel.split('/');
            for (let i = 1; i <= parts.length; i++) readerOwn.add(parts.slice(0, i).join('/'));
          }
      const badAdded = d.added.filter(
        (a) => !plannedPaths.has(`${prefix}/${a}`) && !isAbsOwn(a) && !readerOwn.has(a),
      );
      const badChanged = d.changed.filter(
        (c) =>
          !(c.what === 'mtime' && (madeIn.has(`${prefix}/${c.path}`) || readerOwn.has(c.path))) &&
          !isAbsOwn(c.path),
      );
      lines.push(
        `${prefix}: ${d.counts.added} added (${badAdded.length} not planned), ${d.counts.removed} removed, ${badChanged.length} changed`,
      );
      if (badAdded.length || d.counts.removed || badChanged.length) passed = false;
    }
    // 4. A sample of the new links read again against stage 1's SHA-256.
    const s = getSettings(this.db).audiobooks;
    const sample = this.db
      .prepare(
        `SELECT o.dst, f.sha256 FROM audio_arrival_ops o JOIN audio_files f ON f.id = o.src_file_id
         WHERE o.run_id = ? AND o.kind = 'link' AND f.sha256 IS NOT NULL ORDER BY o.id LIMIT ?`,
      )
      .all(p.runId, s.buildRehashSample) as { dst: string; sha256: string }[];
    let same = 0;
    p.walk.total = books.length + sample.length;
    for (const x of sample) {
      p.walk.done++;
      this.save(p);
      const waitedFrom = this.now();
      while (this.deps.lock.calibreBusy() && !stop()) await sleep(1000);
      p.phaseWaitMs = (p.phaseWaitMs ?? 0) + (this.now() - waitedFrom);
      const h = await hashFile(insideRoot(media, x.dst), new ReadPacer(0), stop);
      if (h?.sha256 === x.sha256) same++;
    }
    lines.push(`Linked files read again: ${same} of ${sample.length} equal stage 1's SHA-256`);
    if (same !== sample.length) passed = false;
    p.check = { passed, lines };
    if (!passed) {
      this.save(p);
      pauseAudioStage(this.db, STAGE7, 'check', lines.join('; '));
    }
    this.setPhase(p, 'changes', books.length);
  }

  // Audiobookshelf ----------------------------------------------------------------------------

  private absClient(): AbsClient | null {
    const a = this.deps.abs();
    return a ? new AbsClient({ ...a, fetchImpl: this.deps.fetchImpl }) : null;
  }

  /** The library on <absMediaFolder>/japanese (whole paths; a podcasts library is not it). */
  private async absLibrary(client: AbsClient): Promise<{ id: string; name: string } | null> {
    const libs =
      (
        await client.get<{
          libraries?: { id: string; name?: string; folders?: { fullPath?: string }[] }[];
        }>('/libraries')
      )?.libraries ?? [];
    const root = getSettings(this.db).audiobooks.absMediaFolder;
    const want = `${root === '/' ? '' : root}/${ARRIVAL_AREA_FOLDERS.main}`;
    const lib = libs.find((l) =>
      (l.folders ?? []).some((f) => (f.fullPath ?? '').replace(/\/+$/, '') === want),
    );
    return lib ? { id: lib.id, name: lib.name ?? lib.id } : null;
  }

  private async absItemCount(p: Stage7Progress): Promise<number | null> {
    const client = this.absClient();
    if (!client) return null;
    const lib = await this.absLibrary(client);
    if (!lib) return null;
    p.abs.library = lib.name;
    const r = await client.get<{ total?: number }>(
      `/libraries/${encodeURIComponent(lib.id)}/items?limit=1&minified=1`,
    );
    return r?.total ?? null;
  }

  private async absStep(p: Stage7Progress): Promise<'wait' | 'more'> {
    const books = this.db
      .prepare(
        `SELECT id, folder, metadata, abs_item_id FROM audio_arrival_books WHERE run_id = ? AND state = 'built' AND area = 'main'`,
      )
      .all(p.runId) as {
      id: number;
      folder: string;
      metadata: Buffer;
      abs_item_id: string | null;
    }[];
    const client = this.absClient();
    if (!client) {
      p.abs.error = 'Audiobookshelf is not set up (address and API key)';
      this.setPhase(p, 'report');
      return 'more';
    }
    if (!books.length) {
      // No new book to look for: only the item count after the run (the library changes may
      // have scanned it).
      p.abs.after = await this.absItemCount(p).catch(() => null);
      this.setPhase(p, 'report');
      return 'more';
    }
    try {
      const lib = await this.absLibrary(client);
      if (!lib) throw new Error('Audiobookshelf has no library on …/japanese');
      p.abs.library = lib.name;
      const full = (await client.get<{ settings?: { metadataPrecedence?: string[] } }>(
        `/libraries/${encodeURIComponent(lib.id)}`,
      )) as {
        settings?: { metadataPrecedence?: string[] };
      } | null;
      const prec = full?.settings?.metadataPrecedence ?? null;
      p.abs.precedence = prec ? prec.join(' < ') : null;
      // Every item's relPath (paged, minified).
      const items = new Map<string, { id: string }>();
      let total = 0;
      for (let page = 0; ; page++) {
        const r = await client.get<{
          results?: { id: string; relPath?: string }[];
          total?: number;
        }>(`/libraries/${encodeURIComponent(lib.id)}/items?limit=500&page=${page}&minified=1`);
        const res = r?.results ?? [];
        total = r?.total ?? total;
        for (const it of res)
          if (it.relPath) items.set(it.relPath.replace(/\\/g, '/'), { id: it.id });
        if (res.length < 500) break;
      }
      p.abs.after = total;
      const prefix = `${ARRIVAL_AREA_FOLDERS.main}/`;
      let found = 0;
      let valuesOk = 0;
      let valuesDiffer = 0;
      const missing: typeof books = [];
      for (const b of books) {
        const it = items.get(b.folder.slice(prefix.length));
        if (!it) {
          missing.push(b);
          continue;
        }
        found++;
        const item = await client.get<{ media?: { metadata?: Record<string, unknown> } }>(
          `/items/${encodeURIComponent(it.id)}`,
        );
        const ok = absValuesAgree(
          item?.media?.metadata ?? null,
          JSON.parse(b.metadata.toString('utf8')) as Record<string, unknown>,
        );
        if (ok) valuesOk++;
        else valuesDiffer++;
        this.db
          .prepare('UPDATE audio_arrival_books SET abs_item_id = ?, abs_json = ? WHERE id = ?')
          .run(it.id, JSON.stringify({ agrees: ok }), b.id);
      }
      p.abs.found = found;
      p.abs.missing = missing.length;
      p.abs.valuesOk = valuesOk;
      p.abs.valuesDiffer = valuesDiffer;
      p.abs.error = null;
      if (missing.length === 0) {
        this.setPhase(p, 'report');
        return 'more';
      }
      const s = getSettings(this.db).audiobooks;
      p.abs.waitingSince ??= this.now();
      const waited = this.now() - p.abs.waitingSince;
      if (waited < s.arrivalsAbsWaitMinutes * 60_000) {
        p.waiting = `Waiting for Audiobookshelf to show ${missing.length} new book${missing.length === 1 ? '' : 's'} (its watcher), up to ${s.arrivalsAbsWaitMinutes} min`;
        this.save(p);
        return 'wait';
      }
      if (s.arrivalsAbsNudge && p.abs.nudged === 0) {
        const a = this.deps.abs()!;
        const nudge = new AbsWatchNotifier({ ...a, fetchImpl: this.deps.fetchImpl });
        const root = s.absMediaFolder === '/' ? '' : s.absMediaFolder;
        for (const b of missing) {
          const files = this.db
            .prepare(`SELECT dst FROM audio_arrival_ops WHERE book_id = ? AND kind = 'link'`)
            .all(b.id) as { dst: string }[];
          for (const f of files) await nudge.fileAdded(lib.id, `${root}/${f.dst}`);
          p.abs.nudged++;
        }
        p.abs.waitingSince = this.now();
        p.waiting = `Told Audiobookshelf about ${missing.length} new book${missing.length === 1 ? '' : 's'}; waiting again`;
        this.save(p);
        return 'wait';
      }
      for (const b of missing)
        this.db
          .prepare(
            `INSERT INTO audio_arrival_reviews (review_key, kind, unit_key, title, detail_json, first_run_id, last_run_id)
             VALUES (?, 'abs_missing', NULL, ?, ?, ?, ?)
             ON CONFLICT(review_key) DO UPDATE SET last_run_id = excluded.last_run_id, resolved_at = NULL`,
          )
          .run(
            `abs:${b.folder}`,
            b.folder,
            JSON.stringify({ folder: b.folder, nudged: p.abs.nudged > 0 }),
            p.runId,
            p.runId,
          );
      this.setPhase(p, 'report');
      return 'more';
    } catch (err) {
      p.abs.error = (err as Error).message.slice(0, 300);
      this.setPhase(p, 'report');
      return 'more';
    }
  }

  // report ------------------------------------------------------------------------------------

  private reportStep(p: Stage7Progress): void {
    const db = this.db;
    const outcomes = Object.fromEntries(
      (
        db
          .prepare(
            'SELECT outcome, COUNT(*) AS n FROM audio_arrivals WHERE run_id = ? GROUP BY outcome',
          )
          .all(p.runId) as {
          outcome: string;
          n: number;
        }[]
      ).map((r) => [r.outcome, r.n]),
    );
    const newReview = (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM audio_arrival_reviews WHERE first_run_id = ? AND resolved_at IS NULL',
        )
        .get(p.runId) as {
        n: number;
      }
    ).n;
    const openReview = (
      db
        .prepare('SELECT COUNT(*) AS n FROM audio_arrival_reviews WHERE resolved_at IS NULL')
        .get() as { n: number }
    ).n;
    const s5 = getAudioStage(db, 5).progress as { analysisId?: string };
    const cost = s5.analysisId ? runSpend(db, 'audio5', s5.analysisId) : null;
    const added =
      p.mode === 'on'
        ? (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM audio_arrival_books WHERE run_id = ? AND state = 'built'`,
              )
              .get(p.runId) as { n: number }
          ).n
        : 0;
    const report = {
      mode: p.mode,
      added,
      planned: p.plan?.books ?? 0,
      outcomes,
      classify: p.classify,
      archives: p.archives,
      abs: p.abs,
      newReview,
      openReview,
      aiCostUsd: cost?.costUsd ?? 0,
      designs: designCounts(db, 'audio5'),
      times: p.phaseTimes,
      lockWaitMs: p.build.lockWaitMs,
      yields: p.build.yields,
      check: p.check,
      // WP21f-2: the changes to books already in the library (planned in Preview, made in On).
      changes: p.changes
        ? {
            mode: p.changes.mode,
            ledger: p.changes.ledger,
            candidates: p.changes.candidates,
            seen: p.changes.seen,
            counts: p.changes.counts,
            apply: p.changes.apply,
            snapshot: p.changes.snapshot,
            remap: p.changes.remap,
            abs: p.changes.abs,
            times: p.changes.phaseTimes,
            error: p.changes.error,
          }
        : null,
    };
    db.prepare('UPDATE audio_arrival_runs SET report_json = ? WHERE id = ?').run(
      JSON.stringify(report),
      p.runId,
    );
    this.setPhase(p, 'done');
    this.finish(p, 'done', null);
  }

  // the sidecar -------------------------------------------------------------------------------

  private sidecarReady(): boolean {
    const r = this.db
      .prepare('SELECT version, last_seen_at FROM link_sidecar_status WHERE id = 1')
      .get() as { version: string | null; last_seen_at: number | null } | undefined;
    return (
      !!r?.last_seen_at &&
      this.now() - r.last_seen_at < 90_000 &&
      versionAtLeast(r.version, ARRIVAL_SIDECAR_VERSION)
    );
  }

  /** The sidecar should poll fast (a run lists, unpacks or builds). */
  active(): boolean {
    const p = this.current();
    return (
      !!p &&
      (p.phase === 'archives' ||
        p.phase === 'build' ||
        (p.phase === 'changes' &&
          (p.changes?.phase === 'preflight' || p.changes?.phase === 'apply')))
    );
  }

  giveBack(): void {
    this.handing = false;
    if (this.deps.lock.holds(OWNER) && !this.inFlight()) this.deps.lock.release(OWNER);
  }

  private inFlight(now = this.now()): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM audio_arrival_batches WHERE state = 'claimed' AND lease_until >= ? LIMIT 1`,
        )
        .get(now) !== undefined
    );
  }

  expireLeases(now = this.now()): number {
    const expired = this.db
      .prepare(
        `SELECT id, kind FROM audio_arrival_batches WHERE state = 'claimed' AND lease_until < ?`,
      )
      .all(now) as { id: number; kind: string }[];
    if (!expired.length) return 0;
    this.db.transaction(() => {
      for (const b of expired) {
        this.db
          .prepare(`UPDATE audio_arrival_batches SET state = 'expired' WHERE id = ?`)
          .run(b.id);
        this.db
          .prepare(
            `UPDATE audio_arrival_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(b.id);
        this.db
          .prepare(
            `UPDATE audio_archive_entries SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(b.id);
      }
    })();
    return expired.length;
  }

  private newBatch(
    runId: number,
    kind: 'build' | 'list' | 'extract',
    ops: number,
    leaseSeconds: number,
  ): number {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO audio_arrival_batches (run_id, kind, state, ops, claimed_at, lease_until) VALUES (?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(runId, kind, ops, now, now + leaseSeconds * 1000).lastInsertRowid,
    );
  }

  /** The sidecar's next batch of stage 7, or null. */
  claim(): ArrivalBatch | LibraryBatch | null {
    this.expireLeases();
    const p = this.current();
    const st = getAudioStage(this.db, STAGE7);
    if (!p || st.mode === 'off' || st.pauseReason) return null;
    if (p.phase === 'changes' && p.changes) return this.changes.claim(p.runId, p.changes);
    if (!this.sidecarReady() || this.inFlight()) return null;
    const s = getSettings(this.db).audiobooks;
    if (p.phase === 'archives') {
      const next = this.settledArchives()[0];
      if (next && !this.deps.lock.calibreBusy()) {
        const a = this.db
          .prepare('SELECT * FROM audio_archives WHERE id = ?')
          .get(next.id) as ArchiveRow;
        const id = this.newBatch(p.runId, 'list', 1, s.buildLeaseSeconds);
        return {
          id,
          kind: 'list',
          leaseSeconds: s.buildLeaseSeconds,
          ops: [{ ...archiveSource(a), id: a.id, kind: 'folder', dst: '', bytes: null }],
        };
      }
      if (
        !next &&
        this.handing &&
        this.deps.lock.holds(OWNER) &&
        !this.deps.lock.shouldYield(OWNER)
      ) {
        const e = this.db
          .prepare(
            `SELECT e.*, a.rel, a.raw, a.size AS a_size, a.mtime_ms, a.dev, a.ino, a.encoding
             FROM audio_archive_entries e JOIN audio_archives a ON a.id = e.archive_id
             WHERE e.state = 'planned' AND a.state = 'listed' ORDER BY e.archive_id, e.seq LIMIT 1`,
          )
          .get() as (EntryRow & ArchiveJoin) | undefined;
        if (!e) return null;
        const id = this.newBatch(p.runId, 'extract', 1, s.extractLeaseSeconds);
        this.db
          .prepare(
            `UPDATE audio_archive_entries SET state = 'claimed', batch_id = ? WHERE archive_id = ? AND seq = ?`,
          )
          .run(id, e.archive_id, e.seq);
        return {
          id,
          kind: 'extract',
          leaseSeconds: s.extractLeaseSeconds,
          ops: [
            {
              id: e.archive_id * 100000 + e.seq,
              kind: 'folder',
              dst: e.dst!,
              src: { rel: e.rel, raw: e.raw },
              size: e.a_size,
              mtimeMs: e.mtime_ms,
              dev: e.dev,
              ino: e.ino,
              bytes: null,
              entry: {
                name: e.name,
                size: e.size,
                encoding: (e.encoding as 'utf8' | 'cp932') ?? 'utf8',
              },
            },
          ],
        };
      }
      return null;
    }
    if (p.phase === 'build' && p.mode === 'on') {
      if (!this.handing || !this.deps.lock.holds(OWNER) || this.deps.lock.shouldYield(OWNER))
        return null;
      const rows = this.db
        .prepare(
          `SELECT * FROM audio_arrival_ops WHERE run_id = ? AND state = 'planned' ORDER BY id LIMIT ?`,
        )
        .all(p.runId, s.buildBatchOps) as OpRow[];
      if (!rows.length) return null;
      const id = this.newBatch(p.runId, 'build', rows.length, s.buildLeaseSeconds);
      const bookOf = this.db.prepare(
        'SELECT folder, metadata, notes_json FROM audio_arrival_books WHERE id = ?',
      );
      const books = new Map<number, { folder: string; metadata: Buffer; planned: string[] }>();
      this.db.transaction(() => {
        const upd = this.db.prepare(
          `UPDATE audio_arrival_ops SET state = 'claimed', batch_id = ? WHERE id = ?`,
        );
        for (const r of rows) upd.run(id, r.id);
      })();
      p.build.batches++;
      p.build.startedAt ??= this.now();
      this.save(p);
      return {
        id,
        kind: 'arrival',
        leaseSeconds: s.buildLeaseSeconds,
        ops: rows.map((r) => {
          let b = books.get(r.book_id);
          if (!b) {
            const x = bookOf.get(r.book_id) as {
              folder: string;
              metadata: Buffer;
              notes_json: string;
            };
            b = {
              folder: x.folder,
              metadata: x.metadata,
              planned: (JSON.parse(x.notes_json) as { planned: string[] }).planned,
            };
            books.set(r.book_id, b);
          }
          return {
            id: r.id,
            kind: r.kind,
            dst: r.dst,
            src: r.src_rel === null ? null : { rel: r.src_rel, raw: r.src_raw },
            size: r.size,
            mtimeMs: r.mtime_ms,
            dev: r.dev,
            ino: r.ino,
            bytes: r.kind === 'metadata' ? b.metadata.toString('base64') : null,
            book: b.folder,
            planned: b.planned,
          };
        }),
      };
    }
    return null;
  }

  /** The sidecar's results of a batch of stage 7. */
  report(batchId: number, results: ArrivalOpResult[]): { accepted: number } {
    if (batchId >= LIBRARY_BATCH_BASE)
      return this.changes.report(batchId, results as unknown as LibraryOpResult[]);
    const batch = this.db
      .prepare('SELECT * FROM audio_arrival_batches WHERE id = ?')
      .get(batchId) as
      | { id: number; run_id: number; kind: 'build' | 'list' | 'extract'; state: string }
      | undefined;
    if (!batch) throw new Error('No such batch');
    const now = this.now();
    let accepted = 0;
    const p = this.runProgress(batch.run_id);
    this.db.transaction(() => {
      if (batch.kind === 'list') {
        for (const r of results) accepted += this.takeListing(r.id, r, batch.run_id);
      } else if (batch.kind === 'extract') {
        for (const r of results) {
          const archiveId = Math.floor(r.id / 100000);
          const seq = r.id % 100000;
          const res = this.db
            .prepare(
              `UPDATE audio_archive_entries SET state = ?, result_json = ?, done_at = ? WHERE archive_id = ? AND seq = ? AND batch_id = ?`,
            )
            .run(
              r.ok ? 'done' : 'failed',
              JSON.stringify({
                error: r.error ?? null,
                bytes: r.bytes ?? null,
                existed: r.existed ?? false,
              }),
              now,
              archiveId,
              seq,
              batchId,
            );
          accepted += res.changes;
          if (r.ok && !r.existed && p) p.archives.thisRun++;
          if (!r.ok && /passphrase|encrypt|password/i.test(r.error ?? '')) {
            this.db
              .prepare(
                `UPDATE audio_archives SET state = 'password', detail = ?, updated_at = ? WHERE id = ?`,
              )
              .run((r.error ?? '').slice(0, 300), now, archiveId);
            this.db
              .prepare(
                `UPDATE audio_archive_entries SET state = 'skipped' WHERE archive_id = ? AND state = 'planned'`,
              )
              .run(archiveId);
            this.review('archive', `archive:${archiveId}`, null, archiveId, batch.run_id);
          }
        }
        this.db
          .prepare(
            `UPDATE audio_archive_entries SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(batchId);
      } else {
        const ok = this.db.prepare(
          `UPDATE audio_arrival_ops SET state = 'done', result_json = ?, done_at = ? WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
        );
        const bad = this.db.prepare(
          `UPDATE audio_arrival_ops SET state = 'failed', result_json = ?, done_at = ? WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
        );
        for (const r of results) {
          const json = JSON.stringify({
            existed: r.existed ?? false,
            dev: r.dev ?? null,
            ino: r.ino ?? null,
            absRewrote: r.absRewrote ?? false,
            error: r.error ?? null,
          });
          if (r.ok) accepted += ok.run(json, now, r.id, batchId).changes;
          else {
            accepted += bad.run(json, now, r.id, batchId).changes;
            if (p) p.build.firstFailure ??= `${r.error ?? 'failed'} (operation ${r.id})`;
          }
        }
        this.db
          .prepare(
            `UPDATE audio_arrival_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(batchId);
      }
      this.db
        .prepare(
          `UPDATE audio_arrival_batches SET state = 'reported', reported_at = ? WHERE id = ?`,
        )
        .run(now, batchId);
    })();
    if (p) {
      if (batch.kind === 'build') this.refreshBuild(p);
      else this.refreshArchiveCounts(p);
      this.save(p);
      if (p.build.firstFailure && batch.kind === 'build')
        pauseAudioStage(this.db, STAGE7, 'build_failed', p.build.firstFailure);
    }
    return { accepted };
  }

  /** An archive's listing: its entries planned (dst under _extracted), or why it can't be used. */
  private takeListing(archiveId: number, r: ArrivalOpResult, runId: number): number {
    const a = this.db.prepare('SELECT * FROM audio_archives WHERE id = ?').get(archiveId) as
      | ArchiveRow
      | undefined;
    if (!a || a.state !== 'new') return 0;
    const now = this.now();
    const problem = r.listProblem ?? (r.ok ? null : (r.error ?? 'failed'));
    if (problem) {
      const state = listProblemState(a.rel, problem);
      this.db
        .prepare(
          `UPDATE audio_archives SET state = ?, detail = ?, listed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(state, problem.slice(0, 500), now, now, archiveId);
      this.review('archive', `archive:${archiveId}`, null, archiveId, runId);
      return 1;
    }
    const entries = r.entries ?? [];
    const seen = new Set<string>();
    const rows = entries.map((e, seq) => {
      const name = e.name.replace(/^\.\//, '').replace(/\/+$/, '');
      let skip: string | null =
        e.kind === 'dir'
          ? 'folder'
          : e.kind !== 'file'
            ? 'a link or special entry'
            : entrySkip(name);
      const dst = `_extracted/${a.rel}/${name}`;
      if (!skip && seen.has(dst)) skip = 'the same name twice';
      seen.add(dst);
      return {
        seq,
        name,
        kind: e.kind,
        size: e.size,
        audio: e.kind === 'file' && isAudioName(name),
        skip,
        dst: skip ? null : dst,
      };
    });
    const audio = rows.filter((x) => x.audio && !x.skip);
    // An empty listing: bsdtar reads a file of zeros as an empty archive (found in the Linux
    // image); macOS's `._` metadata files are not archives at all.
    const base = a.rel.split('/').pop() ?? a.rel;
    const state = audio.length
      ? 'listed'
      : rows.length === 0 && base.startsWith('._')
        ? 'not_archive'
        : 'no_audio';
    this.db.prepare('DELETE FROM audio_archive_entries WHERE archive_id = ?').run(archiveId);
    const put = this.db.prepare(
      `INSERT INTO audio_archive_entries (archive_id, seq, name, kind, size, audio, skip, dst, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const x of rows)
      put.run(
        archiveId,
        x.seq,
        x.name,
        x.kind,
        x.size,
        x.audio ? 1 : 0,
        x.skip,
        x.dst,
        x.skip || state !== 'listed' ? 'skipped' : 'planned',
      );
    this.db
      .prepare(
        `UPDATE audio_archives SET state = ?, encoding = ?, entries = ?, audio_entries = ?, bytes = ?, audio_bytes = ?,
           detail = ?, listed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        r.encoding ?? 'utf8',
        rows.length,
        audio.length,
        rows.filter((x) => !x.skip).reduce((s, x) => s + x.size, 0),
        audio.reduce((s, x) => s + x.size, 0),
        state === 'no_audio'
          ? rows.length
            ? 'No audio file inside'
            : 'Empty, or not an archive bsdtar can read'
          : state === 'not_archive'
            ? 'macOS metadata (._ file), not an archive'
            : null,
        now,
        now,
        archiveId,
      );
    if (state !== 'listed') this.review('archive', `archive:${archiveId}`, null, archiveId, runId);
    return 1;
  }

  // the page ----------------------------------------------------------------------------------

  status() {
    const st = getAudioStage(this.db, STAGE7);
    const last = this.lastRun();
    return {
      mode: st.mode,
      pause: st.pauseReason ? { reason: st.pauseReason, detail: st.pauseDetail } : null,
      running: this.current() !== null,
      nextRunAt: this.current() ? null : this.nextRunAt(),
      timeZone: this.zone() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
      run: last?.progress ?? null,
      report: last?.report ?? null,
      sidecarReady: this.sidecarReady(),
      switched: librarySwitched(this.db),
      ...((u) => ({ designs: u.designs, upgrade: u }))(this.upgradeEstimate()),
      absWaitMinutes: getSettings(this.db).audiobooks.arrivalsAbsWaitMinutes,
      libraryChanges: getSettings(this.db).audiobooks.libraryChanges,
      openReviews: Object.fromEntries(
        (
          this.db
            .prepare(
              `SELECT kind, COUNT(*) AS n FROM audio_arrival_reviews WHERE resolved_at IS NULL GROUP BY kind`,
            )
            .all() as { kind: string; n: number }[]
        ).map((r) => [r.kind, r.n]),
      ),
    };
  }

  private upgradeCache: {
    at: number;
    key: string;
    value: ReturnType<AudioStage7['computeUpgrade']>;
  } | null = null;

  /**
   * What a library-wide F or J upgrade of stage 5 would re-check (recordings and fields) and its
   * expected cost at the stronger pair's prices (their measured answers, else the prompt's
   * length). Values already decided by that design or a stronger one are left out unless the
   * setting includes them. It reads every stage-5 value (about 120 ms on the PC at the live
   * library's size, measured at stop 1): computed again only when stage 5's decisions or the AI
   * settings change, and at most every 10 minutes otherwise (the page polls every few seconds).
   */
  upgradeEstimate() {
    const now = this.now();
    const s5 = getAudioStage(this.db, 5).progress as {
      analysisId?: string;
      phase?: string;
      decided?: number;
      finishedAt?: number | null;
    };
    const ai = getSettings(this.db);
    const ps = this.deps.aiSettings();
    const key = JSON.stringify([
      s5.analysisId,
      s5.phase,
      s5.decided,
      s5.finishedAt,
      ai.ai.upgradeIncludeDecided,
      ps.prices,
      ps.modes,
      ps.batchPriceFactor,
      ai.models['audio5.upgradePrimary'],
      ai.models['audio5.upgradeSecondary'],
    ]);
    if (this.upgradeCache && this.upgradeCache.key === key && now - this.upgradeCache.at < 600_000)
      return this.upgradeCache.value;
    const value = this.computeUpgrade();
    this.upgradeCache = { at: now, key, value };
    return value;
  }

  private computeUpgrade() {
    const s = getSettings(this.db);
    const models = [s.models['audio5.upgradePrimary'], s.models['audio5.upgradeSecondary']];
    const chars = 2600; // the audiobook prompt with a typical record (measured in WP21d: ~2,030 tokens)
    const ps = this.deps.aiSettings();
    const perItem = models.reduce((sum, m) => {
      const c = expectedListCost(this.db, ps, m, chars);
      return sum + c * (modeOfModel(ps, m) === 'batch' ? ps.batchPriceFactor : 1);
    }, 0);
    const out: Record<'F' | 'J', { items: number; fields: number; costUsd: number | null }> = {
      F: { items: 0, fields: 0, costUsd: 0 },
      J: { items: 0, fields: 0, costUsd: 0 },
    };
    for (const d of ['F', 'J'] as const) {
      const t = upgradeTargets(this.db, 'audio5', d, {
        includeDecided: s.ai.upgradeIncludeDecided,
      });
      const items = new Set(t.map((x) => x.itemKey)).size;
      out[d] = {
        items,
        fields: t.length,
        costUsd: Number.isFinite(perItem) ? items * perItem : null,
      };
    }
    return {
      ...out,
      includeDecided: s.ai.upgradeIncludeDecided,
      models,
      designs: designCounts(this.db, 'audio5'),
    };
  }

  /** Why stage 7 can't be switched On now (empty: it can). */
  async onRefusals(): Promise<string[]> {
    const out: string[] = [];
    if (!librarySwitched(this.db)) out.push('The library is not switched yet (WP21e-2)');
    if (!this.deps.roots.media) out.push('CLEANUP_AUDIO_MEDIA_DIR is not set');
    else {
      const stale = await staleLibraryMount(this.deps.roots);
      if (stale) out.push(stale);
    }
    if (!this.sidecarReady())
      out.push(`The linking sidecar ${ARRIVAL_SIDECAR_VERSION} or newer is not online`);
    return out;
  }

  resume(): void {
    const st = getAudioStage(this.db, STAGE7);
    if (!st.pauseReason) return;
    // A failed operation is safe to repeat: back to planned.
    this.db
      .prepare(
        `UPDATE audio_arrival_ops SET state = 'planned', batch_id = NULL WHERE state = 'failed'`,
      )
      .run();
    const p = this.current();
    if (p) {
      p.build.firstFailure = null;
      if (p.changes) {
        this.changes.retryFailed(p.runId);
        p.changes.error = null;
      }
      this.save(p);
    }
    resumeAudioStage(this.db, STAGE7);
  }

  /** The page's lists. */
  list(which: string, opts: { offset?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const run = this.row().currentRun ?? this.row().lastRun ?? 0;
    // WP21f-2: the library changes' lists (of the current run, else the last one).
    const changesList = {
      library_changes: 'changes',
      library_review: 'review',
      library_reader: 'reader',
      library_links: 'links',
      library_kept: 'kept',
    } as const;
    if (which in changesList)
      return this.changes.list(run, changesList[which as keyof typeof changesList], {
        offset,
        limit,
      });
    if (which === 'archives') {
      const total = (
        this.db.prepare('SELECT COUNT(*) AS n FROM audio_archives').get() as { n: number }
      ).n;
      const items = this.db
        .prepare(
          `SELECT id, rel, size, state, detail, entries, audio_entries, audio_bytes, encoding, listed_at, extracted_at
           FROM audio_archives ORDER BY state, rel LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
      return { total, items };
    }
    if (which.startsWith('review')) {
      const kind = which.split(':')[1] ?? null;
      const where = kind ? `resolved_at IS NULL AND kind = ?` : `resolved_at IS NULL`;
      const args = kind ? [kind] : [];
      const total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM audio_arrival_reviews WHERE ${where}`)
          .get(...args) as { n: number }
      ).n;
      const items = (
        this.db
          .prepare(
            `SELECT id, kind, title, detail_json, first_run_id, last_run_id, decision FROM audio_arrival_reviews
           WHERE ${where} ORDER BY kind, id LIMIT ? OFFSET ?`,
          )
          .all(...args, limit, offset) as { detail_json: string }[]
      ).map((r) => ({ ...r, detail: JSON.parse(r.detail_json), detail_json: undefined }));
      return { total, items };
    }
    if (which === 'plan') {
      const total = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM audio_arrival_books WHERE run_id = ?')
          .get(run) as { n: number }
      ).n;
      const items = this.db
        .prepare(
          `SELECT id, unit_key, area, state, folder, author, series, title, files, pdfs, design, abs_item_id, abs_json
           FROM audio_arrival_books WHERE run_id = ? ORDER BY folder LIMIT ? OFFSET ?`,
        )
        .all(run, limit, offset);
      return { total, items };
    }
    if (which === 'runs') {
      const total = (
        this.db.prepare('SELECT COUNT(*) AS n FROM audio_arrival_runs').get() as { n: number }
      ).n;
      const items = this.db
        .prepare(
          `SELECT id, trigger, mode, state, phase, started_at, finished_at, error, report_json FROM audio_arrival_runs
           ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
      return { total, items };
    }
    // An outcome of the last run (new, identical, duplicate, better, waiting, held, removed).
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM audio_arrivals WHERE run_id = ? AND outcome = ?')
        .get(run, which) as { n: number }
    ).n;
    const items = this.db
      .prepare(
        `SELECT unit_key, name, outcome, reason, design, detail_json FROM audio_arrivals
         WHERE run_id = ? AND outcome = ? ORDER BY name LIMIT ? OFFSET ?`,
      )
      .all(run, which, limit, offset);
    return { total, items };
  }

  /** A review choice: keep_current | use_new (better copies, applied by WP21f-2), add_anyway (held), dismiss, clear. */
  decide(reviewId: number, decision: string): void {
    const r = this.db
      .prepare('SELECT kind FROM audio_arrival_reviews WHERE id = ?')
      .get(reviewId) as { kind: string } | undefined;
    if (!r) throw new Error('No such review item');
    const allowed: Record<string, string[]> = {
      better_copy: ['keep_current', 'use_new', 'clear'],
      held: ['add_anyway', 'clear'],
      archive: ['dismiss', 'clear'],
      abs_missing: ['dismiss', 'clear'],
    };
    if (!allowed[r.kind]?.includes(decision))
      throw new Error(`Not a choice for this item: ${decision}`);
    this.db
      .prepare('UPDATE audio_arrival_reviews SET decision = ?, decided_at = ? WHERE id = ?')
      .run(
        decision === 'clear' ? null : decision,
        decision === 'clear' ? null : this.now(),
        reviewId,
      );
  }

  /** The plan of the last run as CSV. */
  planCsv(): string {
    const run = this.row().currentRun ?? this.row().lastRun ?? 0;
    const rows = this.db
      .prepare(
        `SELECT b.folder, b.state, b.design, b.title, o.kind, o.dst, o.src_rel FROM audio_arrival_books b
         JOIN audio_arrival_ops o ON o.book_id = b.id WHERE b.run_id = ? ORDER BY o.id`,
      )
      .all(run) as Record<string, string | null>[];
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return (
      '﻿' +
      [
        'folder,state,design,title,kind,destination,source',
        ...rows.map((r) =>
          [r.folder, r.state, r.design, r.title, r.kind, r.dst, r.src_rel].map(q).join(','),
        ),
      ].join('\r\n')
    );
  }
}

interface ArchiveRow {
  id: number;
  rel: string;
  raw: string | null;
  size: number;
  mtime_ms: number;
  dev: number;
  ino: number;
  state: string;
}

interface EntryRow {
  archive_id: number;
  seq: number;
  name: string;
  size: number;
  dst: string | null;
}

interface ArchiveJoin {
  rel: string;
  raw: string | null;
  a_size: number;
  mtime_ms: number;
  dev: number;
  ino: number;
  encoding: string | null;
}

interface OpRow {
  id: number;
  book_id: number;
  kind: 'folder' | 'link' | 'pdf' | 'metadata';
  dst: string;
  src_rel: string | null;
  src_raw: string | null;
  size: number | null;
  mtime_ms: number | null;
  dev: number | null;
  ino: number | null;
}

function archiveSource(a: ArchiveRow) {
  return {
    src: { rel: a.rel, raw: a.raw },
    size: a.size,
    mtimeMs: a.mtime_ms,
    dev: a.dev,
    ino: a.ino,
  };
}

function isAbsOwn(rel: string): boolean {
  return /(^|\/)(metadata\.json|cover\.(jpe?g|png|webp))$/i.test(rel);
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[\s・･]/g, '')
    .toLowerCase();

/**
 * Whether Audiobookshelf shows our metadata.json's values (title, authors, narrators, the
 * first series, ASIN): it reads that file first. ABS's own form (authors as objects, series as
 * {name, sequence}) is read too.
 */
export function absValuesAgree(
  abs: Record<string, unknown> | null,
  ours: Record<string, unknown>,
): boolean {
  if (!abs) return false;
  const names = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' ? x : ((x as { name?: string })?.name ?? ''))).map(norm)
      : [];
  if (norm(abs.title) !== norm(ours.title)) return false;
  const a1 = names(
    abs.authors ?? (typeof abs.authorName === 'string' ? abs.authorName.split(', ') : []),
  );
  // A field our metadata.json leaves empty is left to ABS's other sources (an unknown author's
  // book is under _Unknown/, which ABS shows as its author): only the values we set are compared.
  const mine = names(ours.authors);
  if (mine.length && mine.join('|') !== a1.join('|')) return false;
  const n1 = names(
    abs.narrators ?? (typeof abs.narratorName === 'string' ? abs.narratorName.split(', ') : []),
  );
  const myNarrators = names(ours.narrators);
  if (myNarrators.length && myNarrators.join('|') !== n1.join('|')) return false;
  const ourSeries = Array.isArray(ours.series) ? (ours.series as string[]) : [];
  const absSeries = Array.isArray(abs.series)
    ? (abs.series as { name?: string; sequence?: string | null }[]).map((s) =>
        typeof s === 'string' ? s : s.sequence ? `${s.name} #${s.sequence}` : `${s.name ?? ''}`,
      )
    : [];
  const sk = (l: string[]) => l.map(norm).sort().join('|');
  if (ourSeries.length && sk(ourSeries) !== sk(absSeries)) return false;
  if ((ours.asin ?? null) !== null && norm(abs.asin) !== norm(ours.asin)) return false;
  return true;
}
