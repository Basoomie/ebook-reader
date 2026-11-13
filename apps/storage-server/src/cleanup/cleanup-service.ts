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
import { BatchService } from './batches';
import { presentBookCount } from './handoff';
import { SecretStore } from './secrets';
import { getSettings } from './settings';
import { Stage1Analysis, type Stage1Progress } from './stage1';
import {
  BUILT_STAGES,
  getStage,
  listStages,
  pauseStage,
  setStageMode,
  type StageMode,
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
  library_indexed: {
    label: "Reader's index of the library is ready (snapshot for each batch)",
    required: true,
  },
};

/** Sidecar results older than this count as not checked. */
export const CHECK_MAX_AGE_MS = 5 * 60 * 1000;
export const SIDECAR_OFFLINE_MS = 90 * 1000;
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
  leaseSeconds?: number;
  log?: (m: string) => void;
  logError?: (m: string, err?: unknown) => void;
}

function str(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
}

export class CleanupService {
  readonly secrets: SecretStore;
  readonly batches: BatchService;
  readonly analysis: Stage1Analysis | null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private analysing: Promise<void> | null = null;
  private stopped = false;
  private readonly log: (m: string) => void;
  private readonly logError: (m: string, err?: unknown) => void;
  /** Why stage 1 is not applying right now (not a pause; it clears by itself). */
  waiting: string | null = null;

  constructor(private readonly opts: CleanupServiceOptions) {
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.secrets = new SecretStore(opts.cleanup, opts.main);
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

  checks(now = Date.now()): CheckResult[] {
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
      library_indexed: this.libraryIndexed(target),
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

  private libraryIndexed(target: string | null): { ok: boolean; detail: string | null } {
    if (!target) return { ok: false, detail: 'No library chosen' };
    if (!this.opts.calibreDir || !this.opts.indexerEnabled()) {
      return { ok: false, detail: "The reader's Calibre indexer is off" };
    }
    try {
      const state = getIndexState(this.opts.main, target);
      if (state.indexedAt === null) return { ok: false, detail: 'Not indexed yet' };
      return { ok: true, detail: `${presentBookCount(this.opts.main, target)} books in the index` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  checksPass(now = Date.now()): { ok: boolean; failing: string[] } {
    const failing = this.checks(now)
      .filter((c) => c.required && !c.ok)
      .map((c) => c.label);
    return { ok: failing.length === 0, failing };
  }

  setMode(stage: number, mode: StageMode): void {
    if (stage < 1 || stage > 5) throw new Error('No such stage');
    if (mode !== 'off' && !BUILT_STAGES.includes(stage)) {
      throw new Error('This stage is not built yet');
    }
    setStageMode(this.db, stage, mode);
    if (stage === 1 && mode !== 'off') {
      const target = this.targetLibrary();
      const p = this.analysis?.progress();
      if (target && this.analysis && (!p || p.libraryId !== target)) this.analysis.restart(target);
    }
    void this.tick();
  }

  /** "Analyse again". */
  reanalyse(): Stage1Progress {
    const target = this.targetLibrary();
    if (!target || !this.analysis) throw new Error('Choose the library first');
    const p = this.analysis.restart(target);
    void this.tick();
    return p;
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
    const stage = getStage(this.db, 1);
    const target = this.targetLibrary();
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
      this.waiting = 'Analysis only: nothing is applied';
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
      : (reason ?? (this.remaining(target) === 0 ? 'Done: nothing left to apply' : null));
  }

  private remaining(target: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 1 AND library_id = ?
           AND state = 'proposed' AND class = 'auto'`,
        )
        .get(target) as { n: number }
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
        pauseStage(this.db, 1, 'mass_missing', `The reader's index reported: ${state.lastWarning}`);
      }
    } catch {
      // No index state yet.
    }
  }

  private runAnalysis(): void {
    if (this.analysing || !this.analysis) return;
    const analysis = this.analysis;
    this.analysing = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, 1).mode === 'off') break;
          const done = await analysis.step(
            () => this.stopped || getStage(this.db, 1).mode === 'off',
          );
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: analysis failed:', err);
      } finally {
        this.analysing = null;
        void this.tick();
      }
    })();
  }

  stage1Counts(target: string | null): Record<string, number> {
    if (!target) return {};
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 1 AND library_id = ? GROUP BY state`,
      )
      .all(target) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  status(now = Date.now()) {
    const target = this.targetLibrary();
    const lib = target ? getLibrary(this.opts.main, target) : null;
    return {
      stages: listStages(this.db),
      waiting: this.waiting,
      checks: this.checks(now),
      sidecar: this.sidecar(now),
      target: lib
        ? {
            id: lib.id,
            name: lib.name,
            folder: lib.folder,
            present: presentBookCount(this.opts.main, lib.id),
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
        openBatch: this.batches.open(),
        awaitingIngest: this.batches.awaitingIngest(),
      },
    };
  }
}
