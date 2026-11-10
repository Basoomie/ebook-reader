/**
 * Uploads (WP7b): a separate source adapter. An upload is staged, checked for
 * duplicates, and then either added as its own book ("Add as a separate book", or no
 * duplicate) or discarded ("Use the library copy", "Cancel"). The user always decides;
 * nothing is merged automatically.
 *
 * Pending uploads live in memory (single server process). After a restart they are
 * gone (the client asks to upload again) and their staged files are swept.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { UploadConfig } from '../config';
import { addUploadedBook } from './catalog-write';
import { type DuplicateHit, findDuplicates } from './duplicates';
import { readEpubMeta, type EpubMeta } from './epub-meta';
import { type StagedFile, UploadStore, UploadTooLargeError } from './upload-store';

export interface PendingUpload {
  id: string;
  userId: string;
  libraryId: string;
  staged: StagedFile;
  meta: EpubMeta;
  createdAt: number;
  /** Set once added (add is idempotent). */
  bookId: string | null;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface UploadServiceOptions {
  db: Database.Database;
  store: UploadStore;
  config: UploadConfig;
  /** Root of the Calibre libraries (read-only), for fingerprinting candidates. */
  calibreDir: string | null;
  /** Called after a book was added (wakes thumbnails and counts). */
  onAdded?: (bookId: string) => void;
  log?: (message: string) => void;
  logError?: (message: string, err: unknown) => void;
}

const HOUR = 3600_000;

export class UploadService {
  readonly store: UploadStore;
  readonly maxBytes: number;
  private readonly pending = new Map<string, PendingUpload>();
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err: unknown) => void;

  constructor(private readonly opts: UploadServiceOptions) {
    this.store = opts.store;
    this.maxBytes = Math.round(opts.config.maxMb * 1024 * 1024);
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
  }

  private get maxAgeMs(): number {
    return this.opts.config.stagedHours * HOUR;
  }

  /** Sweeps once now and then every hour. */
  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), HOUR);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = Date.now()): Promise<number> {
    for (const [id, p] of this.pending) {
      if (now - p.createdAt >= this.maxAgeMs) this.pending.delete(id);
    }
    try {
      const removed = await this.store.sweep(this.maxAgeMs, now);
      if (removed) this.log(`Uploads: removed ${removed} staged file(s) nobody decided on`);
      return removed;
    } catch (err) {
      this.logError('Uploads: could not clean up staged files', err);
      return 0;
    }
  }

  /** The library an upload may go to; throws UploadError otherwise. */
  checkLibrary(libraryId: string): void {
    const lib = this.opts.db
      .prepare('SELECT enabled FROM libraries WHERE id = ?')
      .get(libraryId) as { enabled: number } | undefined;
    if (!lib) throw new UploadError(404, 'library_not_found', 'No such library');
    if (lib.enabled !== 1) {
      throw new UploadError(409, 'library_disabled', 'That library is switched off');
    }
  }

  /** Stages a request body and checks it. Throws UploadError (and removes the file) on failure. */
  async stage(
    userId: string,
    libraryId: string,
    fileName: string,
    body: NodeJS.ReadableStream,
  ): Promise<{ upload: PendingUpload; duplicates: DuplicateHit[] }> {
    this.checkLibrary(libraryId);
    const id = randomUUID();
    let staged: StagedFile;
    try {
      staged = await this.store.stage(id, body, this.maxBytes);
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        throw new UploadError(
          413,
          'too_large',
          `The file is larger than ${this.opts.config.maxMb} MB`,
        );
      }
      throw err;
    }
    if (staged.size === 0) {
      await this.store.discard(id);
      throw new UploadError(422, 'bad_epub', 'The file is empty');
    }
    const fallbackTitle = fileName.replace(/\.epub$/i, '').trim() || 'Untitled';
    let meta: EpubMeta;
    try {
      meta = await readEpubMeta(staged.file, this.store.openFile, fallbackTitle);
    } catch (err) {
      await this.store.discard(id);
      throw new UploadError(
        422,
        'bad_epub',
        `This file can't be read as an EPUB: ${(err as Error).message}`,
      );
    }
    let duplicates: DuplicateHit[];
    try {
      duplicates = await findDuplicates(
        { file: staged.file, sha256: staged.sha256, title: meta.title, authors: meta.authors },
        {
          db: this.opts.db,
          store: this.store,
          calibreDir: this.opts.calibreDir,
          logError: this.logError,
        },
      );
    } catch (err) {
      await this.store.discard(id);
      throw err;
    }
    const upload: PendingUpload = {
      id,
      userId,
      libraryId,
      staged,
      meta,
      createdAt: Date.now(),
      bookId: null,
    };
    this.pending.set(id, upload);
    return { upload, duplicates };
  }

  private own(userId: string, uploadId: string): PendingUpload | null {
    const p = this.pending.get(uploadId);
    return p && p.userId === userId ? p : null;
  }

  /** Adds a staged upload as its own book. Idempotent: a repeated call answers the same book. */
  async add(userId: string, uploadId: string): Promise<string> {
    const p = this.own(userId, uploadId);
    if (!p) {
      throw new UploadError(
        404,
        'upload_expired',
        'This upload is no longer waiting; upload it again',
      );
    }
    if (p.bookId) return p.bookId;
    this.checkLibrary(p.libraryId);
    const bookId = randomUUID();
    const filePath = await this.store.commit(p.id, bookId);
    try {
      addUploadedBook(this.opts.db, {
        bookId,
        libraryId: p.libraryId,
        title: p.meta.title,
        authors: p.meta.authors,
        series: p.meta.series,
        filePath,
        fileSize: p.staged.size,
        sha256: p.staged.sha256,
        hasCover: p.meta.coverEntry !== null,
        now: Date.now(),
      });
    } catch (err) {
      await this.store.uncommit(p.id, bookId);
      throw err;
    }
    p.bookId = bookId;
    this.log(`Uploads: added "${p.meta.title}" (${bookId})`);
    try {
      this.opts.onAdded?.(bookId);
    } catch (err) {
      this.logError('Uploads: follow-up work failed', err);
    }
    return bookId;
  }

  /** Deletes a staged upload ("Use the library copy" or "Cancel"). Unknown ids are fine. */
  async discard(userId: string, uploadId: string): Promise<void> {
    const p = this.own(userId, uploadId);
    if (!p) return;
    if (p.bookId) {
      throw new UploadError(409, 'already_added', 'This upload was already added as a book');
    }
    await this.store.discard(p.id);
    this.pending.delete(p.id);
  }

  /** For tests and the CLI. */
  pendingCount(): number {
    return this.pending.size;
  }
}
