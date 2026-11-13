/**
 * WP17: the work folder of generated audiobooks, CACHE_DIR/tts/<job>/: the book's text for
 * the job (script.json), the chapters the PC uploaded (part-NNNN.flac), ffmpeg's lists and
 * the finished m4b before it is saved. Never the audiobooks folder: only audio-write.ts
 * writes there. Every path is checked to be inside the work folder, which must not overlap
 * the audiobooks folder. (Like merge-workdir.ts; the static writer test allows both.)
 */
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { isInside } from '../db/database';

export class TooLargeError extends Error {}

export class TtsWorkdir {
  readonly root: string;

  constructor(cacheDir: string, audiobooksRoot: string) {
    this.root = path.resolve(cacheDir, 'tts');
    const audio = path.resolve(audiobooksRoot);
    if (isInside(audio, this.root) || isInside(this.root, audio)) {
      throw new Error(
        `The TTS work folder (${this.root}) and the audiobooks folder (${audio}) overlap`,
      );
    }
  }

  jobDir(id: number): string {
    if (!Number.isInteger(id) || id < 1) throw new Error('Bad job id');
    return path.join(this.root, String(id));
  }

  file(id: number, name: string): string {
    if (!/^[\w][\w.-]*$/.test(name)) throw new Error('Bad file name');
    return path.join(this.jobDir(id), name);
  }

  async ensure(id?: number): Promise<void> {
    await fs.mkdir(id === undefined ? this.root : this.jobDir(id), { recursive: true });
  }

  async writeText(id: number, name: string, text: string): Promise<string> {
    await this.ensure(id);
    const file = this.file(id, name);
    await fs.writeFile(file, text, 'utf8');
    return file;
  }

  /** Streams a body into `name` (replacing an earlier partial upload); removed on failure. */
  async receive(
    id: number,
    name: string,
    body: NodeJS.ReadableStream,
    maxBytes: number,
  ): Promise<number> {
    await this.ensure(id);
    const file = this.file(id, name);
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) done(new TooLargeError(`larger than ${maxBytes} bytes`));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(file, { flags: 'w' }));
    } catch (err) {
      await fs.unlink(file).catch(() => undefined);
      throw err;
    }
    return size;
  }

  async promote(id: number, from: string, to: string): Promise<void> {
    await fs.rename(this.file(id, from), this.file(id, to));
  }

  async remove(id: number, name: string): Promise<void> {
    await fs.unlink(this.file(id, name)).catch(() => undefined);
  }

  async removeJob(id: number): Promise<void> {
    await fs.rm(this.jobDir(id), { recursive: true, force: true });
  }

  /** Job ids with a folder here. */
  async jobIds(): Promise<number[]> {
    try {
      return (await fs.readdir(this.root)).filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      return [];
    }
  }
}
