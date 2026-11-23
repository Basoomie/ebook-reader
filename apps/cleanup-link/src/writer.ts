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
 * WP21f-1 (the daily new arrivals; decided with the user 2026-11-20), each create-only:
 *   makeArrivalFolder(dst, book, planned)  a new book's folder (and its Disc folders) under
 *                              media/audiobooks/japanese/ or japanese-generated/; missing author or
 *                              series folders are made, existing ones only entered;
 *   linkArrival(src, dst, book, planned)   a hard link in that new book's folder to the planned,
 *                              unchanged torrent file;
 *   writeArrivalMetadata(...)  the new book's metadata.json.
 *     A book folder that holds anything not planned for it (an existing book) is refused, so an
 *     existing book's folder or files are never touched.
 *   extractEntry(archive, dst, size, tag, open)  one archive entry unpacked into a new file under
 *                              torrents/audiobooks/japanese/_extracted/ (the only new place in the
 *                              torrents besides _from-library); the archive is only read.
 *
 * WP20g (the Calibre library's import; decided with the user 2026-11-17), create-only:
 *   extractBookEntry(root, archive, volumes, dst, size, tag, open)  one archive entry (an EPUB)
 *                              unpacked into a new file under `<book source folder>/_extracted/`,
 *                              the source folder under torrents/ and never torrents/audiobooks;
 *                              the archive (and a split set's volumes) only read.
 *
 * Nothing else: no other rename, move or delete (the build's one other removal is this module's
 * own temporary `.ttsu-link-<n>.partial` file, which never has another name), no chmod or chown of
 * a link (that would change the torrent's file), nothing in the Calibre libraries or anywhere else
 * in /data. A test reads this folder's code and fails if another module calls a write function or
 * this one gains another operation.
 */
import { createHash } from 'crypto';
import { constants, createReadStream } from 'fs';
import fs, { type FileHandle } from 'fs/promises';
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
/**
 * WP21f-1: the library folders new books are added to after the switch (new folders only; a
 * book folder that holds anything not planned for it, i.e. an existing book, is refused).
 */
export const ARRIVAL_ROOTS: readonly string[] = ['japanese', 'japanese-generated'];
/** WP21f-1: the only new folder in the torrents: archives are unpacked under it. */
export const EXTRACTED = '_extracted';
/** WP20g: the archives of a book source folder (zip, rar, 7z, and a split set's first volume). */
export const BOOK_ARCHIVE = /\.(zip|rar|7z|001)$/i;
/** WP21f-2: the library root whose book folders and links may be renamed (no other root). */
export const LIBRARY_ROOT = 'japanese';
/**
 * WP21f-2: the reader's own folders in media/audiobooks and where their files get their
 * original name under the torrents (the only other new places there besides _from-library and
 * _extracted).
 */
export const READER_ROOTS: Readonly<Record<string, string>> = {
  'japanese-generated': 'AI',
  'japanese-merged': '_merged'
};
/** WP21f-2: the temporary name of a book folder in a cycle of renames (same parent only). */
const MOVE_TEMP = /^\.ttsu-move-\d+$/;
/** Files Audiobookshelf writes into a book folder itself ("store metadata/cover with item"). */
const ABS_OWN = /^(metadata\.json|cover\.(jpe?g|png|webp))$/i;
/** This module's own temporary names. */
const OWN_TEMP = /^\.ttsu-(link|x)-\d+\.partial$/;
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
function destination(dst: string, roots: readonly string[] = BUILD_ROOTS): string[] {
  const parts = dst.split('/');
  if (!roots.includes(parts[0])) {
    throw new WriteRefused(`Not inside ${roots.join(' or ')}: ${JSON.stringify(dst)}`);
  }
  for (const p of parts) checkName(p);
  return parts;
}

/** WP21f-1: a new book's path: a root of ARRIVAL_ROOTS, then at least the book folder. */
function arrivalDestination(dst: string, minParts: number): string[] {
  const parts = destination(dst, ARRIVAL_ROOTS);
  if (parts.length < minParts) throw new WriteRefused(`Not inside a book folder: ${dst}`);
  return parts;
}

/** The planned names of a book folder (each an allowed name). */
function plannedNames(planned: string[] | undefined): Set<string> {
  if (!Array.isArray(planned) || planned.length === 0 || planned.length > 10000)
    throw new WriteRefused('A new book needs the list of its planned files');
  for (const n of planned) checkName(n);
  return new Set(planned);
}

/** WP21f-2: a path of a book folder in LIBRARY_ROOT, the last part an allowed name or MOVE_TEMP. */
function movePath(p: string): string[] {
  const parts = p.split('/');
  if (parts[0] !== LIBRARY_ROOT)
    throw new WriteRefused(`Not inside ${LIBRARY_ROOT}: ${JSON.stringify(p)}`);
  for (const x of parts.slice(0, -1)) checkName(x);
  if (!MOVE_TEMP.test(parts[parts.length - 1])) checkName(parts[parts.length - 1]);
  return parts;
}

export class LinkWriter {
  readonly torrents: string;
  readonly media: string;
  /** The /mnt/disk1/data mount (WP20g: the book source folders are under its torrents/). */
  private readonly data: string;
  private readonly dirMode: number;
  private readonly fileMode: number;

  constructor(opts: WriterOptions) {
    const data = path.resolve(opts.dataDir);
    this.data = data;
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
  async source(
    src: PlannedSource,
    base: string = this.torrents
  ): Promise<{ file: string | Buffer; dev: bigint; ino: bigint }> {
    const parts =
      src.raw !== null
        ? Buffer.from(src.raw, 'hex').toString('latin1').split('/')
        : src.rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..'))
      throw new WriteRefused(`Not an allowed source: ${JSON.stringify(src.rel)}`);
    const file =
      src.raw !== null
        ? Buffer.concat([Buffer.from(base + '/'), Buffer.from(src.raw, 'hex')])
        : path.join(base, ...parts);
    const torrentsReal = await fs.realpath(base);
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
  private async torrentFolders(parts: string[], base: string = this.torrents): Promise<string> {
    let cur = base;
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
        throw new WriteRefused(`Not a real folder: ${path.relative(base, cur)}`);
      await this.inside(base, cur, 'the torrents');
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

  // ------------------------------------------------------- WP21f-1: the daily new arrivals

  /**
   * A new book's folder must hold nothing but what is planned for it (plus Audiobookshelf's own
   * metadata.json/cover and this module's temporary files): an existing book's folder never does,
   * so nothing is ever added to one. `sub` is the planned subfolder written into (a Disc folder),
   * whose entries are checked the same way.
   */
  private async checkBook(bookAbs: string, planned: Set<string>, sub: string[]): Promise<void> {
    const check = async (dir: string, prefix: string) => {
      for (const name of await fs.readdir(dir)) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (planned.has(rel) || OWN_TEMP.test(name) || (!prefix && ABS_OWN.test(name))) continue;
        throw new WriteRefused(`The folder holds something that isn't this new book's: ${rel}`);
      }
    };
    await check(bookAbs, '');
    let cur = bookAbs;
    for (let i = 0; i < sub.length; i++) {
      cur = path.join(cur, sub[i]);
      await check(cur, sub.slice(0, i + 1).join('/'));
    }
  }

  /**
   * A new book's folder (or a folder inside it, a Disc folder) under ARRIVAL_ROOTS. Parent
   * folders (author, series) are made when missing and only entered when they exist; the book
   * folder itself must be new, or, made by an earlier try of this run, hold only planned names.
   * `book` is the book folder (relative to media/audiobooks), `planned` its planned entries.
   */
  async makeArrivalFolder(
    dst: string,
    book: string,
    planned: string[]
  ): Promise<{ existed: boolean }> {
    const parts = arrivalDestination(dst, 2);
    const bparts = arrivalDestination(book, 3);
    // dst is the book's folder, one of its planned folders (Disc), or a folder above it (its
    // author or series folder).
    const above = book.startsWith(dst + '/');
    if (!above && dst !== book && !dst.startsWith(book + '/'))
      throw new WriteRefused(`Not the book's folder or a folder above it: ${dst}`);
    const names = plannedNames(planned);
    const inner = above ? [] : parts.slice(bparts.length);
    if (inner.length && !names.has(inner.join('/')))
      throw new WriteRefused(`Not a planned folder of the book: ${dst}`);
    let cur = await this.realFolders(parts.slice(0, 1));
    let existed = false;
    for (let i = 1; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      const st = await fs.lstat(cur).catch(() => null);
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory())
          throw new WriteRefused(`Not a real folder: ${parts.slice(0, i + 1).join('/')}`);
        existed = i === parts.length - 1;
        // A folder above the new book that holds a file is an existing book: never used.
        if (i < bparts.length - 1) {
          for (const e of await fs.readdir(cur, { withFileTypes: true }))
            if (!e.isDirectory() && !e.name.startsWith('.'))
              throw new WriteRefused(
                `An existing book's folder can't hold a new book: ${parts.slice(0, i + 1).join('/')}`
              );
        }
        continue;
      }
      try {
        await fs.mkdir(cur, { mode: this.dirMode });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      await fs.chmod(cur, this.dirMode);
    }
    await this.inside(this.media, cur, 'media/audiobooks');
    if (!above) await this.checkBook(path.join(this.media, ...bparts), names, inner);
    return { existed };
  }

  /** The book folder and the folder a file goes into, both checked real and new-book only. */
  private async arrivalParent(
    dst: string,
    book: string,
    planned: string[]
  ): Promise<{ parent: string; name: string }> {
    const parts = arrivalDestination(dst, 3);
    const bparts = arrivalDestination(book, 2);
    if (!dst.startsWith(book + '/')) throw new WriteRefused(`Not inside the book's folder: ${dst}`);
    const names = plannedNames(planned);
    const inner = parts.slice(bparts.length);
    if (!names.has(inner.join('/')))
      throw new WriteRefused(`Not a planned file of the book: ${dst}`);
    const parent = await this.realFolders(parts.slice(0, -1));
    // The folders above the book hold no file (an existing book is never under a new one).
    let cur = path.join(this.media, bparts[0]);
    for (let i = 1; i < bparts.length - 1; i++) {
      cur = path.join(cur, bparts[i]);
      for (const e of await fs.readdir(cur, { withFileTypes: true }))
        if (!e.isDirectory() && !e.name.startsWith('.'))
          throw new WriteRefused(
            `An existing book's folder can't hold a new book: ${bparts.slice(0, i + 1).join('/')}`
          );
    }
    await this.checkBook(path.join(this.media, ...bparts), names, inner.slice(0, -1));
    return { parent, name: parts[parts.length - 1] };
  }

  /**
   * A hard link in a new book's folder to the planned, unchanged torrent file (or a file this
   * module unpacked under _extracted). Never over an existing name; the same file already there
   * counts as done.
   */
  async linkArrival(
    src: PlannedSource,
    dst: string,
    book: string,
    planned: string[]
  ): Promise<{ existed: boolean; dev: number; ino: number }> {
    const s = await this.source(src);
    const { parent, name } = await this.arrivalParent(dst, book, planned);
    const abs = path.join(parent, name);
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

  /**
   * A new book's metadata.json (temporary name, fsync, link into place). When a different
   * metadata.json is already there and every planned audio file of the book is already linked,
   * it is Audiobookshelf's rewrite after its scan (it writes the file in its own form): done.
   */
  async writeArrivalMetadata(
    dst: string,
    bytes: Buffer,
    tag: number,
    book: string,
    planned: string[]
  ): Promise<{ existed: boolean; absRewrote: boolean }> {
    if (dst !== `${book}/${METADATA_NAME}`)
      throw new WriteRefused(`Only the book's ${METADATA_NAME} can be written: ${dst}`);
    if (!Number.isSafeInteger(tag) || tag < 0) throw new WriteRefused('Bad temporary name');
    if (bytes.length > MAX_METADATA_BYTES) throw new WriteRefused('metadata.json too large');
    const { parent } = await this.arrivalParent(dst, book, planned);
    const abs = path.join(parent, METADATA_NAME);
    const there = await fs.lstat(abs).catch(() => null);
    if (there) {
      if (!there.isFile()) throw new WriteRefused(`Something else is already there: ${dst}`);
      if ((await fs.readFile(abs)).equals(bytes)) return { existed: true, absRewrote: false };
      const audio = planned.filter(
        (n) => n !== METADATA_NAME && !n.includes('/') && /\.[^.]+$/.test(n)
      );
      for (const n of audio) {
        const st = await fs.lstat(path.join(parent, n)).catch(() => null);
        if (!st || !st.isFile())
          throw new WriteRefused(`A different file is already there: ${dst}`);
      }
      return { existed: true, absRewrote: true };
    }
    const temp = path.join(parent, `.ttsu-link-${tag}.partial`);
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
    if (!(await fs.readFile(abs)).equals(bytes))
      throw new WriteRefused(`A different file is already there: ${dst}`);
    return { existed: false, absRewrote: false };
  }

  /** An archive under the torrents (planned, unchanged), opened read only for listing. */
  async openArchive(src: PlannedSource): Promise<FileHandle> {
    if (!/\.(zip|rar|7z)$/i.test(src.rel)) throw new WriteRefused(`Not an archive: ${src.rel}`);
    const s = await this.source(src);
    return fs.open(s.file, constants.O_RDONLY);
  }

  /**
   * One archive entry unpacked into torrents/audiobooks/japanese/_extracted/<dst> (folders
   * made on the way, only under _extracted). The archive (a planned, unchanged torrent file)
   * is opened read only and handed to `open`, which starts bsdtar writing that one entry to a
   * stream; its bytes go into a new temporary file (O_EXCL), are counted against the listed
   * size and synced, then the file is linked into place. Never over an existing name: a file
   * already there with the listed size was put there by this method (nothing else writes under
   * _extracted) and counts as done. The archive is checked unchanged before and after.
   */
  async extractEntry(
    archive: PlannedSource,
    dst: string,
    size: number,
    tag: number,
    open: (handle: FileHandle) => {
      stream: NodeJS.ReadableStream;
      done: Promise<{ code: number | null; stderr: string }>;
      kill: () => void;
    }
  ): Promise<{ existed: boolean; bytes: number }> {
    return this.extractUnder(this.torrents, archive, [], dst, size, tag, (h) => open(h));
  }

  /**
   * The body of extractEntry and extractBookEntry: `base` the torrents folder the archive and the
   * new file are in, `volumes` a split set's other volumes (checked unchanged before and after).
   */
  private async extractUnder(
    base: string,
    archive: PlannedSource,
    volumes: PlannedSource[],
    dst: string,
    size: number,
    tag: number,
    open: (
      handle: FileHandle,
      file: string | Buffer
    ) => {
      stream: NodeJS.ReadableStream;
      done: Promise<{ code: number | null; stderr: string }>;
      kill: () => void;
    }
  ): Promise<{ existed: boolean; bytes: number }> {
    const parts = dst.split('/');
    if (parts[0] !== EXTRACTED || parts.length < 3)
      throw new WriteRefused(`Not inside ${EXTRACTED}: ${dst}`);
    for (const p of parts) checkName(p);
    if (!Number.isSafeInteger(size) || size < 0) throw new WriteRefused('Bad entry size');
    if (!Number.isSafeInteger(tag) || tag < 0) throw new WriteRefused('Bad temporary name');
    const s = await this.source(archive, base);
    for (const v of volumes) await this.source(v, base);
    const dir = await this.torrentFolders(parts.slice(0, -1), base);
    const abs = path.join(dir, parts[parts.length - 1]);
    const there = await fs.lstat(abs).catch(() => null);
    if (there) {
      if (there.isFile() && there.size === size) return { existed: true, bytes: size };
      throw new WriteRefused(`A different file is already there: ${dst}`);
    }
    const temp = path.join(dir, `.ttsu-x-${tag}.partial`);
    const left = await fs.lstat(temp).catch(() => null);
    if (left) {
      if (!left.isFile()) throw new WriteRefused(`Something else is at ${temp}`);
      await fs.unlink(temp);
    }
    const input = await fs.open(s.file, constants.O_RDONLY);
    let bytes = 0;
    try {
      const out = await fs.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        this.fileMode
      );
      try {
        const run = open(input, s.file);
        let tooLong = false;
        let streamError: unknown = null;
        try {
          for await (const chunk of run.stream as AsyncIterable<Buffer>) {
            bytes += chunk.length;
            if (bytes > size) {
              tooLong = true;
              run.kill();
              break;
            }
            await out.write(chunk);
          }
        } catch (err) {
          streamError = err;
        }
        // bsdtar's exit code and messages (a passphrase, a damaged entry) once its output ended.
        const r = await run.done.catch((e: Error) => ({ code: -1, stderr: e.message }));
        if (tooLong) throw new WriteRefused(`The entry is longer than listed: ${dst}`);
        if (r.code !== 0)
          throw new WriteRefused(`bsdtar: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
        if (streamError) throw streamError;
        if (bytes !== size) throw new WriteRefused(`Unpacked ${bytes} of ${size} bytes: ${dst}`);
        await out.chmod(this.fileMode);
        await out.sync();
      } finally {
        await out.close();
      }
      const again = await fs.lstat(s.file, { bigint: true });
      if (again.ino !== s.ino || again.dev !== s.dev || Number(again.size) !== archive.size)
        throw new WriteRefused(`The archive changed while it was read: ${archive.rel}`);
      for (const v of volumes) await this.source(v, base);
      try {
        await fs.link(temp, abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        throw new WriteRefused(`Something appeared at ${dst}`);
      }
    } finally {
      await input.close();
      await fs.unlink(temp).catch(() => undefined);
    }
    return { existed: false, bytes };
  }

  // ---- WP20g: the Calibre library's import (archives under a book source folder) -------------

  /**
   * A book source folder (a pair of the import, relative to /data/torrents): every part an
   * allowed name, never the audiobooks' torrents, never inside _extracted. Only archives in it
   * are read and only its own `_extracted/` gets new files.
   */
  bookRoot(root: string): string {
    if (typeof root !== 'string' || root === '')
      throw new WriteRefused('A source folder is needed');
    const parts = root.split('/');
    for (const p of parts) checkName(p);
    if (parts[0].toLowerCase() === 'audiobooks')
      throw new WriteRefused(`Not a book source folder: ${root}`);
    if (parts.includes(EXTRACTED)) throw new WriteRefused(`Not a book source folder: ${root}`);
    return path.join(this.data, 'torrents', ...parts);
  }

  /** An archive (or a split set's .001) under a book source folder, opened read only. */
  async openBookArchive(root: string, src: PlannedSource): Promise<FileHandle> {
    if (!BOOK_ARCHIVE.test(src.rel)) throw new WriteRefused(`Not an archive: ${src.rel}`);
    const s = await this.source(src, this.bookRoot(root));
    return fs.open(s.file, constants.O_RDONLY);
  }

  /**
   * The checked path of a planned archive under a book source folder, and its volumes checked
   * unchanged (7-Zip reads a split set by its first volume's name and finds the others itself).
   */
  async bookArchivePath(
    root: string,
    src: PlannedSource,
    volumes: PlannedSource[] = []
  ): Promise<string | Buffer> {
    if (!BOOK_ARCHIVE.test(src.rel)) throw new WriteRefused(`Not an archive: ${src.rel}`);
    const base = this.bookRoot(root);
    for (const v of volumes) await this.source(v, base);
    return (await this.source(src, base)).file;
  }

  /**
   * One archive entry unpacked into `<book source folder>/_extracted/<dst>`, as extractEntry does
   * for the audiobooks (new temporary file with O_EXCL, size checked, synced, linked into place,
   * never over a name, the archive and a split set's volumes checked unchanged before and after).
   */
  async extractBookEntry(
    root: string,
    archive: PlannedSource,
    volumes: PlannedSource[],
    dst: string,
    size: number,
    tag: number,
    open: (
      handle: FileHandle,
      file: string | Buffer
    ) => {
      stream: NodeJS.ReadableStream;
      done: Promise<{ code: number | null; stderr: string }>;
      kill: () => void;
    }
  ): Promise<{ existed: boolean; bytes: number }> {
    if (!BOOK_ARCHIVE.test(archive.rel)) throw new WriteRefused(`Not an archive: ${archive.rel}`);
    if (volumes.length > 999) throw new WriteRefused('Too many volumes');
    for (const v of volumes)
      if (!/\.\d{3}$/.test(v.rel)) throw new WriteRefused(`Not a volume: ${v.rel}`);
    return this.extractUnder(this.bookRoot(root), archive, volumes, dst, size, tag, open);
  }

  // ---- WP21f-2: changes to books already in the library -------------------------------------

  /**
   * A book folder of the library (`japanese/…` or `japanese-generated/…`, at least the root,
   * an author and the book), checked real and inside media/audiobooks, and holding at least one
   * file that is not Audiobookshelf's own (an author or series folder is never a book).
   */
  private async libraryBook(book: string | string[], roots: readonly string[]): Promise<string> {
    const parts = Array.isArray(book) ? book : destination(book, roots);
    if (!roots.includes(parts[0]) || parts.length < 3)
      throw new WriteRefused(`Not a book folder: ${parts.join('/')}`);
    const abs = await this.realFolders(parts);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (!entries.some((e) => e.isFile() && !ABS_OWN.test(e.name) && !e.name.startsWith('.')))
      throw new WriteRefused(`Not a book folder (no file of its own): ${book}`);
    return abs;
  }

  /**
   * A built book's metadata.json replaced with new bytes: only when the file there is still the
   * one the server read when it planned the change (`expectSha256`: what we wrote, or
   * Audiobookshelf's rewrite of it, or your edit through ABS), so an edit made since is never
   * overwritten. The new bytes go to a temporary file (O_EXCL, fsync) that is renamed over it in
   * one step. The same bytes already there count as done.
   */
  async replaceBookMetadata(
    book: string,
    bytes: Buffer,
    expectSha256: string,
    tag: number
  ): Promise<{ existed: boolean }> {
    if (!Number.isSafeInteger(tag) || tag < 0) throw new WriteRefused('Bad temporary name');
    if (bytes.length > MAX_METADATA_BYTES) throw new WriteRefused('metadata.json too large');
    if (!/^[0-9a-f]{64}$/.test(expectSha256)) throw new WriteRefused('Bad expected hash');
    const dir = await this.libraryBook(book, ARRIVAL_ROOTS);
    const abs = path.join(dir, METADATA_NAME);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new WriteRefused(`No ${METADATA_NAME} to replace: ${book}`);
    const now = await fs.readFile(abs);
    if (now.equals(bytes)) return { existed: true };
    if (createHash('sha256').update(now).digest('hex') !== expectSha256)
      throw new WriteRefused(`${METADATA_NAME} changed since it was read (an edit?): ${book}`);
    const temp = path.join(dir, `.ttsu-link-${tag}.partial`);
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
    await fs.rename(temp, abs);
    if (!(await fs.readFile(abs)).equals(bytes))
      throw new WriteRefused(`${METADATA_NAME} is not the new bytes: ${book}`);
    return { existed: false };
  }

  /**
   * A book folder of `japanese/` moved to another path in `japanese/` (another author, series,
   * volume number or title): `from` must be the planned folder (inode), a book; `to` must not
   * exist. Missing parents of `to` are made; an existing parent that holds a file (a book) is
   * never used. Never across to another root, never over an existing name. `to` may be this
   * module's temporary name `.ttsu-move-<n>` in the same parent (a cycle of renames); a folder
   * under a temporary name goes on only within that parent: to a sibling, or into a new folder
   * there (1.4.2, WP21g: a book whose series is named as itself, 作者/本 → 作者/.ttsu-move-1 →
   * 作者/本/Vol 1 - 本). `to` already the planned folder and `from` gone counts as done.
   */
  async renameBookFolder(from: string, to: string, ino: number): Promise<{ existed: boolean }> {
    const fparts = movePath(from);
    const tparts = movePath(to);
    const temp = (ps: string[]) => MOVE_TEMP.test(ps[ps.length - 1]);
    const parentOf = (ps: string[]) => ps.slice(0, -1).join('/');
    if (
      (temp(tparts) && parentOf(fparts) !== parentOf(tparts)) ||
      (temp(fparts) &&
        !temp(tparts) &&
        !(
          tparts.length > fparts.length - 1 &&
          tparts.slice(0, fparts.length - 1).join('/') === parentOf(fparts)
        ))
    )
      throw new WriteRefused(`A temporary name stays in the same folder: ${from} -> ${to}`);
    if (fparts.length < 3 || tparts.length < 3)
      throw new WriteRefused(`Not a book folder: ${from} -> ${to}`);
    if (to === from || to.startsWith(from + '/'))
      throw new WriteRefused(`Not a move: ${from} -> ${to}`);
    if (!Number.isFinite(ino) || ino <= 0) throw new WriteRefused('Bad inode');
    const src = path.join(this.media, ...fparts);
    const dst = path.join(this.media, ...tparts);
    const d = await fs.lstat(dst, { bigint: true }).catch(() => null);
    const s = await fs.lstat(src, { bigint: true }).catch(() => null);
    if (d && !d.isSymbolicLink() && d.isDirectory() && Number(d.ino) === ino && !s)
      return { existed: true };
    if (!s) throw new WriteRefused(`The folder to move is missing: ${from}`);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new WriteRefused(`Not a real folder: ${from}`);
    await this.libraryBook(fparts, [LIBRARY_ROOT]);
    if (Number(s.ino) !== ino) throw new WriteRefused(`Not the planned folder (inode): ${from}`);
    if (d) throw new WriteRefused(`Something is already there: ${to}`);
    // The new parents: made when missing; an existing one must be a plain folder (no file).
    let cur = await this.realFolders(tparts.slice(0, 1));
    for (let i = 1; i < tparts.length - 1; i++) {
      cur = path.join(cur, tparts[i]);
      const st = await fs.lstat(cur).catch(() => null);
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory())
          throw new WriteRefused(`Not a real folder: ${tparts.slice(0, i + 1).join('/')}`);
        for (const e of await fs.readdir(cur, { withFileTypes: true }))
          if (!e.isDirectory() && !e.name.startsWith('.'))
            throw new WriteRefused(
              `A book's folder can't hold another book: ${tparts.slice(0, i + 1).join('/')}`
            );
        continue;
      }
      try {
        await fs.mkdir(cur, { mode: this.dirMode });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      await fs.chmod(cur, this.dirMode);
    }
    await this.inside(this.media, cur, 'media/audiobooks');
    await fs.rename(src, dst);
    const after = await fs.lstat(dst, { bigint: true });
    if (Number(after.ino) !== ino)
      throw new WriteRefused(`The moved folder is not the planned one: ${to}`);
    return { existed: false };
  }

  /**
   * An author or series folder of `japanese/` that a move left empty, removed (rmdir: only an
   * empty folder; never the root, never a book). Already gone counts as done; a folder that
   * holds anything stays (returned as not removed).
   */
  async removeEmptyFolder(dir: string): Promise<{ removed: boolean; existed: boolean }> {
    const parts = destination(dir, [LIBRARY_ROOT]);
    if (parts.length < 2) throw new WriteRefused(`Not a folder inside ${LIBRARY_ROOT}: ${dir}`);
    const abs = path.join(this.media, ...parts);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return { removed: false, existed: false };
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new WriteRefused(`Not a real folder: ${dir}`);
    await this.realFolders(parts);
    if ((await fs.readdir(abs)).length > 0) return { removed: false, existed: true };
    try {
      await fs.rmdir(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return { removed: false, existed: true };
      throw err;
    }
    return { removed: true, existed: true };
  }

  /**
   * A file the reader wrote in `japanese-generated/` (an AI book) or `japanese-merged/` (a merge)
   * gets its original name under torrents/audiobooks/japanese/AI/ or _merged/ at the same path
   * inside: link() of the planned, unchanged file (size, mtime, device, inode), its folders made
   * on the way, never over a name. The reader's own path stays as it is. The same file already
   * there counts as done.
   */
  async linkReaderFile(
    src: PlannedMediaEntry
  ): Promise<{ existed: boolean; dst: string; dev: number; ino: number }> {
    const sparts = relParts(src.rel, src.raw);
    const into = READER_ROOTS[sparts[0]];
    if (!into || sparts.length < 2) throw new WriteRefused(`Not a reader-written file: ${src.rel}`);
    for (const p of sparts) checkName(p);
    const file = below(this.media, src.rel, src.raw);
    await this.realFolders(sparts.slice(0, -1));
    const st = await fs.lstat(file, { bigint: true }).catch(() => null);
    if (!st || !st.isFile()) throw new WriteRefused(`Not a file: ${src.rel}`);
    const changed = differences(st, src);
    if (changed.length) throw new WriteRefused(`changed (${changed.join(', ')}): ${src.rel}`);
    const dparts = [into, ...sparts.slice(1)];
    const dir = await this.torrentFolders(dparts.slice(0, -1));
    const abs = path.join(dir, dparts[dparts.length - 1]);
    let existed = false;
    try {
      await fs.link(file, abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      existed = true;
    }
    const d = await fs.lstat(abs, { bigint: true });
    if (!d.isFile() || d.dev !== st.dev || d.ino !== st.ino)
      throw new WriteRefused(
        existed
          ? `A different file is already there: ${dparts.join('/')}`
          : `The new name is not the file: ${dparts.join('/')}`
      );
    const again = await fs.lstat(file, { bigint: true });
    if (differences(again, src).length)
      throw new WriteRefused(`The file changed while it was linked: ${src.rel}`);
    return { existed, dst: dparts.join('/'), dev: Number(d.dev), ino: Number(d.ino) };
  }

  /**
   * One audio link inside a book folder of `japanese/` renamed in the same folder (the story
   * order's numbered names, `01 タイトル.mp3`): `from` must be the planned file (inode), `to` a
   * new name; never metadata.json or a cover, never another folder, never over a name. The
   * torrents' own name of the file is not touched (a hard link has its own names). `to` already
   * the planned file and `from` gone counts as done.
   */
  async renameBookFile(
    book: string,
    from: string,
    to: string,
    ino: number
  ): Promise<{ existed: boolean }> {
    const dir = await this.libraryBook(book, [LIBRARY_ROOT]);
    const fparts = from.split('/');
    const tparts = to.split('/');
    for (const p of [...fparts, ...tparts]) checkName(p);
    if (
      fparts.length !== tparts.length ||
      fparts.slice(0, -1).join('/') !== tparts.slice(0, -1).join('/')
    )
      throw new WriteRefused(`A file is renamed in its own folder only: ${from} -> ${to}`);
    if (fparts.length > 2) throw new WriteRefused(`Too deep inside the book: ${from}`);
    for (const n of [fparts[fparts.length - 1], tparts[tparts.length - 1]])
      if (ABS_OWN.test(n) || n === METADATA_NAME) throw new WriteRefused(`Not an audio link: ${n}`);
    if (!Number.isFinite(ino) || ino <= 0) throw new WriteRefused('Bad inode');
    const parent =
      fparts.length === 2
        ? await this.realFolders([...destination(book, [LIBRARY_ROOT]), fparts[0]])
        : dir;
    const src = path.join(parent, fparts[fparts.length - 1]);
    const dst = path.join(parent, tparts[tparts.length - 1]);
    const s = await fs.lstat(src, { bigint: true }).catch(() => null);
    const d = await fs.lstat(dst, { bigint: true }).catch(() => null);
    if (d && d.isFile() && Number(d.ino) === ino && !s) return { existed: true };
    if (!s || !s.isFile()) throw new WriteRefused(`The file to rename is missing: ${from}`);
    if (Number(s.ino) !== ino) throw new WriteRefused(`Not the planned file (inode): ${from}`);
    if (d) throw new WriteRefused(`Something is already there: ${to}`);
    await fs.rename(src, dst);
    const after = await fs.lstat(dst, { bigint: true });
    if (Number(after.ino) !== ino)
      throw new WriteRefused(`The renamed file is not the planned one: ${to}`);
    return { existed: false };
  }
}
