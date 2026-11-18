/**
 * The library cleanup inside the storage server (Phase 6, WP20a): settings and secrets,
 * the safety checks (stage 0), the stage-1 analysis loop, batch planning and the sidecar's
 * reports. Everything runs on a small timer; every failure is caught and logged, and none
 * of it can affect reading (it only reads Calibre, and writes cleanup.db plus the
 * handoff's book_sources rows in ttsu.db).
 */
import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { snapshotFile } from '../calibre/indexer';
import { getIndexState, getLibrary, listLibraries } from '../calibre/libraries';
import { COUNTER_BUNDLE, readCounterInfo } from '../counts/counter-bundle';
import { BatchService, REMOVAL_STAGES } from './batches';
import { DISK_OWNERS, DiskLock } from './disk-lock';
import { presentBookCount } from './handoff';
import { SecretStore } from './secrets';
import { getSettings } from './settings';
import { Stage1Analysis, type Stage1Progress } from './stage1';
import { Stage2Analysis, type Stage2Progress } from './stage2';
import { listFieldPauses, loadGold, resumeField } from './stage2-gate';
import { STAGE3_WAITING_SQL, Stage3Analysis, type PairRow, type Stage3Progress } from './stage3';
import { Stage3Worker, type Stage3Reader } from '../counts/book-text-worker';
import { Stage4Analysis, type Stage4Progress } from './stage4/analysis';
import { paceSeconds, stage4Eta, type SiteCounts } from './stage4/eta';
import { FetchQueue, LABELED_PRIORITY, backoffKey } from './stage4/queue';
import { FETCH_SITES, type FetchSite } from './settings';
import {
  BUILT_STAGES,
  PREVIEW_ONLY_STAGES,
  CURRENT_PROPOSALS_SQL,
  currentAnalysisId,
  getStage,
  listStages,
  pauseStage,
  resumeStage,
  setStageMode,
  type StageMode,
  updateStage,
} from './stages';

export interface CheckResult {
  name: string;
  label: string;
  ok: boolean;
  detail: string | null;
  source: 'sidecar' | 'server';
  checkedAt: number | null;
  /** false = shown, but applying doesn't wait for it. */
  required: boolean;
}

export const CHECK_LABELS: Record<string, { label: string; required: boolean }> = {
  sidecar_online: { label: 'Apply sidecar is running', required: true },
  calibre_settings: {
    label: 'Content server address, user and password are set',
    required: true,
  },
  content_server: { label: 'Content server reachable', required: true },
  login: { label: 'Content server login works', required: true },
  library_found: { label: 'The library is found on the content server', required: true },
  versions_match: { label: "Sidecar's calibre matches the content server's", required: true },
  illustrator_column: {
    label: 'Custom column #illustrator exists (multiple text)',
    required: true,
  },
  quarantine_writable: { label: 'Quarantine folder writable, with free space', required: true },
  trash_restore: {
    label: "Undo can restore from Calibre's trash (calibre 9.18+)",
    required: false,
  },
  target_library: { label: 'Library to clean is chosen', required: true },
  reference_labels: {
    label: 'Labeled books for the stage 2 gate are found',
    required: false,
  },
  library_indexed: {
    label: "Reader's index of the library is ready (snapshot for each batch)",
    required: true,
  },
};

/** Sidecar results older than this count as not checked. */
export const CHECK_MAX_AGE_MS = 5 * 60 * 1000;
export const SIDECAR_OFFLINE_MS = 90 * 1000;
/** The page's time left for removing copies uses the pace of this recent window. */
export const PACE_WINDOW_MS = 20 * 60 * 1000;
const TICK_MS = 5000;

export interface SidecarHeartbeat {
  version?: unknown;
  calibredb?: unknown;
  serverVersion?: unknown;
  trashRestore?: unknown;
  problem?: unknown;
  checks?: unknown;
  /** The library ids the content server lists (`--with-library http://…/#-`). */
  libraries?: unknown;
}

/** The content server names a library after its folder, with spaces as underscores. */
export function libraryIdFromFolder(folder: string): string {
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  return name.replace(/\s/g, '_');
}

export interface CleanupServiceOptions {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string | null;
  cacheDir: string;
  /** Whether the reader's indexer is running (a snapshot exists per library). */
  indexerEnabled: () => boolean;
  /** DB_DIR: the default labeled-books file is <DB_DIR>/cleanup/reference-sample/gold800.json. */
  dbDir?: string | null;
  /** Stage 3: the reader's import settings (the same as its character counts use). */
  countImport?: unknown;
  /** Stage 3: a stand-in for the reader processes (tests). */
  stage3Reader?: Stage3Reader;
  /** Stage 3: the counter bundle's build id (read from the bundle when not given). */
  counterBuild?: string;
  /** The disk lock shared with the audiobook cleanup (WP21a); a new one when not given. */
  diskLock?: DiskLock;
  leaseSeconds?: number;
  log?: (m: string) => void;
  logError?: (m: string, err?: unknown) => void;
}

/** The counter bundle's build id (its header), or "unknown" when it can't be read. */
function counterBuild(): string {
  try {
    return readCounterInfo(COUNTER_BUNDLE).build;
  } catch {
    return 'unknown';
  }
}

function str(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
}

/**
 * Phases of the Calibre analyses that read book files (WP21a: they take the shared disk lock).
 * Stage 1 stat + hash, stage 2 read, stage 3 text + quality; the others work in the databases.
 */
export const DISK_PHASES: Record<number, readonly string[]> = {
  1: ['stat', 'hash'],
  2: ['read'],
  3: ['text', 'quality'],
  4: ['read'],
};

export class CleanupService {
  readonly secrets: SecretStore;
  /** One disk-heavy job at a time across the Calibre and audiobook cleanups (WP21a). */
  readonly diskLock: DiskLock;
  readonly batches: BatchService;
  readonly analysis: Stage1Analysis | null;
  readonly analysis2: Stage2Analysis | null;
  readonly analysis3: Stage3Analysis | null;
  /** Stage 4 (WP20d): the fetch queue and the online-sources analysis (Preview only). */
  readonly fetchQueue: FetchQueue;
  readonly analysis4: Stage4Analysis | null;
  private analysing4: Promise<void> | null = null;
  /** Why stage 4 is not working right now. */
  waiting4: string | null = null;
  private status4Cache: { at: number; value: unknown } | null = null;
  /** Books read at each status (the reading's measured rate over the last minutes). */
  private readMarks: { at: number; n: number; analysisId: string }[] = [];
  private labeled4Cache: { at: number; value: { site: string; n: number }[] } | null = null;
  private fields4Cache: {
    at: number;
    value: { field: string; class: string; n: number }[];
  } | null = null;
  private reader3: Stage3Reader | null = null;
  private analysing3: Promise<void> | null = null;
  /** Why stage 3 is not applying right now. */
  waiting3: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private analysing: Promise<void> | null = null;
  private analysing2: Promise<void> | null = null;
  private stopped = false;
  private readonly log: (m: string) => void;
  private readonly logError: (m: string, err?: unknown) => void;
  /** Why stage 1 is not applying right now (not a pause; it clears by itself). */
  waiting: string | null = null;
  /** The same for stage 2. */
  waiting2: string | null = null;

  constructor(private readonly opts: CleanupServiceOptions) {
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.secrets = new SecretStore(opts.cleanup, opts.main);
    this.diskLock = opts.diskLock ?? new DiskLock();
    // A batch being applied is Calibre's own disk work: audiobook jobs wait for it too.
    // A Calibre stage that is On with work left counts as using the disk also between its
    // batches (found live 2026-11-17: 2-6 min gaps while the reader's index takes in a batch).
    this.diskLock.setCalibreApplying(() => this.calibreApplying());
    this.batches = new BatchService({
      cleanup: opts.cleanup,
      main: opts.main,
      calibreDir: opts.calibreDir,
      cacheDir: opts.cacheDir,
      leaseSeconds: opts.leaseSeconds,
      log: this.log,
    });
    this.analysis = opts.calibreDir
      ? new Stage1Analysis({
          cleanup: opts.cleanup,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          log: this.log,
        })
      : null;
    this.analysis2 = opts.calibreDir
      ? new Stage2Analysis({
          cleanup: opts.cleanup,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          log: this.log,
        })
      : null;
    this.analysis3 = opts.calibreDir
      ? new Stage3Analysis({
          cleanup: opts.cleanup,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          reader: () => this.stage3Reader(),
          counterBuild: opts.counterBuild ?? counterBuild(),
          log: this.log,
        })
      : null;
    this.fetchQueue = new FetchQueue(
      opts.cleanup,
      opts.cacheDir + '/cleanup',
      () => getSettings(this.db).fetch,
      this.log,
    );
    this.analysis4 = opts.calibreDir
      ? new Stage4Analysis({
          cleanup: opts.cleanup,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          queue: this.fetchQueue,
          log: this.log,
        })
      : null;
  }

  /**
   * An answer reached the queue: wakes stage 4's analysis only (when it is not running already).
   * A whole round per answer ran stages 1-3's planning about once a second (found live
   * 2026-11-17); the 5 s timer still runs every stage.
   */
  answerArrived(): void {
    if (this.stopped || this.analysing4) return;
    try {
      this.round4(this.targetLibrary());
    } catch (err) {
      this.logError('Cleanup: stage 4 wake-up failed:', err);
    }
  }

  /** The fetch container's heartbeat; true when it is (or becomes) the one active fetcher. */
  fetchHeartbeat(
    hb: {
      fetcherId: string;
      version: string | null;
      problem: string | null;
      sudachi: string | null;
    },
    now = Date.now(),
  ): boolean {
    const s = getSettings(this.db).fetch;
    const r = this.db
      .prepare('SELECT fetcher_id, last_seen_at FROM fetcher_status WHERE id = 1')
      .get() as {
      fetcher_id: string | null;
      last_seen_at: number | null;
    };
    const other =
      r.fetcher_id !== null &&
      r.fetcher_id !== hb.fetcherId &&
      r.last_seen_at !== null &&
      now - r.last_seen_at < s.offlineSeconds * 1000;
    if (other) return false;
    this.db
      .prepare(
        `UPDATE fetcher_status SET fetcher_id = ?, last_seen_at = ?, version = ?, problem = ?, sudachi = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(hb.fetcherId, now, hb.version, hb.problem, hb.sudachi, now);
    return true;
  }

  isActiveFetcher(fetcherId: string, now = Date.now()): boolean {
    const s = getSettings(this.db).fetch;
    const r = this.db
      .prepare('SELECT fetcher_id, last_seen_at FROM fetcher_status WHERE id = 1')
      .get() as {
      fetcher_id: string | null;
      last_seen_at: number | null;
    };
    return (
      r.fetcher_id === fetcherId &&
      r.last_seen_at !== null &&
      now - r.last_seen_at < s.offlineSeconds * 1000
    );
  }

  fetcher(now = Date.now()) {
    const s = getSettings(this.db).fetch;
    const r = this.db.prepare('SELECT * FROM fetcher_status WHERE id = 1').get() as {
      fetcher_id: string | null;
      last_seen_at: number | null;
      version: string | null;
      problem: string | null;
      sudachi: string | null;
    };
    return {
      online: r.last_seen_at !== null && now - r.last_seen_at < s.offlineSeconds * 1000,
      lastSeenAt: r.last_seen_at,
      version: r.version,
      problem: r.problem,
      sudachi: r.sudachi,
    };
  }

  /** The reader processes for stage 3 (started on first use; their number follows the settings). */
  private stage3Reader(): Stage3Reader {
    if (this.opts.stage3Reader) return this.opts.stage3Reader;
    const dup = getSettings(this.db).duplicates;
    if (!this.reader3) {
      this.reader3 = new Stage3Worker(
        {
          bundle: COUNTER_BUNDLE,
          importOptions: this.opts.countImport ?? {
            importHTMLFixMode: 'Off',
            restrictImportFixToAnchor: true,
          },
          timeoutMs: () => getSettings(this.db).duplicates.textTimeoutSeconds * 1000,
          log: this.log,
        },
        dup.textWorkers,
      );
    }
    (this.reader3 as Stage3Worker).resize?.(dup.textWorkers);
    return this.reader3;
  }

  get db(): Database.Database {
    return this.opts.cleanup;
  }

  start({ timer = true }: { timer?: boolean } = {}): void {
    if (timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref();
    }
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
    await this.analysing;
    await this.analysing2;
    this.reader3?.close();
    await this.analysing3;
    this.analysis3?.close();
    await this.analysing4;
  }

  /** A finished removal batch waits for the reader's index of this library (index it now). */
  wantsIngest(libraryId: string): boolean {
    try {
      return REMOVAL_STAGES.some((st) => this.batches.awaitingIngest(st)?.libraryId === libraryId);
    } catch {
      return false;
    }
  }

  /** The indexer asks this before touching a library. */
  holdsIngest(libraryId: string): boolean {
    try {
      return this.batches.holdsIngest(libraryId);
    } catch {
      return false;
    }
  }

  targetLibrary(): string | null {
    const id = getSettings(this.db).targetLibraryId;
    if (id && getLibrary(this.opts.main, id)) return id;
    // Default: the library in the folder "japanese-library" (the plan's scope), if any.
    const lib = listLibraries(this.opts.main).find((l) => l.folder === 'japanese-library');
    return lib?.id ?? null;
  }

  /** Records the sidecar's heartbeat and its safety-check results. */
  heartbeat(body: SidecarHeartbeat, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE sidecar_status SET last_seen_at = ?, version = ?, calibredb = ?, server_version = ?,
           trash_restore = ?, problem = ?, updated_at = ? WHERE id = 1`,
      )
      .run(
        now,
        str(body.version, 50),
        str(body.calibredb, 100),
        str(body.serverVersion, 100),
        typeof body.trashRestore === 'boolean' ? (body.trashRestore ? 1 : 0) : null,
        str(body.problem, 2000),
        now,
      );
    if (Array.isArray(body.libraries)) {
      const ids = body.libraries
        .map((l) => str(l, 200))
        .filter((l): l is string => l !== null)
        .slice(0, 100);
      this.db
        .prepare('UPDATE sidecar_status SET calibre_libraries = ? WHERE id = 1')
        .run(JSON.stringify(ids));
    }
    if (Array.isArray(body.checks)) {
      const put = this.db.prepare(
        `INSERT INTO preflight (name, ok, detail, source, checked_at) VALUES (?, ?, ?, 'sidecar', ?)
         ON CONFLICT(name) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
           source = excluded.source, checked_at = excluded.checked_at`,
      );
      this.db.transaction(() => {
        for (const c of body.checks as unknown[]) {
          const check = c as { name?: unknown; ok?: unknown; detail?: unknown };
          const name = str(check.name, 50);
          if (!name || !(name in CHECK_LABELS)) continue;
          put.run(name, check.ok === true ? 1 : 0, str(check.detail, 1000), now);
        }
      })();
    }
  }

  /** The library ids the content server listed on the sidecar's last check. */
  calibreLibraries(): string[] {
    const r = this.db
      .prepare('SELECT calibre_libraries FROM sidecar_status WHERE id = 1')
      .get() as {
      calibre_libraries: string | null;
    };
    try {
      return r.calibre_libraries ? (JSON.parse(r.calibre_libraries) as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * The content server's id for the library to clean. Found automatically: the library whose
   * id is the reader library's folder name (spaces as underscores), else the only library the
   * server has. A library chosen on the page (settings.calibreLibraryId) wins.
   */
  resolvedLibraryId(): { id: string | null; auto: boolean; libraries: string[] } {
    const libraries = this.calibreLibraries();
    const chosen = getSettings(this.db).calibreLibraryId;
    if (chosen) return { id: chosen, auto: false, libraries };
    const target = this.targetLibrary();
    const folder = target ? getLibrary(this.opts.main, target)?.folder : undefined;
    const fromFolder = folder !== undefined ? libraryIdFromFolder(folder) : null;
    if (fromFolder && libraries.includes(fromFolder))
      return { id: fromFolder, auto: true, libraries };
    if (libraries.length === 1) return { id: libraries[0], auto: true, libraries };
    return { id: null, auto: true, libraries };
  }

  /**
   * What the sidecar needs to reach Calibre (its token only). The library id may still be
   * null: the sidecar then only lists the server's libraries, and no batch is handed out.
   */
  sidecarConfig(): {
    contentServerUrl: string;
    libraryId: string | null;
    username: string;
    password: string;
  } | null {
    const s = getSettings(this.db);
    const password = this.secrets.read('calibrePassword');
    if (!s.contentServerUrl || !s.calibreUsername || !password) return null;
    return {
      contentServerUrl: s.contentServerUrl,
      libraryId: this.resolvedLibraryId().id,
      username: s.calibreUsername,
      password,
    };
  }

  sidecar(now = Date.now()) {
    const r = this.db.prepare('SELECT * FROM sidecar_status WHERE id = 1').get() as {
      last_seen_at: number | null;
      version: string | null;
      calibredb: string | null;
      server_version: string | null;
      trash_restore: number | null;
      problem: string | null;
    };
    return {
      online: r.last_seen_at !== null && now - r.last_seen_at < SIDECAR_OFFLINE_MS,
      lastSeenAt: r.last_seen_at,
      version: r.version,
      calibredb: r.calibredb,
      serverVersion: r.server_version,
      trashRestore: r.trash_restore === null ? null : r.trash_restore === 1,
      problem: r.problem,
    };
  }

  /**
   * present: the reader's count of the library's books, when the caller already has it; null
   * leaves it out of the detail (no check depends on it, and counting reads 60,000+ rows).
   */
  checks(now = Date.now(), present?: number | null): CheckResult[] {
    const sidecar = this.sidecar(now);
    const target = this.targetLibrary();
    const login = this.sidecarConfig();
    const lib = this.resolvedLibraryId();
    const server: Record<string, { ok: boolean; detail: string | null }> = {
      sidecar_online: {
        ok: sidecar.online,
        detail: sidecar.lastSeenAt
          ? sidecar.online
            ? null
            : `Last seen ${new Date(sidecar.lastSeenAt).toISOString()}`
          : 'Never seen. Start the ttsu-cleanup-apply container with its token.',
      },
      calibre_settings: {
        ok: login !== null,
        detail: login ? null : 'Fill in the Calibre settings (Settings tab)',
      },
      library_found: {
        ok: lib.id !== null && lib.libraries.includes(lib.id),
        detail:
          lib.libraries.length === 0
            ? 'Waiting for the sidecar to list the content server’s libraries'
            : lib.id === null
              ? `Choose it in the Settings tab (the server has: ${lib.libraries.join(', ')})`
              : lib.libraries.includes(lib.id)
                ? `${lib.id}${lib.auto ? ' (found automatically)' : ''}`
                : `${lib.id} is not on the server (it has: ${lib.libraries.join(', ')})`,
      },
      target_library: {
        ok: target !== null,
        detail: target
          ? (getLibrary(this.opts.main, target)?.name ?? target)
          : 'Choose the library below',
      },
      library_indexed: this.libraryIndexed(target, present),
      reference_labels: this.referenceLabels(),
    };
    const sidecarRows = new Map(
      (
        this.db.prepare(`SELECT * FROM preflight WHERE source = 'sidecar'`).all() as {
          name: string;
          ok: number;
          detail: string | null;
          checked_at: number;
        }[]
      ).map((r) => [r.name, r]),
    );
    return Object.entries(CHECK_LABELS).map(([name, { label, required }]) => {
      if (name in server) {
        return {
          name,
          label,
          required,
          source: 'server' as const,
          checkedAt: now,
          ...server[name],
        };
      }
      const row = sidecarRows.get(name);
      const fresh = row && now - row.checked_at < CHECK_MAX_AGE_MS;
      return {
        name,
        label,
        required,
        source: 'sidecar' as const,
        ok: !!fresh && row.ok === 1,
        detail: row ? (fresh ? row.detail : 'Not checked recently') : 'Not checked yet',
        checkedAt: row?.checked_at ?? null,
      };
    });
  }

  private referenceLabels(): { ok: boolean; detail: string | null } {
    const file = this.analysis2?.referenceFile() ?? null;
    if (!file) return { ok: false, detail: 'No labeled-books file is set' };
    const { gold, error } = loadGold(file);
    return gold
      ? { ok: true, detail: `${Object.keys(gold).length} labeled books (${file})` }
      : { ok: false, detail: error };
  }

  private libraryIndexed(
    target: string | null,
    present?: number | null,
  ): { ok: boolean; detail: string | null } {
    if (!target) return { ok: false, detail: 'No library chosen' };
    if (!this.opts.calibreDir || !this.opts.indexerEnabled()) {
      return { ok: false, detail: "The reader's Calibre indexer is off" };
    }
    try {
      const state = getIndexState(this.opts.main, target);
      if (state.indexedAt === null) return { ok: false, detail: 'Not indexed yet' };
      if (present === null) return { ok: true, detail: null };
      return {
        ok: true,
        detail: `${present ?? presentBookCount(this.opts.main, target)} books in the index`,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Whether the required checks pass (each round of every stage asks; no book count needed). */
  checksPass(now = Date.now()): { ok: boolean; failing: string[] } {
    const failing = this.checks(now, null)
      .filter((c) => c.required && !c.ok)
      .map((c) => c.label);
    return { ok: failing.length === 0, failing };
  }

  setMode(stage: number, mode: StageMode): void {
    if (stage < 1 || stage > 5) throw new Error('No such stage');
    if (mode !== 'off' && !BUILT_STAGES.includes(stage)) {
      throw new Error('This stage is not built yet');
    }
    if (mode === 'on' && PREVIEW_ONLY_STAGES.includes(stage)) {
      throw new Error('Stage 4 is Preview only for now: its writes come with the AI check (WP20e)');
    }
    setStageMode(this.db, stage, mode);
    if (stage === 1 && mode !== 'off') {
      const target = this.targetLibrary();
      const p = this.analysis?.progress();
      if (target && this.analysis && (!p || p.libraryId !== target)) this.analysis.restart(target);
    }
    if (stage === 2 && mode !== 'off') {
      const target = this.targetLibrary();
      const p = this.analysis2?.progress();
      if (target && this.analysis2 && (!p || p.libraryId !== target))
        this.analysis2.restart(target);
    }
    if (stage === 3 && mode !== 'off') {
      const target = this.targetLibrary();
      const p = this.analysis3?.progress();
      if (target && this.analysis3 && (!p || p.libraryId !== target))
        this.analysis3.restart(target);
    }
    if (stage === 4 && mode !== 'off') {
      const target = this.targetLibrary();
      const p = this.analysis4?.progress();
      if (target && this.analysis4 && (!p || p.libraryId !== target))
        this.analysis4.restart(target);
    }
    void this.tick();
  }

  /** "Analyse again". */
  reanalyse(stage = 1): Stage1Progress | Stage2Progress | Stage3Progress | Stage4Progress {
    const target = this.targetLibrary();
    const analysis =
      stage === 4
        ? this.analysis4
        : stage === 3
          ? this.analysis3
          : stage === 2
            ? this.analysis2
            : stage === 1
              ? this.analysis
              : null;
    if (!analysis)
      throw new Error(stage >= 1 && stage <= 4 ? 'Choose the library first' : 'No such stage');
    if (!target) throw new Error('Choose the library first');
    const p = analysis.restart(target);
    // These pauses ask for a new analysis; it is running now.
    const pause = getStage(this.db, stage).pauseReason;
    if (pause === 'library_changed' || pause === 'not_identical') resumeStage(this.db, stage);
    void this.tick();
    return p;
  }

  /** Resume one paused field of stage 2. A gate pause lifts only when a new analysis passes. */
  resumeField(stage: number, field: string): void {
    const pause = listFieldPauses(this.db, stage).find((p) => p.field === field);
    if (!pause) return;
    if (pause.reason === 'gate' || pause.reason === 'no_labels') {
      throw new Error(
        'This field is paused by the gate on the labeled books; it resumes by itself when a new analysis passes',
      );
    }
    resumeField(this.db, stage, field);
    void this.tick();
  }

  /** One round: leases, ingest, guard, analysis, planning. Never throws. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.round();
      } catch (err) {
        this.logError('Cleanup: round failed:', err);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async round(): Promise<void> {
    this.batches.expireLeases();
    this.batches.checkIngested();
    const target = this.targetLibrary();
    await this.round1(target);
    await this.round2(target);
    await this.round3(target);
    this.round4(target);
  }

  /** Stage 4 (WP20d): Preview only; the analysis (reading, lookups, proposals) runs while not Off. */
  private round4(target: string | null): void {
    const stage = getStage(this.db, 4);
    if (stage.mode === 'off' || !target || !this.analysis4) {
      this.waiting4 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    const p = this.analysis4.progress();
    if (!p || p.libraryId !== target) {
      this.analysis4.restart(target);
    } else if (p.phase === 'done') {
      this.waiting4 = p.error ? `The analysis failed: ${p.error}` : 'Done';
      return;
    }
    this.waiting4 = this.fetcher().online
      ? null
      : 'The fetch container is not running (or has no token yet)';
    this.runAnalysis4();
  }

  private runAnalysis4(): void {
    if (this.analysing4 || !this.analysis4) return;
    const analysis = this.analysis4;
    this.analysing4 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, 4).mode === 'off') break;
          const stop4 = () => this.stopped || getStage(this.db, 4).mode === 'off';
          if (!(await this.diskFor(4, analysis.progress()?.phase, stop4))) break;
          const before = analysis.progress();
          const done = await analysis.step(stop4);
          if (done) break;
          // Waiting on the fetcher: no busy loop; the next answer or round goes on. The step
          // times change on every step, so they don't count as progress (with them the loop
          // never saw "nothing changed" and spun without giving the server back).
          const after = analysis.progress();
          const same = (a: typeof after, b: typeof before) =>
            JSON.stringify({ ...a, times: undefined }) ===
            JSON.stringify({ ...b, times: undefined });
          if (after && after.phase !== 'read' && same(after, before)) {
            if (!this.stage4HasWork()) break;
          }
        }
      } catch (err) {
        this.logError('Cleanup: stage 4 analysis failed:', err);
      } finally {
        this.diskLock.release(DISK_OWNERS.calibre4);
        this.analysing4 = null;
      }
    })();
  }

  /** Stage 4 work that needs no answer from the fetcher (answered requests, books to plan or propose). */
  private stage4HasWork(): boolean {
    const p = this.analysis4?.progress();
    if (!p) return false;
    const ready = this.db.prepare('SELECT 1 FROM fetch_waiters WHERE ready = 1 LIMIT 1').get();
    if (ready) return true;
    const books = this.db
      .prepare(
        `SELECT 1 FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'ready') LIMIT 1`,
      )
      .get(p.analysisId);
    return !!books;
  }

  /** "Ask again" for a site: its given-up requests go back to the queue and their books are planned again. */
  retryStage4Site(site: string, now = Date.now()): { requests: number; books: number } {
    const p = this.analysis4?.progress();
    const requests = this.fetchQueue.retryFailed(site, now);
    const books = p
      ? this.db
          .prepare(
            `UPDATE stage4_books SET state = 'read', lookup_json = '{}', updated_at = ?
             WHERE analysis_id = ? AND json_extract(lookup_json, '$.failed.' || ?) IS NOT NULL`,
          )
          .run(now, p.analysisId, site).changes
      : 0;
    if (p && p.phase !== 'lookups' && p.phase !== 'read' && books > 0) {
      p.phase = 'lookups';
      updateStage(this.db, 4, {
        progress: p as unknown as Record<string, unknown>,
        state: 'analysing',
      });
    }
    this.status4Cache = null;
    void this.tick();
    return { requests, books };
  }

  /** Stage 4's proposals for the page's list (paged). */
  stage4Proposals(f: {
    field: string | null;
    cls: 'auto' | 'review' | null;
    source: string | null;
    offset: number;
    limit: number;
  }) {
    const p = this.analysis4?.progress();
    const target = this.targetLibrary();
    if (!p || !target) return { total: 0, items: [] };
    const where = ['stage = 4', 'library_id = ?', "state = 'proposed'", 'analysis_id = ?'];
    const args: unknown[] = [target, p.analysisId];
    if (f.field) {
      where.push('field = ?');
      args.push(f.field);
    }
    if (f.cls) {
      where.push('class = ?');
      args.push(f.cls);
    }
    if (f.source) {
      where.push('source = ?');
      args.push(f.source);
    }
    const sql = where.join(' AND ');
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM proposed_changes WHERE ${sql}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, field, old_json, new_json, class, source, review_reason, evidence_json
         FROM proposed_changes WHERE ${sql} ORDER BY calibre_id, field LIMIT ? OFFSET ?`,
      )
      .all(...args, f.limit, f.offset) as {
      id: number;
      calibre_id: number;
      calibre_uuid: string;
      field: string;
      old_json: string | null;
      new_json: string | null;
      class: string;
      source: string;
      review_reason: string | null;
      evidence_json: string;
    }[];
    const snap = this.analysis4!.loadSnapshot(target);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        calibreId: r.calibre_id,
        title: snap.books.get(r.calibre_id)?.title ?? null,
        field: r.field,
        old: r.old_json === null ? null : (JSON.parse(r.old_json) as unknown),
        new: r.new_json === null ? null : (JSON.parse(r.new_json) as unknown),
        class: r.class,
        source: r.source,
        reason: r.review_reason,
        evidence: JSON.parse(r.evidence_json) as unknown,
      })),
    };
  }

  /** The author readings (NDL's and generated ones) for the page's list. */
  stage4Readings(state: string | null, offset: number) {
    const where = state ? 'WHERE state = ?' : '';
    const args = state ? [state] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM author_readings ${where}`).get(...args) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT name, state, reading, source, authority, ambiguous FROM author_readings ${where}
         ORDER BY name LIMIT 100 OFFSET ?`,
      )
      .all(...args, offset);
    return { total, items };
  }

  /** Stage 4's status for the page (cached 30 s: some counts read the whole queue). */
  stage4Status(target: string | null, now = Date.now()): unknown {
    if (this.status4Cache && now - this.status4Cache.at < 30_000) return this.status4Cache.value;
    const p = this.analysis4?.progress() ?? null;
    const s = getSettings(this.db).fetch;
    const counts = this.db
      .prepare('SELECT site, state, COUNT(*) AS n FROM fetch_requests GROUP BY site, state')
      .all() as { site: string; state: string; n: number }[];
    const recent = this.db
      .prepare(
        `SELECT site, COUNT(*) AS n, SUM(outcome = 'challenge') AS challenges, SUM(outcome = 'error') AS errors,
           AVG(ms) AS ms, MIN(at) AS first FROM fetch_attempts WHERE at >= ? GROUP BY site`,
      )
      .all(now - 20 * 60_000) as {
      site: string;
      n: number;
      challenges: number;
      errors: number;
      ms: number | null;
      first: number;
    }[];
    const totals = this.db
      .prepare('SELECT site, attempts AS n, challenges, errors, busy FROM fetch_sites')
      .all() as { site: string; n: number; challenges: number; errors: number; busy: number }[];
    // A site's pace: the mean gap over its last 500 requests while work was waiting, refusal
    // waits included (Amazon's cap shows as waits); see stage4/eta.ts paceSeconds. The median
    // (2026-11-18 morning) left out the waits, and per queue it read 40 s for Amazon's two
    // queues taking turns in one 20 s slot.
    const idleMs = (s.challengeBackoffMaxSeconds + 60) * 1000;
    // Each site's last 501 straight from its index (two sites together in one query sort all
    // their requests), merged for Amazon's slot.
    const lastAttempts = this.db.prepare(
      `SELECT a.at, r.created_at AS created FROM fetch_attempts a
       JOIN fetch_requests r ON r.id = a.request_id
       WHERE a.site = ? ORDER BY a.at DESC LIMIT 501`,
    );
    const oldestOpen = this.db.prepare(
      `SELECT MIN(created_at) AS m FROM fetch_requests
       WHERE site = ? AND state IN ('queued', 'leased')`,
    );
    const pace = (group: string[]): number | null => {
      const rows = group
        .flatMap((g) => lastAttempts.all(g) as { at: number; created: number }[])
        .sort((a, b) => b.at - a.at)
        .slice(0, 501);
      const openSince = () => {
        const ms = group
          .map((g) => (oldestOpen.get(g) as { m: number | null }).m)
          .filter((m): m is number => m !== null);
        return ms.length ? Math.min(...ms) : null;
      };
      return paceSeconds(rows, openSince, idleMs);
    };
    const sites = (FETCH_SITES as readonly FetchSite[]).map((site) => {
      const by = (st: string) => counts.find((c) => c.site === site && c.state === st)?.n ?? 0;
      const r = recent.find((x) => x.site === site);
      const t = totals.find((x) => x.site === site);
      const row = this.db
        .prepare('SELECT * FROM fetch_sites WHERE site = ?')
        .get(backoffKey(site)) as
        | {
            paused_reason: string | null;
            backoff_until: number | null;
            backoff_reason: string | null;
            slow_factor: number;
          }
        | undefined;
      const left = by('queued') + by('leased');
      const perRequest = Math.max(pace([site]) ?? s.sites[site].intervalSeconds, 0.1);
      return {
        site,
        enabled: s.sites[site].enabled,
        intervalSeconds: s.sites[site].intervalSeconds,
        queued: by('queued'),
        leased: by('leased'),
        done: by('done'),
        gone: by('gone'),
        failed: by('failed'),
        attempts: t?.n ?? 0,
        challenges: t?.challenges ?? 0,
        errors: t?.errors ?? 0,
        busy: t?.busy ?? 0,
        recent: r
          ? {
              requests: r.n,
              challenges: r.challenges,
              errors: r.errors,
              avgMs: r.ms === null ? null : Math.round(r.ms),
            }
          : null,
        secondsPerRequest: Math.round(perRequest * 10) / 10,
        secondsLeft: Math.round(left * perRequest),
        pausedReason: row?.paused_reason ?? null,
        backoffUntil: row?.backoff_until && row.backoff_until > now ? row.backoff_until : null,
        backoffReason: row?.backoff_until && row.backoff_until > now ? row.backoff_reason : null,
        slowFactor: row?.slow_factor ?? 1,
        sharedSlot: false,
      };
    });
    const books = p
      ? (this.db
          .prepare(
            'SELECT state, labeled, COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? GROUP BY state, labeled',
          )
          .all(p.analysisId) as { state: string; labeled: number; n: number }[])
      : [];
    const readings = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM author_readings GROUP BY state')
      .all() as { state: string; n: number }[];
    // Nothing is left once the analysis is done (or failed).
    // Amazon's shared slot: the pace over both queues' last 500 requests together.
    const amazonSlot = pace(['amazon-dp', 'amazon-search']);
    const eta =
      p && p.phase !== 'done'
        ? this.stage4TimeLeft(p, sites, books, readings, now, amazonSlot)
        : null;
    for (const site of sites) {
      const t = eta?.result.sites[site.site];
      if (t !== undefined) site.secondsLeft = t;
      // In the shared slot each queue takes every other turn: both show the slot's pace and
      // the time left for both together.
      const slot = eta?.result.amazonSlot;
      if (
        slot !== null &&
        slot !== undefined &&
        amazonSlot !== null &&
        (site.site === 'amazon-dp' || site.site === 'amazon-search')
      ) {
        site.sharedSlot = true;
        site.secondsPerRequest = Math.round(amazonSlot * 10) / 10;
        site.secondsLeft = slot;
      }
    }
    const natively = this.db
      .prepare(
        'SELECT COUNT(*) AS listed, SUM(read_at IS NOT NULL) AS read, SUM(isbn13 IS NOT NULL) AS withIsbn FROM natively_books',
      )
      .get() as { listed: number; read: number | null; withIsbn: number | null };
    const nativelyAsins = (
      this.db.prepare('SELECT COUNT(*) AS n FROM natively_asins').get() as { n: number }
    ).n;
    // The proposals' counts read every stage-4 proposal (41 ms on the PC at the library's size):
    // counted at most every 5 minutes.
    if (!this.fields4Cache || now - this.fields4Cache.at > 300_000) {
      this.fields4Cache = {
        at: now,
        value:
          target && p
            ? (this.db
                .prepare(
                  `SELECT field, class, COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND library_id = ?
                 AND state = 'proposed' AND analysis_id = ? GROUP BY field, class`,
                )
                .all(target, p.analysisId) as { field: string; class: string; n: number }[])
            : [],
      };
    }
    const fields = this.fields4Cache.value;
    const value = {
      waiting: this.waiting4,
      fetcher: this.fetcher(now),
      amazonPace:
        s.amazonPace === 'trial' ? `trial (now ${this.fetchQueue.amazonPace(now)})` : s.amazonPace,
      sites,
      books,
      readings,
      natively: { ...natively, asins: nativelyAsins },
      fields,
      fieldPauses: listFieldPauses(this.db, 4),
      read: p
        ? {
            done: books.reduce((a, b) => a + b.n, 0),
            total: p.readTotal,
            perSecond: eta?.readPerSecond ?? null,
          }
        : null,
      timeLeft: eta?.result ?? null,
      cachedAt: now,
    };
    this.status4Cache = { at: now, value };
    return value;
  }

  /**
   * Stage 4's time left (stage4/eta.ts): the reading at its rate measured over the last minutes
   * (books read, counted from stage4_books, at each status), every site's requests still to
   * come at its measured pace, and the final pass at the measured time per proposed book.
   */
  private stage4TimeLeft(
    p: Stage4Progress,
    sites: {
      site: FetchSite;
      enabled: boolean;
      queued: number;
      leased: number;
      done: number;
      gone: number;
      failed: number;
      secondsPerRequest: number;
    }[],
    books: { state: string; labeled: number; n: number }[],
    readings: { state: string; n: number }[],
    now: number,
    amazonSlot: number | null = null,
  ) {
    const s = getSettings(this.db).fetch;
    const count = (states: string[]) =>
      books.filter((b) => states.includes(b.state)).reduce((a, b) => a + b.n, 0);
    const booksRead = count(['read', 'waiting', 'ready', 'proposed', 'error']);
    this.readMarks = this.readMarks.filter(
      (m) => m.analysisId === p.analysisId && now - m.at <= 20 * 60_000,
    );
    if (p.phase === 'read')
      this.readMarks.push({ at: now, n: booksRead, analysisId: p.analysisId });
    const first = this.readMarks[0];
    const readPerSecond =
      first && now - first.at >= 120_000 && booksRead > first.n
        ? (booksRead - first.n) / ((now - first.at) / 1000)
        : null;
    // This run's requests on the labeled books, once they are all proposed (10 minutes kept).
    let labeled: { site: string; n: number }[] = [];
    if (p.labeledDoneAt !== null) {
      if (!this.labeled4Cache || now - this.labeled4Cache.at > 600_000) {
        this.labeled4Cache = {
          at: now,
          value: this.db
            .prepare(
              'SELECT site, COUNT(*) AS n FROM fetch_requests WHERE priority >= ? GROUP BY site',
            )
            .all(LABELED_PRIORITY) as { site: string; n: number }[],
        };
      }
      labeled = this.labeled4Cache.value;
    }
    const per = p.times?.['propose: book'];
    const unreadable = count(['error']);
    const result = stage4Eta({
      sites: sites.map(
        (x): SiteCounts => ({
          site: x.site,
          enabled: x.enabled,
          open: x.queued + x.leased,
          finished: x.done + x.gone + x.failed,
          secondsPerRequest: x.secondsPerRequest,
          labeledRequests: labeled.find((l) => l.site === x.site)?.n ?? 0,
        }),
      ),
      booksTotal: p.readTotal,
      booksRead: p.phase === 'read' ? booksRead : p.readTotal,
      booksUnreadable: unreadable,
      readPerSecond,
      labeledBooks: p.labeledIds.length,
      labeledDone: p.labeledDoneAt !== null,
      amazonShared: this.fetchQueue.amazonPace(now) === 'shared',
      amazonSlotSeconds: amazonSlot,
      ndlNames: readings.filter((r) => r.state === 'queued').reduce((a, b) => a + b.n, 0),
      ndlBatch: s.ndlNamesPerQuery,
      ndlSecondsPerQuery: s.sites.ndl?.intervalSeconds ?? 30,
      finalBooks: Math.max(
        0,
        p.readTotal - unreadable - (p.phase === 'final' ? (p.finalDone ?? 0) : 0),
      ),
      msPerProposal: per && per.n > 0 ? per.ms / per.n : null,
    });
    return { result, readPerSecond };
  }

  /**
   * Stage 3: analysis (after stage 1's and 2's), then (On, gate passed) one removal batch at a
   * time once stages 1 and 2 have nothing left to apply.
   */
  private async round3(target: string | null): Promise<void> {
    const stage = getStage(this.db, 3);
    if (stage.mode === 'off' || !target || !this.analysis3) {
      this.waiting3 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    let progress = this.analysis3.progress();
    if (!progress || progress.libraryId !== target) progress = this.analysis3.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        this.waiting3 = "Waiting for the reader's index of the library";
        return;
      }
      if (this.analysing || this.analysing2) {
        this.waiting3 = "Waiting for stage 1's or stage 2's analysis to finish";
        return;
      }
      this.waiting3 = 'Analysing';
      this.runAnalysis3();
      return;
    }
    if (progress.error) {
      this.waiting3 = `The analysis failed: ${progress.error}`;
      return;
    }
    // New rules or new limits in the settings: the measured pairs are classified again
    // (nothing read again), then the copies are chosen again.
    if (this.analysis3.needsReclassify(progress) && !this.batches.open()) {
      this.analysis3.reclassify();
      this.waiting3 = 'Analysing';
      this.runAnalysis3();
      return;
    }
    if (stage.mode !== 'on') {
      this.waiting3 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, 3).pauseReason) {
      this.waiting3 = null;
      return;
    }
    if (!progress.gate?.passed) {
      this.waiting3 = `Not applying: the gate hasn't passed (${(progress.gate?.problems ?? ['not checked']).join('; ')})`;
      return;
    }
    if (this.batches.open()) {
      this.waiting3 = 'A batch is being applied';
      return;
    }
    if (getStage(this.db, 1).mode === 'on' && this.remaining(target) > 0) {
      this.waiting3 = 'Waiting for stage 1 to finish removing identical copies';
      return;
    }
    if (getStage(this.db, 2).mode === 'on' && this.remaining2(target) > 0) {
      this.waiting3 = 'Waiting for stage 2 to finish writing';
      return;
    }
    const checks = this.checksPass();
    if (!checks.ok) {
      this.waiting3 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.planStage3(target, () => this.stopped);
    this.waiting3 = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining3(target) === 0 ? 'Done: nothing left to remove' : null));
  }

  /**
   * The Calibre cleanup's applying, for the shared disk lock (WP21a): a batch that is planned
   * or claimed, or a stage that is On with removals or writes left (between its batches it
   * waits for the reader's index, then plans the next). Null when no stage applies anything.
   */
  calibreApplying(): string | null {
    const open = this.batches.open() as { stage?: number } | null;
    if (open) return `Calibre stage ${open.stage ?? ''} (applying a batch)`;
    const target = this.targetLibrary();
    if (!target) return null;
    const left: [number, () => number][] = [
      [1, () => this.remaining(target)],
      [2, () => this.remaining2(target)],
      [3, () => this.remaining3(target)],
    ];
    for (const [stage, count] of left) {
      const st = getStage(this.db, stage);
      if (st.mode === 'on' && !st.pauseReason && count() > 0) {
        return `Calibre stage ${stage} (between batches)`;
      }
    }
    return null;
  }

  private remaining3(target: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 3 AND library_id = ?
           AND state = 'proposed' AND class = 'auto' AND analysis_id = ?`,
        )
        .get(target, currentAnalysisId(this.db, 3)) as { n: number }
    ).n;
  }

  /**
   * Before a Calibre analysis step (WP21a): a phase that reads book files holds the shared
   * disk lock (waiting for an audiobook job to give it back, which it does at once); any other
   * phase gives it back. False when the analysis was stopped while waiting.
   */
  private async diskFor(
    stage: 1 | 2 | 3 | 4,
    phase: string | undefined,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    const owner = DISK_OWNERS[`calibre${stage}`];
    if (phase && DISK_PHASES[stage].includes(phase)) {
      return this.diskLock.acquire(owner, 'calibre', shouldStop);
    }
    this.diskLock.release(owner);
    return true;
  }

  private runAnalysis3(): void {
    if (this.analysing3 || !this.analysis3) return;
    const analysis = this.analysis3;
    this.analysing3 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, 3).mode === 'off') break;
          const stop3 = () => this.stopped || getStage(this.db, 3).mode === 'off';
          if (!(await this.diskFor(3, analysis.progress()?.phase, stop3))) break;
          const done = await analysis.step(stop3);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: stage 3 analysis failed:', err);
      } finally {
        this.diskLock.release(DISK_OWNERS.calibre3);
        this.analysing3 = null;
        void this.tick();
      }
    })();
  }

  /** Your decision on a stage-3 pair (keep both, remove one, or none); the sets are worked out again. */
  decidePair(pairId: number, decision: 'keep_both' | 'remove_a' | 'remove_b' | 'clear'): void {
    const target = this.targetLibrary();
    const p = this.analysis3?.progress();
    if (!target || !p || !this.analysis3) throw new Error('Stage 3 has no analysis');
    const pair = this.db
      .prepare('SELECT * FROM content_pairs WHERE id = ? AND analysis_id = ?')
      .get(pairId, p.analysisId) as PairRow | undefined;
    if (!pair) throw new Error('No such pair in the current analysis');
    if (decision === 'clear') {
      this.db
        .prepare(
          `DELETE FROM pair_decisions WHERE library_id = ?
             AND ((a_uuid = ? AND b_uuid = ?) OR (a_uuid = ? AND b_uuid = ?))`,
        )
        .run(target, pair.a_uuid, pair.b_uuid, pair.b_uuid, pair.a_uuid);
    } else {
      this.db
        .prepare(
          `INSERT INTO pair_decisions (library_id, a_uuid, b_uuid, decision, decided_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(library_id, a_uuid, b_uuid)
           DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`,
        )
        .run(target, pair.a_uuid, pair.b_uuid, decision, Date.now());
    }
    // Work out the sets again with the decision (fast; the measurements are kept).
    if (p.phase === 'done' && !p.error) {
      p.phase = 'group';
      p.finishedAt = null;
      updateStage(this.db, 3, {
        progress: p as unknown as Record<string, unknown>,
        state: 'analysing',
      });
    }
    void this.tick();
  }

  /** Stage 2: analysis, then (On) one batch at a time once stage 1 has nothing left to remove. */
  private async round2(target: string | null): Promise<void> {
    const stage = getStage(this.db, 2);
    if (stage.mode === 'off' || !target || !this.analysis2) {
      this.waiting2 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    let progress = this.analysis2.progress();
    if (!progress || progress.libraryId !== target) progress = this.analysis2.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        this.waiting2 = "Waiting for the reader's index of the library";
        return;
      }
      if (this.analysing) {
        this.waiting2 = "Waiting for stage 1's analysis to finish";
        return;
      }
      this.waiting2 = 'Analysing';
      this.runAnalysis2();
      return;
    }
    if (progress.error) {
      this.waiting2 = `The analysis failed: ${progress.error}`;
      return;
    }
    if (stage.mode !== 'on') {
      this.waiting2 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, 2).pauseReason) {
      this.waiting2 = null;
      return;
    }
    if (this.batches.open()) {
      this.waiting2 = 'A batch is being applied';
      return;
    }
    if (getStage(this.db, 1).mode === 'on' && this.remaining(target) > 0) {
      this.waiting2 = 'Waiting for stage 1 to finish removing identical copies';
      return;
    }
    const checks = this.checksPass();
    if (!checks.ok) {
      this.waiting2 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.stage2.plan(target);
    this.waiting2 = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining2(target) === 0 ? 'Done: nothing left to write' : null));
  }

  private remaining2(target: string): number {
    const paused = listFieldPauses(this.db, 2).map((p) => p.field);
    const rows = this.db
      .prepare(
        `SELECT field, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND state = 'proposed' AND class = 'auto' AND (analysis_id = ? OR decided_by IS NOT NULL)
         GROUP BY field`,
      )
      .all(target, currentAnalysisId(this.db, 2)) as { field: string; n: number }[];
    return rows.filter((r) => !paused.includes(r.field)).reduce((a, r) => a + r.n, 0);
  }

  private runAnalysis2(): void {
    if (this.analysing2 || !this.analysis2) return;
    const analysis = this.analysis2;
    this.analysing2 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, 2).mode === 'off') break;
          const stop2 = () => this.stopped || getStage(this.db, 2).mode === 'off';
          if (!(await this.diskFor(2, analysis.progress()?.phase, stop2))) break;
          const done = await analysis.step(stop2);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: stage 2 analysis failed:', err);
      } finally {
        this.diskLock.release(DISK_OWNERS.calibre2);
        this.analysing2 = null;
        void this.tick();
      }
    })();
  }

  /** Stage 2's counts per field, class and state (current analysis plus everything queued or applied). */
  stage2Counts(
    target: string | null,
  ): { field: string; class: string; state: string; n: number }[] {
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT field, class, state, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND (${CURRENT_PROPOSALS_SQL} OR decided_by IS NOT NULL) GROUP BY field, class, state`,
      )
      .all(target, currentAnalysisId(this.db, 2)) as {
      field: string;
      class: string;
      state: string;
      n: number;
    }[];
  }

  stage2SkipReasons(target: string | null): { reason: string; count: number }[] {
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT COALESCE(review_reason, 'No reason recorded') AS reason, COUNT(*) AS count
         FROM proposed_changes WHERE stage = 2 AND library_id = ? AND state = 'skipped' AND analysis_id = ?
         GROUP BY reason ORDER BY count DESC, reason LIMIT 20`,
      )
      .all(target, currentAnalysisId(this.db, 2)) as { reason: string; count: number }[];
  }

  /** Books written in the recent window (for the page's time left). */
  stage2Pace(now = Date.now()): { written: number; firstAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT c.calibre_id) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id JOIN proposed_changes c ON c.id = i.change_id
         WHERE b.kind = 'apply' AND b.stage = 2 AND i.state = 'written' AND i.updated_at >= ?`,
      )
      .get(now - PACE_WINDOW_MS) as { n: number; first: number | null };
    return { written: row.n, firstAt: row.first };
  }

  /** Books left to write (auto, not paused). */
  stage2BooksLeft(target: string | null): number {
    if (!target) return 0;
    const paused = listFieldPauses(this.db, 2).map((p) => p.field);
    const placeholders = paused.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT calibre_id) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
           AND state = 'proposed' AND class = 'auto' AND (analysis_id = ? OR decided_by IS NOT NULL)
           ${paused.length ? `AND field NOT IN (${placeholders})` : ''}`,
        )
        .get(target, currentAnalysisId(this.db, 2), ...paused) as { n: number }
    ).n;
  }

  /** Stage 1: removing identical copies. */
  private async round1(target: string | null): Promise<void> {
    const stage = getStage(this.db, 1);
    if (stage.mode === 'off' || !target || !this.analysis) {
      this.waiting =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    this.checkMassMissing(target);
    let progress = this.analysis.progress();
    if (!progress || progress.libraryId !== target) progress = this.analysis.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        this.waiting = "Waiting for the reader's index of the library";
        return;
      }
      this.waiting = 'Analysing';
      this.runAnalysis();
      return;
    }
    if (progress.error) {
      this.waiting = `The analysis failed: ${progress.error}`;
      return;
    }
    if (stage.mode !== 'on') {
      this.waiting = 'Preview: nothing is changed in Calibre';
      return;
    }
    const current = getStage(this.db, 1);
    if (current.pauseReason) {
      this.waiting = null;
      return;
    }
    if (this.batches.open()) {
      this.waiting = 'A batch is being applied';
      return;
    }
    const checks = this.checksPass();
    if (!checks.ok) {
      this.waiting = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.planStage1(target, () => this.stopped);
    this.waiting = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining(target) === 0 ? this.doneText() : null));
  }

  /**
   * The line once nothing is left to remove. The page shows the counts right below it, and
   * each skipped copy's reason in the Identical copies list (Skipped).
   */
  private doneText(): string {
    return 'Done: nothing left to remove';
  }

  private remaining(target: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 1 AND library_id = ?
           AND state = 'proposed' AND class = 'auto' AND analysis_id = ?`,
        )
        .get(target, currentAnalysisId(this.db)) as { n: number }
    ).n;
  }

  /** The indexer's metadata.db snapshot (in CACHE_DIR, not in the library). */
  private snapshotExists(target: string): boolean {
    return existsSync(snapshotFile(this.opts.cacheDir, target));
  }

  /** The indexer's mass-missing guard fired after one of our batches: stop applying. */
  private checkMassMissing(target: string): void {
    try {
      const state = getIndexState(this.opts.main, target);
      if (!state.lastWarning || state.lastWarningAt === null) return;
      const last = this.db
        .prepare(
          `SELECT MAX(finished_at) AS t FROM batches WHERE library_id = ? AND kind = 'apply'`,
        )
        .get(target) as { t: number | null };
      if (last.t !== null && state.lastWarningAt >= last.t) {
        // Every removing stage stops: the index refused a batch's missing copies.
        for (const st of REMOVAL_STAGES) {
          if (getStage(this.db, st).mode === 'on' && !getStage(this.db, st).pauseReason) {
            pauseStage(
              this.db,
              st,
              'mass_missing',
              `The reader's index reported: ${state.lastWarning}`,
            );
          }
        }
      }
    } catch {
      // No index state yet.
    }
  }

  private runAnalysis(): void {
    if (this.analysing || this.analysing2 || !this.analysis) return;
    const analysis = this.analysis;
    this.analysing = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, 1).mode === 'off') break;
          const stop1 = () => this.stopped || getStage(this.db, 1).mode === 'off';
          if (!(await this.diskFor(1, analysis.progress()?.phase, stop1))) break;
          const done = await analysis.step(stop1);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: analysis failed:', err);
      } finally {
        this.diskLock.release(DISK_OWNERS.calibre1);
        this.analysing = null;
        void this.tick();
      }
    })();
  }

  stage1Counts(target: string | null): Record<string, number> {
    if (!target) return {};
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 1 AND library_id = ?
         AND ${CURRENT_PROPOSALS_SQL} GROUP BY state`,
      )
      .all(target, currentAnalysisId(this.db)) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** Why copies were skipped, most common first (for the page). */
  stage1SkipReasons(target: string | null): { reason: string; count: number }[] {
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT COALESCE(review_reason, 'No reason recorded') AS reason, COUNT(*) AS count
         FROM proposed_changes WHERE stage = 1 AND library_id = ? AND state = 'skipped'
           AND analysis_id = ?
         GROUP BY reason ORDER BY count DESC, reason`,
      )
      .all(target, currentAnalysisId(this.db)) as { reason: string; count: number }[];
  }

  /**
   * The recent pace of removals (for the page's time left): copies removed in the last
   * PACE_WINDOW_MS and when the first of them was removed. The pace of the whole run would
   * be thrown off by a slow start or an earlier run.
   */
  stage1Pace(now = Date.now()): { removed: number; firstAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id
         WHERE b.kind = 'apply' AND b.stage = 1 AND i.state = 'removed' AND i.updated_at >= ?`,
      )
      .get(now - PACE_WINDOW_MS) as { n: number; first: number | null };
    return { removed: row.n, firstAt: row.first };
  }

  /**
   * Stage 3's pairs for the page, with both books' facts. view: review (waiting for a
   * decision), a class (duplicate, superset, keep_both, never, different), image_only,
   * errors, spread (pairs with extra text inside the chapters, most first: the special-edition
   * measure) or examples (30 random pairs of one class).
   */
  stage3Pairs(
    view: string,
    { cls, offset = 0, limit = 50 }: { cls?: string; offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const target = this.targetLibrary();
    const p = this.analysis3?.progress();
    if (!target || !p || !this.analysis3) return { total: 0, items: [] };
    const where = ['p.analysis_id = ?'];
    const params: unknown[] = [p.analysisId];
    let order = 'p.a_id, p.b_id';
    const classes = ['duplicate', 'superset', 'keep_both', 'never', 'different', 'review'];
    if (view === 'review') {
      // Waiting for a decision: the pairs already decided are in the other lists (removals,
      // keep both), so this list and the page's count agree.
      where.push(STAGE3_WAITING_SQL);
    } else if (view === 'image_only') where.push(`p.source = 'image_only'`);
    else if (view === 'errors') where.push('p.error IS NOT NULL');
    else if (view === 'spread') {
      where.push(
        `p.spread_json IS NOT NULL AND p.class IN ('duplicate', 'superset', 'review', 'keep_both')`,
      );
      where.push(
        `MAX(COALESCE(json_extract(p.spread_json, '$.a.interleavedShare'), 0),
             COALESCE(json_extract(p.spread_json, '$.b.interleavedShare'), 0)) > 0`,
      );
      order = `MAX(COALESCE(json_extract(p.spread_json, '$.a.interleavedShare'), 0),
                    COALESCE(json_extract(p.spread_json, '$.b.interleavedShare'), 0)) DESC`;
    } else if (view === 'examples') {
      if (!cls || !classes.includes(cls)) throw new Error('Name a class for the examples');
      where.push('p.class = ?');
      params.push(cls);
      order = 'RANDOM()';
      limit = 30;
      offset = 0;
    } else if (classes.includes(view)) {
      where.push('p.class = ?');
      params.push(view);
    } else throw new Error('No such list');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM content_pairs p WHERE ${where.join(' AND ')}`)
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT p.* FROM content_pairs p WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as PairRow[];
    const books = this.analysis3.loadBooks(target);
    const fact = this.db.prepare(
      `SELECT calibre_id, chars, reader_chars, kind, kind_marker, kind_by, ruby, toc_entries, vertical,
              cover_side, json_array_length(images_json) AS images, image_entries, error, quality_error
       FROM text_facts WHERE library_id = ? AND calibre_id = ?`,
    );
    const decision = this.db.prepare(
      `SELECT a_uuid, decision FROM pair_decisions WHERE library_id = ?
         AND ((a_uuid = ? AND b_uuid = ?) OR (a_uuid = ? AND b_uuid = ?))`,
    );
    const side = (id: number) => {
      const b = books.get(id);
      return {
        calibreId: id,
        title: b?.title ?? null,
        author: b?.firstAuthor ?? null,
        tags: b?.tags ?? [],
        formats: b?.formats ?? [],
        addedAt: b?.timestamp ?? null,
        ...((fact.get(target, id) as Record<string, unknown> | undefined) ?? {}),
      };
    };
    const items = rows.map((r) => {
      const d = decision.get(target, r.a_uuid, r.b_uuid, r.b_uuid, r.a_uuid) as
        | { a_uuid: string; decision: string }
        | undefined;
      let mine: string | null = d?.decision ?? null;
      if (d && d.a_uuid !== r.a_uuid && mine !== 'keep_both')
        mine = mine === 'remove_a' ? 'remove_b' : 'remove_a';
      return {
        id: r.id,
        source: r.source,
        class: r.class,
        rule: r.rule,
        reason: r.reason,
        container: r.container,
        aInB: r.a_in_b,
        bInA: r.b_in_a,
        estAInB: r.est_a_in_b,
        estBInA: r.est_b_in_a,
        keepId: r.keep_id,
        error: r.error,
        spread: r.spread_json ? JSON.parse(r.spread_json) : null,
        best: r.best_json ? JSON.parse(r.best_json) : null,
        decision: mine,
        a: side(r.a_id),
        b: side(r.b_id),
      };
    });
    return { total, items };
  }

  /** Stage 3's books of one sort: omnibus files, unreadable files, image-only books. */
  stage3Books(
    view: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const target = this.targetLibrary();
    if (!target || !this.analysis3) return { total: 0, items: [] };
    const where =
      view === 'omnibus'
        ? `kind = 'omnibus'`
        : view === 'errors'
          ? 'error IS NOT NULL'
          : view === 'image_only'
            ? 'image_only = 1'
            : null;
    if (!where) throw new Error('No such list');
    const books = this.analysis3.loadBooks(target);
    const rows = (
      this.db
        .prepare(
          `SELECT calibre_id, chars, kind, kind_marker, kind_by, image_entries, error FROM text_facts
           WHERE library_id = ? AND ${where} ORDER BY calibre_id`,
        )
        .all(target) as { calibre_id: number }[]
    ).filter((r) => books.has(r.calibre_id));
    return {
      total: rows.length,
      items: rows.slice(offset, offset + limit).map((r) => ({
        ...r,
        title: books.get(r.calibre_id)?.title ?? null,
        author: books.get(r.calibre_id)?.firstAuthor ?? null,
      })),
    };
  }

  /** The gate's result per measured pair. */
  stage3Gate() {
    return this.analysis3?.progress()?.gate ?? null;
  }

  /** Stage 3's line on the page (the gate's per-pair results come from their own route). */
  stage3Status(target: string | null, now = Date.now()) {
    const p = this.analysis3?.progress() ?? null;
    const counts: Record<string, number> = {};
    if (target) {
      for (const r of this.db
        .prepare(
          `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 3 AND library_id = ?
           AND ${CURRENT_PROPOSALS_SQL} GROUP BY state`,
        )
        .all(target, currentAnalysisId(this.db, 3)) as { state: string; n: number }[]) {
        counts[r.state] = r.n;
      }
    }
    const pace = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id
         WHERE b.kind = 'apply' AND b.stage = 3 AND i.state = 'removed' AND i.updated_at >= ?`,
      )
      .get(now - PACE_WINDOW_MS) as { n: number; first: number | null };
    const gate = p?.gate
      ? {
          ...p.gate,
          pairs: p.gate.pairs ? { ...p.gate.pairs, results: undefined } : null,
        }
      : null;
    return {
      waiting: this.waiting3,
      progress: p ? { ...p, gate: undefined } : null,
      gate,
      counts,
      skipReasons: target
        ? (this.db
            .prepare(
              `SELECT COALESCE(review_reason, 'No reason recorded') AS reason, COUNT(*) AS count
               FROM proposed_changes WHERE stage = 3 AND library_id = ? AND state = 'skipped'
                 AND analysis_id = ? GROUP BY reason ORDER BY count DESC, reason LIMIT 20`,
            )
            .all(target, currentAnalysisId(this.db, 3)) as { reason: string; count: number }[])
        : [],
      pace: { removed: pace.n, firstAt: pace.first },
      awaitingIngest: this.batches.awaitingIngest(3),
    };
  }

  status(now = Date.now()) {
    const target = this.targetLibrary();
    const lib = target ? getLibrary(this.opts.main, target) : null;
    // Counted once: the reader's index of 60,000+ books is read row by row (0.3 s on the PC).
    const present = lib ? presentBookCount(this.opts.main, lib.id) : undefined;
    return {
      stages: listStages(this.db),
      // The disk lock shared with the audiobook cleanup (WP21a).
      disk: this.diskLock.state(),
      waiting: this.waiting,
      checks: this.checks(now, present),
      sidecar: this.sidecar(now),
      target: lib
        ? {
            id: lib.id,
            name: lib.name,
            folder: lib.folder,
            present: present ?? 0,
          }
        : null,
      libraries: listLibraries(this.opts.main).map((l) => ({
        id: l.id,
        name: l.name,
        folder: l.folder,
      })),
      // The content server's name for the library to clean (found automatically if possible).
      calibre: this.resolvedLibraryId(),
      stage1: {
        counts: this.stage1Counts(target),
        skipReasons: this.stage1SkipReasons(target),
        pace: this.stage1Pace(now),
        openBatch: this.batches.open(),
        awaitingIngest: this.batches.awaitingIngest(1),
      },
      stage3: this.stage3Status(target, now),
      stage4: this.stage4Status(target, now),
      stage2: {
        waiting: this.waiting2,
        counts: this.stage2Counts(target),
        skipReasons: this.stage2SkipReasons(target),
        fieldPauses: listFieldPauses(this.db, 2),
        pace: this.stage2Pace(now),
        booksLeft: this.stage2BooksLeft(target),
      },
    };
  }
}
