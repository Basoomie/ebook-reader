/**
 * Custom font files (WP13), stored like uploaded books in the reader's data folder
 * (decided 2026-11-10), only below DATA_DIR/.uploads/fonts:
 *
 *   .uploads/fonts/<random>.tmp          a font being received (removed on failure
 *                                        and when the server starts)
 *   .uploads/fonts/<fontId>/font.<ext>   a stored font
 *
 * `.uploads` keeps holding only subfolders, so the WP5 migration scan (skips
 * dot-folders) and the old sync's book list (ignores folders without files) never see
 * fonts. Created by the first font upload; refuses folders that are symbolic links.
 * Never writes anywhere else, never touches Calibre. Fonts don't depend on Calibre or
 * on the book upload adapter.
 */
import { createHash, randomBytes } from 'crypto';
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  ReadStream,
  unlinkSync,
} from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { UPLOADS_DIRNAME } from '../uploads/upload-store';
import { FONT_SNIFF_BYTES, type FontFormat, sniffFontFormat } from './font-format';

export const FONTS_DIRNAME = 'fonts';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMP_RE = /^[0-9a-f]{16}\.tmp$/;

export class FontTooLargeError extends Error {}
export class NotAFontError extends Error {}

export interface ReceivedFont {
  /** Absolute path of the temp file; pass to commit() or discard(). */
  tmp: string;
  size: number;
  sha256: string;
  format: FontFormat;
}

export class FontStore {
  /** Absolute path of DATA_DIR/.uploads. */
  readonly uploadsRoot: string;
  /** Absolute path of DATA_DIR/.uploads/fonts. */
  readonly root: string;

  constructor(dataRoot: string) {
    this.uploadsRoot = path.join(path.resolve(dataRoot), UPLOADS_DIRNAME);
    this.root = path.join(this.uploadsRoot, FONTS_DIRNAME);
  }

  /**
   * Checks the folders that exist (throws when one is a link or not a folder) and
   * removes temp files a stopped server left behind. Creates nothing.
   */
  init(): void {
    if (!this.checkDirs(false)) return;
    for (const name of readdirSync(this.root)) {
      if (!TMP_RE.test(name)) continue;
      try {
        unlinkSync(path.join(this.root, name));
      } catch {
        // Gone in the meantime.
      }
    }
  }

  /** Checks (and with `create`, makes) .uploads and .uploads/fonts. True when both exist. */
  private checkDirs(create: boolean): boolean {
    for (const dir of [this.uploadsRoot, this.root]) {
      let st;
      try {
        st = lstatSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) return false;
        mkdirSync(dir);
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`${dir} must be a plain folder (not a link or a file)`);
      }
    }
    return true;
  }

  /** The stored path (relative to .uploads/fonts, forward slashes) of a font file. */
  static fontPath(fontId: string, format: FontFormat): string {
    if (!ID_RE.test(fontId)) throw new Error('Invalid font id');
    return `${fontId}/font.${format}`;
  }

  /** Absolute path of a stored relative path; throws when it would leave .uploads/fonts. */
  resolve(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error('Path outside the font folder');
    return resolved;
  }

  /**
   * Streams a request body to a temp file (fsynced), hashing it and reading its
   * format on the way. Throws FontTooLargeError past `maxBytes` and NotAFontError when
   * the first bytes are not a font's; the temp file is removed in both cases.
   */
  async receive(body: NodeJS.ReadableStream, maxBytes: number): Promise<ReceivedFont> {
    this.checkDirs(true);
    const tmp = path.join(this.root, `${randomBytes(8).toString('hex')}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let format: FontFormat | null = null;
    let notAFont = false;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) {
          done(new FontTooLargeError(`The file is larger than ${maxBytes} bytes`));
          return;
        }
        if (head.length < FONT_SNIFF_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, FONT_SNIFF_BYTES - head.length)]);
          if (head.length >= FONT_SNIFF_BYTES) {
            format = sniffFontFormat(head);
            notAFont = !format;
          }
        }
        // Not a font: the rest is read and dropped, so the client gets an answer
        // instead of a reset connection.
        if (notAFont) {
          done();
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      const out = createWriteStream(tmp, { flags: 'wx' });
      await pipeline(body, meter, out);
      if (!format) throw new NotAFontError('not a font file');
      const handle = await fs.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return { tmp, size, sha256: hash.digest('hex'), format: format as FontFormat };
  }

  /** Moves a received font to its own folder; returns the stored relative path. */
  async commit(received: ReceivedFont, fontId: string): Promise<string> {
    const relative = FontStore.fontPath(fontId, received.format);
    const target = this.resolve(relative);
    this.checkDirs(true);
    await fs.mkdir(path.dirname(target));
    await fs.rename(received.tmp, target);
    return relative;
  }

  /** Undoes commit() (the database write failed): the file and its folder go. */
  async uncommit(relative: string): Promise<void> {
    const target = this.resolve(relative);
    await fs.unlink(target).catch(() => {});
    await fs.rmdir(path.dirname(target)).catch(() => {});
  }

  /** Deletes a received temp file (no error when it is already gone). */
  async discard(received: ReceivedFont): Promise<void> {
    await fs.unlink(received.tmp).catch(() => {});
  }

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
