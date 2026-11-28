/**
 * The library cleanup inside the storage server (Phase 6, WP20a): settings and secrets,
 * the safety checks (stage 0), the stage-1 analysis loop, batch planning and the sidecar's
 * reports. Everything runs on a small timer; every failure is caught and logged, and none
 * of it can affect reading (it only reads Calibre, and writes cleanup.db plus the
 * handoff's book_sources rows in ttsu.db).
 */
import { stage4Write, type Stage4Write, type WriteBatchRow } from './stage4/write-progress';
import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { getIndexState, getLibrary, listLibraries } from '../calibre/libraries';
import { LibraryParts } from './library-parts';
import { COUNTER_BUNDLE, readCounterInfo } from '../counts/counter-bundle';
import { BatchService, REMOVAL_STAGES } from './batches';
import { EditService } from './edits/edits';
import { ChangeAttribution } from './edits/attribution';
import { CoverArchive, coverArchiveDir } from './edits/cover-archive';
import { StoreCovers } from './edits/store-covers';
import { readFileSync } from 'fs';
import { resolveInside } from '../calibre/source-fs';
import { DISK_OWNERS, DiskLock } from './disk-lock';
import { presentBookCount } from './handoff';
import { SecretStore } from './secrets';
import { getSettings } from './settings';
import { Stage1Analysis, type Stage1Progress } from './stage1';
import { Stage2Analysis, type Stage2Progress } from './stage2';
import { listFieldPauses, loadGold, resumeField } from './stage2-gate';
import { STAGE3_WAITING_SQL, Stage3Analysis, type PairRow, type Stage3Progress } from './stage3';
import { Stage3Worker, type Stage3Reader } from '../counts/book-text-worker';
import { oneTimePassesDone, Stage4Analysis, type Stage4Progress } from './stage4/analysis';
import { listOtherGuesses, listSeriesGuesses } from './stage4/series-order-store';
import { listTitleFits } from './title-fits';
import { Stage4Ai } from './stage4/ai-step';
import { Stage5, type Stage5Progress } from './stage5/step';
import { BY_ID as STAGE5_TERMS } from './stage5/vocab';
import { STAGE4_WRITTEN_FIELDS } from './stage2-batches';
import { AiCore, type AiCoreDeps } from '../ai/core';
import { AiRunner } from '../ai/runner';
import {
  CLEANUP_AI_FEATURES,
  CLEANUP_AI_SOURCE,
  CLEANUP_AI_TASK_NAMES,
  cleanupFeatureOf,
} from './ai-features';
import {
  labeledRequestsSince,
  openLookups,
  paceSeconds,
  stage4Eta,
  type SiteCounts,
} from './stage4/eta';
import { FetchQueue, LABELED_PRIORITY, backoffKey } from './stage4/queue';
import { FetcherSlots, slotStateRow, type FetcherSlot } from './stage4/fetch-slots';
import { BookArrivals } from './arrivals/run';
import {
  BookmeterMore,
  bookmeterAnalysisId,
  bookmeterBar,
  stage4Finished,
} from './stage4/bookmeter-more';
import { SeriesPairs, seriesPairsAnalysisId } from './series-pairs/pass';
import { InheritPass } from './inherit/pass';
import { MovePass } from './move/pass';
import { recentPaceLeftMs } from './move/pace';
import { moveAnalysisId } from './move/state';
import {
  FORMATS_CONVERT_SIDECAR_VERSION,
  FORMATS_SIDECAR_VERSION,
  FORMATS_STAGE,
  MOVE_LEFTOVER_SIDECAR_VERSION,
  MOVE_STAGE,
} from './field-stages';
import { FormatsError, FormatsPass, type FormatJobView } from './formats/pass';
import { formatsAnalysisId } from './formats/state';
import { LISTED_TEXT } from './formats/select';
import { booksWithReaderData } from './handoff';
import { LinkDiscovery } from './stage4/link-discovery';
import { BookmeterListings } from './stage4/bookmeter-listing';
import { CALIBRE_FETCH_SITES, type FetchSite } from './settings';
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
  // Manga part A: checked by the sidecar (1.6.0) while the move is not Off; the move waits for it.
  move_target: {
    label: 'The manga library is on the content server with the same #illustrator and #characters',
    required: false,
  },
};

/**
 * Manga part B: the checks about one Calibre library, made per library (the rest are about the
 * content server, the sidecar or the settings). A library's stages write only when its own
 * checks and the shared ones pass.
 */
export const PER_LIBRARY_CHECKS: readonly string[] = [
  'library_found',
  'target_library',
  'library_indexed',
  'illustrator_column',
];

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
  /**
   * The shared AI layer (src/ai/core.ts; one per server). Tests may leave it out: a core on
   * ttsu.db is made then, with `aiProviders` as its stand-in providers.
   */
  aiCore?: AiCore;
  /** Stand-in AI providers (tests, when no aiCore is given). */
  aiProviders?: AiCoreDeps['providers'];
  /**
   * WP20g: the import's source folders (CLEANUP_BOOK_SOURCES_DIR, /mnt/disk1/data/torrents read
   * only); null = the import is off (books added by hand still go through stages 1-5).
   */
  bookSourcesDir?: string | null;
  /** Tests: the source folders are a writable temp folder. */
  bookSourcesReadOnly?: boolean;
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
  /** Stage 4 (WP20d): the fetch queue and the online-sources analysis (Preview only). */
  readonly fetchQueue: FetchQueue;
  /**
   * The AI framework's runner, one for every cleanup stage that asks the models (Calibre
   * stage 4 here, audiobook stage 5 through AudioCleanupService): one spending limit, one
   * provider back-off (WP20e).
   */
  readonly aiRunner: AiRunner;
  /** The shared AI layer the runner asks through (keys, provider settings, the limit). */
  readonly aiCore: AiCore;
  /** WP20g: the Calibre library's new arrivals and the import. */
  readonly arrivals: BookArrivals;
  /** Manga part A: moving the manga and image-only books to the manga library. */
  readonly move: MovePass;
  private moveRunning: Promise<void> | null = null;
  /** Calibre metadata editing from the reader: the user's edits, their history and Undo. */
  readonly edits: EditService;
  /** What the reader's index saw change in Calibre, sorted out (whose change it was). */
  readonly attribution: ChangeAttribution;
  /** Book covers: every picture a cover had before it was replaced (edits/cover-archive.ts). */
  readonly coverArchive: CoverArchive;
  /** Book covers: the store pictures offered in the cover section (edits/store-covers.ts). */
  readonly storeCovers: StoreCovers;
  private attributing: Promise<void> | null = null;
  private arriving: Promise<void> | null = null;
  /** Until when the arrivals asked the reader's index to copy a library's metadata.db at once. */
  private readonly arrivalsIngestUntil = new Map<string, number>();
  /** The linking sidecar's last heartbeat (the audiobook cleanup tells; archives need it). */
  private linkSeen: () => boolean = () => false;
  /** Books written per finished stage-4 batch (counted once each; write-progress.ts). */
  private batchBooks = new Map<string, number>();
  private reader3: Stage3Reader | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly log: (m: string) => void;
  private readonly logError: (m: string, err?: unknown) => void;

  constructor(private readonly opts: CleanupServiceOptions) {
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.secrets = new SecretStore(opts.cleanup, opts.main);
    this.aiCore =
      opts.aiCore ??
      new AiCore({
        db: opts.main,
        dbDir: opts.dbDir ?? path.dirname(opts.main.name),
        providers: opts.aiProviders,
        log: this.log,
      });
    for (const [id, label] of Object.entries(CLEANUP_AI_FEATURES))
      this.aiCore.registerFeature(id, label);
    // A model one of the cleanup's steps uses can't be deleted in Settings > AI (the tasks of
    // steps not built, kept in the settings but shown nowhere, don't hold one).
    this.aiCore.registerModelUse((model) =>
      Object.entries(getSettings(opts.cleanup).models)
        .filter(([task, m]) => m === model && task in CLEANUP_AI_TASK_NAMES)
        .map(([task]) => CLEANUP_AI_TASK_NAMES[task]),
    );
    this.aiRunner = new AiRunner({
      db: opts.cleanup,
      core: this.aiCore,
      source: CLEANUP_AI_SOURCE,
      featureOf: cleanupFeatureOf,
      modelFor: (task) => getSettings(opts.cleanup).models[task] ?? '',
      onlyLabeled: () => getSettings(opts.cleanup).ai.labeledOnly,
      log: this.log,
    });
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
      calibreLibraryOf: (lib) => this.calibreLibraryOf(lib),
      defaultCalibreLibrary: () => this.resolvedLibraryId().id,
    });
    this.fetchQueue = new FetchQueue(
      opts.cleanup,
      opts.cacheDir + '/cleanup',
      () => getSettings(this.db).fetch,
      this.log,
    );
    // Book covers: every picture a cover had before it was replaced, in DB_DIR/covers.
    this.coverArchive = new CoverArchive(
      opts.cleanup,
      coverArchiveDir(opts.dbDir ?? path.dirname(opts.main.name)),
    );
    for (const w of [
      this.batches.stage2,
      this.batches.stage4,
      this.batches.stage5,
      this.batches.edits,
    ])
      w.setCoverArchive(this.coverArchive);
    this.edits = new EditService({
      cleanup: opts.cleanup,
      main: opts.main,
      batches: this.batches,
      cacheDir: opts.cacheDir,
      archive: this.coverArchive,
    });
    this.edits.readCover = (libraryId, bookPath) => {
      const lib = getLibrary(opts.main, libraryId);
      if (!lib || !opts.calibreDir || !bookPath) return null;
      try {
        return readFileSync(
          resolveInside(path.join(opts.calibreDir, lib.folder), `${bookPath}/cover.jpg`),
        );
      } catch {
        return null;
      }
    };
    this.storeCovers = new StoreCovers({
      cleanup: opts.cleanup,
      main: opts.main,
      queue: this.fetchQueue,
      currentCover: (bookId) => {
        const src = opts.main
          .prepare(
            `SELECT library_id, calibre_path, has_cover FROM book_sources
             WHERE book_id = ? AND kind = 'calibre' AND missing_at IS NULL LIMIT 1`,
          )
          .get(bookId) as
          | { library_id: string; calibre_path: string | null; has_cover: number | null }
          | undefined;
        return src?.has_cover === 1
          ? (this.edits.readCover?.(src.library_id, src.calibre_path) ?? null)
          : null;
      },
    });
    this.attribution = new ChangeAttribution({ cleanup: opts.cleanup, main: opts.main });
    this.arrivals = new BookArrivals({
      cleanup: opts.cleanup,
      main: opts.main,
      calibreDir: opts.calibreDir,
      cacheDir: opts.cacheDir,
      sourcesDir: opts.bookSourcesDir ?? null,
      diskLock: this.diskLock,
      batches: this.batches,
      stage2: (lib) => this.lp(lib).analysis2,
      stage2Batches: this.batches.stage2,
      stage4Batches: this.batches.stage4,
      stage5Batches: this.batches.stage5,
      inherit: (lib) => this.lp(lib).inherit,
      analysis4: (lib) => this.lp(lib).analysis4,
      runner: this.aiRunner,
      reader: () => this.stage3Reader(),
      counterBuild: opts.counterBuild ?? counterBuild(),
      targetLibrary: () => this.targetLibrary(),
      libraries: () => this.cleanupLibraries(),
      libraryBusy: () => this.libraryBusy(),
      wantIngest: (lib) => {
        this.arrivalsIngestUntil.set(lib, Date.now() + 10 * 60_000);
      },
      linkSidecarOnline: () => this.linkSeen(),
      carry: (libraryId, from, to) => this.edits.carry(libraryId, from, to),
      requireReadOnlySources: opts.bookSourcesReadOnly,
      checksPass: (lib) => this.checksPass(lib),
      // Manga part A: the run's manga move in the same run (built below; read when the run gets there).
      move: () =>
        this.move
          ? { pass: this.move, writeWait: (lib, target) => this.moveWriteWait(lib, target) }
          : null,
      log: this.log,
    });
    this.move = new MovePass({
      db: opts.cleanup,
      main: opts.main,
      cacheDir: opts.cacheDir,
      batches: this.batches,
      sourceLibrary: () => this.targetLibrary(),
      writeWait: (lib, target) => this.moveWriteWait(lib, target),
      withData: (ids) => booksWithReaderData(opts.main, ids),
      arrivalsRunning: (lib) => {
        const run = this.arrivals.currentRun();
        return !!run && this.arrivals.runLibrary(run) === lib;
      },
      log: this.log,
    });
    // Stage 4's covers are the stores' pictures, read from the fetch cache.
    this.batches.stage4.setStoreCover((url) => {
      const r = opts.cleanup
        .prepare(
          `SELECT id FROM fetch_requests WHERE site = 'amazon-img' AND key = ? AND state = 'done'`,
        )
        .get(url) as { id: number } | undefined;
      return r ? this.fetchQueue.readAnswer(r.id) : null;
    });
  }

  /** Manga part B: the library's own stage objects and round state, made when first needed. */
  private readonly partsByLibrary = new Map<string, LibraryParts>();

  /** Without a library: parts with no stage objects (every stage reads as not set up). */
  private readonly noParts = new LibraryParts(
    '',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );

  /** The parts of a library (made on first use); without a library, parts with nothing in them. */
  lp(libraryId: string | null): LibraryParts {
    if (!libraryId) return this.noParts;
    let parts = this.partsByLibrary.get(libraryId);
    if (!parts) {
      parts = this.makeParts(libraryId);
      this.partsByLibrary.set(libraryId, parts);
    }
    return parts;
  }

  /**
   * The primary library's stage objects and round state (tools and tests that work on one
   * library). The service itself always names a library (lp()).
   */
  get analysis(): Stage1Analysis | null {
    return this.lp(this.targetLibrary()).analysis;
  }
  get analysis2(): Stage2Analysis | null {
    return this.lp(this.targetLibrary()).analysis2;
  }
  get analysis3(): Stage3Analysis | null {
    return this.lp(this.targetLibrary()).analysis3;
  }
  get analysis4(): Stage4Analysis | null {
    return this.lp(this.targetLibrary()).analysis4;
  }
  get stage4Ai(): Stage4Ai | null {
    return this.lp(this.targetLibrary()).stage4Ai;
  }
  get stage5(): Stage5 | null {
    return this.lp(this.targetLibrary()).stage5;
  }
  get bookmeter(): BookmeterMore | null {
    return this.lp(this.targetLibrary()).bookmeter;
  }
  get seriesPairs(): SeriesPairs | null {
    return this.lp(this.targetLibrary()).seriesPairs;
  }
  get links(): LinkDiscovery | null {
    return this.lp(this.targetLibrary()).links;
  }
  get listings(): BookmeterListings | null {
    return this.lp(this.targetLibrary()).listings;
  }
  get waiting(): string | null {
    return this.lp(this.targetLibrary()).waiting;
  }
  get waiting2(): string | null {
    return this.lp(this.targetLibrary()).waiting2;
  }
  get waiting3(): string | null {
    return this.lp(this.targetLibrary()).waiting3;
  }
  get waiting4(): string | null {
    return this.lp(this.targetLibrary()).waiting4;
  }
  get waiting5(): string | null {
    return this.lp(this.targetLibrary()).waiting5;
  }

  /** Every library whose parts exist (the ones worked on since the server started). */
  private allParts(): LibraryParts[] {
    return [...this.partsByLibrary.values()];
  }

  private makeParts(libraryId: string): LibraryParts {
    const opts = this.opts;
    const analysis = opts.calibreDir
      ? new Stage1Analysis({
          cleanup: opts.cleanup,
          libraryId,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          log: this.log,
        })
      : null;
    const analysis2 = opts.calibreDir
      ? new Stage2Analysis({
          cleanup: opts.cleanup,
          libraryId,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          log: this.log,
        })
      : null;
    const analysis3 = opts.calibreDir
      ? new Stage3Analysis({
          cleanup: opts.cleanup,
          libraryId,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          reader: () => this.stage3Reader(),
          counterBuild: opts.counterBuild ?? counterBuild(),
          log: this.log,
        })
      : null;
    const analysis4 = opts.calibreDir
      ? new Stage4Analysis({
          cleanup: opts.cleanup,
          libraryId,
          main: opts.main,
          calibreDir: opts.calibreDir,
          cacheDir: opts.cacheDir,
          dbDir: opts.dbDir ?? null,
          queue: this.fetchQueue,
          log: this.log,
        })
      : null;
    const stage4Ai = analysis4
      ? new Stage4Ai({
          db: opts.cleanup,
          libraryId,
          runner: this.aiRunner,
          analysis: analysis4,
          log: this.log,
        })
      : null;
    const stage5 =
      analysis4 && stage4Ai
        ? new Stage5({
            db: opts.cleanup,
            libraryId,
            runner: this.aiRunner,
            analysis: analysis4,
            stage4Ai: stage4Ai,
            dbDir: opts.dbDir ?? null,
            log: this.log,
          })
        : null;
    const bookmeter =
      analysis4 && stage4Ai
        ? new BookmeterMore({
            db: opts.cleanup,
            analysis: analysis4,
            queue: this.fetchQueue,
            runner: this.aiRunner,
            batches: this.batches.stage4,
            targetLibrary: () => libraryId,
            stage4Done: () => stage4Finished(this.db, libraryId, stage4Ai?.isDone() ?? false),
            writeWait: (lib) => this.bookmeterWriteWait(lib),
            referenceFile: () => analysis4?.referenceFile() ?? null,
            log: this.log,
          })
        : null;
    const a4 = analysis4;
    const seriesPairs = a4
      ? new SeriesPairs({
          db: opts.cleanup,
          source: {
            books: (lib) => a4.seriesPairBooks(lib),
            facts: (lib, uuid) => a4.seriesPairFacts(lib, uuid),
          },
          batches: this.batches.stage4,
          targetLibrary: () => libraryId,
          writeWait: (lib) => this.bookmeterWriteWait(lib),
          log: this.log,
        })
      : null;
    const links = a4
      ? new LinkDiscovery({
          db: opts.cleanup,
          analysis: a4,
          batches: this.batches.stage4,
          targetLibrary: () => libraryId,
          stage4Done: () => stage4Finished(this.db, libraryId, stage4Ai?.isDone() ?? false),
          writeWait: (lib) => this.bookmeterWriteWait(lib),
          referenceFile: () => a4.referenceFile(),
          log: this.log,
        })
      : null;
    const listings = a4
      ? new BookmeterListings({
          db: opts.cleanup,
          analysis: a4,
          queue: this.fetchQueue,
          batches: this.batches.stage4,
          targetLibrary: () => libraryId,
          stage4Done: () => stage4Finished(this.db, libraryId, stage4Ai?.isDone() ?? false),
          writeWait: (lib) => this.bookmeterWriteWait(lib),
          referenceFile: () => a4.referenceFile(),
          log: this.log,
        })
      : null;
    const parts = new LibraryParts(
      libraryId,
      analysis,
      analysis2,
      analysis3,
      analysis4,
      stage4Ai,
      stage5,
      bookmeter,
      seriesPairs,
      links,
      listings,
    );
    // Replaced books: this library's pass (inherit/pass.ts).
    parts.inherit = new InheritPass(
      {
        db: opts.cleanup,
        main: opts.main,
        batches: this.batches,
        writeWait: (lib) => this.bookmeterWriteWait(lib),
        log: this.log,
      },
      libraryId,
    );
    // Books without an EPUB: this library's pass (non-epub-books.md).
    parts.formats = new FormatsPass({
      db: opts.cleanup,
      main: opts.main,
      cacheDir: opts.cacheDir,
      calibreDir: opts.calibreDir,
      batches: this.batches,
      writes: this.batches.formats,
      store: this.batches.formats.store,
      reader: () => this.stage3Reader(),
      libraryId,
      writeWait: (lib) => this.formatsWriteWait(lib),
      calibreLibraryOf: (lib) => this.calibreLibraryOf(lib),
      disk: {
        tryAcquire: (owner, side) => this.diskLock.tryAcquire(owner, side),
        release: (owner) => this.diskLock.release(owner),
      },
      log: this.log,
    });
    return parts;
  }

  /**
   * An answer reached the queue: wakes stage 4's analysis only (when it is not running already).
   * A whole round per answer ran stages 1-3's planning about once a second (found live
   * 2026-11-17); the 5 s timer still runs every stage.
   */
  answerArrived(): void {
    // The audiobook cleanup's stage 4 (WP21c) shares the queue: it is told too.
    for (const l of this.answerListeners) {
      try {
        l();
      } catch (err) {
        this.logError('Cleanup: an answer listener failed:', err);
      }
    }
    // More Bookmeter coverage's pass waits on its own answers, and so does Bookmeter links'.
    this.runBookmeter();
    this.runListings();
    if (this.stopped) return;
    for (const lib of this.cleanupLibraries()) {
      if (this.lp(lib).analysing4) continue;
      try {
        void this.round4(lib);
      } catch (err) {
        this.logError('Cleanup: stage 4 wake-up failed:', err);
      }
    }
  }

  private readonly answerListeners = new Set<() => void>();

  /** Called whenever the fetcher's answer reached the queue (the audiobook cleanup's stage 4). */
  onAnswerArrived(listener: () => void): () => void {
    this.answerListeners.add(listener);
    return () => this.answerListeners.delete(listener);
  }

  /** The active fetcher's process (its run id), as last seen by this server process. */
  private fetcherRun: { fetcherId: string; runId: string } | null = null;

  /** Parallel fetchers beside the usual one (temporary: stage4/fetch-slots.ts). */
  private fetcherSlotsOnce: FetcherSlots | null = null;
  private get fetcherSlots(): FetcherSlots {
    return (this.fetcherSlotsOnce ??= new FetcherSlots(
      (slot) => this.fetchQueue.releaseLeases(Date.now(), slot),
      this.log,
    ));
  }

  /**
   * The fetch container's heartbeat; true when it is (or becomes) the one active fetcher.
   *
   * A restarted fetcher (a new run id under the same fetcher id, or another fetcher taking over)
   * can't post the answers its old process had in flight: those requests go back to the queue at
   * once instead of waiting out their leases (2 minutes). Found live 2026-11-18: a VPN switch
   * every 15 minutes restarts the fetcher, and every site with a request in flight stood still
   * for the lease. Run ids are kept in memory only: after a server restart the first heartbeat
   * just records one (a fetcher that kept running may still post its answers).
   */
  fetchHeartbeat(
    hb: {
      fetcherId: string;
      version: string | null;
      problem: string | null;
      sudachi: string | null;
      runId?: string | null;
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
    if (other) return this.fetcherSlots.heartbeat(hb, now, s.offlineSeconds * 1000) !== null;
    this.fetcherSlots.drop(hb.fetcherId);
    if (hb.runId) {
      const prev = this.fetcherRun;
      const restarted =
        prev !== null && (prev.fetcherId !== hb.fetcherId || prev.runId !== hb.runId);
      this.fetcherRun = { fetcherId: hb.fetcherId, runId: hb.runId };
      if (restarted) {
        const n = this.fetchQueue.releaseLeases(now, 0);
        if (n > 0) this.log(`Cleanup: fetcher restarted; ${n} requests in flight asked again`);
      }
    }
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

  /** The fetcher's slot while it is active (0 = the usual one), else null. */
  fetcherSlot(fetcherId: string, now = Date.now()): FetcherSlot | null {
    if (this.isActiveFetcher(fetcherId, now)) return { slot: 0 };
    const s = getSettings(this.db).fetch;
    return this.fetcherSlots.slotOf(fetcherId, now, s.offlineSeconds * 1000);
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

  /** The reader's database (ttsu.db). */
  get main(): Database.Database {
    return this.opts.main;
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
    for (const P of this.allParts()) {
      await P.analysing;
      await P.analysing2;
    }
    this.reader3?.close();
    for (const P of this.allParts()) {
      await P.analysing3;
      P.analysis3?.close();
      await P.analysing4;
    }
    this.arrivals.stop();
    await this.arriving;
  }

  /** WP20g: the audiobook cleanup tells whether the linking sidecar is seen. */
  setLinkSidecarSeen(seen: () => boolean): void {
    this.linkSeen = seen;
  }

  /**
   * WP20g: a stage's own analysis running (an arrivals run never overlaps one: each waits), as
   * the words for the page; null when none runs.
   */
  libraryBusy(): string | null {
    // Manga part B: one library's analysis at a time, and no run beside any of them.
    for (const P of this.allParts()) {
      const busy = P.busy();
      if (busy)
        return this.allParts().length > 1 ? `${busy} of ${this.libraryName(P.libraryId)}` : busy;
    }
    return null;
  }

  /** The reader's name of a library (its folder), for the page's words. */
  libraryName(libraryId: string): string {
    const lib = getLibrary(this.opts.main, libraryId);
    return lib?.name || lib?.folder || libraryId;
  }

  /**
   * Manga part B: the Calibre libraries the cleanup works on, primary first: the primary library
   * (targetLibrary()) and the move's target (manga-library), when the reader has them.
   */
  cleanupLibraries(): string[] {
    const out: string[] = [];
    const primary = this.targetLibrary();
    if (primary) out.push(primary);
    const second = this.move?.targetLibrary() ?? null;
    if (second && !out.includes(second)) out.push(second);
    return out;
  }

  /** The library a request names (?library=), else the primary library. */
  libraryOr(libraryId: unknown): string | null {
    if (typeof libraryId === 'string' && libraryId) {
      if (!this.cleanupLibraries().includes(libraryId))
        throw new Error('The cleanup does not work on that library');
      return libraryId;
    }
    return this.targetLibrary();
  }

  /** A finished removal batch waits for the reader's index of this library (index it now). */
  wantsIngest(libraryId: string): boolean {
    try {
      if (Date.now() < (this.arrivalsIngestUntil.get(libraryId) ?? 0)) return true;
      const move = this.batches.awaitingIngest(MOVE_STAGE);
      if (move && (move.libraryId === libraryId || move.targetLibraryId === libraryId)) return true;
      return REMOVAL_STAGES.some((st) => this.batches.awaitingIngest(st, libraryId) !== null);
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
        `INSERT INTO preflight (name, library_id, ok, detail, source, checked_at)
         VALUES (?, ?, ?, ?, 'sidecar', ?)
         ON CONFLICT(name, library_id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
           source = excluded.source, checked_at = excluded.checked_at`,
      );
      // Manga part B: a per-library check names its content-server library (sidecar 1.7.0); an
      // older sidecar checks only its own library, the primary one.
      const byCalibre = new Map<string, string>();
      for (const lib of this.cleanupLibraries()) {
        const c = this.calibreLibraryOf(lib);
        if (c) byCalibre.set(c, lib);
      }
      const primary = this.targetLibrary() ?? '';
      this.db.transaction(() => {
        for (const c of body.checks as unknown[]) {
          const check = c as { name?: unknown; ok?: unknown; detail?: unknown; library?: unknown };
          const name = str(check.name, 50);
          if (!name || !(name in CHECK_LABELS)) continue;
          let lib = '';
          if (PER_LIBRARY_CHECKS.includes(name)) {
            const calibre = str(check.library, 200);
            lib = calibre ? (byCalibre.get(calibre) ?? '') : primary;
            if (!lib) continue;
          }
          put.run(name, lib, check.ok === true ? 1 : 0, str(check.detail, 1000), now);
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
  checks(now = Date.now(), present?: number | null, libraryId?: string | null): CheckResult[] {
    const sidecar = this.sidecar(now);
    // Manga part B: the per-library checks are those of the library asked about (the primary
    // library when none is named); the others are shared.
    const target = libraryId ?? this.targetLibrary();
    const primary = target !== null && target === this.targetLibrary();
    const login = this.sidecarConfig();
    const lib = primary
      ? this.resolvedLibraryId()
      : {
          id: target ? this.calibreLibraryIdOf(target) : null,
          auto: true,
          libraries: this.calibreLibraries(),
        };
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
        this.db
          .prepare(`SELECT * FROM preflight WHERE source = 'sidecar' AND library_id IN ('', ?)`)
          .all(target ?? '') as {
          name: string;
          library_id: string;
          ok: number;
          detail: string | null;
          checked_at: number;
        }[]
      )
        .filter((r) => PER_LIBRARY_CHECKS.includes(r.name) === (r.library_id !== ''))
        .map((r) => [r.name, r]),
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
    const primary = this.targetLibrary();
    const file = primary ? (this.lp(primary).analysis2?.referenceFile() ?? null) : null;
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
  checksPass(libraryId: string | null, now = Date.now()): { ok: boolean; failing: string[] } {
    const failing = this.checks(now, null, libraryId)
      .filter((c) => c.required && !c.ok)
      .map((c) => c.label);
    return { ok: failing.length === 0, failing };
  }

  setMode(libraryId: string | null, stage: number, mode: StageMode): void {
    if (stage < 1 || stage > 5) throw new Error('No such stage');
    if (mode !== 'off' && !BUILT_STAGES.includes(stage)) {
      throw new Error('This stage is not built yet');
    }
    if (mode === 'on' && PREVIEW_ONLY_STAGES.includes(stage)) {
      throw new Error('Stage 4 is Preview only for now: its writes come with the AI check (WP20e)');
    }
    const target = this.libraryOr(libraryId);
    if (!target) throw new Error('Choose the library first');
    setStageMode(this.db, target, stage, mode);
    const P = this.lp(target);
    const analysis =
      stage === 1
        ? P.analysis
        : stage === 2
          ? P.analysis2
          : stage === 3
            ? P.analysis3
            : stage === 4
              ? P.analysis4
              : null;
    if (analysis && mode !== 'off') {
      const p = analysis.progress();
      if (!p || p.libraryId !== target) analysis.restart(target);
    }
    void this.tick();
  }

  /** "Analyse again". */
  reanalyse(
    libraryId: string | null,
    stage = 1,
  ): Stage1Progress | Stage2Progress | Stage3Progress | Stage4Progress | Stage5Progress {
    const target = this.libraryOr(libraryId);
    // WP20g: a new-arrivals run and a stage's own analysis never overlap.
    const arrivalRun = this.arrivals.currentRun();
    if (
      arrivalRun &&
      !['scan', 'archives', 'identify', 'compare', 'plan'].includes(arrivalRun.phase)
    )
      throw new Error(
        'A new-arrivals run is working on its books; run the analysis again after it',
      );
    if (!target) throw new Error('Choose the library first');
    const P = this.lp(target);
    if (stage === 5) {
      const p5 = P.stage5?.restart(target);
      if (!p5) throw new Error("Stage 5 starts after stage 4's analysis");
      if (getStage(this.db, target, 5).pauseReason === 'library_changed')
        resumeStage(this.db, target, 5);
      P.status5Cache = null;
      void this.tick();
      return p5;
    }
    const analysis =
      stage === 4
        ? P.analysis4
        : stage === 3
          ? P.analysis3
          : stage === 2
            ? P.analysis2
            : stage === 1
              ? P.analysis
              : null;
    if (!analysis)
      throw new Error(stage >= 1 && stage <= 4 ? 'Choose the library first' : 'No such stage');
    const p = analysis.restart(target);
    // These pauses ask for a new analysis; it is running now.
    const pause = getStage(this.db, target, stage).pauseReason;
    if (pause === 'library_changed' || pause === 'not_identical')
      resumeStage(this.db, target, stage);
    void this.tick();
    return p;
  }

  /** Resume one paused field of stage 2. A gate pause lifts only when a new analysis passes. */
  resumeField(libraryId: string | null, stage: number, field: string): void {
    const target = this.libraryOr(libraryId);
    if (!target) throw new Error('Choose the library first');
    const pause = listFieldPauses(this.db, target, stage).find((p) => p.field === field);
    if (!pause) return;
    if (pause.reason === 'gate' || pause.reason === 'no_labels') {
      throw new Error(
        'This field is paused by the gate on the labeled books; it resumes by itself when a new analysis passes',
      );
    }
    resumeField(this.db, target, stage, field);
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
    this.sortChanges();
    // Manga part B: every library the cleanup works on, the primary one first.
    for (const target of this.cleanupLibraries()) {
      if (this.stopped) return;
      await this.round1(target);
      await this.round2(target);
      await this.round3(target);
      await this.round4(target);
      await this.round5(target);
    }
    this.runArrivals();
    this.runBookmeter();
    this.runSeriesPairs();
    this.runMove();
    this.runFormats();
    this.runInherit();
    this.runLinks();
    this.runListings();
  }

  /**
   * Manga part A: the move pass in its own loop (each step short; the select step reads the
   * library's snapshot once). Woken by the 5 s round and by the card.
   */
  runMove(): void {
    if (this.moveRunning || this.stopped) return;
    const pass = this.move;
    this.moveRunning = (async () => {
      try {
        for (let i = 0; i < 1000; i++) {
          if (this.stopped) break;
          const r = await pass.step(() => this.stopped);
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: the move to the manga library failed:', err);
      } finally {
        this.moveRunning = null;
      }
    })();
  }

  /** After the user's change on the card: work at once. */
  moveChanged(): void {
    this.runMove();
  }

  /**
   * Books without an EPUB: each library's pass in its own loop (each step short: a select reads
   * the snapshot once; a check or a comparison is one book). Woken by the 5 s round, the card and
   * each answer from the sidecar.
   */
  runFormats(): void {
    for (const lib of this.cleanupLibraries()) this.runFormatsOf(lib);
  }

  private runFormatsOf(target: string): void {
    const P = this.lp(target);
    const pass = P.formats;
    if (P.formatsRunning || this.stopped || !pass) return;
    P.formatsRunning = (async () => {
      try {
        for (let i = 0; i < 1000; i++) {
          if (this.stopped) break;
          const r = await pass.step(() => this.stopped);
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: books without an EPUB failed:', err);
      } finally {
        P.formatsRunning = null;
      }
    })();
  }

  /**
   * Replaced books: each library's pass in its own loop (a step looks at 200 replacements or
   * plans one batch). Woken by the 5 s round and by the card.
   */
  runInherit(): void {
    for (const lib of this.cleanupLibraries()) this.runInheritOf(lib);
  }

  private runInheritOf(target: string): void {
    const P = this.lp(target);
    const pass = P.inherit;
    if (P.inheritRunning || this.stopped || !pass) return;
    // A new-arrivals run writes its own replacements (run.ts phase inherit): one writer.
    if (this.arrivals.currentRun()) return;
    P.inheritRunning = (async () => {
      try {
        for (let i = 0; i < 1000; i++) {
          if (this.stopped) break;
          const r = await pass.step();
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: replaced books failed:', err);
      } finally {
        P.inheritRunning = null;
      }
    })();
  }

  /** Replaced books: a library's pass (null: no such cleanup library). */
  inheritOf(target: string | null): InheritPass | null {
    if (!target) return null;
    return this.lp(target).inherit;
  }

  /** The card's status: mode, counts, the bar of the write with its time left, a page of items. */
  inheritStatus(target: string | null, offset = 0, now = Date.now()): unknown {
    const pass = this.inheritOf(target);
    if (!pass) return null;
    const st = pass.state();
    const counts = pass.counts();
    const written = (counts.applied ?? 0) + (counts.skipped ?? 0);
    const toWrite = (counts.proposed ?? 0) + (counts.queued ?? 0);
    const w = st.progress.write;
    const bar =
      st.mode === 'on' && written + toWrite > 0
        ? {
            label: 'values',
            done: written,
            total: written + toWrite,
            startedAt: w?.startedAt ?? null,
            base: w?.writtenAtStart ?? 0,
          }
        : null;
    const left =
      bar && bar.startedAt && bar.done - bar.base > 0 && bar.done < bar.total
        ? Math.round(((now - bar.startedAt) / (bar.done - bar.base)) * (bar.total - bar.done))
        : null;
    return {
      mode: st.mode,
      waiting: st.progress.waiting ?? null,
      counts,
      bar: bar ? { ...bar, leftMs: left } : null,
      ...pass.view(offset),
    };
  }

  /** After the user's change on the page: work at once. */
  inheritChanged(target: string | null): void {
    if (target) this.runInheritOf(target);
  }

  /** A library's pass (null: no such cleanup library, or none set up). */
  formatsOf(target: string | null): FormatsPass | null {
    if (!target) return null;
    return this.lp(target).formats;
  }

  /** After the user's change on the card, or an answer from the sidecar: work at once. */
  formatsChanged(target: string | null = null): void {
    if (target) this.runFormatsOf(target);
    else this.runFormats();
  }

  /** The next conversion job of any library (one at a time across them; the primary first). */
  claimFormatJob(): FormatJobView | null {
    for (const lib of this.cleanupLibraries()) {
      const job = this.lp(lib).formats?.claimJob() ?? null;
      if (job) return job;
    }
    return null;
  }

  /** The pass a conversion job belongs to (its book's library). */
  formatsForJob(jobId: number): FormatsPass {
    const r = this.db
      .prepare('SELECT library_id FROM calibre_format_books WHERE id = ?')
      .get(jobId) as { library_id: string } | undefined;
    const pass = r ? this.formatsOf(r.library_id) : null;
    if (!pass) throw new FormatsError(404, 'not_found', 'No such job');
    return pass;
  }

  /**
   * Why the pass's write must wait now: a batch open, an earlier stage of this library still
   * writing, the safety checks, and a sidecar that converts and adds formats (1.8.0).
   */
  private formatsWriteWait(lib: string): string | null {
    if (this.batches.open()) return 'A batch is being applied';
    for (const [s, left] of [
      [1, () => this.remaining(lib)],
      [2, () => this.remaining2(lib)],
      [3, () => this.remaining3(lib)],
      [4, () => this.remaining4(lib)],
      [5, () => this.remaining5(lib)],
    ] as [number, () => number][]) {
      if (getStage(this.db, lib, s).mode === 'on' && left() > 0)
        return `Waiting for stage ${s} to finish writing`;
    }
    const checks = this.checksPass(lib);
    if (!checks.ok) return `Waiting for the safety checks: ${checks.failing.join('; ')}`;
    if (!this.batches.sidecarAtLeast(FORMATS_SIDECAR_VERSION))
      return `The cleanup sidecar is older than ${FORMATS_SIDECAR_VERSION}: rebuild ttsu-cleanup-apply`;
    return null;
  }

  /** A library's books-without-an-EPUB card: mode, phase, counts, bars with the time left, the spot check. */
  formatsStatus(target: string | null): unknown {
    const pass = this.formatsOf(target);
    if (!target || !pass) return null;
    const st = pass.state();
    const p = st.progress;
    const lib = target;
    return {
      mode: st.mode,
      pausedReason: st.pausedReason,
      pausedDetail: st.pausedDetail,
      analysisId: formatsAnalysisId(p.run),
      progress: p,
      bars: pass.bars(lib),
      counts: pass.counts(lib),
      listedText: LISTED_TEXT,
      spot: pass.spotCounts(),
      spotPassed: pass.spotPassed(),
      // Conversions need the sidecar of rules 2 (1.8.1); it also writes (1.8.0).
      sidecar: {
        ready: this.batches.sidecarAtLeast(FORMATS_CONVERT_SIDECAR_VERSION),
        need: FORMATS_CONVERT_SIDECAR_VERSION,
      },
      batches: pass.batchesOf(20).map((b) => ({
        id: b.id,
        kind: b.kind,
        state: b.state,
        itemCount: b.itemCount,
        createdAt: b.createdAt,
        finishedAt: b.finishedAt,
        undoOf: b.undoOf,
        error: b.error,
        counts: this.batches.itemCounts(b.id),
      })),
      stage: FORMATS_STAGE,
      library: { id: lib, folder: getLibrary(this.opts.main, lib)?.folder ?? null },
    };
  }

  /**
   * The library the sidecar checks for the move (its columns against the cleanup's library):
   * the content server's id of the move's target while the move is not Off.
   */
  moveTargetForSidecar(): string | null {
    try {
      if (this.move.state().mode === 'off') return null;
      const target = this.move.targetLibrary();
      return target ? this.calibreLibraryOf(target) : null;
    } catch {
      return null;
    }
  }

  /**
   * The content server's id of a reader library: the cleanup's own library as resolved for the
   * sidecar, any other by its folder name when the content server lists it (null otherwise).
   */
  calibreLibraryOf(readerLibraryId: string): string | null {
    if (readerLibraryId === this.targetLibrary()) return this.resolvedLibraryId().id;
    const folder = getLibrary(this.opts.main, readerLibraryId)?.folder;
    if (folder === undefined) return null;
    const id = libraryIdFromFolder(folder);
    return this.calibreLibraries().includes(id) ? id : null;
  }

  /** The content server's id a library would have (from its folder), listed by the server or not. */
  private calibreLibraryIdOf(readerLibraryId: string): string | null {
    if (readerLibraryId === this.targetLibrary()) return this.resolvedLibraryId().id;
    const folder = getLibrary(this.opts.main, readerLibraryId)?.folder;
    return folder === undefined ? null : libraryIdFromFolder(folder);
  }

  /**
   * Why the move's write must wait now: a batch open, an earlier stage still writing, the
   * safety checks, and the move's own: the target library on the content server with the same
   * columns (the sidecar's check), on in the reader with a language and indexed, and a sidecar
   * that moves books (1.6.0).
   */
  private moveWriteWait(lib: string, target: string): string | null {
    if (this.batches.open()) return 'A batch is being applied';
    for (const [s, left] of [
      [1, () => this.remaining(lib)],
      [2, () => this.remaining2(lib)],
      [3, () => this.remaining3(lib)],
      [4, () => this.remaining4(lib)],
      [5, () => this.remaining5(lib)],
    ] as [number, () => number][]) {
      if (getStage(this.db, lib, s).mode === 'on' && left() > 0)
        return `Waiting for stage ${s} to finish writing`;
    }
    const checks = this.checksPass(lib);
    if (!checks.ok) return `Waiting for the safety checks: ${checks.failing.join('; ')}`;
    if (!this.batches.sidecarAtLeast(MOVE_LEFTOVER_SIDECAR_VERSION))
      return `The cleanup sidecar is older than ${MOVE_LEFTOVER_SIDECAR_VERSION}: rebuild ttsu-cleanup-apply`;
    const t = getLibrary(this.opts.main, target);
    if (!t || !t.enabled || !t.language)
      return `Switch the library "${t?.folder ?? target}" on in the reader, with its language, first`;
    if (!this.calibreLibraryOf(target))
      return `The content server doesn't list the library "${t.folder}"`;
    const check = this.checks().find((c) => c.name === 'move_target');
    if (!check?.ok)
      return `The library "${t.folder}" on the content server: ${check?.detail ?? 'not checked yet'}`;
    try {
      if (getIndexState(this.opts.main, target).indexedAt === null)
        return `The reader hasn't indexed "${t.folder}" yet`;
    } catch {
      return `The reader hasn't indexed "${t.folder}" yet`;
    }
    return null;
  }

  /** The move card: mode, phase, counts, the spot check, the bar with the time left. */
  moveStatus(now = Date.now()): unknown {
    const pass = this.move;
    const st = pass.state();
    const p = st.progress;
    const lib = p.libraryId ?? this.targetLibrary();
    const target = pass.targetLibrary();
    const proposals = lib ? pass.proposalCounts(lib, p.run) : {};
    const moved = lib ? pass.movedCount(lib) : 0;
    const toMove = (proposals['auto:proposed'] ?? 0) + (proposals['auto:queued'] ?? 0);
    const base = p.write.movedAtStart ?? moved;
    const bar =
      p.phase === 'write' && st.mode === 'on' && moved - base + toMove > 0
        ? {
            label: 'books',
            done: moved - base,
            total: moved - base + toMove,
            startedAt: p.write.startedAt,
          }
        : null;
    // The time left from the last hour's pace (move/pace.ts), not from the first batch.
    const left =
      bar && lib && bar.done < bar.total
        ? recentPaceLeftMs(
            (
              this.db
                .prepare(
                  `SELECT moved_at FROM calibre_moves INDEXED BY calibre_moves_from
                   WHERE from_library_id = ? ORDER BY moved_at DESC LIMIT 200`,
                )
                .all(lib) as { moved_at: number }[]
            ).map((r) => r.moved_at),
            bar.total - bar.done,
            now,
          )
        : null;
    const t = target ? getLibrary(this.opts.main, target) : null;
    return {
      mode: st.mode,
      pausedReason: st.pausedReason,
      pausedDetail: st.pausedDetail,
      analysisId: moveAnalysisId(p.run),
      progress: p,
      bar: bar ? { ...bar, leftMs: left } : null,
      proposals,
      moved,
      spot: pass.spotCounts(),
      spotPassed: pass.spotPassed(),
      target: t
        ? {
            id: t.id,
            folder: t.folder,
            name: t.name,
            enabled: t.enabled,
            language: t.language,
            calibreLibrary: this.calibreLibraryOf(t.id),
          }
        : { folder: getSettings(this.db).move.targetFolder, missing: true },
      source: lib ? { id: lib, folder: getLibrary(this.opts.main, lib)?.folder ?? null } : null,
    };
  }

  /**
   * Series under two names: its pass in its own loop (each step works about 25 ms), once stage 4
   * has finished (the pass reads stage 4's stored answers). Woken by the 5 s round.
   */
  runSeriesPairs(): void {
    for (const lib of this.cleanupLibraries()) this.runSeriesPairsOf(lib);
  }

  private runSeriesPairsOf(target: string): void {
    const P = this.lp(target);
    const pass = P.seriesPairs;
    if (P.seriesPairsRunning || this.stopped || !pass) return;
    if (!stage4Finished(this.db, target, P.stage4Ai?.isDone() ?? false)) return;
    P.seriesPairsRunning = (async () => {
      try {
        for (let i = 0; i < 100_000; i++) {
          if (this.stopped) break;
          const r = await pass.step();
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: series under two names failed:', err);
      } finally {
        P.seriesPairsRunning = null;
      }
    })();
  }

  /** The card's status: mode, phase, bar with the time left, counts. */
  seriesPairsStatus(target: string | null, now = Date.now()): unknown {
    const P = this.lp(target);
    if (!target) return null;
    const pass = P.seriesPairs;
    if (!pass) return null;
    const st = pass.state();
    const p = st.progress;
    const proposals = target ? pass.proposalCounts(target) : {};
    const written = (proposals.applied ?? 0) + (proposals.skipped ?? 0);
    const toWrite = (proposals.proposed ?? 0) + (proposals.queued ?? 0);
    const bar =
      p.phase === 'signals' && p.pairs
        ? { label: 'pairs', done: p.done, total: p.pairs, startedAt: p.phaseStartedAt }
        : p.phase === 'write' && st.mode === 'on' && written + toWrite > 0
          ? {
              label: 'books',
              done: written,
              total: written + toWrite,
              // The pace of this write: from its first batch, books written since (WP20 lessons
              // 4; the phase may have waited in Preview for hours before On).
              startedAt: p.write.startedAt ?? null,
              base: p.write.writtenAtStart ?? 0,
            }
          : null;
    const base = bar && 'base' in bar ? (bar.base ?? 0) : 0;
    const left =
      bar && bar.startedAt && bar.done - base > 0 && bar.done < bar.total
        ? Math.round(((now - bar.startedAt) / (bar.done - base)) * (bar.total - bar.done))
        : null;
    return {
      mode: st.mode,
      pausedReason: st.pausedReason,
      stage4Done: stage4Finished(this.db, target, P.stage4Ai?.isDone() ?? false),
      analysisId: seriesPairsAnalysisId(p.run),
      progress: p,
      bar: bar ? { ...bar, leftMs: left } : null,
      proposals,
    };
  }

  /** After the user's change on the page: work at once. */
  seriesPairsChanged(target: string | null): void {
    if (target) this.runSeriesPairsOf(target);
  }

  /**
   * More Bookmeter coverage: its pass, stepped in its own loop like the new arrivals (never
   * blocks a round; each step works about 25 ms). Woken by the 5 s round and by answers.
   */
  runBookmeter(): void {
    for (const lib of this.cleanupLibraries()) this.runBookmeterOf(lib);
  }

  private runBookmeterOf(target: string): void {
    const P = this.lp(target);
    const pass = P.bookmeter;
    if (P.bookmeterRunning || this.stopped || !pass) return;
    P.bookmeterRunning = (async () => {
      try {
        for (let i = 0; i < 100_000; i++) {
          if (this.stopped) break;
          const r = await pass.step(() => this.stopped);
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: More Bookmeter matches failed:', err);
      } finally {
        P.bookmeterRunning = null;
      }
    })();
  }

  /**
   * More direct links: its pass, stepped in its own loop like the Bookmeter pass (never blocks a
   * round; each step works about 25 ms). Woken by the 5 s round and by the user's changes.
   */
  runLinks(): void {
    for (const lib of this.cleanupLibraries()) this.runLinksOf(lib);
  }

  private runLinksOf(target: string): void {
    const P = this.lp(target);
    const pass = P.links;
    if (P.linksRunning || this.stopped || !pass) return;
    P.linksRunning = (async () => {
      try {
        for (let i = 0; i < 1_000_000; i++) {
          if (this.stopped) break;
          const r = await pass.step(() => this.stopped);
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: More direct links failed:', err);
      } finally {
        P.linksRunning = null;
        P.linksCache = null;
      }
    })();
  }

  /** More direct links' card; cached 5 s (its counts read two covering indexes). */
  linksStatus(target: string | null, now = Date.now()): unknown {
    const P = this.lp(target);
    if (!target) return null;
    const pass = P.links;
    if (!pass) return null;
    if (P.linksCache && now - P.linksCache.at < 5_000) return P.linksCache.value;
    const value = pass.status(target, now);
    P.linksCache = { at: now, value };
    return value;
  }

  /** Drops the card's cached status (after the user's change on the page) and works at once. */
  linksChanged(target: string | null): void {
    const P = this.lp(target);
    if (!target) return;
    P.linksCache = null;
    this.runLinksOf(target);
  }

  /**
   * Bookmeter links: its pass, stepped in its own loop like More direct links (never blocks a
   * round; each step works about 25 ms). Woken by the 5 s round, by answers and by the card.
   */
  runListings(): void {
    for (const lib of this.cleanupLibraries()) this.runListingsOf(lib);
  }

  private runListingsOf(target: string): void {
    const P = this.lp(target);
    const pass = P.listings;
    if (P.listingsRunning || this.stopped || !pass) return;
    P.listingsRunning = (async () => {
      try {
        for (let i = 0; i < 1_000_000; i++) {
          if (this.stopped) break;
          const r = await pass.step();
          if (r === 'idle' || r === 'wait') break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: Bookmeter links failed:', err);
      } finally {
        P.listingsRunning = null;
      }
    })();
  }

  /** Bookmeter links' card; cached 5 s (its counts read one covering index). */
  listingsStatus(target: string | null, now = Date.now()): unknown {
    const P = this.lp(target);
    if (!target) return null;
    const pass = P.listings;
    if (!pass) return null;
    if (P.listingsCache && now - P.listingsCache.at < 5_000) return P.listingsCache.value;
    const b = this.fetchQueue.blocked('bookmeter', now);
    const value = pass.status(target, now, b && b.reason !== 'pace' ? b.reason : null);
    P.listingsCache = { at: now, value };
    return value;
  }

  /** Drops the card's cached status (after the user's change on the page) and works at once. */
  listingsChanged(target: string | null): void {
    const P = this.lp(target);
    if (!target) return;
    P.listingsCache = null;
    this.runListingsOf(target);
  }

  /** Why the pass's write must wait now (as stage 4 On's own: apply4), else null. */
  private bookmeterWriteWait(target: string): string | null {
    if (getStage(this.db, target, 4).pauseReason) return 'Stage 4 is paused';
    if (this.batches.open()) return 'A batch is being applied';
    for (const [s, left] of [
      [1, () => this.remaining(target)],
      [2, () => this.remaining2(target)],
      [3, () => this.remaining3(target)],
    ] as [number, () => number][]) {
      if (getStage(this.db, target, s).mode === 'on' && left() > 0)
        return `Waiting for stage ${s} to finish writing`;
    }
    const checks = this.checksPass(target);
    if (!checks.ok) return `Waiting for the safety checks: ${checks.failing.join('; ')}`;
    return null;
  }

  /**
   * More Bookmeter coverage's card: mode, phase, bars with the time left (from what is open, at
   * the pace measured in this run: WP20 lessons 4), counts. Cached 30 s (the counts read the
   * pass's covering index and the proposals' count index).
   */
  bookmeterStatus(target: string | null, now = Date.now()): unknown {
    const P = this.lp(target);
    if (!target) return null;
    const pass = P.bookmeter;
    if (!pass) return null;
    if (P.bookmeterCache && now - P.bookmeterCache.at < 30_000) return P.bookmeterCache.value;
    const st = pass.state();
    const p = st.progress;
    const lib = target;
    const interval = getSettings(this.db).fetch.sites.bookmeter.intervalSeconds;
    const runId = bookmeterAnalysisId(p.run);
    const aiBatches = p.phase === 'ai' ? pass.openAiBatches() : [];
    const proposals = lib ? pass.proposalCounts(lib, p.run) : {};
    const written = (proposals.applied ?? 0) + (proposals.skipped ?? 0);
    const bar = bookmeterBar(p, now, {
      ai: pass.aiCounts(runId),
      aiInBatches: aiBatches.reduce((a, b) => a + b.requests, 0),
      openSearches: pass.openRequests(['q1', 'q2']),
      openQ1: pass.openRequests(['q1']),
      openStores: pass.openRequests(['stores']),
      intervalSeconds: interval,
      write:
        p.phase === 'write' && p.write.rebuilt
          ? {
              done: written,
              total: written + (proposals.proposed ?? 0) + (proposals.queued ?? 0),
              pace: pass.writePace(p.write.batches),
            }
          : undefined,
    });
    const value = {
      mode: st.mode,
      pausedReason: st.pausedReason,
      pausedDetail: st.pausedDetail,
      stage4Done: stage4Finished(this.db, target, P.stage4Ai?.isDone() ?? false),
      progress: p,
      bar,
      books: lib ? pass.bookCounts(lib) : {},
      proposals,
      spot: pass.spotCounts(),
      spotPassed: pass.spotPassed(),
      aiBatches,
      batchStallMinutes: this.aiRunner.settings().batchStallMinutes,
      // OpenAI's batches have their own limit (book summaries session 3).
      batchStallMinutesOpenai: this.aiRunner.settings().batchStallMinutesOpenai,
      siteWait: ((b) => (b && b.reason !== 'pace' ? b.reason : null))(
        this.fetchQueue.blocked('bookmeter', now),
      ),
    };
    P.bookmeterCache = { at: now, value };
    return value;
  }

  /** Drops the card's cached status (after the user's change on the page). */
  bookmeterChanged(target: string | null): void {
    const P = this.lp(target);
    if (!target) return;
    P.bookmeterCache = null;
    this.runBookmeterOf(target);
  }

  /**
   * What the reader's index saw change in Calibre, sorted out in chunks of 500 that yield to the
   * event loop between them (never blocks a request for long). Called after every index and on
   * every round while rows wait (a change of a book in an unfinished batch waits for it).
   */
  sortChanges(): void {
    if (this.attributing || this.stopped) return;
    let pending = false;
    let covers = false;
    try {
      pending = this.attribution.pending();
      covers = this.db.prepare('SELECT 1 FROM cover_archive_wanted LIMIT 1').get() !== undefined;
    } catch (err) {
      this.logError('Cleanup: reading the changes the index saw failed:', err);
      return;
    }
    if (!pending && !covers) return;
    this.attributing = (async () => {
      try {
        for (let i = 0; pending && i < 200 && !this.stopped; i++) {
          const r = this.attribution.drain(500);
          if (r.calibre > 0 || r.renames > 0)
            this.log(
              `Cleanup: ${r.calibre} field(s) changed in Calibre itself, ${r.renames} renamed with an edit: now the user's`,
            );
          if (r.processed === 0) break;
          await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: sorting out the changes the index saw failed:', err);
      }
      try {
        await this.keepChangedCovers();
      } catch (err) {
        this.logError('Cleanup: keeping the changed covers failed:', err);
      } finally {
        this.attributing = null;
      }
    })();
  }

  /**
   * Book covers: the picture each cover change the index saw left (the user's edit, or a change
   * in Calibre's own program), read from the library (read only) into the cover archive, so a
   * later change can always be taken back. A picture that can't be read is tried again on the
   * next index, at most 5 times.
   */
  private async keepChangedCovers(limit = 200): Promise<number> {
    const rows = this.db
      .prepare('SELECT * FROM cover_archive_wanted ORDER BY seen_at LIMIT ?')
      .all(limit) as {
      library_id: string;
      calibre_uuid: string;
      calibre_id: number;
      tries: number;
    }[];
    const done = this.db.prepare(
      'DELETE FROM cover_archive_wanted WHERE library_id = ? AND calibre_uuid = ?',
    );
    const retry = this.db.prepare(
      'UPDATE cover_archive_wanted SET tries = tries + 1 WHERE library_id = ? AND calibre_uuid = ?',
    );
    let kept = 0;
    for (const r of rows) {
      if (this.stopped) break;
      const src = this.main
        .prepare(
          `SELECT calibre_path, has_cover FROM book_sources
           WHERE library_id = ? AND calibre_uuid = ? AND kind = 'calibre' AND missing_at IS NULL`,
        )
        .get(r.library_id, r.calibre_uuid) as
        | { calibre_path: string | null; has_cover: number | null }
        | undefined;
      if (!src || src.has_cover !== 1) {
        done.run(r.library_id, r.calibre_uuid);
        continue;
      }
      const bytes = this.edits.readCover?.(r.library_id, src.calibre_path) ?? null;
      try {
        if (!bytes) throw new Error("cover.jpg can't be read");
        await this.coverArchive.keep(
          { libraryId: r.library_id, uuid: r.calibre_uuid, calibreId: r.calibre_id },
          bytes,
          'seen',
          null,
        );
        done.run(r.library_id, r.calibre_uuid);
        kept++;
      } catch (err) {
        if (r.tries + 1 >= 5) {
          done.run(r.library_id, r.calibre_uuid);
          this.log(
            `Cleanup: the cover of Calibre book ${r.calibre_id} couldn't be kept: ${(err as Error).message}`,
          );
        } else retry.run(r.library_id, r.calibre_uuid);
      }
      await new Promise((res) => setImmediate(res));
    }
    return kept;
  }

  /** WP20g: the new arrivals' run, stepped in its own loop (never blocks a round). */
  private runArrivals(): void {
    if (this.arriving || this.stopped) return;
    this.arriving = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          const r = await this.arrivals.step();
          if (r === 'idle') break;
          if (r === 'wait') await new Promise((res) => setTimeout(res, 2000));
          else await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: new arrivals failed:', err);
      } finally {
        this.arriving = null;
      }
    })();
  }

  /**
   * Stage 5 (WP20f): genres and tags. Works once stage 4's AI check is done; reads cleanup.db and
   * the reader's snapshot only (no disk lock). On writes its proposals through stage 2's
   * field-write path after stages 1-4 have nothing left to write.
   */
  private async round5(target: string): Promise<void> {
    const P = this.lp(target);
    const stage = getStage(this.db, target, 5);
    if (stage.mode === 'off' || !target || !P.stage5) {
      P.waiting5 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    if (!P.stage5.stage4Ready()) {
      P.waiting5 = "Waiting for stage 4's analysis and AI check";
      return;
    }
    if (P.stage5.needsWork(target)) {
      P.waiting5 = null;
      this.runAnalysis5(target);
      return;
    }
    const p = P.stage5.progress();
    if (p?.error) {
      P.waiting5 = `Stage 5 failed: ${p.error}`;
      return;
    }
    await this.apply5(target, stage.mode);
  }

  private runAnalysis5(target: string): void {
    const P = this.lp(target);
    if (P.analysing5 || !P.stage5) return;
    const s5 = P.stage5;
    P.analysing5 = (async () => {
      try {
        for (;;) {
          const stop5 = () => this.stopped || getStage(this.db, target, 5).mode === 'off';
          if (stop5() || !s5.needsWork(target)) break;
          const r = await s5.step(target, stop5);
          P.status5Cache = null;
          if (r === 'wait') {
            for (let i = 0; i < 10 && !stop5(); i++)
              await new Promise((res) => setTimeout(res, 500));
          } else await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Cleanup: stage 5 failed:', err);
      } finally {
        P.analysing5 = null;
      }
    })();
  }

  private async apply5(target: string, mode: StageMode): Promise<void> {
    const P = this.lp(target);
    if (mode !== 'on') {
      P.waiting5 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, target, 5).pauseReason) {
      P.waiting5 = null;
      return;
    }
    const p = P.stage5?.progress();
    if (!p?.gate || (p.gate.books.genres === 0 && p.gate.books.tags === 0)) {
      P.waiting5 = 'No labeled books for the gate: nothing is written';
      return;
    }
    if (this.batches.open()) {
      P.waiting5 = 'A batch is being applied';
      return;
    }
    for (const [s, left] of [
      [1, () => this.remaining(target)],
      [2, () => this.remaining2(target)],
      [3, () => this.remaining3(target)],
      [4, () => this.remaining4(target)],
    ] as [number, () => number][]) {
      if (getStage(this.db, target, s).mode === 'on' && left() > 0) {
        P.waiting5 = `Waiting for stage ${s} to finish writing`;
        return;
      }
    }
    const checks = this.checksPass(target);
    if (!checks.ok) {
      P.waiting5 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.stage5.plan(target);
    P.waiting5 = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining5(target) === 0 ? 'Done: nothing left to write' : null));
  }

  /** Stage 5's automatic changes still to write (one per book). */
  private remaining5(target: string): number {
    const id = currentAnalysisId(this.db, target, 5);
    if (!id) return 0;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
           WHERE stage = 5 AND library_id = ? AND state = 'proposed' AND field = 'tags'
             AND class = 'auto' AND analysis_id = ?`,
        )
        .get(target, id) as { n: number }
    ).n;
  }

  /** Stage 5 On's progress: books written, still to write, the time left (as stage 4's). */
  private write5(target: string, analysisId: string, now: number): Stage4Write | null {
    const P = this.lp(target);
    const n = (state: string, cls: string | null) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
             WHERE stage = 5 AND library_id = ? AND state = ? AND field = 'tags'
             ${cls ? 'AND class = ?' : ''} AND analysis_id = ?`,
          )
          .get(target, state, ...(cls ? [cls] : []), analysisId) as { n: number }
      ).n;
    const doneChanges = n('applied', null);
    const queued = n('queued', null);
    const leftChanges = n('proposed', 'auto') + queued;
    if (doneChanges === 0 && queued === 0 && getStage(this.db, target, 5).mode !== 'on')
      return null;
    const finished = this.db
      .prepare(
        `SELECT id, claimed_at AS claimedAt, finished_at AS finishedAt, item_count AS items FROM batches
         WHERE stage = 5 AND library_id = ? AND kind = 'apply' AND state IN ('applied', 'partial')
         ORDER BY created_at DESC`,
      )
      .all(target) as (WriteBatchRow & { id: string })[];
    // Books written, each once: a book written again after stage 5 decided again (a newer
    // proposal) is not counted twice (the 2026-11-22 run showed 53,258 books for 53,229).
    // Counted in full once (355 ms on the live 53,258 rows; also when a batch was undone), then
    // per finished batch, only its books not written before (at most 80 ms a batch). Counting
    // every batch that way at once after a restart held the server 2.5 s.
    const c = P.batchBooks5;
    const ids = new Set(finished.map((b) => b.id));
    if (c.analysisId !== analysisId || [...c.counted].some((id) => !ids.has(id))) {
      c.analysisId = analysisId;
      c.counted = ids;
      c.books = (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT calibre_uuid) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
             WHERE stage = 5 AND library_id = ? AND state = 'applied' AND field = 'tags' AND analysis_id = ?`,
          )
          .get(target, analysisId) as { n: number }
      ).n;
    }
    for (const bt of finished) {
      if (c.counted.has(bt.id)) continue;
      c.counted.add(bt.id);
      c.books += (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM batch_items i JOIN proposed_changes p ON p.id = i.change_id
             WHERE i.batch_id = ? AND p.state = 'applied' AND p.analysis_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM proposed_changes q INDEXED BY proposed_changes_book
                 WHERE q.library_id = p.library_id AND q.calibre_uuid = p.calibre_uuid
                   AND q.id < p.id AND q.stage = 5 AND q.field = 'tags' AND q.state = 'applied'
                   AND q.analysis_id = p.analysis_id)`,
          )
          .get(bt.id, analysisId) as { n: number }
      ).n;
    }
    const doneBooks = c.books;
    return stage4Write(
      {
        doneChanges,
        leftChanges,
        doneBooks,
        batches: finished.slice(0, 10),
        batchCount: finished.length,
      },
      now,
    );
  }

  /** Stage 5's card (cached 10 s: the bar's per-model count reads ai_requests' run index). */
  stage5Status(target: string | null, now = Date.now()): unknown {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    if (P.status5Cache && now - P.status5Cache.at < 10_000) return P.status5Cache.value;
    const p = P.stage5?.progress() ?? null;
    const value = {
      waiting: P.waiting5,
      ready: P.stage5?.stage4Ready() ?? false,
      progress: p
        ? {
            phase: p.phase,
            bar: P.stage5?.bar(now) ?? null,
            startedAt: p.startedAt,
            finishedAt: p.finishedAt,
            total: p.total,
            items: p.items,
            labeledItems: p.labeledItems,
            decided: p.decided,
            asked: p.asked,
            oneModel: p.oneModel,
            droppedTerms: p.droppedTerms,
            marks: p.marks,
            answers: p.ai,
            wait: p.wait,
            costUsd: p.cost?.costUsd ?? null,
            gate: p.gate,
            counts: p.counts,
            error: p.error,
            times: p.times,
          }
        : null,
      fieldPauses: target ? listFieldPauses(this.db, target, 5) : [],
      write: target && p ? this.write5(target, p.analysisId, now) : null,
      // The vocabulary's labels (the page shows counts by id with these).
      terms: [...STAGE5_TERMS.entries()].map(([id, t]) => ({
        id,
        ja: t.ja,
        en: t.en,
        kind: t.kind,
      })),
      cachedAt: now,
    };
    P.status5Cache = { at: now, value };
    return value;
  }

  /** Stage 4's books whose changes were all undone, proposed again (the stage-4 card's button). */
  async reproposeStage4Undone(target: string | null): Promise<{ books: number }> {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const books = (await P.stage4Ai?.reproposeUndone()) ?? 0;
    P.status4Cache = null;
    if (books > 0) void this.tick();
    return { books };
  }

  /** Stage 5's given-up AI questions asked again (the card's button). */
  askStage5AiAgain(target: string | null): { questions: number } {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const questions = P.stage5?.askAgain() ?? 0;
    P.status5Cache = null;
    if (questions > 0) void this.tick();
    return { questions };
  }

  /** Stage 5's proposals for the page (paged, in the order they were made). */
  stage5Proposals(
    target: string | null,
    f: { state: string; outside: boolean | null; offset: number; limit: number },
  ) {
    target = target ?? this.targetLibrary();
    const id = target ? currentAnalysisId(this.db, target, 5) : null;
    if (!target || !id) return { total: 0, rows: [] };
    const where = `stage = 5 AND library_id = ? AND state = ? AND field = 'tags' AND analysis_id = ?${
      f.outside === null
        ? ''
        : f.outside
          ? ` AND source = 'stage5-removals'`
          : ` AND source = 'stage5'`
    }`;
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE ${where}`,
        )
        .get(target, f.state, id) as { n: number }
    ).n;
    const rows = (
      this.db
        .prepare(
          `SELECT id, calibre_id, old_json, new_json, source, evidence_json, class, review_reason, state
           FROM proposed_changes INDEXED BY proposed_changes_stage WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(target, f.state, id, f.limit, f.offset) as {
        id: number;
        calibre_id: number;
        old_json: string;
        new_json: string;
        source: string;
        evidence_json: string;
        class: string;
        review_reason: string | null;
        state: string;
      }[]
    ).map((r) => {
      const ev = JSON.parse(r.evidence_json) as {
        title?: string;
        series?: string | null;
        format?: string | null;
        sources?: Record<string, { from: string[]; books: number }>;
      };
      return {
        id: r.id,
        calibreId: r.calibre_id,
        title: ev.title ?? '',
        series: ev.series ?? null,
        format: ev.format ?? null,
        before: JSON.parse(r.old_json) as string[],
        change: JSON.parse(r.new_json) as { add: string[]; remove: string[] },
        sources: ev.sources ?? {},
        outside: r.source === 'stage5-removals',
        cls: r.class,
        reason: r.review_reason,
        state: r.state,
      };
    });
    return { total, rows };
  }

  /** Stage 4 (WP20d): Preview only; the analysis (reading, lookups, proposals) runs while not Off. */
  private async round4(target: string): Promise<void> {
    const P = this.lp(target);
    const stage = getStage(this.db, target, 4);
    if (stage.mode === 'off' || !target || !P.analysis4) {
      P.waiting4 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    const p = P.analysis4.progress();
    if (!p || p.libraryId !== target) {
      P.analysis4.restart(target);
    } else if (p.phase === 'done') {
      if (p.error) {
        P.waiting4 = `The analysis failed: ${p.error}`;
        return;
      }
      // The one-time passes (Bookmeter's edition check, the fixed picker's picks), then the AI
      // check (WP20e). A pass that reopens books sends the analysis back to its lookups, which
      // wait for the fetcher like any lookup (the round above, next time).
      if (!oneTimePassesDone(p) || P.stage4Ai?.needsWork()) {
        P.waiting4 = null;
        this.runAnalysis4(target);
        return;
      }
      await this.apply4(target, stage.mode);
      return;
    }
    P.waiting4 = this.fetcher().online
      ? null
      : 'The fetch container is not running (or has no token yet)';
    this.runAnalysis4(target);
  }

  private runAnalysis4(target: string): void {
    const P = this.lp(target);
    if (P.analysing4 || !P.analysis4) return;
    const analysis = P.analysis4;
    const owner4 = this.diskOwner(4, target);
    P.analysing4 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, target, 4).mode === 'off') break;
          const stop4 = () => this.stopped || getStage(this.db, target, 4).mode === 'off';
          if (!(await this.diskFor(4, owner4, analysis.progress()?.phase, stop4))) break;
          const before = analysis.progress();
          const done = await analysis.step(stop4);
          if (done) {
            // The AI check after the rules (WP20e). It holds no disk: it reads cleanup.db.
            const ai = P.stage4Ai;
            if (!ai || !ai.needsWork()) break;
            this.diskLock.release(owner4);
            const r = await ai.step(stop4);
            if (r === 'wait') {
              for (let i = 0; i < 10 && !stop4(); i++)
                await new Promise((res) => setTimeout(res, 500));
            } else await new Promise((res) => setImmediate(res));
            continue;
          }
          // Waiting on the fetcher: no busy loop; the next answer or round goes on. The step
          // times change on every step, so they don't count as progress (with them the loop
          // never saw "nothing changed" and spun without giving the server back).
          const after = analysis.progress();
          const same = (a: typeof after, b: typeof before) =>
            JSON.stringify({ ...a, times: undefined }) ===
            JSON.stringify({ ...b, times: undefined });
          if (after && after.phase !== 'read' && same(after, before)) {
            if (!this.stage4HasWork(target)) break;
          }
        }
      } catch (err) {
        this.logError('Cleanup: stage 4 analysis failed:', err);
      } finally {
        this.diskLock.release(owner4);
        P.analysing4 = null;
      }
    })();
  }

  /**
   * Stage 4 On (WP20e): its proposals are written through stage 2's field-write path, after the
   * rules, Bookmeter's edition pass and the AI check are done for the current analysis.
   */
  private async apply4(target: string, mode: StageMode): Promise<void> {
    const P = this.lp(target);
    if (mode !== 'on') {
      P.waiting4 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, target, 4).pauseReason) {
      P.waiting4 = null;
      return;
    }
    if (!P.stage4Ai?.isDone()) {
      P.waiting4 = 'Waiting for the AI check';
      return;
    }
    if (this.batches.open()) {
      P.waiting4 = 'A batch is being applied';
      return;
    }
    for (const [s, left] of [
      [1, () => this.remaining(target)],
      [2, () => this.remaining2(target)],
      [3, () => this.remaining3(target)],
    ] as [number, () => number][]) {
      if (getStage(this.db, target, s).mode === 'on' && left() > 0) {
        P.waiting4 = `Waiting for stage ${s} to finish writing`;
        return;
      }
    }
    const checks = this.checksPass(target);
    if (!checks.ok) {
      P.waiting4 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.stage4.plan(target);
    P.waiting4 = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining4(target) === 0 ? 'Done: nothing left to write' : null));
  }

  /** Stage 4's automatic changes still to write (the fields it writes, not paused). */
  private remaining4(target: string): number {
    const paused = new Set(
      listFieldPauses(this.db, target, 4).flatMap((p) =>
        p.field === 'illustrators'
          ? ['illustrator']
          : p.field === 'number'
            ? ['series']
            : [p.field],
      ),
    );
    const rows = this.db
      .prepare(
        `SELECT field, COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND library_id = ?
         AND state = 'proposed' AND class = 'auto' AND analysis_id = ? GROUP BY field`,
      )
      .all(target, currentAnalysisId(this.db, target, 4)) as { field: string; n: number }[];
    const written = new Set<string>(STAGE4_WRITTEN_FIELDS);
    return rows
      .filter((r) => written.has(r.field) && !paused.has(r.field))
      .reduce((a, r) => a + r.n, 0);
  }

  /**
   * Stage 4 On's progress (write-progress.ts): the writable automatic changes written (applied)
   * and still to write, by change and by book, and the pace of the last batches. Read from the
   * proposals' count index (EXPLAINed and timed on a copy of the live cleanup.db at the run's
   * size); the page's status caches it 30 s.
   */
  private write4(target: string, analysisId: string, now: number): Stage4Write | null {
    const P = this.lp(target);
    const fields = [...STAGE4_WRITTEN_FIELDS];
    const inList = fields.map(() => '?').join(', ');
    const n = (state: string, cls: string | null) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND library_id = ? AND state = ?
             AND field IN (${inList}) ${cls ? 'AND class = ?' : ''} AND analysis_id = ?`,
          )
          .get(target, state, ...fields, ...(cls ? [cls] : []), analysisId) as { n: number }
      ).n;
    const doneChanges = n('applied', null);
    // A planned batch's changes are queued until written: still to write.
    const queued = n('queued', null);
    const leftChanges = n('proposed', 'auto') + queued;
    if (doneChanges === 0 && queued === 0 && getStage(this.db, target, 4).mode !== 'on')
      return null;
    // Books per finished batch, counted once each (a few ms by the batch's items): counting
    // distinct books over all proposals held the server 1.4 s at the run's size (measured).
    const finished = this.db
      .prepare(
        `SELECT id, claimed_at AS claimedAt, finished_at AS finishedAt, item_count AS items FROM batches
         WHERE stage = 4 AND library_id = ? AND kind = 'apply' AND state IN ('applied', 'partial')
         ORDER BY created_at DESC`,
      )
      .all(target) as (WriteBatchRow & { id: string })[];
    let doneBooks = 0;
    for (const bt of finished) {
      let k = P.batchBooks.get(bt.id);
      if (k === undefined) {
        k = (
          this.db
            .prepare(
              `SELECT COUNT(DISTINCT p.calibre_id) AS n FROM batch_items i JOIN proposed_changes p ON p.id = i.change_id
               WHERE i.batch_id = ? AND p.state = 'applied' AND p.analysis_id = ?`,
            )
            .get(bt.id, analysisId) as { n: number }
        ).n;
        P.batchBooks.set(bt.id, k);
      }
      doneBooks += k;
    }
    const batchCount = finished.length;
    const batches = finished.slice(0, 10);
    return stage4Write(
      {
        doneChanges,
        leftChanges,
        doneBooks,
        batches,
        batchCount,
      },
      now,
    );
  }

  /** Stage 4 work that needs no answer from the fetcher (answered requests, books to plan or propose). */
  private stage4HasWork(target: string): boolean {
    const P = this.lp(target);
    const p = P.analysis4?.progress();
    if (!p) return false;
    // Manga part B: this library's answered waiters (each library's analysis takes its own).
    const ready = this.db
      .prepare(
        `SELECT 1 FROM fetch_waiters WHERE ready = 1 AND library_id IN (?, 'natively') LIMIT 1`,
      )
      .get(target);
    if (ready) return true;
    const books = this.db
      .prepare(
        `SELECT 1 FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'ready') LIMIT 1`,
      )
      .get(p.analysisId);
    return !!books;
  }

  /** "Ask again" for a site: its given-up requests go back to the queue and their books are planned again. */
  retryStage4Site(
    target: string | null,
    site: string,
    now = Date.now(),
  ): { requests: number; books: number } {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const p = P.analysis4?.progress();
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
      updateStage(this.db, p.libraryId, 4, {
        progress: p as unknown as Record<string, unknown>,
        state: 'analysing',
      });
    }
    P.status4Cache = null;
    void this.tick();
    return { requests, books };
  }

  /** Stage 4's AI questions that were given up, asked again (the stage-4 card's button). */
  askStage4AiAgain(target: string | null): { questions: number } {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const questions = P.stage4Ai?.askAgain() ?? 0;
    P.status4Cache = null;
    if (questions > 0) void this.tick();
    return { questions };
  }

  /** Stage 4's proposals for the page's list (paged). */
  stage4Proposals(
    target: string | null,
    f: {
      field: string | null;
      cls: 'auto' | 'review' | null;
      source: string | null;
      offset: number;
      limit: number;
    },
  ) {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const p = P.analysis4?.progress();
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
    const snap = P.analysis4!.loadSnapshot(target);
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
  /**
   * The Best guesses list (series-order follow-up): series with a best guess or a problem for
   * review, each whole and in order, or the books outside a series with a best guess.
   */
  stage4Guesses(target: string | null, kind: 'series' | 'other', offset: number, limit: number) {
    target = target ?? this.targetLibrary();
    if (!target) return kind === 'series' ? { total: 0, series: [] } : { total: 0, books: [] };
    return kind === 'series'
      ? listSeriesGuesses(this.db, target, offset, limit)
      : listOtherGuesses(this.db, target, offset, limit);
  }

  /** The titles shortened or cut to fit Calibre's folder names (cleanup.db v26), newest first. */
  titleFits(target: string | null, offset: number, limit: number) {
    target = target ?? this.targetLibrary();
    if (!target) return { total: 0, items: [] };
    return listTitleFits(this.db, this.opts.main, target, offset, limit);
  }

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
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    if (P.status4Cache && now - P.status4Cache.at < 30_000) return P.status4Cache.value;
    const p = P.analysis4?.progress() ?? null;
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
    const sites = (CALIBRE_FETCH_SITES as readonly FetchSite[]).map((site) => {
      const by = (st: string) => counts.find((c) => c.site === site && c.state === st)?.n ?? 0;
      const r = recent.find((x) => x.site === site);
      const t = totals.find((x) => x.site === site);
      const row = slotStateRow(this.db, backoffKey(site), now) as
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
        ? this.stage4TimeLeft(p.libraryId, p, sites, books, readings, now, amazonSlot)
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
    if (!P.fields4Cache || now - P.fields4Cache.at > 300_000) {
      P.fields4Cache = {
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
    const fields = P.fields4Cache.value;
    const ai = P.stage4Ai?.progress() ?? null;
    const value = {
      waiting: P.waiting4,
      fetcher: this.fetcher(now),
      amazonPace:
        s.amazonPace === 'trial' ? `trial (now ${this.fetchQueue.amazonPace(now)})` : s.amazonPace,
      sites,
      books,
      readings,
      natively: { ...natively, asins: nativelyAsins },
      fields,
      // Counted once when the AI check finished (reading the proposals' evidence took 5 s).
      unconfirmed: Object.entries(ai?.unconfirmed ?? {}).map(([field, n]) => ({ field, n })),
      // The AI check (WP20e): its phase, the answers, the wait, the cost and the gate.
      ai: ai
        ? {
            phase: ai.phase,
            // The progress bar and the time left of the running phase (WP20e follow-up).
            bar: P.stage4Ai?.bar(now) ?? null,
            items: ai.items,
            labeledItems: ai.labeledItems,
            decided: ai.decided,
            answers: ai.ai,
            wait: ai.wait,
            costUsd: ai.cost?.costUsd ?? null,
            invented: ai.invented,
            flaggedAgainstRules: ai.flaggedAgainstRules,
            // The series step (series-order follow-up): what it changed, its best guesses and
            // review items, and the library-wide checks.
            seriesOrder: ai.seriesOrder
              ? {
                  series: ai.seriesOrder.series,
                  choices: ai.seriesOrder.choices,
                  changed: ai.seriesOrder.changed,
                  guesses: ai.seriesOrder.guesses,
                  reviews: ai.seriesOrder.reviews,
                  checks: ai.seriesOrder.checks ?? null,
                }
              : null,
            gate: ai.gate
              ? {
                  passed: ai.gate.passed,
                  below: ai.gate.below,
                  books: ai.gate.books,
                  notAsked: ai.gate.notAsked,
                  all: ai.gate.all,
                  the600: ai.gate.the600,
                  checkD: ai.gate.checkD,
                }
              : null,
            error: ai.error,
            finishedAt: ai.finishedAt,
          }
        : null,
      fieldPauses: target ? listFieldPauses(this.db, target, 4) : [],
      // Books whose changes were all undone (the test batches): written on the card's button.
      undoneBooks: P.stage4Ai?.isDone() ? P.stage4Ai.undoneBooks().length : 0,
      // Stage 4 On: books and changes written, what is left, the time left (WP20e).
      write: target && p ? this.write4(target, p.analysisId, now) : null,
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
    P.status4Cache = { at: now, value };
    return value;
  }

  /**
   * Stage 4's time left (stage4/eta.ts): the reading at its rate measured over the last minutes
   * (books read, counted from stage4_books, at each status), every site's requests still to
   * come at its measured pace, and the final pass at the measured time per proposed book.
   */
  private stage4TimeLeft(
    target: string,
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
    const P = this.lp(target);
    const s = getSettings(this.db).fetch;
    const count = (states: string[]) =>
      books.filter((b) => states.includes(b.state)).reduce((a, b) => a + b.n, 0);
    const booksRead = count(['read', 'waiting', 'ready', 'proposed', 'error']);
    P.readMarks = P.readMarks.filter(
      (m) => m.analysisId === p.analysisId && now - m.at <= 20 * 60_000,
    );
    if (p.phase === 'read') P.readMarks.push({ at: now, n: booksRead, analysisId: p.analysisId });
    const first = P.readMarks[0];
    const readPerSecond =
      first && now - first.at >= 120_000 && booksRead > first.n
        ? (booksRead - first.n) / ((now - first.at) / 1000)
        : null;
    // This run's requests on the labeled books, once they are all proposed (10 minutes kept).
    let labeled: { site: string; n: number }[] = [];
    // Also while reopened labeled books are checked again: their earlier ratios still hold.
    const labeledKnown = p.labeledDoneAt !== null || p.labeledCheckedOnce === true;
    if (labeledKnown) {
      if (
        !P.labeled4Cache ||
        P.labeled4Cache.analysisId !== p.analysisId ||
        now - P.labeled4Cache.at > 600_000
      ) {
        // Only the requests this analysis made (stage4/eta.ts labeledRequestsSince).
        P.labeled4Cache = {
          at: now,
          analysisId: p.analysisId,
          value: labeledRequestsSince(this.db, p.startedAt, LABELED_PRIORITY),
        };
      }
      labeled = P.labeled4Cache.value;
    }
    const per = p.times?.['propose: book'];
    const unreadable = count(['error']);
    const result = stage4Eta({
      sites: sites.map(
        (x): SiteCounts => ({
          site: x.site,
          enabled: x.enabled,
          open: x.queued + x.leased,
          secondsPerRequest: x.secondsPerRequest,
          labeledRequests: labeled.find((l) => l.site === x.site)?.n ?? 0,
        }),
      ),
      booksTotal: p.readTotal,
      booksRead: p.phase === 'read' ? booksRead : p.readTotal,
      booksUnreadable: unreadable,
      booksStarted: count(['waiting', 'ready', 'proposed']),
      open: openLookups(this.db),
      followUps: p.followUps ?? null,
      readPerSecond,
      labeledBooks: p.labeledIds.length,
      labeledDone: labeledKnown,
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
  private async round3(target: string): Promise<void> {
    const P = this.lp(target);
    const stage = getStage(this.db, target, 3);
    if (stage.mode === 'off' || !target || !P.analysis3) {
      P.waiting3 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    let progress = P.analysis3.progress();
    if (!progress || progress.libraryId !== target) progress = P.analysis3.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        P.waiting3 = "Waiting for the reader's index of the library";
        return;
      }
      if (P.analysing || P.analysing2) {
        P.waiting3 = "Waiting for stage 1's or stage 2's analysis to finish";
        return;
      }
      P.waiting3 = 'Analysing';
      this.runAnalysis3(target);
      return;
    }
    if (progress.error) {
      P.waiting3 = `The analysis failed: ${progress.error}`;
      return;
    }
    // New rules or new limits in the settings: the measured pairs are classified again
    // (nothing read again), then the copies are chosen again.
    if (P.analysis3.needsReclassify(progress) && !this.batches.open()) {
      P.analysis3.reclassify();
      P.waiting3 = 'Analysing';
      this.runAnalysis3(target);
      return;
    }
    if (stage.mode !== 'on') {
      P.waiting3 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, target, 3).pauseReason) {
      P.waiting3 = null;
      return;
    }
    if (!progress.gate?.passed) {
      P.waiting3 = `Not applying: the gate hasn't passed (${(progress.gate?.problems ?? ['not checked']).join('; ')})`;
      return;
    }
    // Manga part B: one gate across the libraries. The measured pairs and labeled books live in
    // the library they were labeled in; another library's stage 3 applies only while that
    // library's gate passes too.
    for (const lib of this.cleanupLibraries()) {
      if (lib === target) continue;
      const other = this.lp(lib).analysis3?.progress();
      if (other?.gate && !other.gate.passed) {
        P.waiting3 = `Not applying: stage 3's gate of ${this.libraryName(lib)} hasn't passed`;
        return;
      }
    }
    if (this.batches.open()) {
      P.waiting3 = 'A batch is being applied';
      return;
    }
    if (getStage(this.db, target, 1).mode === 'on' && this.remaining(target) > 0) {
      P.waiting3 = 'Waiting for stage 1 to finish removing identical copies';
      return;
    }
    if (getStage(this.db, target, 2).mode === 'on' && this.remaining2(target) > 0) {
      P.waiting3 = 'Waiting for stage 2 to finish writing';
      return;
    }
    const checks = this.checksPass(target);
    if (!checks.ok) {
      P.waiting3 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.planStage3(target, () => this.stopped);
    P.waiting3 = batch
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
    // Manga part B: any library's stage that is On with work left.
    for (const target of this.cleanupLibraries()) {
      const left: [number, () => number][] = [
        [1, () => this.remaining(target)],
        [2, () => this.remaining2(target)],
        [3, () => this.remaining3(target)],
        [4, () => this.remaining4(target)],
        [5, () => this.remaining5(target)],
      ];
      for (const [stage, count] of left) {
        const st = getStage(this.db, target, stage);
        if (st.mode === 'on' && !st.pauseReason && count() > 0) {
          return `Calibre stage ${stage} (between batches)`;
        }
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
        .get(target, currentAnalysisId(this.db, target, 3)) as { n: number }
    ).n;
  }

  /**
   * Before a Calibre analysis step (WP21a): a phase that reads book files holds the shared
   * disk lock (waiting for an audiobook job to give it back, which it does at once); any other
   * phase gives it back. False when the analysis was stopped while waiting.
   */
  /**
   * The disk lock's holder name of a library's stage analysis: the stage AND its library (manga
   * part B). Named by the stage alone, japanese-library's stage 4 gave back the lock manga-
   * library's stage 4 held in the middle of its read (it releases its name whenever it isn't
   * reading), and stage 2 took the disk (found live 2026-11-28). Fixed for one analysis loop.
   */
  private diskOwner(stage: 1 | 2 | 3 | 4, target: string): string {
    return `${DISK_OWNERS[`calibre${stage}`]} · ${this.libraryName(target)}`;
  }

  private async diskFor(
    stage: 1 | 2 | 3 | 4,
    owner: string,
    phase: string | undefined,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    if (phase && DISK_PHASES[stage].includes(phase)) {
      return this.diskLock.acquire(owner, 'calibre', shouldStop);
    }
    this.diskLock.release(owner);
    return true;
  }

  private runAnalysis3(target: string): void {
    const P = this.lp(target);
    if (P.analysing3 || !P.analysis3) return;
    const analysis = P.analysis3;
    const owner3 = this.diskOwner(3, target);
    P.analysing3 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, target, 3).mode === 'off') break;
          const stop3 = () => this.stopped || getStage(this.db, target, 3).mode === 'off';
          if (!(await this.diskFor(3, owner3, analysis.progress()?.phase, stop3))) break;
          const done = await analysis.step(stop3);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: stage 3 analysis failed:', err);
      } finally {
        this.diskLock.release(owner3);
        P.analysing3 = null;
        void this.tick();
      }
    })();
  }

  /** Your decision on a stage-3 pair (keep both, remove one, or none); the sets are worked out again. */
  decidePair(
    target: string | null,
    pairId: number,
    decision: 'keep_both' | 'remove_a' | 'remove_b' | 'clear',
  ): void {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const p = P.analysis3?.progress();
    if (!target || !p || !P.analysis3) throw new Error('Stage 3 has no analysis');
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
      updateStage(this.db, target, 3, {
        progress: p as unknown as Record<string, unknown>,
        state: 'analysing',
      });
    }
    void this.tick();
  }

  /** Stage 2: analysis, then (On) one batch at a time once stage 1 has nothing left to remove. */
  private async round2(target: string): Promise<void> {
    const P = this.lp(target);
    const stage = getStage(this.db, target, 2);
    if (stage.mode === 'off' || !target || !P.analysis2) {
      P.waiting2 =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    let progress = P.analysis2.progress();
    if (!progress || progress.libraryId !== target) progress = P.analysis2.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        P.waiting2 = "Waiting for the reader's index of the library";
        return;
      }
      if (P.analysing) {
        P.waiting2 = "Waiting for stage 1's analysis to finish";
        return;
      }
      P.waiting2 = 'Analysing';
      this.runAnalysis2(target);
      return;
    }
    if (progress.error) {
      P.waiting2 = `The analysis failed: ${progress.error}`;
      return;
    }
    if (stage.mode !== 'on') {
      P.waiting2 = 'Preview: nothing is changed in Calibre';
      return;
    }
    if (getStage(this.db, target, 2).pauseReason) {
      P.waiting2 = null;
      return;
    }
    if (this.batches.open()) {
      P.waiting2 = 'A batch is being applied';
      return;
    }
    if (getStage(this.db, target, 1).mode === 'on' && this.remaining(target) > 0) {
      P.waiting2 = 'Waiting for stage 1 to finish removing identical copies';
      return;
    }
    const checks = this.checksPass(target);
    if (!checks.ok) {
      P.waiting2 = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.stage2.plan(target);
    P.waiting2 = batch
      ? 'A batch is being applied'
      : (reason ?? (this.remaining2(target) === 0 ? 'Done: nothing left to write' : null));
  }

  private remaining2(target: string): number {
    const paused = listFieldPauses(this.db, target, 2).map((p) => p.field);
    const rows = this.db
      .prepare(
        `SELECT field, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND state = 'proposed' AND class = 'auto' AND (analysis_id = ? OR decided_by IS NOT NULL)
         GROUP BY field`,
      )
      .all(target, currentAnalysisId(this.db, target, 2)) as { field: string; n: number }[];
    return rows.filter((r) => !paused.includes(r.field)).reduce((a, r) => a + r.n, 0);
  }

  private runAnalysis2(target: string): void {
    const P = this.lp(target);
    if (P.analysing2 || !P.analysis2) return;
    const analysis = P.analysis2;
    const owner2 = this.diskOwner(2, target);
    P.analysing2 = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, target, 2).mode === 'off') break;
          const stop2 = () => this.stopped || getStage(this.db, target, 2).mode === 'off';
          if (!(await this.diskFor(2, owner2, analysis.progress()?.phase, stop2))) break;
          const done = await analysis.step(stop2);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: stage 2 analysis failed:', err);
      } finally {
        this.diskLock.release(owner2);
        P.analysing2 = null;
        void this.tick();
      }
    })();
  }

  /** Stage 2's counts per field, class and state (current analysis plus everything queued or applied). */
  stage2Counts(
    target: string | null,
  ): { field: string; class: string; state: string; n: number }[] {
    target = target ?? this.targetLibrary();
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT field, class, state, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND (${CURRENT_PROPOSALS_SQL} OR decided_by IS NOT NULL) GROUP BY field, class, state`,
      )
      .all(target, currentAnalysisId(this.db, target, 2)) as {
      field: string;
      class: string;
      state: string;
      n: number;
    }[];
  }

  stage2SkipReasons(target: string | null): { reason: string; count: number }[] {
    target = target ?? this.targetLibrary();
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT COALESCE(review_reason, 'No reason recorded') AS reason, COUNT(*) AS count
         FROM proposed_changes WHERE stage = 2 AND library_id = ? AND state = 'skipped' AND analysis_id = ?
         GROUP BY reason ORDER BY count DESC, reason LIMIT 20`,
      )
      .all(target, currentAnalysisId(this.db, target, 2)) as { reason: string; count: number }[];
  }

  /** Books written in the recent window (for the page's time left). */
  stage2Pace(target: string | null, now = Date.now()): { written: number; firstAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT c.calibre_id) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id JOIN proposed_changes c ON c.id = i.change_id
         WHERE b.kind = 'apply' AND b.stage = 2 AND b.library_id = ? AND i.state = 'written'
           AND i.updated_at >= ?`,
      )
      .get(target ?? '', now - PACE_WINDOW_MS) as { n: number; first: number | null };
    return { written: row.n, firstAt: row.first };
  }

  /** Books left to write (auto, not paused). */
  stage2BooksLeft(target: string | null): number {
    target = target ?? this.targetLibrary();
    if (!target) return 0;
    const paused = listFieldPauses(this.db, target, 2).map((p) => p.field);
    const placeholders = paused.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT calibre_id) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
           AND state = 'proposed' AND class = 'auto' AND (analysis_id = ? OR decided_by IS NOT NULL)
           ${paused.length ? `AND field NOT IN (${placeholders})` : ''}`,
        )
        .get(target, currentAnalysisId(this.db, target, 2), ...paused) as { n: number }
    ).n;
  }

  /** Stage 1: removing identical copies. */
  private async round1(target: string): Promise<void> {
    const P = this.lp(target);
    const stage = getStage(this.db, target, 1);
    if (stage.mode === 'off' || !target || !P.analysis) {
      P.waiting =
        stage.mode === 'off'
          ? null
          : target
            ? 'The Calibre folder is not set up'
            : 'Choose the library';
      return;
    }
    this.checkMassMissing(target);
    let progress = P.analysis.progress();
    if (!progress || progress.libraryId !== target) progress = P.analysis.restart(target);
    if (progress.phase !== 'done') {
      if (!this.snapshotExists(target)) {
        P.waiting = "Waiting for the reader's index of the library";
        return;
      }
      P.waiting = 'Analysing';
      this.runAnalysis(target);
      return;
    }
    if (progress.error) {
      P.waiting = `The analysis failed: ${progress.error}`;
      return;
    }
    if (stage.mode !== 'on') {
      P.waiting = 'Preview: nothing is changed in Calibre';
      return;
    }
    const current = getStage(this.db, target, 1);
    if (current.pauseReason) {
      P.waiting = null;
      return;
    }
    if (this.batches.open()) {
      P.waiting = 'A batch is being applied';
      return;
    }
    const checks = this.checksPass(target);
    if (!checks.ok) {
      P.waiting = `Waiting for the safety checks: ${checks.failing.join('; ')}`;
      return;
    }
    const { batch, reason } = await this.batches.planStage1(target, () => this.stopped);
    P.waiting = batch
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
        .get(target, currentAnalysisId(this.db, target, 1)) as { n: number }
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
          if (
            getStage(this.db, target, st).mode === 'on' &&
            !getStage(this.db, target, st).pauseReason
          ) {
            pauseStage(
              this.db,
              target,
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

  private runAnalysis(target: string): void {
    const P = this.lp(target);
    if (P.analysing || P.analysing2 || !P.analysis) return;
    const analysis = P.analysis;
    const owner1 = this.diskOwner(1, target);
    P.analysing = (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          if (getStage(this.db, target, 1).mode === 'off') break;
          const stop1 = () => this.stopped || getStage(this.db, target, 1).mode === 'off';
          if (!(await this.diskFor(1, owner1, analysis.progress()?.phase, stop1))) break;
          const done = await analysis.step(stop1);
          if (done) break;
        }
      } catch (err) {
        this.logError('Cleanup: analysis failed:', err);
      } finally {
        this.diskLock.release(owner1);
        P.analysing = null;
        void this.tick();
      }
    })();
  }

  stage1Counts(target: string | null): Record<string, number> {
    target = target ?? this.targetLibrary();
    if (!target) return {};
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 1 AND library_id = ?
         AND ${CURRENT_PROPOSALS_SQL} GROUP BY state`,
      )
      .all(target, currentAnalysisId(this.db, target, 1)) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** Why copies were skipped, most common first (for the page). */
  stage1SkipReasons(target: string | null): { reason: string; count: number }[] {
    target = target ?? this.targetLibrary();
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT COALESCE(review_reason, 'No reason recorded') AS reason, COUNT(*) AS count
         FROM proposed_changes WHERE stage = 1 AND library_id = ? AND state = 'skipped'
           AND analysis_id = ?
         GROUP BY reason ORDER BY count DESC, reason`,
      )
      .all(target, currentAnalysisId(this.db, target, 1)) as { reason: string; count: number }[];
  }

  /**
   * The recent pace of removals (for the page's time left): copies removed in the last
   * PACE_WINDOW_MS and when the first of them was removed. The pace of the whole run would
   * be thrown off by a slow start or an earlier run.
   */
  stage1Pace(target: string | null, now = Date.now()): { removed: number; firstAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id
         WHERE b.kind = 'apply' AND b.stage = 1 AND b.library_id = ? AND i.state = 'removed'
           AND i.updated_at >= ?`,
      )
      .get(target ?? '', now - PACE_WINDOW_MS) as { n: number; first: number | null };
    return { removed: row.n, firstAt: row.first };
  }

  /**
   * Stage 3's pairs for the page, with both books' facts. view: review (waiting for a
   * decision), a class (duplicate, superset, keep_both, never, different), image_only,
   * errors, spread (pairs with extra text inside the chapters, most first: the special-edition
   * measure) or examples (30 random pairs of one class).
   */
  stage3Pairs(
    target: string | null,
    view: string,
    { cls, offset = 0, limit = 50 }: { cls?: string; offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const p = P.analysis3?.progress();
    if (!target || !p || !P.analysis3) return { total: 0, items: [] };
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
    const books = P.analysis3.loadBooks(target);
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
    target: string | null,
    view: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    if (!target || !P.analysis3) return { total: 0, items: [] };
    const where =
      view === 'omnibus'
        ? `kind = 'omnibus'`
        : view === 'errors'
          ? 'error IS NOT NULL'
          : view === 'image_only'
            ? 'image_only = 1'
            : null;
    if (!where) throw new Error('No such list');
    const books = P.analysis3.loadBooks(target);
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
  stage3Gate(target: string | null) {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    return P.analysis3?.progress()?.gate ?? null;
  }

  /** Stage 3's line on the page (the gate's per-pair results come from their own route). */
  stage3Status(target: string | null, now = Date.now()) {
    target = target ?? this.targetLibrary();
    const P = this.lp(target);
    const p = P.analysis3?.progress() ?? null;
    const counts: Record<string, number> = {};
    if (target) {
      for (const r of this.db
        .prepare(
          `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 3 AND library_id = ?
           AND ${CURRENT_PROPOSALS_SQL} GROUP BY state`,
        )
        .all(target, currentAnalysisId(this.db, target, 3)) as { state: string; n: number }[]) {
        counts[r.state] = r.n;
      }
    }
    const pace = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id
         WHERE b.kind = 'apply' AND b.stage = 3 AND b.library_id = ? AND i.state = 'removed'
           AND i.updated_at >= ?`,
      )
      .get(target ?? '', now - PACE_WINDOW_MS) as { n: number; first: number | null };
    const gate = p?.gate
      ? {
          ...p.gate,
          pairs: p.gate.pairs ? { ...p.gate.pairs, results: undefined } : null,
        }
      : null;
    return {
      waiting: P.waiting3,
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
            .all(target, currentAnalysisId(this.db, target, 3)) as {
            reason: string;
            count: number;
          }[])
        : [],
      pace: { removed: pace.n, firstAt: pace.first },
      awaitingIngest: this.batches.awaitingIngest(3),
    };
  }

  status(libraryId: string | null = null, now = Date.now()) {
    // Manga part B: the stages of one library (the primary one unless the page names another),
    // and a line per library for the page's picker or columns.
    const target = this.libraryOr(libraryId);
    const lib = target ? getLibrary(this.opts.main, target) : null;
    // Counted once: the reader's index of 60,000+ books is read row by row (0.3 s on the PC).
    const present = lib ? presentBookCount(this.opts.main, lib.id) : undefined;
    return {
      stages: target ? listStages(this.db, target) : [],
      cleanupLibraries: this.cleanupLibraries().map((id) => this.librarySummary(id)),
      // The disk lock shared with the audiobook cleanup (WP21a).
      disk: this.diskLock.state(),
      waiting: this.lp(target).waiting,
      checks: this.checks(now, present, target),
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
      calibre:
        target && target !== this.targetLibrary()
          ? {
              id: this.calibreLibraryIdOf(target),
              auto: true,
              libraries: this.calibreLibraries(),
            }
          : this.resolvedLibraryId(),
      stage1: {
        counts: this.stage1Counts(target),
        skipReasons: this.stage1SkipReasons(target),
        pace: this.stage1Pace(target, now),
        openBatch: this.batches.open(),
        awaitingIngest: target ? this.batches.awaitingIngest(1, target) : null,
      },
      stage3: this.stage3Status(target, now),
      stage4: this.stage4Status(target, now),
      stage5: this.stage5Status(target, now),
      stage2: {
        waiting: this.lp(target).waiting2,
        counts: this.stage2Counts(target),
        skipReasons: this.stage2SkipReasons(target),
        fieldPauses: target ? listFieldPauses(this.db, target, 2) : [],
        pace: this.stage2Pace(target, now),
        booksLeft: this.stage2BooksLeft(target),
      },
    };
  }

  /**
   * One library's line for the page (the picker's buttons, the columns' headings): its name,
   * its books in the reader's index, how many stages are On or in Preview, whether one is
   * paused. The count is cached per library by the reader's index version (presentBookCount).
   */
  librarySummary(id: string): {
    id: string;
    name: string;
    folder: string;
    primary: boolean;
    present: number;
    on: number;
    preview: number;
    paused: boolean;
  } {
    const lib = getLibrary(this.opts.main, id);
    const stages = listStages(this.db, id).filter((s) => s.stage >= 1 && s.stage <= 5);
    return {
      id,
      name: lib?.name || lib?.folder || id,
      folder: lib?.folder ?? '',
      primary: id === this.targetLibrary(),
      present: lib ? presentBookCount(this.opts.main, id) : 0,
      on: stages.filter((s) => s.mode === 'on').length,
      preview: stages.filter((s) => s.mode === 'analyse').length,
      paused:
        stages.some((s) => s.pauseReason !== null) ||
        [2, 4, 5].some((st) => listFieldPauses(this.db, id, st).length > 0),
    };
  }
}
