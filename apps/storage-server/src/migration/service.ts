/**
 * WP5: migration off the old file sync.
 *
 * - scan:    link each old-sync book folder to a catalog book. Exact Calibre
 *            identity reported by a device first, then the WP3a fingerprint;
 *            otherwise the book waits for the user (decisions.md, WP5).
 * - import:  copy the old position and per-day statistics of linked books into
 *            sync records, written as the pseudo-device "Old sync (imported)"
 *            with the old data's own timestamps (re-runs never overwrite newer
 *            records). A verified database snapshot is taken first.
 * - check:   compare the old files with the new records, per book.
 * - undo:    delete what the import wrote.
 *
 * The old sync's files are only read (legacy-fs.ts) and Calibre only through
 * source-fs.ts. Nothing here writes outside the database and its snapshot folder.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { openSourceFile, resolveInside } from '../calibre/source-fs';
import { BookSummary, getBookFor } from '../catalog/queries';
import { listDevices } from '../db/devices';
import { SNAPSHOT_DIRNAME, writeVerifiedCopy } from '../snapshot';
import type { SyncChange, SyncStore } from '../sync/store';
import {
  BookFingerprint,
  candidateTiers,
  compareFingerprints,
  FingerprintComparison,
  fingerprintEpub,
  fingerprintStoredZip,
  looseTitleKey,
  MAX_CANDIDATES_PER_TIER,
  StoredFingerprint,
  titleKey,
} from './fingerprint';
import {
  LegacyFolder,
  listLegacyFolders,
  openLegacyFile,
  readLegacyFolder,
  readLegacyProgress,
  readLegacyStatistics,
  LegacyStatistic,
} from './legacy-fs';

export const IMPORT_DEVICE_NAME = 'Old sync (imported)';
/** Pre-import snapshots kept (they are named differently from the nightly ones). */
export const PRE_IMPORT_SNAPSHOTS_KEPT = 3;
/** Title candidates listed (not fingerprinted) when the stored book can't be fingerprinted. */
const MAX_LISTED_CANDIDATES = 10;

export type LegacyState = 'linked' | 'needs_user' | 'deferred';
export type LinkMethod = 'calibre-link' | 'fingerprint' | 'user';
/**
 * Why a book waits for the user:
 * several      several Calibre books match the fingerprint (identical files)
 * unverified   title candidates exist but none matches the fingerprint
 * no_candidate no Calibre book with a similar title
 * no_book_file the folder has no bookdata zip (nothing to fingerprint)
 * damaged      the stored data can't be read or its name can't be decoded
 * conflict     devices report different Calibre books for this title
 * unlinked     the user removed an automatic link
 */
export type NeedsReason =
  | 'several'
  | 'unverified'
  | 'no_candidate'
  | 'no_book_file'
  | 'damaged'
  | 'conflict'
  | 'unlinked';

export interface Candidate extends Partial<FingerprintComparison> {
  bookId: string;
  /** false = listed by title only (the stored book could not be fingerprinted). */
  fingerprinted: boolean;
  error?: string;
}

export interface FolderDetails {
  characters: number | null;
  bookFiles: number;
  progress: { charPos: number; progress: number | null; at: number } | null;
  stats: { days: number; characters: number; seconds: number; lastDay: string | null } | null;
  audioBook: boolean;
  subtitles: boolean;
  error?: string;
  /** A device reports a different Calibre book than the imported link. */
  conflictBookIds?: string[];
}

export interface DeviceReport {
  calibreLinks: { title: string; bookId: string; calibreUuid: string }[];
  localTitles: { title: string; hasBookmark: boolean; statDays: number }[];
}

interface LegacyRow {
  folder: string;
  title: string;
  state: LegacyState;
  reason: NeedsReason | null;
  method: LinkMethod | null;
  book_id: string | null;
  candidates: string;
  details: string;
  scanned_at: number;
  decided_at: number | null;
  imported_at: number | null;
}

export interface LegacyBookView {
  folder: string;
  title: string;
  state: LegacyState;
  reason: NeedsReason | null;
  method: LinkMethod | null;
  bookId: string | null;
  book: BookSummary | null;
  candidates: (Candidate & { book: BookSummary | null })[];
  details: FolderDetails;
  scannedAt: number;
  decidedAt: number | null;
  importedAt: number | null;
}

export interface ScanStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  error: string | null;
}

export class MigrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MigrationOptions {
  db: Database.Database;
  store: SyncStore;
  /** The old sync's folder (DATA_DIR). Read-only. */
  dataRoot: string;
  /** Root of the Calibre libraries (read-only); null when the indexer is off. */
  calibreDir: string | null;
  /** Whether the Calibre indexer runs (the catalog is usable). */
  indexerEnabled: () => boolean;
  /** Folder of the database; the pre-import snapshot goes to its snapshots folder. */
  dbDir: string;
  log?: (message: string) => void;
}

/** Sync record id of a legacy-book link (devices never compute it). */
export function legacyBookRecordId(title: string): string {
  return `t:${createHash('sha256').update(title, 'utf8').digest('hex')}`;
}

interface CatalogEntry {
  bookId: string;
  title: string;
  libraryFolder: string;
  filePath: string;
  key: string;
  looseKey: string;
}

function statsSummary(rows: LegacyStatistic[]): FolderDetails['stats'] {
  if (!rows.length) return null;
  const days = [...rows].sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  return {
    days: rows.length,
    characters: rows.reduce((n, r) => n + (Number(r.charactersRead) || 0), 0),
    seconds: rows.reduce((n, r) => n + (Number(r.readingTime) || 0), 0),
    lastDay: days[days.length - 1].dateKey,
  };
}

function clampProgress(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export class MigrationService {
  private status: ScanStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    done: 0,
    total: 0,
    error: null,
  };
  private importing = false;

  constructor(private readonly opts: MigrationOptions) {}

  private get db() {
    return this.opts.db;
  }

  scanStatus(): ScanStatus {
    return { ...this.status };
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private ensureState(userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO migration_state (user_id) VALUES (?)').run(userId);
  }

  private state(userId: string) {
    this.ensureState(userId);
    return this.db.prepare('SELECT * FROM migration_state WHERE user_id = ?').get(userId) as {
      import_device_id: string | null;
      last_scan_at: number | null;
      last_import_at: number | null;
      last_snapshot: string | null;
    };
  }

  /** The pseudo-device that writes imported records; created on first use. */
  ensureImportDevice(userId: string, now = Date.now()): string {
    const existing = this.state(userId).import_device_id;
    if (existing) return existing;
    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, userId, now);
      this.db
        .prepare('UPDATE migration_state SET import_device_id = ? WHERE user_id = ?')
        .run(id, userId);
      const result = this.opts.store.writeAs(
        userId,
        id,
        { kind: 'device', id, updatedAt: now, data: { name: IMPORT_DEVICE_NAME } },
        now,
      );
      if (result.status === 'rejected') throw new Error(result.error.message);
    })();
    return id;
  }

  private rows(userId: string): LegacyRow[] {
    return this.db
      .prepare('SELECT * FROM legacy_books WHERE user_id = ? ORDER BY title, folder')
      .all(userId) as LegacyRow[];
  }

  private row(userId: string, folder: string): LegacyRow | undefined {
    return this.db
      .prepare('SELECT * FROM legacy_books WHERE user_id = ? AND folder = ?')
      .get(userId, folder) as LegacyRow | undefined;
  }

  // -------------------------------------------------------------------------
  // Device reports
  // -------------------------------------------------------------------------

  report(userId: string, deviceId: string, raw: unknown, now = Date.now()): void {
    const body = (raw ?? {}) as Partial<DeviceReport>;
    const links = (Array.isArray(body.calibreLinks) ? body.calibreLinks : [])
      .filter(
        (l) =>
          l &&
          typeof l.title === 'string' &&
          typeof l.bookId === 'string' &&
          typeof l.calibreUuid === 'string',
      )
      .slice(0, 20_000)
      .map((l) => ({ title: l.title, bookId: l.bookId, calibreUuid: l.calibreUuid }));
    const titles = (Array.isArray(body.localTitles) ? body.localTitles : [])
      .filter((t) => t && typeof t.title === 'string')
      .slice(0, 20_000)
      .map((t) => ({
        title: t.title,
        hasBookmark: !!t.hasBookmark,
        statDays: Number.isFinite(Number(t.statDays)) ? Number(t.statDays) : 0,
      }));
    this.db
      .prepare(
        `INSERT INTO legacy_device_reports (user_id, device_id, reported_at, data)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, device_id) DO UPDATE SET
           reported_at = excluded.reported_at, data = excluded.data`,
      )
      .run(userId, deviceId, now, JSON.stringify({ calibreLinks: links, localTitles: titles }));
  }

  private reports(userId: string): { deviceId: string; reportedAt: number; data: DeviceReport }[] {
    return (
      this.db
        .prepare('SELECT device_id, reported_at, data FROM legacy_device_reports WHERE user_id = ?')
        .all(userId) as { device_id: string; reported_at: number; data: string }[]
    ).map((r) => ({
      deviceId: r.device_id,
      reportedAt: r.reported_at,
      data: JSON.parse(r.data) as DeviceReport,
    }));
  }

  /** title -> catalog book ids from devices' Calibre links whose identity still holds. */
  private exactLinks(userId: string): Map<string, Set<string>> {
    const check = this.db.prepare(
      `SELECT 1 FROM book_sources WHERE book_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
    );
    const out = new Map<string, Set<string>>();
    for (const report of this.reports(userId)) {
      for (const link of report.data.calibreLinks) {
        if (!check.get(link.bookId, link.calibreUuid)) continue;
        const set = out.get(link.title) ?? new Set<string>();
        set.add(link.bookId);
        out.set(link.title, set);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  private catalogEntries(): CatalogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT b.id AS bookId, b.title, l.folder AS libraryFolder, s.file_path AS filePath
           FROM books b
           JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'
           JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
          WHERE s.missing_at IS NULL AND s.file_path IS NOT NULL
          ORDER BY l.folder, s.calibre_id`,
      )
      .all() as Omit<CatalogEntry, 'key' | 'looseKey'>[];
    return rows.map((r) => ({ ...r, key: titleKey(r.title), looseKey: looseTitleKey(r.title) }));
  }

  /** Starts a scan in the background. Throws when one is already running. */
  startScan(userId: string): void {
    if (this.status.running) throw new MigrationError(409, 'busy', 'A scan is already running');
    if (this.importing) throw new MigrationError(409, 'busy', 'An import is running');
    if (!this.opts.calibreDir || !this.opts.indexerEnabled()) {
      throw new MigrationError(503, 'indexer_off', 'The Calibre library is not available');
    }
    this.status = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      done: 0,
      total: 0,
      error: null,
    };
    this.scan(userId).catch((err) => {
      this.status.error = (err as Error).message ?? String(err);
      this.opts.log?.(`Migration scan failed: ${this.status.error}`);
    });
  }

  /** Runs a scan to the end (startScan runs this in the background). */
  async scan(userId: string, now = () => Date.now()): Promise<void> {
    const calibreDir = this.opts.calibreDir;
    try {
      if (!calibreDir) throw new MigrationError(503, 'indexer_off', 'No Calibre folder');
      this.status.running = true;
      const folders = await listLegacyFolders(this.opts.dataRoot);
      this.status.total = folders.length;
      this.status.done = 0;
      const catalog = this.catalogEntries();
      const exact = this.exactLinks(userId);
      const epubCache = new Map<string, Promise<BookFingerprint>>();
      const legacyOpener = openLegacyFile(this.opts.dataRoot);
      const epubPrint = (entry: CatalogEntry) => {
        let p = epubCache.get(entry.bookId);
        if (!p) {
          const file = resolveInside(path.join(calibreDir, entry.libraryFolder), entry.filePath);
          p = fingerprintEpub(file, openSourceFile);
          epubCache.set(entry.bookId, p);
        }
        return p;
      };

      for (const folderName of folders) {
        const existing = this.row(userId, folderName);
        let folder: LegacyFolder | null = null;
        let details: FolderDetails;
        try {
          folder = await readLegacyFolder(this.opts.dataRoot, folderName);
          details = await this.folderDetails(folder);
        } catch (err) {
          details = emptyDetails((err as Error).message);
        }
        const title = folder?.title ?? existing?.title ?? folderName;

        // Kept as they are: the user's own links and anything already imported.
        if (
          existing &&
          existing.state === 'linked' &&
          (existing.method === 'user' || existing.imported_at)
        ) {
          const ids = exact.get(title);
          if (ids && existing.book_id && !ids.has(existing.book_id)) {
            details.conflictBookIds = [...ids];
          }
          this.updateDetails(userId, folderName, details, now());
          this.status.done += 1;
          continue;
        }

        let decision = await this.decide(
          folder,
          title,
          details,
          catalog,
          exact,
          epubPrint,
          legacyOpener,
        );
        // The user removed an automatic link: never link it again automatically.
        if (
          existing?.reason === 'unlinked' &&
          existing.state !== 'linked' &&
          decision.state === 'linked'
        ) {
          decision = {
            state: 'needs_user',
            reason: 'unlinked',
            candidates: decision.candidates.length
              ? decision.candidates
              : [{ bookId: decision.bookId, fingerprinted: false }],
          };
        }
        const keepDeferred = existing?.state === 'deferred' && decision.state !== 'linked';
        this.upsert(userId, {
          folder: folderName,
          title,
          state: keepDeferred ? 'deferred' : decision.state,
          reason:
            decision.state === 'linked'
              ? null
              : existing?.reason === 'unlinked'
                ? 'unlinked'
                : decision.reason,
          method: decision.state === 'linked' ? decision.method : null,
          bookId: decision.state === 'linked' ? decision.bookId : null,
          candidates: decision.candidates,
          details,
          scannedAt: now(),
          decidedAt: keepDeferred ? existing!.decided_at : null,
        });
        this.status.done += 1;
      }

      // Folders that are gone: forget them unless their data was imported.
      const present = new Set(folders);
      for (const row of this.rows(userId)) {
        if (!present.has(row.folder) && !row.imported_at) {
          this.db
            .prepare('DELETE FROM legacy_books WHERE user_id = ? AND folder = ?')
            .run(userId, row.folder);
        }
      }
      this.ensureState(userId);
      this.db
        .prepare('UPDATE migration_state SET last_scan_at = ? WHERE user_id = ?')
        .run(now(), userId);
    } finally {
      this.status.running = false;
      this.status.finishedAt = Date.now();
    }
  }

  private async folderDetails(folder: LegacyFolder): Promise<FolderDetails> {
    const details: FolderDetails = {
      characters: folder.bookData?.characters ?? null,
      bookFiles: folder.bookData?.count ?? 0,
      progress: null,
      stats: null,
      audioBook: folder.hasAudioBook,
      subtitles: folder.hasSubtitles,
    };
    if (folder.progressFile) {
      const p = await readLegacyProgress(this.opts.dataRoot, folder.progressFile.file);
      if (p) {
        details.progress = {
          charPos: Math.round(p.exploredCharCount),
          progress: clampProgress(p.progress),
          at: p.lastBookmarkModified,
        };
      }
    }
    if (folder.statisticsFile) {
      details.stats = statsSummary(
        await readLegacyStatistics(this.opts.dataRoot, folder.statisticsFile.file),
      );
    }
    return details;
  }

  private async decide(
    folder: LegacyFolder | null,
    title: string,
    details: FolderDetails,
    catalog: CatalogEntry[],
    exact: Map<string, Set<string>>,
    epubPrint: (entry: CatalogEntry) => Promise<BookFingerprint>,
    legacyOpener: ReturnType<typeof openLegacyFile>,
  ): Promise<
    | { state: 'linked'; method: LinkMethod; bookId: string; candidates: Candidate[] }
    | { state: 'needs_user'; reason: NeedsReason; candidates: Candidate[] }
  > {
    if (!folder || folder.title === null || details.error) {
      return { state: 'needs_user', reason: 'damaged', candidates: [] };
    }

    // 1. Exact Calibre identity (WP5 decision 1).
    const exactIds = exact.get(title);
    if (exactIds && exactIds.size === 1) {
      const [bookId] = exactIds;
      return { state: 'linked', method: 'calibre-link', bookId, candidates: [] };
    }
    if (exactIds && exactIds.size > 1) {
      return {
        state: 'needs_user',
        reason: 'conflict',
        candidates: [...exactIds].map((bookId) => ({ bookId, fingerprinted: false })),
      };
    }

    // 2. Fingerprint (WP5 decision 2).
    const titleOnly = (storedTitle: string): Candidate[] => {
      const tier = candidateTiers(storedTitle, catalog).find((t) => t.length > 0) ?? [];
      return tier
        .slice(0, MAX_LISTED_CANDIDATES)
        .map((c) => ({ bookId: c.bookId, fingerprinted: false }));
    };
    if (!folder.bookData) {
      const candidates = titleOnly(title);
      return { state: 'needs_user', reason: 'no_book_file', candidates };
    }
    let stored: StoredFingerprint;
    try {
      stored = await fingerprintStoredZip(folder.bookData.file, legacyOpener);
    } catch (err) {
      details.error = `The stored book could not be read: ${(err as Error).message}`;
      return { state: 'needs_user', reason: 'damaged', candidates: titleOnly(title) };
    }
    const storedTitle = stored.title || title;
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const tier of candidateTiers(storedTitle, catalog)) {
      const fresh = tier.filter((c) => !seen.has(c.bookId)).slice(0, MAX_CANDIDATES_PER_TIER);
      for (const entry of fresh) {
        seen.add(entry.bookId);
        try {
          candidates.push({
            bookId: entry.bookId,
            fingerprinted: true,
            ...compareFingerprints(stored, await epubPrint(entry)),
          });
        } catch (err) {
          candidates.push({
            bookId: entry.bookId,
            fingerprinted: true,
            titleMatches: false,
            imagesMatched: 0,
            imagesTotal: stored.images.size,
            missingSpineIds: -1,
            verified: false,
            error: (err as Error).message,
          });
        }
      }
      const verified = candidates.filter((c) => c.verified);
      if (verified.length === 1) {
        return {
          state: 'linked',
          method: 'fingerprint',
          bookId: verified[0].bookId,
          candidates: verified,
        };
      }
      if (verified.length > 1) {
        return { state: 'needs_user', reason: 'several', candidates: verified };
      }
    }
    if (!candidates.length) return { state: 'needs_user', reason: 'no_candidate', candidates };
    // Best partial matches first, so the screen shows the likeliest ones on top.
    candidates.sort(
      (a, b) =>
        Number(b.titleMatches) - Number(a.titleMatches) ||
        (b.imagesMatched ?? 0) - (a.imagesMatched ?? 0),
    );
    return {
      state: 'needs_user',
      reason: 'unverified',
      candidates: candidates.slice(0, MAX_LISTED_CANDIDATES),
    };
  }

  private upsert(
    userId: string,
    r: {
      folder: string;
      title: string;
      state: LegacyState;
      reason: NeedsReason | null;
      method: LinkMethod | null;
      bookId: string | null;
      candidates: Candidate[];
      details: FolderDetails;
      scannedAt: number;
      decidedAt: number | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO legacy_books
           (user_id, folder, title, state, reason, method, book_id, candidates, details,
            scanned_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, folder) DO UPDATE SET
           title = excluded.title, state = excluded.state, reason = excluded.reason,
           method = excluded.method, book_id = excluded.book_id,
           candidates = excluded.candidates, details = excluded.details,
           scanned_at = excluded.scanned_at, decided_at = excluded.decided_at`,
      )
      .run(
        userId,
        r.folder,
        r.title,
        r.state,
        r.reason,
        r.method,
        r.bookId,
        JSON.stringify(r.candidates),
        JSON.stringify(r.details),
        r.scannedAt,
        r.decidedAt,
      );
  }

  private updateDetails(userId: string, folder: string, details: FolderDetails, now: number): void {
    this.db
      .prepare(
        'UPDATE legacy_books SET details = ?, scanned_at = ? WHERE user_id = ? AND folder = ?',
      )
      .run(JSON.stringify(details), now, userId, folder);
  }

  // -------------------------------------------------------------------------
  // The user's decisions
  // -------------------------------------------------------------------------

  /** Link a book to a catalog book chosen by the user. */
  link(userId: string, folder: string, bookId: string, now = Date.now()): void {
    const row = this.requireRow(userId, folder);
    if (row.imported_at) {
      throw new MigrationError(409, 'already_imported', 'This book was already imported');
    }
    if (!this.db.prepare(`SELECT 1 FROM books WHERE id = ?`).get(bookId)) {
      throw new MigrationError(404, 'unknown_book', 'No such book in the library');
    }
    this.db
      .prepare(
        `UPDATE legacy_books SET state = 'linked', method = 'user', book_id = ?, reason = NULL,
           decided_at = ? WHERE user_id = ? AND folder = ?`,
      )
      .run(bookId, now, userId, folder);
  }

  /** "Not in Calibre yet: decide later". The book stays on the old sync only. */
  defer(userId: string, folder: string, now = Date.now()): void {
    const row = this.requireRow(userId, folder);
    if (row.imported_at) {
      throw new MigrationError(409, 'already_imported', 'This book was already imported');
    }
    this.db
      .prepare(
        `UPDATE legacy_books SET state = 'deferred', method = NULL, book_id = NULL,
           reason = COALESCE(reason, 'unlinked'), decided_at = ?
         WHERE user_id = ? AND folder = ?`,
      )
      .run(now, userId, folder);
  }

  /** Removes a link before import; the book then waits for the user. */
  unlink(userId: string, folder: string, now = Date.now()): void {
    const row = this.requireRow(userId, folder);
    if (row.imported_at) {
      throw new MigrationError(
        409,
        'already_imported',
        'Imported links are undone with "migration undo"',
      );
    }
    this.db
      .prepare(
        `UPDATE legacy_books SET state = 'needs_user', method = NULL, book_id = NULL,
           reason = 'unlinked', decided_at = ? WHERE user_id = ? AND folder = ?`,
      )
      .run(now, userId, folder);
  }

  private requireRow(userId: string, folder: string): LegacyRow {
    const row = this.row(userId, folder);
    if (!row) throw new MigrationError(404, 'not_found', 'No such book folder');
    return row;
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  async takePreImportSnapshot(now = new Date()): Promise<string> {
    const dir = path.join(this.opts.dbDir, SNAPSHOT_DIRNAME);
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const file = path.join(dir, `pre-import-${stamp}Z.db`);
    await writeVerifiedCopy(this.db, file);
    // Keep only the newest few pre-import snapshots (never touches nightly ones).
    const fs = await import('fs/promises');
    const names = (await fs.readdir(dir))
      .filter((n) => /^pre-import-\d{8}-\d{6}Z\.db$/.test(n))
      .sort();
    for (const old of names.slice(0, Math.max(0, names.length - PRE_IMPORT_SNAPSHOTS_KEPT))) {
      await fs.unlink(path.join(dir, old));
    }
    return file;
  }

  async import(
    userId: string,
    now = () => Date.now(),
  ): Promise<{ books: number; positions: number; statDays: number; snapshot: string }> {
    if (this.importing || this.status.running) {
      throw new MigrationError(409, 'busy', 'A scan or import is running');
    }
    this.importing = true;
    try {
      const linked = this.rows(userId).filter((r) => r.state === 'linked' && r.book_id);
      if (!linked.length)
        throw new MigrationError(409, 'nothing_linked', 'No linked books to import');
      const snapshot = await this.takePreImportSnapshot(new Date(now()));
      const deviceId = this.ensureImportDevice(userId, now());
      let positions = 0;
      let statDays = 0;

      for (const row of linked) {
        const bookId = row.book_id!;
        const changes: SyncChange[] = [];
        const linkId = legacyBookRecordId(row.title);
        const current = this.opts.store.getRecord(userId, 'legacy-book', linkId);
        const linkData = { title: row.title, bookId, method: row.method };
        if (
          !current ||
          current.deletedAt !== null ||
          JSON.stringify(current.data) !== JSON.stringify(linkData)
        ) {
          changes.push({
            kind: 'legacy-book',
            id: linkId,
            updatedAt: Math.max(now(), (current?.updatedAt ?? 0) + 1),
            data: linkData,
          });
        }

        let folder: LegacyFolder | null = null;
        try {
          folder = await readLegacyFolder(this.opts.dataRoot, row.folder);
        } catch {
          folder = null; // folder gone: only the link is written
        }
        if (folder?.progressFile) {
          const p = await readLegacyProgress(this.opts.dataRoot, folder.progressFile.file);
          if (p) {
            changes.push({
              kind: 'position',
              id: `${bookId}:${deviceId}`,
              updatedAt: p.lastBookmarkModified,
              data: {
                charPos: Math.round(p.exploredCharCount),
                progress: clampProgress(p.progress),
                readThroughId: null,
              },
            });
          }
        }
        if (folder?.statisticsFile) {
          for (const stat of await readLegacyStatistics(
            this.opts.dataRoot,
            folder.statisticsFile.file,
          )) {
            const { title: _title, ...data } = stat as LegacyStatistic & { title?: string };
            changes.push({
              kind: 'stat-day',
              id: `${bookId}:${stat.dateKey}`,
              updatedAt: Math.max(0, Math.floor(Number(stat.lastStatisticModified) || 0)),
              data,
            });
          }
        }

        const results = this.opts.store.push(userId, deviceId, changes, now());
        for (const [i, result] of results.entries()) {
          if (result.status === 'rejected') {
            this.opts.log?.(
              `Migration import: ${changes[i].kind} ${changes[i].id} rejected: ${result.error.message}`,
            );
          } else if (result.status === 'applied') {
            if (changes[i].kind === 'position') positions += 1;
            if (changes[i].kind === 'stat-day') statDays += 1;
          }
        }
        this.db
          .prepare('UPDATE legacy_books SET imported_at = ? WHERE user_id = ? AND folder = ?')
          .run(now(), userId, row.folder);
      }
      this.db
        .prepare(
          'UPDATE migration_state SET last_import_at = ?, last_snapshot = ? WHERE user_id = ?',
        )
        .run(now(), path.basename(snapshot), userId);
      return { books: linked.length, positions, statDays, snapshot: path.basename(snapshot) };
    } finally {
      this.importing = false;
    }
  }

  /**
   * Deletes what the import wrote: every live record written by the import
   * device and every legacy-book link. With forgetDecisions the scan results
   * and the user's decisions are cleared too.
   */
  undo(userId: string, forgetDecisions = false, now = Date.now()): number {
    const deviceId = this.state(userId).import_device_id;
    if (!deviceId) return 0;
    const live = this.db
      .prepare(
        `SELECT kind, id, updated_at FROM sync_records
          WHERE user_id = ? AND deleted_at IS NULL AND kind <> 'device'
            AND (device_id = ? OR kind = 'legacy-book')`,
      )
      .all(userId, deviceId) as { kind: string; id: string; updated_at: number }[];
    const changes: SyncChange[] = live.map((r) => {
      const at = Math.max(now, r.updated_at + 1);
      return { kind: r.kind, id: r.id, updatedAt: at, deletedAt: at };
    });
    let deleted = 0;
    for (let i = 0; i < changes.length; i += 500) {
      for (const result of this.opts.store.push(userId, deviceId, changes.slice(i, i + 500), now)) {
        if (result.status === 'applied') deleted += 1;
      }
    }
    this.db.transaction(() => {
      if (forgetDecisions) {
        this.db.prepare('DELETE FROM legacy_books WHERE user_id = ?').run(userId);
      } else {
        this.db.prepare('UPDATE legacy_books SET imported_at = NULL WHERE user_id = ?').run(userId);
      }
      this.db
        .prepare('UPDATE migration_state SET last_import_at = NULL WHERE user_id = ?')
        .run(userId);
    })();
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Overview and check
  // -------------------------------------------------------------------------

  private bookSummary(userId: string, bookId: string | null): BookSummary | null {
    if (!bookId) return null;
    const book = getBookFor(this.db, { id: userId }, bookId);
    if (!book) return null;
    const { description: _d, sources: _s, ...summary } = book;
    return summary;
  }

  private view(userId: string, row: LegacyRow): LegacyBookView {
    const candidates = JSON.parse(row.candidates) as Candidate[];
    return {
      folder: row.folder,
      title: row.title,
      state: row.state,
      reason: row.reason,
      method: row.method,
      bookId: row.book_id,
      book: this.bookSummary(userId, row.book_id),
      candidates: candidates.map((c) => ({ ...c, book: this.bookSummary(userId, c.bookId) })),
      details: JSON.parse(row.details) as FolderDetails,
      scannedAt: row.scanned_at,
      decidedAt: row.decided_at,
      importedAt: row.imported_at,
    };
  }

  overview(userId: string) {
    const state = this.state(userId);
    const rows = this.rows(userId);
    const folderTitles = new Set(rows.map((r) => r.title));
    const devices = listDevices(this.db, this.opts.store, userId).filter(
      (d) => d.id !== state.import_device_id,
    );
    const reports = new Map(this.reports(userId).map((r) => [r.deviceId, r]));
    const record = (kind: string, id: string) => {
      const r = this.opts.store.getRecord(userId, kind, id);
      return r && r.deletedAt === null ? r : null;
    };
    const legacySync = record('migration', 'legacy-sync');
    const settingsSource = record('migration', 'settings-source');
    return {
      scan: this.scanStatus(),
      lastScanAt: state.last_scan_at,
      lastImportAt: state.last_import_at,
      lastSnapshot: state.last_snapshot,
      importDeviceId: state.import_device_id,
      calibreAvailable: !!this.opts.calibreDir && this.opts.indexerEnabled(),
      legacySyncEnabled: legacySync ? legacySync.data.enabled !== false : true,
      settingsSourceDeviceId:
        typeof settingsSource?.data.deviceId === 'string' ? settingsSource.data.deviceId : null,
      books: rows.map((r) => this.view(userId, r)),
      devices: devices.map((d) => {
        const report = reports.get(d.id);
        return {
          id: d.id,
          name: d.name,
          lastSeenAt: d.lastSeenAt,
          reportedAt: report?.reportedAt ?? null,
          calibreLinks: report?.data.calibreLinks.length ?? 0,
          localOnlyTitles: (report?.data.localTitles ?? [])
            .filter((t) => !folderTitles.has(t.title) && (t.hasBookmark || t.statDays > 0))
            .map((t) => t.title),
        };
      }),
    };
  }

  /** Compares the old sync's files with the new records, per linked book. */
  async check(userId: string) {
    const rows = this.rows(userId);
    const deviceNames = new Map(
      listDevices(this.db, this.opts.store, userId).map((d) => [d.id, d.name]),
    );
    const books = [];
    for (const row of rows.filter((r) => r.state === 'linked' && r.book_id)) {
      const bookId = row.book_id!;
      let folder: LegacyFolder | null = null;
      let error: string | null = null;
      try {
        folder = await readLegacyFolder(this.opts.dataRoot, row.folder);
      } catch (err) {
        error = (err as Error).message;
      }

      const oldProgress = folder?.progressFile
        ? await readLegacyProgress(this.opts.dataRoot, folder.progressFile.file)
        : null;
      const oldStats = folder?.statisticsFile
        ? await readLegacyStatistics(this.opts.dataRoot, folder.statisticsFile.file)
        : [];

      const positions = this.liveRecords(userId, 'position', bookId);
      const newest = positions.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      const newStats = this.liveRecords(userId, 'stat-day', bookId);

      const position = {
        old: oldProgress
          ? {
              charPos: Math.round(oldProgress.exploredCharCount),
              progress: clampProgress(oldProgress.progress),
              at: oldProgress.lastBookmarkModified,
            }
          : null,
        new: newest
          ? {
              charPos: Number(newest.data.charPos),
              progress: (newest.data.progress as number | null) ?? null,
              at: newest.updatedAt,
              deviceId: newest.deviceId,
              deviceName: deviceNames.get(newest.deviceId) ?? null,
            }
          : null,
        match: false,
      };
      position.match =
        (!position.old && !position.new) ||
        (!!position.old && !!position.new && position.old.charPos === position.new.charPos);

      const oldTotals = totals(oldStats.map((s) => s as unknown as Record<string, unknown>));
      const newTotals = totals(newStats.map((r) => r.data));
      const dayDiffs = diffDays(
        oldStats,
        newStats.map((r) => r.data),
      );
      const stats = {
        old: oldTotals,
        new: newTotals,
        days: dayDiffs.slice(0, 30),
        match:
          oldTotals.days === newTotals.days &&
          oldTotals.characters === newTotals.characters &&
          Math.abs(oldTotals.seconds - newTotals.seconds) <= 1 &&
          oldTotals.completed === newTotals.completed,
      };

      books.push({
        folder: row.folder,
        title: row.title,
        bookId,
        importedAt: row.imported_at,
        error,
        position,
        stats,
        positionsByDevice: positions.map((p) => ({
          deviceId: p.deviceId,
          charPos: Number(p.data.charPos),
          at: p.updatedAt,
        })),
        match: !error && position.match && stats.match,
      });
    }
    const notMigrated = rows
      .filter((r) => r.state !== 'linked')
      .map((r) => ({ folder: r.folder, title: r.title, state: r.state, reason: r.reason }));
    const audioOnOldSync = rows
      .filter((r) => {
        const d = JSON.parse(r.details) as FolderDetails;
        return d.audioBook || d.subtitles;
      })
      .map((r) => ({ folder: r.folder, title: r.title }));
    return {
      generatedAt: Date.now(),
      allMatch: books.every((b) => b.match),
      differences: books.filter((b) => !b.match).length,
      books,
      notMigrated,
      audioOnOldSync,
    };
  }

  private liveRecords(userId: string, kind: string, bookId: string) {
    return (
      this.db
        .prepare(
          `SELECT device_id, updated_at, data FROM sync_records
            WHERE user_id = ? AND kind = ? AND book_id = ? AND deleted_at IS NULL`,
        )
        .all(userId, kind, bookId) as { device_id: string; updated_at: number; data: string }[]
    ).map((r) => ({
      deviceId: r.device_id,
      updatedAt: r.updated_at,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }
}

function emptyDetails(error: string): FolderDetails {
  return {
    characters: null,
    bookFiles: 0,
    progress: null,
    stats: null,
    audioBook: false,
    subtitles: false,
    error,
  };
}

/** Stat totals as the check page compares them. */
export function totals(rows: Record<string, unknown>[]) {
  const completedDays = rows
    .filter((r) => typeof r.completedBook === 'number' && r.completedBook)
    .map((r) => String(r.dateKey))
    .sort();
  return {
    days: rows.length,
    characters: rows.reduce((n, r) => n + (Number(r.charactersRead) || 0), 0),
    seconds: rows.reduce((n, r) => n + (Number(r.readingTime) || 0), 0),
    completed: completedDays.length ? completedDays[completedDays.length - 1] : null,
  };
}

function diffDays(oldRows: LegacyStatistic[], newRows: Record<string, unknown>[]) {
  const byDay = new Map<
    string,
    { old: Record<string, unknown> | null; new: Record<string, unknown> | null }
  >();
  for (const r of oldRows)
    byDay.set(r.dateKey, { old: r as unknown as Record<string, unknown>, new: null });
  for (const r of newRows) {
    const key = String(r.dateKey);
    byDay.set(key, { old: byDay.get(key)?.old ?? null, new: r });
  }
  const out: {
    dateKey: string;
    old: { characters: number; seconds: number } | null;
    new: { characters: number; seconds: number } | null;
  }[] = [];
  const pick = (r: Record<string, unknown> | null) =>
    r ? { characters: Number(r.charactersRead) || 0, seconds: Number(r.readingTime) || 0 } : null;
  for (const [dateKey, pair] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const o = pick(pair.old);
    const n = pick(pair.new);
    if (!o || !n || o.characters !== n.characters || Math.abs(o.seconds - n.seconds) > 1) {
      out.push({ dateKey, old: o, new: n });
    }
  }
  return out;
}
