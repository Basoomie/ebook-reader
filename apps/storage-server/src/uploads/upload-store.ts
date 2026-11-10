/**
 * Uploaded EPUB files (WP7b). The ONLY new-code module that writes into DATA_DIR,
 * and only below DATA_DIR/.uploads:
 *
 *   .uploads/staging/<uploadId>.epub   a file waiting for the user's decision
 *   .uploads/books/<bookId>/book.epub  an uploaded book in the catalog
 *
 * Why a dot-folder holding only subfolders: the WP5 migration scan skips
 * dot-folders (legacy-fs.listLegacyFolders), and the old sync's book list ignores a
 * folder with no files directly inside it, so neither sees uploads.
 *
 * Never writes outside `.uploads`, which is created by the first upload (a server
 * nobody uploads to leaves DATA_DIR as it is); refuses a `.uploads` (or a subfolder)
 * that is a symbolic link. Calibre libraries are never touched (decided: uploads stay in the
 * reader's data folder in appdata).
 */
import { createHash, randomBytes } from 'crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  ReadStream,
} from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

export const UPLOADS_DIRNAME = '.uploads';
const STAGING = 'staging';
const BOOKS = 'books';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class UploadTooLargeError extends Error {}

export interface StagedFile {
  file: string;
  size: number;
  sha256: string;
}

export class UploadStore {
  /** Absolute path of DATA_DIR/.uploads. */
  readonly root: string;

  constructor(dataRoot: string) {
    this.root = path.join(path.resolve(dataRoot), UPLOADS_DIRNAME);
  }

  /**
   * Checks the folders that exist. Throws when one is a symbolic link or not a folder.
   * Nothing is created here: `.uploads` appears in DATA_DIR with the first upload.
   */
  init(): void {
    this.checkDirs(false);
  }

  /** Checks (and with `create`, makes) .uploads and its two subfolders. */
  private checkDirs(create: boolean): void {
    for (const dir of [this.root, path.join(this.root, STAGING), path.join(this.root, BOOKS)]) {
      let st;
      try {
        st = lstatSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) return;
        mkdirSync(dir);
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`${dir} must be a plain folder (not a link or a file)`);
      }
    }
  }

  stagingFile(uploadId: string): string {
    if (!ID_RE.test(uploadId)) throw new Error('Invalid upload id');
    return path.join(this.root, STAGING, `${uploadId}.epub`);
  }

  /** The stored path (relative to .uploads, forward slashes) of an uploaded book's file. */
  static bookPath(bookId: string): string {
    if (!ID_RE.test(bookId)) throw new Error('Invalid book id');
    return `${BOOKS}/${bookId}/book.epub`;
  }

  /** Absolute path of a stored relative path; throws when it would leave .uploads. */
  resolve(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error('Path outside .uploads');
    return resolved;
  }

  /**
   * Streams a request body to staging (temp file, fsync, rename), hashing it on the
   * way. Throws UploadTooLargeError past `maxBytes` (the partial file is removed).
   */
  async stage(
    uploadId: string,
    body: NodeJS.ReadableStream,
    maxBytes: number,
  ): Promise<StagedFile> {
    const file = this.stagingFile(uploadId);
    this.checkDirs(true);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) {
          done(new UploadTooLargeError(`The file is larger than ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      const out = createWriteStream(tmp, { flags: 'wx' });
      await pipeline(body, meter, out);
      const handle = await fs.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return { file, size, sha256: hash.digest('hex') };
  }

  /** Moves a staged file to its book folder; returns the stored relative path. */
  async commit(uploadId: string, bookId: string): Promise<string> {
    const relative = UploadStore.bookPath(bookId);
    const target = this.resolve(relative);
    this.checkDirs(true);
    await fs.mkdir(path.dirname(target));
    await fs.rename(this.stagingFile(uploadId), target);
    return relative;
  }

  /** Undoes commit() (the catalog write failed). */
  async uncommit(uploadId: string, bookId: string): Promise<void> {
    const target = this.resolve(UploadStore.bookPath(bookId));
    await fs.rename(target, this.stagingFile(uploadId)).catch(() => {});
    await fs.rmdir(path.dirname(target)).catch(() => {});
  }

  /** Deletes a staged file (no error when it is already gone). */
  async discard(uploadId: string): Promise<void> {
    await fs.unlink(this.stagingFile(uploadId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  /** Deletes staged files (and leftover temp files) older than `maxAgeMs`; returns how many. */
  async sweep(maxAgeMs: number, now = Date.now()): Promise<number> {
    const dir = path.join(this.root, STAGING);
    let removed = 0;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = await fs.lstat(file);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs >= maxAgeMs) {
          await fs.unlink(file);
          removed++;
        }
      } catch {
        // Gone in the meantime.
      }
    }
    return removed;
  }

  /** Names of the staged files (for the CLI). */
  async listStaged(): Promise<{ name: string; size: number; mtimeMs: number }[]> {
    const dir = path.join(this.root, STAGING);
    const out: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const st = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  // --- read-only access (file route, counts, thumbnails, duplicate check) ---

  /** Read-only file handle (flag 'r'); the opener for zip-read / fingerprints. */
  openFile = (file: string): Promise<fs.FileHandle> => fs.open(file, constants.O_RDONLY);

  /** Opens a stored file for streaming; resolves once open (a missing file rejects first). */
  openStream(relative: string): Promise<ReadStream> {
    const file = this.resolve(relative);
    return new Promise((resolve, reject) => {
      const stream = createReadStream(file, { flags: 'r' });
      stream.once('open', () => resolve(stream));
      stream.once('error', reject);
    });
  }

  async stat(relative: string): Promise<{ size: number } | null> {
    try {
      const st = await fs.stat(this.resolve(relative));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }
}
