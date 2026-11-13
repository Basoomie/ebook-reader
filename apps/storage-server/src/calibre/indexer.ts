/**
 * Calibre indexer (WP2): discovers libraries, watches each enabled library's
 * metadata.db, snapshots it when it changed and has settled, and ingests the
 * snapshot. Runs inside the server on a poll timer.
 *
 * HDD load is kept low on purpose:
 * - discovery is one readdir of the root plus a stat per subfolder (no walks);
 * - change detection is a stat of metadata.db (and its journal names);
 * - a changed metadata.db is read once, as one sequential copy;
 * - libraries are processed one at a time;
 * - disabled libraries are never read beyond the discovery stat.
 *
 * Every failure is caught and logged; the indexer can never take down the
 * server.
 */
import type Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { CalibreConfig } from '../config';
import { isInside } from '../db/database';
import type { ThumbnailService } from '../thumbnails/thumbnails';
import { ingestSnapshot } from './ingest';
import {
  adoptLibraryUuid,
  getIndexState,
  Library,
  listLibraries,
  syncDiscoveredLibraries,
  updateIndexState,
} from './libraries';
import { hasJournal, snapshotMetadataDb, SnapshotSkipped } from './snapshot';
import { isWritable, listSubfolders, METADATA_DB, statFile } from './source-fs';

export const SNAPSHOT_DIRNAME = 'calibre';

export interface IndexerStatus {
  /** false when CALIBRE_DIR is unset or unusable. */
  enabled: boolean;
  /** Why the indexer is off, if it is. */
  error: string | null;
}

export interface IndexerOptions {
  db: Database.Database;
  config: CalibreConfig;
  dbDir: string;
  dataRoot: string;
  thumbnails?: ThumbnailService | null;
  /** Background character counts (WP3b); woken after every poll like the thumbnails. */
  counts?: { wake(): void } | null;
  /**
   * WP20a: true while the library cleanup's sidecar is applying a batch to this library.
   * The indexer then leaves the library alone (no snapshot, no ingest) until the batch is
   * done, so the removed copies' missing flags and the reader-side handoffs land together.
   */
  holdIngest?: (libraryId: string) => boolean;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

export function snapshotFile(cacheDir: string, libraryId: string): string {
  return path.join(cacheDir, SNAPSHOT_DIRNAME, `${libraryId}.db`);
}

/**
 * Checks the folders before anything is read. Returns why the indexer can't
 * run, or null if it can.
 */
export async function checkIndexerConfig(
  config: CalibreConfig,
  dbDir: string,
  dataRoot: string,
): Promise<string | null> {
  const { dir, cacheDir } = config;
  if (!dir) return 'CALIBRE_DIR is not set';
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return `CALIBRE_DIR does not exist: ${dir}`;
  }
  if (!existsSync(cacheDir) || !statSync(cacheDir).isDirectory()) {
    return `CACHE_DIR does not exist: ${cacheDir}`;
  }
  for (const [name, other] of [
    ['CACHE_DIR', cacheDir],
    ['DB_DIR', dbDir],
    ['DATA_DIR', dataRoot],
  ] as const) {
    if (isInside(dir, other) || isInside(other, dir)) {
      return `${name} (${other}) and CALIBRE_DIR (${dir}) overlap; nothing may be written near the Calibre libraries`;
    }
  }
  if (isInside(dataRoot, cacheDir) || isInside(cacheDir, dataRoot)) {
    return `CACHE_DIR (${cacheDir}) and DATA_DIR (${dataRoot}) overlap; mount the cache separately`;
  }
  if (config.requireReadonly && (await isWritable(dir))) {
    return (
      `CALIBRE_DIR (${dir}) is writable. Mount the Calibre libraries read-only ` +
      '(docker-compose: read_only: true). CALIBRE_REQUIRE_READONLY=false is for local development only.'
    );
  }
  return null;
}

export class CalibreIndexer {
  readonly status: IndexerStatus = { enabled: false, error: 'not started' };
  private readonly db: Database.Database;
  private readonly config: CalibreConfig;
  private readonly opts: IndexerOptions;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private ticking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Last message logged per library, so a persisting problem is logged once. */
  private readonly lastProblem = new Map<string, string>();

  constructor(opts: IndexerOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.config = opts.config;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
  }

  private get root(): string {
    return this.config.dir!;
  }

  /** Validates the setup and, if usable, runs a first poll and starts the timer. */
  async start({ timer = true }: { timer?: boolean } = {}): Promise<void> {
    const problem = await checkIndexerConfig(this.config, this.opts.dbDir, this.opts.dataRoot);
    if (problem) {
      this.status.enabled = false;
      this.status.error = problem;
      if (this.config.dir) this.logError(`Calibre indexer is off: ${problem}`);
      else this.log(`Calibre indexer is off: ${problem}`);
      return;
    }
    await fs.mkdir(path.join(this.config.cacheDir, SNAPSHOT_DIRNAME), { recursive: true });
    this.status.enabled = true;
    this.status.error = null;
    this.log(
      `Calibre indexer: watching ${this.root} every ${this.config.pollSeconds} s ` +
        `(settle ${this.config.settleSeconds} s)`,
    );
    await this.tick();
    if (timer && !this.stopped) {
      this.timer = setInterval(() => void this.tick(), this.config.pollSeconds * 1000);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.ticking) await this.ticking;
  }

  /** One poll: discovery, then each enabled library in turn. Never throws. */
  tick(): Promise<void> {
    if (!this.status.enabled || this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.discover();
        for (const lib of listLibraries(this.db)) {
          if (this.stopped) break;
          if (!lib.enabled || !lib.available) continue;
          await this.checkLibrary(lib);
        }
      } catch (err) {
        this.logError('Calibre indexer: poll failed:', err);
      } finally {
        this.ticking = null;
        this.opts.thumbnails?.wake();
        this.opts.counts?.wake();
      }
    })();
    return this.ticking;
  }

  /** Folders holding a metadata.db: the root itself and its direct subfolders only. */
  async discover(): Promise<void> {
    const folders: string[] = [];
    if (await statFile(path.join(this.root, METADATA_DB))) folders.push('');
    for (const name of await listSubfolders(this.root)) {
      if (await statFile(path.join(this.root, name, METADATA_DB))) folders.push(name);
    }
    for (const lib of syncDiscoveredLibraries(this.db, folders)) {
      this.log(
        `Calibre: found library "${lib.folder || '(root)'}" (id ${lib.id}). It stays off until ` +
          `you set its language: node dist/cli.js library set ${lib.id} --language <ja|en|...> --enable`,
      );
    }
  }

  private noteProblem(libraryId: string, message: string, isError: boolean, err?: unknown) {
    if (this.lastProblem.get(libraryId) === message) return;
    this.lastProblem.set(libraryId, message);
    if (isError) this.logError(`Calibre: ${message}`, err);
    else this.log(`Calibre: ${message}`);
  }

  async checkLibrary(lib: Library): Promise<void> {
    const label = `library "${lib.name}"`;
    const startedAt = Date.now();
    try {
      const state = getIndexState(this.db, lib.id);
      const source = path.join(this.root, lib.folder, METADATA_DB);
      const stat = await statFile(source);
      if (!stat) return; // Discovery marks it unavailable on the next poll.

      const unchanged = state.sourceMtimeMs === stat.mtimeMs && state.sourceSize === stat.size;
      if (unchanged && state.reindexRequestedAt === null) return;
      if (this.opts.holdIngest?.(lib.id)) {
        this.noteProblem(
          lib.id,
          `${label}: waiting for the library cleanup's batch to finish`,
          false,
        );
        return;
      }

      const settled = Date.now() - stat.mtimeMs >= this.config.settleSeconds * 1000;
      if (!settled || (await hasJournal(source))) {
        if (state.status !== 'settling') updateIndexState(this.db, lib.id, { status: 'settling' });
        return;
      }

      updateIndexState(this.db, lib.id, { status: 'snapshotting' });
      let dest = snapshotFile(this.config.cacheDir, lib.id);
      const snap = await snapshotMetadataDb(source, dest, {
        timeoutMs: this.config.snapshotTimeoutSeconds * 1000,
      });

      const target = adoptLibraryUuid(this.db, lib.id, snap.libraryUuid);
      if (target.id !== lib.id) {
        const moved = snapshotFile(this.config.cacheDir, target.id);
        await fs.rename(dest, moved);
        dest = moved;
      }

      const before = getIndexState(this.db, target.id);
      updateIndexState(this.db, target.id, { status: 'ingesting', snapshotAt: Date.now() });
      const result = await ingestSnapshot(this.db, dest, {
        libraryId: target.id,
        maxMissingPercent: this.config.maxMissingPercent,
        allowMassMissing: before.allowMassMissing || state.allowMassMissing,
      });

      const now = Date.now();
      updateIndexState(this.db, target.id, {
        status: 'idle',
        sourceMtimeMs: snap.sourceStat.mtimeMs,
        sourceSize: snap.sourceStat.size,
        indexedAt: now,
        lastError: null,
        lastErrorAt: null,
        lastWarning: result.massMissingWarning,
        lastWarningAt: result.massMissingWarning ? now : null,
        booksIndexed: result.present,
        booksMissing: result.missing,
        booksSkipped: result.skippedNoUuid,
        allowMassMissing: false,
      });
      // A reindex requested while this run was going keeps its request.
      this.db
        .prepare(
          `UPDATE library_index_state SET reindex_requested_at = NULL
           WHERE library_id = ? AND reindex_requested_at <= ?`,
        )
        .run(target.id, startedAt);
      this.lastProblem.delete(lib.id);

      const secs = ((now - startedAt) / 1000).toFixed(1);
      this.log(
        `Calibre: indexed ${label} in ${secs} s: ${result.total} EPUB books ` +
          `(${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged, ` +
          `${result.missingMarked} newly missing, ${result.skippedNoUuid} without UUID skipped)`,
      );
      if (result.massMissingWarning) this.log(`Calibre: ${label}: ${result.massMissingWarning}`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (err instanceof SnapshotSkipped) {
        safeUpdate(this.db, lib.id, { status: 'settling' });
        this.noteProblem(lib.id, `${label}: snapshot postponed: ${message}`, false);
      } else {
        safeUpdate(this.db, lib.id, {
          status: 'error',
          lastError: message,
          lastErrorAt: Date.now(),
        });
        this.noteProblem(lib.id, `${label}: ${message}`, true);
      }
    }
  }
}

function safeUpdate(
  db: Database.Database,
  libraryId: string,
  changes: Parameters<typeof updateIndexState>[2],
): void {
  try {
    updateIndexState(db, libraryId, changes);
  } catch {
    // The library may have been merged into another record; nothing to record.
  }
}
