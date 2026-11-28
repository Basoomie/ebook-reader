/**
 * Books without an EPUB: where the checked EPUBs wait until they are written (or the pass looks
 * again). The only code of the pass that writes files, and only under its own folder
 * CACHE_DIR/cleanup/formats/<library>/<uuid>.epub (a regenerable cache: a run made again converts
 * the books again). Nothing here touches a Calibre library (test-enforced).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export class EpubStoreError extends Error {}

export class EpubStore {
  readonly root: string;

  constructor(cacheDir: string) {
    this.root = path.join(cacheDir, 'cleanup', 'formats');
  }

  /** The book's checked EPUB (whether or not it is there). */
  file(libraryId: string, uuid: string): string {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(uuid) || !/^[0-9a-zA-Z-]{1,64}$/.test(libraryId))
      throw new EpubStoreError('Bad id');
    return path.join(this.root, libraryId, `${uuid}.epub`);
  }

  has(libraryId: string, uuid: string): boolean {
    return fs.existsSync(this.file(libraryId, uuid));
  }

  /**
   * Streams an EPUB in, to a temporary name beside it, and keeps it only when it arrived whole
   * with the SHA-256 (and size) the sidecar sent.
   */
  async receive(
    libraryId: string,
    uuid: string,
    body: Readable,
    sha256: string,
    size: number,
  ): Promise<void> {
    const final = this.file(libraryId, uuid);
    const tmp = `${final}.part`;
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    body.on('data', (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    try {
      await pipeline(body, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    if (hash.digest('hex') !== sha256 || (size > 0 && bytes !== size)) {
      await fsp.rm(tmp, { force: true });
      throw new EpubStoreError('The EPUB arrived incomplete or changed');
    }
    await fsp.rename(tmp, final);
  }

  /** Removes a book's checked EPUB (written, failed its check, or looked at again). */
  async remove(libraryId: string, uuid: string): Promise<void> {
    const final = this.file(libraryId, uuid);
    await fsp.rm(final, { force: true });
  }
}
