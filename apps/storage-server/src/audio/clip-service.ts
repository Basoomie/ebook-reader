/**
 * WP14 "Enrich last card": cuts a short sentence-audio clip out of a book's linked
 * audiobook file with ffmpeg, as MP3, for an Anki card.
 *
 * Read-only: ffmpeg reads the linked file and writes the clip to its stdout (pipe:1);
 * nothing is written anywhere (no temp files, nothing in the audiobooks folder, so
 * audio-write.ts is not involved). A cut is bounded by a length cap, a timeout and a
 * small concurrency limit (AUDIO_CLIP_* settings).
 */
import { spawn } from 'child_process';
import os from 'os';
import type { AudioClipConfig } from '../config';
import { shortenPaths } from './merge-service';

export class ClipError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClipServiceOptions {
  config: AudioClipConfig;
  /** Roots removed from error messages shown to users (the audiobooks folder). */
  hideRoots?: () => (string | null)[];
  logError?: (message: string, err?: unknown) => void;
  /** Tests only: arguments put before ffmpeg's own (a fake ffmpeg run by node). */
  ffmpegPrefixArgs?: string[];
}

/** Seconds as ffmpeg reads them, to the millisecond. */
function secs(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

/** The ffmpeg arguments for one clip (exported for tests). */
export function clipArgs(file: string, start: number, end: number, bitrate: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-ss',
    secs(start),
    '-i',
    file,
    '-t',
    secs(end - start),
    '-map',
    '0:a:0',
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    bitrate,
    '-f',
    'mp3',
    'pipe:1',
  ];
}

export class ClipService {
  private active = 0;
  private readonly config: AudioClipConfig;

  constructor(private readonly options: ClipServiceOptions) {
    this.config = options.config;
  }

  get maxSeconds(): number {
    return this.config.maxSeconds;
  }

  /** The MP3 bytes of [start, end) seconds of `file`. Throws ClipError. */
  async cut(file: string, start: number, end: number): Promise<Buffer> {
    if (this.active >= this.config.concurrency) {
      throw new ClipError(429, 'busy', 'The server is cutting other sentence audio; try again');
    }
    this.active += 1;
    try {
      return await this.run(clipArgs(file, start, end, this.config.bitrate), end - start);
    } finally {
      this.active -= 1;
    }
  }

  private run(args: string[], seconds: number): Promise<Buffer> {
    const { ffmpegPath, timeoutSeconds, bitrate } = this.config;
    // Generous upper bound on the output: the bitrate's size twice over plus headers.
    const kbps = Number(bitrate.replace(/k$/i, '')) || 128;
    const maxBytes = Math.ceil(((seconds + 2) * kbps * 1000) / 8) * 2 + 256 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [...(this.options.ffmpegPrefixArgs ?? []), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try {
        if (child.pid) os.setPriority(child.pid, 10);
      } catch {
        // Lower priority is a nicety only.
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let failure: ClipError | null = null;
      let settled = false;
      const finish = (err: ClipError | null, out?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(out!);
      };
      const stop = (err: ClipError) => {
        failure ??= err;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => stop(new ClipError(504, 'timeout', 'Cutting the sentence audio took too long')),
        timeoutSeconds * 1000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          stop(new ClipError(500, 'clip_failed', 'The sentence audio came out too large'));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.on('error', (err) => {
        this.options.logError?.('ffmpeg could not start for a sentence clip', err);
        finish(new ClipError(503, 'clip_off', 'ffmpeg is not available on the server'));
      });
      // 'exit' as well as 'close': a wrapper that keeps the pipes open must not hang us.
      child.on('exit', () => {
        if (failure) finish(failure);
      });
      child.on('close', (code) => {
        if (failure) return finish(failure);
        if (code !== 0) {
          const last = stderr.trim().split(/\r?\n/).pop() ?? '';
          const reason = shortenPaths(last, this.options.hideRoots?.() ?? []);
          this.options.logError?.(`ffmpeg failed for a sentence clip: ${reason}`);
          return finish(
            new ClipError(
              500,
              'clip_failed',
              `Could not cut the sentence audio: ${reason || 'ffmpeg failed'}`,
            ),
          );
        }
        const out = Buffer.concat(chunks);
        if (out.length === 0) {
          return finish(new ClipError(500, 'clip_failed', 'The sentence audio came out empty'));
        }
        finish(null, out);
      });
    });
  }
}
