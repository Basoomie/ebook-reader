/**
 * A file's SHA-256, read with plain positional reads (1 MiB each).
 *
 * Not `for await (… of handle.createReadStream())`: on the NAS (2026-11-26) such a stream stopped
 * part way through a batch's metadata.db copy (the file held open at 62 of 165 MB, every thread
 * idle) and its promise never settled, so the batch waited for its copy for ever. A read that
 * takes longer than `stallMs` fails instead of waiting.
 */
import { createHash } from 'crypto';
import fs from 'fs/promises';

const CHUNK = 1 << 20;

export async function sha256File(file: string, stallMs = 120_000): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let pos = 0; ; ) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`reading ${file} stalled at byte ${pos}`)),
          stallMs,
        );
        timer.unref();
      });
      let bytesRead: number;
      try {
        ({ bytesRead } = await Promise.race([handle.read(buf, 0, CHUNK, pos), stalled]));
      } finally {
        clearTimeout(timer);
      }
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    // Never waited on: a handle whose read stalled may not close either.
    void handle.close().catch(() => {});
  }
  return hash.digest('hex');
}
