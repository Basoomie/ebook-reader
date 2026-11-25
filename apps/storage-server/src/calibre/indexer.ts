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
import { isWritable, listSubfolders, METADATA_DB, resolveInside, statFile } from './source-fs';

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
  /** The Natively level (2026-11-24): looks for newly linked books after a poll. */
  natively?: { wake(): void } | null;
  /** Store ratings (2026-11-25): newly linked books get their cached figures. */
  ratings?: { wake(): void } | null;
  /**
   * WP20a: true while the library cleanup's sidecar is applying a batch to this library.
   * The indexer then leaves the library alone (no snapshot, no ingest) until the batch is
   * done, so the removed copies' missing flags and the reader-side handoffs land together.
   */
  holdIngest?: (libraryId: string) => boolean;
  /**
   * True when something waits for this library's next index (a finished stage-1 cleanup
   * batch): a busy metadata.db is copied at once instead of after the longest settle wait.
   */
  wantsIngest?: (libraryId: string) => boolean;
  /** After an index that queued field changes (calibre_field_changes): the cleanup sorts them out. */
  onFieldChanges?: (libraryId: string) => void;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

/** A cover's size and mtime ("size:mtimeMs"), read only; null when it can't be read. */
export async function coverSigOf(libDir: string, bookPath: string): Promise<string | null> {
  try {
    const st = await statFile(resolveInside(libDir, `${bookPath}/cover.jpg`));
    return st ? `${st.size}:${Math.round(st.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

/** Covers read per poll by the background pass that records each cover's size and mtime. */
export const COVER_SIGS_PER_POLL = 300;

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
  /** Since when each library's metadata.db has kept changing (the settle wait). */
  private readonly unsettledSince = new Map<string, number>();

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
          await this.fillCoverSigs(lib).catch((err) =>
            this.logError('Calibre indexer: reading covers failed:', err),
          );
        }
      } catch (err) {
        this.logError('Calibre indexer: poll failed:', err);
      } finally {
        this.ticking = null;
        this.opts.thumbnails?.wake();
        this.opts.counts?.wake();
        this.opts.natively?.wake();
        this.opts.ratings?.wake();
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

  /**
   * The covers' size and mtime, a few hundred books per poll (read only, one stat each): the
   * baseline the index compares a changed book's cover with ("Changed in Calibre"). Books whose
   * record changes get theirs during the ingest; this fills in the rest once, slowly.
   */
  async fillCoverSigs(lib: Library, limit = COVER_SIGS_PER_POLL): Promise<number> {
    if (this.stopped) return 0;
    const rows = this.db
      .prepare(
        `SELECT id, calibre_path FROM book_sources
         WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL AND has_cover = 1
           AND cover_sig IS NULL AND calibre_path IS NOT NULL
         LIMIT ?`,
      )
      .all(lib.id, limit) as { id: string; calibre_path: string }[];
    if (rows.length === 0) return 0;
    const libDir = path.join(this.root, lib.folder);
    const sigs: [string, string][] = [];
    for (const r of rows) {
      if (this.stopped) break;
      // A cover that can't be read is marked so it isn't asked for again every poll.
      sigs.push([r.id, (await coverSigOf(libDir, r.calibre_path)) ?? 'none']);
    }
    const set = this.db.prepare(
      'UPDATE book_sources SET cover_sig = ? WHERE id = ? AND cover_sig IS NULL',
    );
    this.db.transaction(() => {
      for (const [id, sig] of sigs) set.run(sig, id);
    })();
    return sigs.length;
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
      let forced = false;
      if (!settled || (await hasJournal(source))) {
        // Calibre can keep changing metadata.db for hours (its own background writes of each
        // changed book's metadata.opf; a long cleanup run): past the wait, copy it anyway.
        const since = this.unsettledSince.get(lib.id) ?? Date.now();
        this.unsettledSince.set(lib.id, since);
        const maxWait = this.config.maxSettleWaitSeconds * 1000;
        const wanted = this.opts.wantsIngest?.(lib.id) ?? false;
        if (!wanted && (maxWait <= 0 || Date.now() - since < maxWait)) {
          if (state.status !== 'settling')
            updateIndexState(this.db, lib.id, { status: 'settling' });
          return;
        }
        forced = true;
        this.noteProblem(
          lib.id,
          wanted
            ? `${label}: the library cleanup waits for this index; indexing without waiting for metadata.db to stay unchanged`
            : `${label}: metadata.db has not stayed unchanged for ${this.config.settleSeconds} s in ${Math.round((Date.now() - since) / 1000)} s; indexing it anyway`,
          false,
        );
      }

      updateIndexState(this.db, lib.id, { status: 'snapshotting' });
      let dest = snapshotFile(this.config.cacheDir, lib.id);
      const snap = await snapshotMetadataDb(source, dest, {
        timeoutMs: this.config.snapshotTimeoutSeconds * 1000,
        allowChanging: forced,
        oneStep: forced,
      });
      this.unsettledSince.delete(lib.id);

      const target = adoptLibraryUuid(this.db, lib.id, snap.libraryUuid);
      if (target.id !== lib.id) {
        const moved = snapshotFile(this.config.cacheDir, target.id);
        await fs.rename(dest, moved);
        dest = moved;
      }

      const before = getIndexState(this.db, target.id);
      updateIndexState(this.db, target.id, { status: 'ingesting', snapshotAt: Date.now() });
      const libDir = path.join(this.root, lib.folder);
      const result = await ingestSnapshot(this.db, dest, {
        libraryId: target.id,
        maxMissingPercent: this.config.maxMissingPercent,
        allowMassMissing: before.allowMassMissing || state.allowMassMissing,
        coverSig: (bookPath) => coverSigOf(libDir, bookPath),
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
      try {
        this.opts.onFieldChanges?.(target.id);
      } catch (err) {
        this.logError('Calibre indexer: the field-change hook failed:', err);
      }
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
