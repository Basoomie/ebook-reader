/**
 * The ONLY code that writes audiobook files (WP21e-1, design "Hard links and 'already in ABS'").
 * It runs in the linking sidecar, which mounts /mnt/disk1/data once, read-write (a hard link
 * can't cross two mounts). In WP21e-1 it can do exactly three things, each create-only:
 *
 *   makeFolder(dst)            a new folder under media/audiobooks/japanese-new/ or
 *                              media/audiobooks/japanese-generated-new/;
 *   linkFile(src, dst, stat)   a hard link there to a file under torrents/audiobooks/japanese/
 *                              that is exactly the file the plan names (size, mtime, device,
 *                              inode), never replacing anything (link() fails on an existing name);
 *   writeMetadata(dst, bytes)  a book's metadata.json in a folder there.
 *
 * Nothing else: no rename, no move, no delete (the one removal is this module's own temporary
 * `.ttsu-link-<n>.partial` file, which never has another name), no chmod or chown of a link (that
 * would change the torrent's file), nothing under the torrents, the live library, the Calibre
 * libraries or anywhere else in /data. A test reads this folder's code and fails if another
 * module calls a write function or this one gains another operation.
 */
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';

/** The two folders the build may create things in (relative to media/audiobooks). */
export const BUILD_ROOTS: readonly string[] = ['japanese-new', 'japanese-generated-new'];
export const METADATA_NAME = 'metadata.json';
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
}
