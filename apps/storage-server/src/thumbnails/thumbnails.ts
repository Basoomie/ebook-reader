/**
 * Cover thumbnails (design doc 4.2). Generated once from Calibre's cover.jpg
 * and cached on the SSD under CACHE_DIR/thumbs. Grids and collages use only
 * these.
 *
 * - Background pass: newest books first, one cover at a time by default and
 *   rate-limited, so the HDD array is never hammered. Resumable: the
 *   thumbnails table holds the state.
 * - On request: a thumbnail that isn't made yet is generated right away.
 * - Regenerated when the book's cover source changes (Calibre bumps
 *   last_modified on a cover change; verified with Calibre 7.1) or when
 *   THUMB_SPEC changes.
 *
 * Never writes anywhere but CACHE_DIR/thumbs. Covers are read through
 * calibre/source-fs (read-only).
 */
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { readSourceFile, resolveInside } from '../calibre/source-fs';

// Keep libvips light on the NAS: one worker thread, no operation cache.
sharp.concurrency(1);
sharp.cache(false);

/**
 * The thumbnail format. Changing any value means bumping `version`: every
 * thumbnail is then regenerated in the background (old ones keep being served
 * until replaced).
 */
export const THUMB_SPEC = { version: 1, width: 320, height: 480, quality: 75 } as const;

export const THUMBS_DIRNAME = 'thumbs';

export function thumbnailFile(cacheDir: string, bookId: string): string {
  return path.join(cacheDir, THUMBS_DIRNAME, bookId.slice(0, 2), `${bookId}.webp`);
}

export interface CoverSource {
  bookId: string;
  libraryFolder: string;
  calibrePath: string;
  hasCover: boolean;
  lastModified: number | null;
}

export function sourceKey(src: Pick<CoverSource, 'lastModified' | 'calibrePath' | 'hasCover'>) {
  return `${src.lastModified ?? ''}|${src.calibrePath}|${src.hasCover ? 1 : 0}`;
}

/** Short version tag for thumbnail URLs (?v=): changes whenever the thumbnail would. */
export function thumbnailVersion(key: string, spec: number = THUMB_SPEC.version): string {
  return createHash('sha1').update(`${spec}|${key}`).digest('hex').slice(0, 12);
}

/** Same as sourceKey(), in SQL, over book_sources aliased as `s`. */
const SQL_SOURCE_KEY =
  "(COALESCE(s.calibre_last_modified, '') || '|' || s.calibre_path || '|' || s.has_cover)";

const SQL_COVER_SOURCES = `
  SELECT b.id AS book_id, l.folder, s.calibre_path, s.has_cover, s.calibre_last_modified
  FROM books b
  JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre' AND s.missing_at IS NULL
  JOIN libraries l ON l.id = s.library_id AND l.enabled = 1 AND l.available = 1`;

interface CoverSourceRow {
  book_id: string;
  folder: string;
  calibre_path: string;
  has_cover: number;
  calibre_last_modified: number | null;
}

function toCoverSource(r: CoverSourceRow): CoverSource {
  return {
    bookId: r.book_id,
    libraryFolder: r.folder,
    calibrePath: r.calibre_path,
    hasCover: r.has_cover === 1,
    lastModified: r.calibre_last_modified,
  };
}

export type ThumbnailStatus = 'ok' | 'none' | 'error';

export interface ThumbnailRecord {
  bookId: string;
  status: ThumbnailStatus;
  sourceKey: string;
  spec: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  attempts: number;
  error: string | null;
  generatedAt: number;
}

interface ThumbnailRow {
  book_id: string;
  status: ThumbnailStatus;
  source_key: string;
  spec: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  attempts: number;
  error: string | null;
  generated_at: number;
}

function toRecord(r: ThumbnailRow): ThumbnailRecord {
  return {
    bookId: r.book_id,
    status: r.status,
    sourceKey: r.source_key,
    spec: r.spec,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    attempts: r.attempts,
    error: r.error,
    generatedAt: r.generated_at,
  };
}

export function getThumbnailRecord(db: Database.Database, bookId: string): ThumbnailRecord | null {
  const row = db.prepare('SELECT * FROM thumbnails WHERE book_id = ?').get(bookId) as
    | ThumbnailRow
    | undefined;
  return row ? toRecord(row) : null;
}

export type RebuildScope = { all: true } | { bookId: string } | { libraryId: string };

/** Forgets thumbnails so the background pass makes them again (files are overwritten then). */
export function forgetThumbnails(db: Database.Database, scope: RebuildScope): number {
  if ('all' in scope) return db.prepare('DELETE FROM thumbnails').run().changes;
  if ('bookId' in scope) {
    return db.prepare('DELETE FROM thumbnails WHERE book_id = ?').run(scope.bookId).changes;
  }
  return db
    .prepare('DELETE FROM thumbnails WHERE book_id IN (SELECT id FROM books WHERE library_id = ?)')
    .run(scope.libraryId).changes;
}

export interface ThumbnailServiceOptions {
  db: Database.Database;
  calibreDir: string;
  cacheDir: string;
  concurrency: number;
  /** Background rate limit; 0 = none. On-demand requests are not rate-limited. */
  perSecond: number;
  background: boolean;
  log?: (message: string) => void;
  logError?: (message: string, err: unknown) => void;
}

export interface ThumbnailResult {
  record: ThumbnailRecord;
  /** The WebP file when status is 'ok'. */
  file: string | null;
}

const BACKGROUND_BATCH = 200;

/** Position in the newest-first walk of the background pass. */
export interface PendingCursor {
  addedAt: number;
  bookId: string;
}

export class ThumbnailService {
  private readonly db: Database.Database;
  private readonly opts: ThumbnailServiceOptions;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err: unknown) => void;
  private readonly inflight = new Map<string, Promise<ThumbnailResult | null>>();
  private running = false;
  private stopped = false;
  private wakeRequested = false;
  private loop: Promise<void> | null = null;
  private nextStartAt = 0;
  /** Thumbnails made by the background pass since start (for logs and tests). */
  generated = 0;

  constructor(opts: ThumbnailServiceOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
  }

  /**
   * Books with a cover whose thumbnail is missing or out of date, newest first,
   * starting after `after` (keyset paging, so a full pass reads each book once).
   * Books without a cover need no background work: a request for one answers
   * "no cover" on the spot.
   */
  pending(limit: number, after?: PendingCursor): (CoverSource & PendingCursor)[] {
    const cursor = after ?? { addedAt: Number.MAX_SAFE_INTEGER, bookId: '￿' };
    // `books` drives the join so the scan walks books_added in order and stops at
    // `limit` matches, instead of sorting every book on each call.
    return (
      this.db
        .prepare(
          `SELECT b.id AS book_id, b.added_at, l.folder, s.calibre_path, s.has_cover,
                  s.calibre_last_modified
           FROM books b INDEXED BY books_added
           CROSS JOIN book_sources s
             ON s.book_id = b.id AND s.kind = 'calibre' AND s.missing_at IS NULL
           JOIN libraries l ON l.id = s.library_id AND l.enabled = 1 AND l.available = 1
           LEFT JOIN thumbnails t ON t.book_id = b.id
           WHERE s.has_cover = 1
             AND (b.added_at < ? OR (b.added_at = ? AND b.id < ?))
             AND (t.book_id IS NULL OR t.spec <> ? OR t.source_key <> ${SQL_SOURCE_KEY})
           ORDER BY b.added_at DESC, b.id DESC LIMIT ?`,
        )
        .all(
          cursor.addedAt,
          cursor.addedAt,
          cursor.bookId,
          THUMB_SPEC.version,
          limit,
        ) as (CoverSourceRow & { added_at: number })[]
    ).map((r) => ({ ...toCoverSource(r), addedAt: r.added_at }));
  }

  coverSource(bookId: string): CoverSource | null {
    const row = this.db.prepare(`${SQL_COVER_SOURCES} WHERE b.id = ?`).get(bookId) as
      | CoverSourceRow
      | undefined;
    return row ? toCoverSource(row) : null;
  }

  /**
   * The current thumbnail for a book, generating it first if needed.
   * null when the book is unknown, missing, or in a disabled library.
   */
  async ensure(bookId: string): Promise<ThumbnailResult | null> {
    const src = this.coverSource(bookId);
    if (!src) return null;
    const record = getThumbnailRecord(this.db, bookId);
    if (record && record.spec === THUMB_SPEC.version && record.sourceKey === sourceKey(src)) {
      if (record.status !== 'ok') return { record, file: null };
      const file = thumbnailFile(this.opts.cacheDir, bookId);
      if (await fileExists(file)) return { record, file };
      // The cache was cleared: make it again.
    }
    return this.generateOnce(src);
  }

  private generateOnce(src: CoverSource): Promise<ThumbnailResult | null> {
    const existing = this.inflight.get(src.bookId);
    if (existing) return existing;
    const p = this.generate(src).finally(() => this.inflight.delete(src.bookId));
    this.inflight.set(src.bookId, p);
    return p;
  }

  /** Reads the cover, writes the WebP and records the outcome. Never throws for a bad cover. */
  async generate(src: CoverSource): Promise<ThumbnailResult> {
    const key = sourceKey(src);
    const now = Date.now();
    const previous = getThumbnailRecord(this.db, src.bookId);
    let record: ThumbnailRecord;
    let file: string | null = null;

    if (!src.hasCover) {
      record = this.save(src.bookId, { status: 'none', key, now, attempts: 0 });
    } else {
      try {
        const libraryDir = path.join(this.opts.calibreDir, src.libraryFolder);
        const cover = resolveInside(libraryDir, `${src.calibrePath}/cover.jpg`);
        const input = await readSourceFile(cover);
        const { data, info } = await sharp(input, { failOn: 'error' })
          .rotate()
          .resize({
            width: THUMB_SPEC.width,
            height: THUMB_SPEC.height,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: THUMB_SPEC.quality })
          .toBuffer({ resolveWithObject: true });
        file = thumbnailFile(this.opts.cacheDir, src.bookId);
        await writeAtomic(file, data);
        record = this.save(src.bookId, {
          status: 'ok',
          key,
          now,
          attempts: 0,
          width: info.width,
          height: info.height,
          bytes: data.length,
        });
      } catch (err) {
        const message =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'cover.jpg is missing although Calibre lists a cover'
            : `cover could not be read: ${(err as Error).message}`;
        record = this.save(src.bookId, {
          status: 'error',
          key,
          now,
          attempts: (previous?.sourceKey === key ? previous.attempts : 0) + 1,
          error: message,
        });
        file = null;
      }
    }
    return { record, file };
  }

  private save(
    bookId: string,
    v: {
      status: ThumbnailStatus;
      key: string;
      now: number;
      attempts: number;
      width?: number;
      height?: number;
      bytes?: number;
      error?: string;
    },
  ): ThumbnailRecord {
    this.db
      .prepare(
        `INSERT INTO thumbnails (book_id, status, source_key, spec, width, height, bytes,
           attempts, error, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET status = excluded.status,
           source_key = excluded.source_key, spec = excluded.spec, width = excluded.width,
           height = excluded.height, bytes = excluded.bytes, attempts = excluded.attempts,
           error = excluded.error, generated_at = excluded.generated_at`,
      )
      .run(
        bookId,
        v.status,
        v.key,
        THUMB_SPEC.version,
        v.width ?? null,
        v.height ?? null,
        v.bytes ?? null,
        v.attempts,
        v.error ?? null,
        v.now,
      );
    return getThumbnailRecord(this.db, bookId)!;
  }

  /** Starts (or nudges) the background pass. Cheap to call often. */
  wake(): void {
    if (!this.opts.background || this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    this.loop = this.runBackground()
      .catch((err) => this.logError('Thumbnails: background pass failed:', err))
      .finally(() => {
        this.running = false;
        if (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          this.wake();
        }
      });
  }

  /** Resolves when the current background pass (if any) has finished. */
  async idle(): Promise<void> {
    while (this.loop) {
      const current = this.loop;
      await current;
      if (this.loop === current) break;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async waitForSlot(): Promise<void> {
    const perSecond = this.opts.perSecond;
    if (perSecond <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextStartAt);
    this.nextStartAt = start + 1000 / perSecond;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  }

  private async runBackground(): Promise<void> {
    let made = 0;
    const started = Date.now();
    let cursor: PendingCursor | undefined;
    while (!this.stopped) {
      const batch = this.pending(BACKGROUND_BATCH, cursor);
      if (batch.length === 0) break;
      const last = batch[batch.length - 1];
      cursor = { addedAt: last.addedAt, bookId: last.bookId };
      const before = this.generated;
      const queue = [...batch];
      const workers = Array.from({ length: this.opts.concurrency }, async () => {
        while (!this.stopped) {
          const src = queue.shift();
          if (!src) return;
          await this.waitForSlot();
          if (this.stopped) return;
          await this.generateOnce(src);
          this.generated++;
          made++;
        }
      });
      await Promise.all(workers);
      // A batch that made no progress (every write failed) must not spin.
      if (this.generated === before) break;
    }
    if (made > 0) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log(`Thumbnails: made ${made} in ${secs} s`);
    }
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
