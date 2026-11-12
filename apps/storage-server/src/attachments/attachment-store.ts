/**
 * Book attachments (WP15c): files that belong to one book of one user and are too large
 * for a sync record (64 KB): whispersync's saved subtitles and saved match. Stored in the
 * reader's data folder (appdata, backed up), only below DATA_DIR/.uploads/attachments:
 *
 *   .uploads/attachments/<random>.tmp                     a file being received
 *   .uploads/attachments/<userId>/<bookId>/<name>.bin     the stored file (replaced in place)
 *
 * Never writes anywhere else; never touches Calibre or the audiobooks folder. Refuses
 * folders that are symbolic links. Created by the first upload.
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

export const ATTACHMENTS_DIRNAME = 'attachments';
/** The attachments a book can have. */
export const ATTACHMENT_NAMES = ['whispersync-subtitles', 'whispersync-match'] as const;
export type AttachmentName = (typeof ATTACHMENT_NAMES)[number];

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMP_RE = /^[0-9a-f]{16}\.tmp$/;

export class AttachmentTooLargeError extends Error {}

export interface ReceivedAttachment {
  tmp: string;
  size: number;
  sha256: string;
}

export function isAttachmentName(value: string): value is AttachmentName {
  return (ATTACHMENT_NAMES as readonly string[]).includes(value);
}

export class AttachmentStore {
  readonly uploadsRoot: string;
  readonly root: string;

  constructor(dataRoot: string) {
    this.uploadsRoot = path.join(path.resolve(dataRoot), UPLOADS_DIRNAME);
    this.root = path.join(this.uploadsRoot, ATTACHMENTS_DIRNAME);
  }

  /** Checks the folders that exist and removes temp files a stopped server left. Creates nothing. */
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

  /** Stored path (relative to .uploads/attachments) of a book's attachment. */
  static attachmentPath(userId: string, bookId: string, name: AttachmentName): string {
    if (!ID_RE.test(userId) || !ID_RE.test(bookId) || !isAttachmentName(name)) {
      throw new Error('Invalid attachment path');
    }
    return `${userId}/${bookId}/${name}.bin`;
  }

  resolve(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep)) {
      throw new Error('Path outside the attachment folder');
    }
    return resolved;
  }

  /** Streams a body to a temp file (fsynced), hashing it. Throws past `maxBytes`. */
  async receive(body: NodeJS.ReadableStream, maxBytes: number): Promise<ReceivedAttachment> {
    this.checkDirs(true);
    const tmp = path.join(this.root, `${randomBytes(8).toString('hex')}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) {
          done(new AttachmentTooLargeError(`The file is larger than ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx' }));
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
    return { tmp, size, sha256: hash.digest('hex') };
  }

  /** Puts a received file in place (replacing the previous one atomically). */
  async commit(received: ReceivedAttachment, relative: string): Promise<void> {
    const target = this.resolve(relative);
    this.checkDirs(true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(received.tmp, target);
  }

  async discard(received: ReceivedAttachment): Promise<void> {
    await fs.unlink(received.tmp).catch(() => {});
  }

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
