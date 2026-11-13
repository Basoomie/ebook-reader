/**
 * The quarantine folder (/mnt/user/data/backups/calibre-quarantine, mounted at /quarantine):
 * every removed copy is exported here before Calibre removes it, with the batch's
 * metadata.db snapshot. NOTHING here is ever deleted, renamed or overwritten by the
 * sidecar: files are created new ('wx') and folders only made. The user empties it.
 *
 * Layout: /quarantine/<batch id>/batch.json, metadata.db, <calibre id>/ (the export:
 * book.epub, book.opf, book.jpg, other formats), <calibre id>.json (what was removed and
 * what it was a duplicate of).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export class Quarantine {
  constructor(readonly root: string) {}

  batchDir(batchId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(batchId)) throw new Error('Bad batch id');
    return path.join(this.root, batchId);
  }

  async makeBatchDir(batchId: string): Promise<string> {
    const dir = this.batchDir(batchId);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Writes a new file; false when it already exists (never replaced). */
  async createOnce(file: string, data: string): Promise<boolean> {
    try {
      await fsp.writeFile(file, data, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  /** The first name of `base`, `base-2`, `base-3`… that doesn't exist yet. */
  async freshName(dir: string, base: string, ext = ''): Promise<string> {
    for (let n = 1; n < 1000; n++) {
      const name = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}${ext}`);
      if (!(await exists(name))) return name;
    }
    throw new Error(`No free name for ${base} in ${dir}`);
  }

  /**
   * An earlier export of this copy whose EPUB has the expected SHA-256 (an interrupted run),
   * or null. Looks at <id>, <id>-2, ….
   */
  async findExport(batchId: string, calibreId: number, sha256: string): Promise<string | null> {
    const dir = this.batchDir(batchId);
    for (let n = 1; n < 1000; n++) {
      const candidate = path.join(dir, `${calibreId}${n === 1 ? '' : `-${n}`}`);
      if (!(await exists(candidate))) return null;
      const epub = await this.epubIn(candidate);
      if (epub && (await sha256File(epub)) === sha256) return candidate;
    }
    return null;
  }

  async epubIn(dir: string): Promise<string | null> {
    try {
      const names = await fsp.readdir(dir);
      const epub = names.find((n) => n.toLowerCase().endsWith('.epub'));
      return epub ? path.join(dir, epub) : null;
    } catch {
      return null;
    }
  }

  /** Writable, with at least `minFreeMb` free. */
  async check(minFreeMb: number): Promise<{ ok: boolean; detail: string }> {
    try {
      await fsp.access(this.root, fs.constants.W_OK);
    } catch {
      return { ok: false, detail: `${this.root} is missing or not writable` };
    }
    try {
      const st = await fsp.statfs(this.root);
      const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
      if (freeMb < minFreeMb) {
        return { ok: false, detail: `only ${freeMb} MB free (needs ${minFreeMb} MB)` };
      }
      return { ok: true, detail: `${freeMb} MB free` };
    } catch (err) {
      return { ok: false, detail: `free space unknown: ${(err as Error).message}` };
    }
  }
}
