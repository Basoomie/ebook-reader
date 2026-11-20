/**
 * The ONLY code that writes audiobook files (WP21e-1, design "Hard links and 'already in ABS'").
 * It runs in the linking sidecar, which mounts /mnt/disk1/data once, read-write (a hard link
 * can't cross two mounts).
 *
 * WP21e-1 (the build), each create-only:
 *   makeFolder(dst)            a new folder under media/audiobooks/japanese-new/ or
 *                              media/audiobooks/japanese-generated-new/;
 *   linkFile(src, dst, stat)   a hard link there to a file under torrents/audiobooks/japanese/
 *                              that is exactly the file the plan names (size, mtime, device,
 *                              inode), never replacing anything (link() fails on an existing name);
 *   writeMetadata(dst, bytes)  a book's metadata.json in a folder there.
 *
 * WP21e-2 (the switch; added only now, decided with the user 2026-11-20), each bounded:
 *   renameRoot(from, to, ino)  one of exactly six folder renames in media/audiobooks (the three of
 *                              the switch and their reverses, for Undo), never onto an existing name;
 *   linkToFromLibrary(src, dst) a hard link under torrents/audiobooks/japanese/_from-library/ to a
 *                              library-only file of media/audiobooks/japanese/, after re-checking
 *                              its size, mtime, device, inode and SHA-256 (the only new names ever
 *                              made under the torrents; nothing there is renamed, moved or changed);
 *   copyInventory(name, plan)  one of the old copy script's five files from japanese-old/ copied to
 *                              media/audiobooks/_inventory/old-copy-script/ (create-only);
 *   deleteOld(entry)           one entry of media/audiobooks/japanese-old/: a file only when it is
 *                              still exactly what the deletion's list says (size, mtime, device,
 *                              inode), a folder only when empty (rmdir). Nothing outside it.
 *
 * Nothing else: no other rename, move or delete (the build's one other removal is this module's
 * own temporary `.ttsu-link-<n>.partial` file, which never has another name), no chmod or chown of
 * a link (that would change the torrent's file), nothing in the Calibre libraries or anywhere else
 * in /data. A test reads this folder's code and fails if another module calls a write function or
 * this one gains another operation.
 */
import { createHash } from 'crypto';
import { constants, createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

/** The two folders the build may create things in (relative to media/audiobooks). */
export const BUILD_ROOTS: readonly string[] = ['japanese-new', 'japanese-generated-new'];
export const METADATA_NAME = 'metadata.json';
/**
 * WP21e-2: the only folder renames, `from -> to` in media/audiobooks: the switch's three and,
 * for Undo, their reverses.
 */
export const RENAME_PAIRS: readonly (readonly [string, string])[] = [
  ['japanese', 'japanese-old'],
  ['japanese-new', 'japanese'],
  ['japanese-generated-new', 'japanese-generated'],
  ['japanese', 'japanese-new'],
  ['japanese-old', 'japanese'],
  ['japanese-generated', 'japanese-generated-new']
];
/** WP21e-2: where library-only files get their name under the torrents. */
export const FROM_LIBRARY = '_from-library';
/** WP21e-2: the folder deleted at the end, and the only one anything is removed from. */
export const OLD_ROOT = 'japanese-old';
/** WP21e-2: the old copy script's files at the old library's root, kept before the deletion. */
export const INVENTORY_NAMES: readonly string[] = [
  'needs_extraction.csv',
  'needs_review.csv',
  'restructure_log.csv',
  'unmatched_bonus_content.csv',
  '.processed_files.json'
];
export const INVENTORY_DIR = ['_inventory', 'old-copy-script'] as const;
const MAX_NAME_BYTES = 255;
const MAX_METADATA_BYTES = 1024 * 1024;

export class WriteRefused extends Error {
  readonly code = 'write_refused';
}

/** A torrent file as the plan names it: its path and what it was when stage 1 saw it. */
export interface PlannedSource {
  /** Relative to torrents/audiobooks/japanese, forward slashes. */
  rel: string;
  /** The exact bytes of the relative path as hex, when they are not UTF-8. */
  raw: string | null;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface WriterOptions {
  /** The sidecar's mount of /mnt/disk1/data. */
  dataDir: string;
  /** Mode of new folders (Unraid shares: 0777). */
  dirMode?: number;
  /** Mode of new metadata files (0666, like files made over SMB). */
  fileMode?: number;
}

function checkName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x20 || c === 0x7f;
    }) ||
    Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES
  ) {
    throw new WriteRefused(`Not an allowed name: ${JSON.stringify(name)}`);
  }
}

/** A file in media/audiobooks as the switch names it (path, and what it was when listed). */
export interface PlannedMediaEntry {
  /** Relative to media/audiobooks, forward slashes. */
  rel: string;
  /** The exact bytes of the relative path as hex, when they are not UTF-8. */
  raw: string | null;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** The parts of a relative path; '', '.', '..' refused (names are not otherwise limited). */
function relParts(rel: string, raw: string | null): string[] {
  const parts =
    raw !== null ? Buffer.from(raw, 'hex').toString('latin1').split('/') : rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..'))
    throw new WriteRefused(`Not an allowed path: ${JSON.stringify(rel)}`);
  return parts;
}

/** An absolute path below `base` for `rel` (raw bytes kept as a Buffer path). */
function below(base: string, rel: string, raw: string | null): string | Buffer {
  return raw !== null
    ? Buffer.concat([Buffer.from(base + '/'), Buffer.from(raw, 'hex')])
    : path.join(base, ...rel.split('/'));
}

function parentOf(file: string | Buffer): string | Buffer {
  return typeof file === 'string' ? path.dirname(file) : file.subarray(0, file.lastIndexOf(0x2f));
}

/** What differs between a file's lstat and the planned values. */
function differences(
  st: { size: bigint; mtimeMs: bigint; ino: bigint; dev: bigint },
  plan: { size: number; mtimeMs: number; ino: number; dev: number }
): string[] {
  const changed: string[] = [];
  if (Number(st.size) !== plan.size) changed.push('size');
  if (Math.floor(Number(st.mtimeMs)) !== plan.mtimeMs) changed.push('mtime');
  if (Number(st.ino) !== plan.ino) changed.push('inode');
  if (Number(st.dev) !== plan.dev) changed.push('device');
  return changed;
}

/** A file's SHA-256 (read only). */
export async function sha256Of(file: string | Buffer): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** A destination's parts: inside one of the two build folders, every part an allowed name. */
function destination(dst: string): string[] {
  const parts = dst.split('/');
  if (!BUILD_ROOTS.includes(parts[0])) {
    throw new WriteRefused(`Not inside ${BUILD_ROOTS.join(' or ')}: ${JSON.stringify(dst)}`);
  }
  for (const p of parts) checkName(p);
  return parts;
}

export class LinkWriter {
  readonly torrents: string;
  readonly media: string;
  private readonly dirMode: number;
  private readonly fileMode: number;

  constructor(opts: WriterOptions) {
    const data = path.resolve(opts.dataDir);
    this.torrents = path.join(data, 'torrents', 'audiobooks', 'japanese');
    this.media = path.join(data, 'media', 'audiobooks');
    this.dirMode = opts.dirMode ?? 0o777;
    this.fileMode = opts.fileMode ?? 0o666;
  }

  /**
   * Every folder from media/audiobooks down to `parts` (exclusive of nothing: all of them) must
   * be a real folder, not a symlink, and resolve inside media/audiobooks.
   */
  private async realFolders(parts: string[]): Promise<string> {
    const mediaReal = await fs.realpath(this.media);
    let cur = this.media;
    for (const p of parts) {
      cur = path.join(cur, p);
      const st = await fs.lstat(cur).catch(() => null);
      if (!st) throw new WriteRefused(`The folder is missing: ${parts.join('/')}`);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new WriteRefused(`Not a real folder: ${path.relative(this.media, cur)}`);
      }
    }
    const real = await fs.realpath(cur);
    if (real !== mediaReal && !real.startsWith(mediaReal + path.sep)) {
      throw new WriteRefused(`Leaves media/audiobooks: ${parts.join('/')}`);
    }
    return cur;
  }

  /** A new folder (its parent must exist). An existing real folder counts as done. */
  async makeFolder(dst: string): Promise<{ existed: boolean }> {
    const parts = destination(dst);
    const parent = await this.realFolders(parts.slice(0, -1));
    const abs = path.join(parent, parts[parts.length - 1]);
    try {
      await fs.mkdir(abs, { mode: this.dirMode });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new WriteRefused(`Something else is already there: ${dst}`);
      return { existed: true };
    }
    // mkdir's mode is reduced by the umask; a folder this call made gets the full mode.
    await fs.chmod(abs, this.dirMode);
    return { existed: false };
  }

  /** The torrent file the plan names, checked: a regular file, unchanged since stage 1. */
  async source(src: PlannedSource): Promise<{ file: string | Buffer; dev: bigint; ino: bigint }> {
    const parts =
      src.raw !== null
        ? Buffer.from(src.raw, 'hex').toString('latin1').split('/')
        : src.rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..'))
      throw new WriteRefused(`Not an allowed source: ${JSON.stringify(src.rel)}`);
    const file =
      src.raw !== null
        ? Buffer.concat([Buffer.from(this.torrents + '/'), Buffer.from(src.raw, 'hex')])
        : path.join(this.torrents, ...parts);
    const torrentsReal = await fs.realpath(this.torrents);
    const dir =
      typeof file === 'string' ? path.dirname(file) : file.subarray(0, file.lastIndexOf(0x2f));
    const dirReal = (await fs.realpath(dir).catch(() => null)) as string | null;
    if (!dirReal || (dirReal !== torrentsReal && !dirReal.startsWith(torrentsReal + path.sep)))
      throw new WriteRefused(`The source is not under the torrents: ${src.rel}`);
    const st = await fs.lstat(file, { bigint: true }).catch(() => null);
    if (!st) throw new WriteRefused(`missing: ${src.rel}`);
    if (!st.isFile()) throw new WriteRefused(`not a file: ${src.rel}`);
    const changed: string[] = [];
    if (Number(st.size) !== src.size) changed.push('size');
    if (Math.floor(Number(st.mtimeMs)) !== src.mtimeMs) changed.push('mtime');
    if (Number(st.ino) !== src.ino) changed.push('inode');
    if (Number(st.dev) !== src.dev) changed.push('device');
    if (changed.length) throw new WriteRefused(`changed (${changed.join(', ')}): ${src.rel}`);
    return { file, dev: st.dev, ino: st.ino };
  }

  /**
   * A hard link at `dst` to the planned torrent file. A link that is already there (the same
   * file) counts as done; anything else at `dst` is refused, never replaced.
   */
  async linkFile(
    src: PlannedSource,
    dst: string
  ): Promise<{ existed: boolean; dev: number; ino: number }> {
    const parts = destination(dst);
    const s = await this.source(src);
    const parent = await this.realFolders(parts.slice(0, -1));
    const abs = path.join(parent, parts[parts.length - 1]);
    let existed = false;
    try {
      await fs.link(s.file, abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      existed = true;
    }
    const st = await fs.lstat(abs, { bigint: true });
    if (!st.isFile() || st.dev !== s.dev || st.ino !== s.ino) {
      throw new WriteRefused(
        existed
          ? `A different file is already there: ${dst}`
          : `The new link is not the source: ${dst}`
      );
    }
    return { existed, dev: Number(st.dev), ino: Number(st.ino) };
  }

  /** A book's metadata.json: written to a temporary name, fsynced, then linked into place. */
  async writeMetadata(dst: string, bytes: Buffer, tag: number): Promise<{ existed: boolean }> {
    const parts = destination(dst);
    if (parts[parts.length - 1] !== METADATA_NAME)
      throw new WriteRefused(`Only ${METADATA_NAME} can be written: ${dst}`);
    if (!Number.isSafeInteger(tag) || tag < 0) throw new WriteRefused('Bad temporary name');
    if (bytes.length > MAX_METADATA_BYTES) throw new WriteRefused('metadata.json too large');
    const parent = await this.realFolders(parts.slice(0, -1));
    const abs = path.join(parent, METADATA_NAME);
    const same = async (): Promise<boolean | null> => {
      const st = await fs.lstat(abs).catch(() => null);
      if (!st) return null;
      if (!st.isFile()) return false;
      return (await fs.readFile(abs)).equals(bytes);
    };
    const before = await same();
    if (before === true) return { existed: true };
    if (before === false) throw new WriteRefused(`A different file is already there: ${dst}`);
    const temp = path.join(parent, `.ttsu-link-${tag}.partial`);
    // A temporary file left by an interrupted run of this same operation.
    const left = await fs.lstat(temp).catch(() => null);
    if (left) {
      if (!left.isFile()) throw new WriteRefused(`Something else is at ${temp}`);
      await fs.unlink(temp);
    }
    const handle = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      this.fileMode
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(this.fileMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temp, abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      await fs.unlink(temp);
    }
    const after = await same();
    if (after !== true) throw new WriteRefused(`A different file is already there: ${dst}`);
    return { existed: false };
  }

  // ------------------------------------------------------------------ WP21e-2: the switch

  /** `cur` (a path in media/audiobooks or the torrents) must resolve inside `base`. */
  private async inside(base: string, cur: string | Buffer, what: string): Promise<void> {
    const baseReal = await fs.realpath(base);
    const real = (await fs.realpath(cur).catch(() => null)) as string | null;
    if (!real || (real !== baseReal && !real.startsWith(baseReal + path.sep)))
      throw new WriteRefused(`Not inside ${what}`);
  }

  /**
   * One of RENAME_PAIRS. `from` must be a real folder (not a symlink) with the planned inode and
   * `to` must not exist; afterwards `to` is that folder and `from` is gone. Already done (`from`
   * gone, `to` the planned folder) counts as done.
   */
  async renameRoot(from: string, to: string, ino: number): Promise<{ existed: boolean }> {
    if (!RENAME_PAIRS.some(([a, b]) => a === from && b === to))
      throw new WriteRefused(`Not an allowed rename: ${from} -> ${to}`);
    const src = path.join(this.media, from);
    const dst = path.join(this.media, to);
    const s = await fs.lstat(src, { bigint: true }).catch(() => null);
    const d = await fs.lstat(dst, { bigint: true }).catch(() => null);
    // Done already (also when `from` is now another folder: after the switch's second rename,
    // `japanese` is the new library, and a repeated first rename must not touch it).
    if (d && !d.isSymbolicLink() && d.isDirectory() && Number(d.ino) === ino)
      return { existed: true };
    if (!s) throw new WriteRefused(`The folder to rename is missing: ${from}`);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new WriteRefused(`Not a real folder: ${from}`);
    if (Number(s.ino) !== ino) throw new WriteRefused(`Not the planned folder (inode): ${from}`);
    if (d) throw new WriteRefused(`Something is already there: ${to}`);
    await fs.rename(src, dst);
    const after = await fs.lstat(dst, { bigint: true });
    const gone = await fs.lstat(src).catch(() => null);
    if (!after.isDirectory() || Number(after.ino) !== ino || gone)
      throw new WriteRefused(`The rename did not give the planned result: ${from} -> ${to}`);
    return { existed: false };
  }

  /** A folder path under the torrents (made one level at a time), each a real folder there. */
  private async torrentFolders(parts: string[]): Promise<string> {
    let cur = this.torrents;
    for (const p of parts) {
      cur = path.join(cur, p);
      try {
        await fs.mkdir(cur, { mode: this.dirMode });
        await fs.chmod(cur, this.dirMode);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const c = await fs.lstat(cur);
      if (c.isSymbolicLink() || !c.isDirectory())
        throw new WriteRefused(`Not a real folder: ${path.relative(this.torrents, cur)}`);
      await this.inside(this.torrents, cur, 'the torrents');
    }
    return cur;
  }

  /**
   * A library-only file of media/audiobooks/japanese/ gets a name under
   * torrents/audiobooks/japanese/_from-library/ (its folders made on the way): the file is
   * re-checked first (size, mtime, device, inode, then SHA-256 read in full), then link()ed,
   * never replacing anything. The library's own name stays (it goes with japanese-old).
   */
  async linkToFromLibrary(
    src: PlannedMediaEntry & { sha256: string },
    dst: string
  ): Promise<{ existed: boolean; dev: number; ino: number; sha256: string }> {
    const sparts = relParts(src.rel, src.raw);
    if (sparts[0] !== 'japanese' || sparts.length < 2)
      throw new WriteRefused(`Not a file of the live library: ${src.rel}`);
    const dparts = dst.split('/');
    if (dparts[0] !== FROM_LIBRARY || dparts.length < 2)
      throw new WriteRefused(`Not inside ${FROM_LIBRARY}: ${dst}`);
    for (const p of dparts) checkName(p);
    if (!/^[0-9a-f]{64}$/.test(src.sha256)) throw new WriteRefused('No planned SHA-256');
    const file = below(this.media, src.rel, src.raw);
    await this.inside(path.join(this.media, 'japanese'), parentOf(file), 'the live library');
    const st = await fs.lstat(file, { bigint: true }).catch(() => null);
    if (!st) throw new WriteRefused(`missing: ${src.rel}`);
    if (!st.isFile()) throw new WriteRefused(`not a file: ${src.rel}`);
    const changed = differences(st, src);
    if (changed.length) throw new WriteRefused(`changed (${changed.join(', ')}): ${src.rel}`);
    const dir = await this.torrentFolders(dparts.slice(0, -1));
    const abs = path.join(dir, dparts[dparts.length - 1]);
    const there = await fs.lstat(abs, { bigint: true }).catch(() => null);
    if (there) {
      if (there.isFile() && there.dev === st.dev && there.ino === st.ino)
        return { existed: true, dev: Number(st.dev), ino: Number(st.ino), sha256: src.sha256 };
      throw new WriteRefused(`A different file is already there: ${dst}`);
    }
    const sha = await sha256Of(file);
    if (sha !== src.sha256) throw new WriteRefused(`changed (SHA-256): ${src.rel}`);
    const again = await fs.lstat(file, { bigint: true });
    if (differences(again, src).length) throw new WriteRefused(`changed while read: ${src.rel}`);
    await fs.link(file, abs);
    const made = await fs.lstat(abs, { bigint: true });
    if (!made.isFile() || made.dev !== st.dev || made.ino !== st.ino)
      throw new WriteRefused(`The new link is not the source: ${dst}`);
    return { existed: false, dev: Number(made.dev), ino: Number(made.ino), sha256: sha };
  }

  /**
   * One of INVENTORY_NAMES copied from media/audiobooks/japanese-old/ to
   * media/audiobooks/_inventory/old-copy-script/ (O_EXCL, fsync). The same bytes already there
   * count as done; anything else there is refused.
   */
  async copyInventory(
    name: string,
    plan: { size: number; mtimeMs: number; dev: number; ino: number }
  ): Promise<{ existed: boolean; size: number }> {
    if (!INVENTORY_NAMES.includes(name)) throw new WriteRefused(`Not an inventory file: ${name}`);
    const src = path.join(this.media, OLD_ROOT, name);
    const st = await fs.lstat(src, { bigint: true }).catch(() => null);
    if (!st || !st.isFile()) throw new WriteRefused(`missing: ${OLD_ROOT}/${name}`);
    const changed = differences(st, plan);
    if (changed.length) throw new WriteRefused(`changed (${changed.join(', ')}): ${name}`);
    const bytes = await fs.readFile(src);
    let cur = this.media;
    for (const p of INVENTORY_DIR) {
      cur = path.join(cur, p);
      try {
        await fs.mkdir(cur, { mode: this.dirMode });
        await fs.chmod(cur, this.dirMode);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const c = await fs.lstat(cur);
      if (c.isSymbolicLink() || !c.isDirectory())
        throw new WriteRefused(`Not a real folder: ${path.relative(this.media, cur)}`);
    }
    await this.inside(this.media, cur, 'media/audiobooks');
    const abs = path.join(cur, name);
    const there = await fs.lstat(abs).catch(() => null);
    if (there) {
      if (there.isFile() && (await fs.readFile(abs)).equals(bytes))
        return { existed: true, size: bytes.length };
      throw new WriteRefused(
        `A different file is already there: _inventory/old-copy-script/${name}`
      );
    }
    const handle = await fs.open(
      abs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      this.fileMode
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(this.fileMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await fs.readFile(abs)).equals(bytes))
      throw new WriteRefused(`The copy differs: ${name}`);
    return { existed: false, size: bytes.length };
  }

  /**
   * One entry of media/audiobooks/japanese-old/ removed: a file (or a symlink, never followed)
   * only when its lstat is exactly the listed one; a folder only when empty (rmdir) and the
   * listed folder. An entry already gone counts as done. `japanese-old` itself is the last
   * folder removed. Returns the bytes freed (a regular file that had no other name).
   */
  async deleteOld(
    entry: PlannedMediaEntry & { dir: boolean }
  ): Promise<{ existed: boolean; freed: number }> {
    const parts = relParts(entry.rel, entry.raw);
    if (parts[0] !== OLD_ROOT) throw new WriteRefused(`Not inside ${OLD_ROOT}: ${entry.rel}`);
    const abs = below(this.media, entry.rel, entry.raw);
    const parent = parentOf(abs);
    const pst = await fs.lstat(parent).catch(() => null);
    if (!pst) return { existed: true, freed: 0 };
    if (pst.isSymbolicLink() || !pst.isDirectory())
      throw new WriteRefused(`Not a real folder above: ${entry.rel}`);
    if (parts.length > 1) await this.inside(path.join(this.media, OLD_ROOT), parent, OLD_ROOT);
    else await this.inside(this.media, parent, 'media/audiobooks');
    const st = await fs.lstat(abs, { bigint: true }).catch(() => null);
    if (!st) return { existed: true, freed: 0 };
    if (entry.dir) {
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new WriteRefused(`Not a folder: ${entry.rel}`);
      if (Number(st.ino) !== entry.ino || Number(st.dev) !== entry.dev)
        throw new WriteRefused(`Not the listed folder: ${entry.rel}`);
      await fs.rmdir(abs);
      return { existed: false, freed: 0 };
    }
    if (st.isDirectory()) throw new WriteRefused(`A folder, listed as a file: ${entry.rel}`);
    const changed = differences(st, entry);
    if (changed.length) throw new WriteRefused(`changed (${changed.join(', ')}): ${entry.rel}`);
    const freed = st.nlink === 1n && st.isFile() ? Number(st.size) : 0;
    await fs.unlink(abs);
    return { existed: false, freed };
  }
}
