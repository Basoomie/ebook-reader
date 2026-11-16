/**
 * Season 2 Phase 12 session 3: the work folder of live read-aloud, CACHE_DIR/tts-live/<session>/:
 * the batches the PC uploaded (b-<seq>.flac) and their MP3s for the device (b-<seq>.mp3).
 * Never the audiobooks folder (only audio-write.ts writes there); every path is checked to be
 * inside this folder, which must not overlap the audiobooks folder. A session's folder is
 * removed when the session ends, and the whole folder at server start. (Like tts-workdir.ts;
 * the static writer test allows both.)
 */
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { isInside } from '../db/database';
import { TooLargeError } from './tts-workdir';

export class ReadAloudWorkdir {
  readonly root: string;

  constructor(cacheDir: string, audiobooksRoot: string) {
    this.root = path.resolve(cacheDir, 'tts-live');
    const audio = path.resolve(audiobooksRoot);
    if (isInside(audio, this.root) || isInside(this.root, audio)) {
      throw new Error(
        `The read-aloud work folder (${this.root}) and the audiobooks folder (${audio}) overlap`,
      );
    }
  }

  dir(session: string): string {
    if (!/^[a-f0-9]{8,64}$/.test(session)) throw new Error('Bad session id');
    return path.join(this.root, session);
  }

  file(session: string, name: string): string {
    if (!/^[\w][\w.-]*$/.test(name)) throw new Error('Bad file name');
    return path.join(this.dir(session), name);
  }

  /** Streams a body into `name` (replacing an earlier partial upload); removed on failure. */
  async receive(
    session: string,
    name: string,
    body: NodeJS.ReadableStream,
    maxBytes: number,
  ): Promise<number> {
    await fs.mkdir(this.dir(session), { recursive: true });
    const file = this.file(session, name);
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

  async remove(session: string, name: string): Promise<void> {
    await fs.unlink(this.file(session, name)).catch(() => undefined);
  }

  async removeSession(session: string): Promise<void> {
    await fs.rm(this.dir(session), { recursive: true, force: true });
  }

  /** At server start: nothing of an earlier run is kept (sessions live in memory). */
  async clear(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true });
  }
}
