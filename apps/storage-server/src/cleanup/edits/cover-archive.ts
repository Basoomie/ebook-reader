/**
 * The cover archive (docs/design/book-covers.md): every picture a book's cover had before it was
 * replaced, kept by the server itself so any of them can be put back.
 *
 * - Files: DB_DIR/covers/<sha256>.<jpg|png|webp|gif> (one file per distinct picture, written once
 *   and never changed or deleted by the app). DB_DIR is the server's lasting folder, beside
 *   ttsu.db and cleanup.db; the cache folder is regenerable and not backed up.
 * - Rows: cleanup.db `cover_archive`, one per book, picture and reason it was kept (re-keyed with
 *   the book by move/rekey.ts).
 *
 * Kept: Calibre's picture before any cover write (the user's edits, Undo, the cleanup's stages 2
 * and 4), the picture a cover change made by the user's edit or in Calibre's own program left
 * (the index sees it), and the earlier pictures the apply sidecar kept in its quarantine
 * (`cli covers import-quarantine`, once).
 */
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { imageFacts } from '../file-metadata';
import { hammingHex } from '../stage2-rules';
import { pictureType } from './edits';

export type ArchiveSource = 'before' | 'seen' | 'quarantine';

export interface ArchivedCover {
  sha256: string;
  width: number | null;
  height: number | null;
  bytes: number;
  dhash: string | null;
  /** When the picture was first and last kept for this book. */
  firstAt: number;
  lastAt: number;
}

export interface ArchiveBook {
  libraryId: string;
  uuid: string;
  calibreId: number;
}

export class CoverArchive {
  constructor(
    private readonly db: Database.Database,
    private readonly dir: string,
  ) {}

  /** Where a kept picture is, or null when the archive doesn't have it. */
  file(sha256: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const f = path.join(this.dir, `${sha256}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /**
   * Keeps a picture for a book (written once per distinct picture, checked by SHA-256 after the
   * write). The same picture kept again for the same book and reason only updates nothing.
   * Throws when the picture can't be written: the caller then doesn't replace the cover.
   */
  async keep(
    book: ArchiveBook,
    bytes: Buffer,
    source: ArchiveSource,
    changeId: number | null,
    now = Date.now(),
  ): Promise<string> {
    if (bytes.length === 0) throw new Error('The picture is empty');
    const ext = pictureType(bytes);
    if (!ext) throw new Error('Not a picture (JPEG, PNG, WebP or GIF)');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!this.file(sha256)) {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const final = path.join(this.dir, `${sha256}.${ext}`);
      const tmp = path.join(this.dir, `.${sha256}.${randomBytes(4).toString('hex')}.part`);
      await fs.promises.writeFile(tmp, bytes, { flag: 'wx' });
      try {
        const back = await fs.promises.readFile(tmp);
        if (createHash('sha256').update(back).digest('hex') !== sha256)
          throw new Error('The kept picture does not read back the same');
        await fs.promises.rename(tmp, final);
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    }
    const facts = await imageFacts(bytes);
    this.db
      .prepare(
        `INSERT INTO cover_archive (library_id, calibre_uuid, calibre_id, sha256, ext, width, height,
           bytes, dhash, source, change_id, kept_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (library_id, calibre_uuid, sha256, source, change_id) DO NOTHING`,
      )
      .run(
        book.libraryId,
        book.uuid,
        book.calibreId,
        sha256,
        ext,
        facts?.width ?? null,
        facts?.height ?? null,
        bytes.length,
        facts?.dhash ?? null,
        source,
        changeId ?? 0,
        now,
      );
    return sha256;
  }

  /** The picture kept before a write (by the write's change id), or null. */
  keptBefore(changeId: number): string | null {
    const r = this.db
      .prepare(
        `SELECT sha256 FROM cover_archive WHERE change_id = ? AND source IN ('before', 'quarantine')
         ORDER BY kept_at LIMIT 1`,
      )
      .get(changeId) as { sha256: string } | undefined;
    return r && this.file(r.sha256) ? r.sha256 : null;
  }

  /** Whether the book has this picture in the archive. */
  has(book: { libraryId: string; uuid: string }, sha256: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM cover_archive WHERE library_id = ? AND calibre_uuid = ? AND sha256 = ? LIMIT 1',
        )
        .get(book.libraryId, book.uuid, sha256) !== undefined && this.file(sha256) !== null
    );
  }

  /** Every picture the book's cover has had (that the archive keeps), oldest first. */
  list(book: { libraryId: string; uuid: string }): ArchivedCover[] {
    const rows = this.db
      .prepare(
        `SELECT sha256, MAX(width) AS width, MAX(height) AS height, MAX(bytes) AS bytes,
                MAX(dhash) AS dhash, MIN(kept_at) AS first_at, MAX(kept_at) AS last_at
         FROM cover_archive WHERE library_id = ? AND calibre_uuid = ?
         GROUP BY sha256 ORDER BY first_at, sha256`,
      )
      .all(book.libraryId, book.uuid) as {
      sha256: string;
      width: number | null;
      height: number | null;
      bytes: number;
      dhash: string | null;
      first_at: number;
      last_at: number;
    }[];
    return rows
      .filter((r) => this.file(r.sha256) !== null)
      .map((r) => ({
        sha256: r.sha256,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        dhash: r.dhash,
        firstAt: r.first_at,
        lastAt: r.last_at,
      }));
  }
}

/** Whether two pictures are the same by their difference hashes (stage 4's rule and setting). */
export function samePicture(a: string | null, b: string | null, maxDistance: number): boolean {
  const d = hammingHex(a, b);
  return d !== null && d <= maxDistance;
}

/** The archive's folder under DB_DIR. */
export function coverArchiveDir(dbDir: string): string {
  return path.join(dbDir, 'covers');
}
