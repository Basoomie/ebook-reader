/**
 * WP17: voice preset clips, stored like fonts and uploaded books in the reader's data
 * folder (decided 2026-11-12), only below DATA_DIR/.uploads/voices:
 *
 *   .uploads/voices/<random>.tmp        a clip being received or converted (removed on
 *                                       failure and when the server starts)
 *   .uploads/voices/<voiceId>/clip.wav  a preset's reference clip (48 kHz mono WAV)
 *
 * Created by the first voice; refuses folders that are symbolic links. Never writes
 * anywhere else; never touches Calibre or the audiobooks folder.
 */
import { createHash, randomBytes } from 'crypto';
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import type { ReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { UPLOADS_DIRNAME } from '../uploads/upload-store';

export const VOICES_DIRNAME = 'voices';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMP_RE = /^[0-9a-f]{16}(\.[a-z0-9]+)?\.tmp$/;

export class ClipTooLargeError extends Error {}

export class VoiceStore {
  readonly uploadsRoot: string;
  readonly root: string;

  constructor(dataRoot: string) {
    this.uploadsRoot = path.join(path.resolve(dataRoot), UPLOADS_DIRNAME);
    this.root = path.join(this.uploadsRoot, VOICES_DIRNAME);
  }

  /** Checks the folders that exist and removes leftover temp files. Creates nothing. */
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

  static clipPath(voiceId: string): string {
    if (!ID_RE.test(voiceId)) throw new Error('Invalid voice id');
    return `${voiceId}/clip.wav`;
  }

  resolve(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep))
      throw new Error('Path outside the voice folder');
    return resolved;
  }

  /** A new temp file name in the voice folder (`ext` e.g. 'wav'). */
  tempPath(ext = ''): string {
    this.checkDirs(true);
    return path.join(this.root, `${randomBytes(8).toString('hex')}${ext ? `.${ext}` : ''}.tmp`);
  }

  /** Streams an upload to a temp file; throws ClipTooLargeError past `maxBytes`. */
  async receive(body: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
    const tmp = this.tempPath();
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) {
          done(new ClipTooLargeError(`The file is larger than ${maxBytes} bytes`));
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return tmp;
  }

  /** Moves a finished WAV (a temp file of this store) into the voice's folder. */
  async commit(
    tmpWav: string,
    voiceId: string,
  ): Promise<{ relative: string; size: number; sha256: string }> {
    const tmp = path.resolve(tmpWav);
    if (path.dirname(tmp) !== this.root || !TMP_RE.test(path.basename(tmp))) {
      throw new Error('Not a temp file of the voice folder');
    }
    const relative = VoiceStore.clipPath(voiceId);
    const target = this.resolve(relative);
    const handle = await fs.open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(tmp), hash);
    const size = (await fs.stat(tmp)).size;
    await fs.mkdir(path.dirname(target));
    await fs.rename(tmp, target);
    return { relative, size, sha256: hash.digest('hex') };
  }

  /** Removes a voice's folder (its clip). */
  async remove(voiceId: string): Promise<void> {
    const dir = path.dirname(this.resolve(VoiceStore.clipPath(voiceId)));
    await fs.rm(dir, { recursive: true, force: true });
  }

  async discard(tmp: string): Promise<void> {
    if (path.dirname(path.resolve(tmp)) !== this.root) return;
    await fs.unlink(tmp).catch(() => {});
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
