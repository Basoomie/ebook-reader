/**
 * The ONLY code that writes into the audiobooks folder (WP15f, decided with the user
 * 2026-11-12). Everything else there stays read-only (audio-fs.ts); a test fails if
 * another file under src/audio/ calls a write function.
 *
 * Guardrails:
 * - New files only. Every file is created with an exclusive open ('wx'), so an existing
 *   file is never opened for writing. Nothing here renames, overwrites or deletes a file
 *   it did not create itself; there is no rename at all.
 * - Only three places:
 *   1. a merged `.m4b` directly inside a present, indexed audiobook folder;
 *   2. anything under `<library subtitle folder>/_generated/` (e.g. japanese-srt/_generated/);
 *   3. anything under `<library audio folder>-generated/` (e.g. japanese-generated/).
 *   Checked on the real path (realpath), so a symlink can't lead elsewhere. Folders are
 *   created only inside 2 and 3.
 * - No partial file is ever visible under its final name. The bytes go into a hidden
 *   `.ttsu-write-<random>.partial` next to the target, recorded in `audio_writes` before
 *   it is created; once complete and fsynced it gets its final name with link() (which
 *   fails with EEXIST instead of replacing a file), then the temp name is removed. On a
 *   filesystem without hard links the final name is created directly instead (still
 *   'wx'); a failure then removes only that file, which this module created.
 * - At start, recover() removes the partial files of writes that were interrupted, using
 *   only the paths recorded in audio_writes.
 */
import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import fs, { type FileHandle } from 'fs/promises';
import path from 'path';
import { getLibrary } from '../calibre/libraries';
import { isInside } from '../db/database';
import { resolveInsideAudio } from './audio-fs';
import { getAudioFolderByRelPath } from './audio-index';

export class WriteRefused extends Error {
  readonly code = 'write_refused';
}

export class WriteAborted extends Error {
  readonly code = 'aborted';
  constructor() {
    super('Stopped');
  }
}

/** Owner, group and mode given to every new file; null = left as created. */
export interface WriteOwner {
  uid: number | null;
  gid: number | null;
  mode: number | null;
}

/** The file-system calls that differ between file systems (replaceable in tests). */
export interface WriteOps {
  link(existing: string, newPath: string): Promise<void>;
  chown(handle: FileHandle, uid: number, gid: number): Promise<void>;
  chmod(handle: FileHandle, mode: number): Promise<void>;
}

export interface AudioWriterOptions {
  db: Database.Database;
  /** The audiobooks root (AUDIOBOOKS_DIR). */
  root: string;
  owner?: WriteOwner;
  ops?: Partial<WriteOps>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Where a merged file or a generated file goes, and what it is made from. */
export type WriteSource = string | Buffer;

export interface WriteResult {
  name: string;
  /** Relative to the audiobooks root, forward slashes. */
  relPath: string;
}

export type WriteProgress = (written: number, total: number) => void;

const TEMP_PATTERN = /^\.ttsu-write-[0-9a-f]{12}\.partial$/;
/** link() errors that mean "this file system has no hard links". */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);
const CHUNK_BYTES = 1024 * 1024;
/** File names are limited to 255 bytes on the NAS (and most file systems). */
const MAX_NAME_BYTES = 250;
const MAX_MERGED_CANDIDATES = 50;

type WriteState = 'reserving' | 'writing' | 'published' | 'done' | 'cleaned';

interface WriteRow {
  id: number;
  purpose: 'merge' | 'generated';
  temp_rel_path: string;
  final_rel_path: string | null;
  direct: number;
  state: WriteState;
}

const toRel = (...parts: string[]) =>
  parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/+/g, '/');

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Cuts `s` (by characters) so that it is at most `bytes` long in UTF-8. */
function truncateBytes(s: string, bytes: number): string {
  let out = '';
  for (const ch of s) {
    if (utf8Length(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/** A file name from a folder name: no path separators, control or reserved characters. */
export function safeBaseName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || 'audiobook';
}

/** `<base>.m4b`, `<base> (merged).m4b`, `<base> (merged 2).m4b`, … */
export function mergedNameCandidates(folderName: string): string[] {
  const longestSuffix = ` (merged ${MAX_MERGED_CANDIDATES}).m4b`;
  const base = truncateBytes(safeBaseName(folderName), MAX_NAME_BYTES - utf8Length(longestSuffix));
  const names = [`${base}.m4b`, `${base} (merged).m4b`];
  for (let n = 2; n <= MAX_MERGED_CANDIDATES; n++) names.push(`${base} (merged ${n}).m4b`);
  return names;
}

function checkFileName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    /[/\\]/.test(name) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name) ||
    utf8Length(name) > 255
  ) {
    throw new WriteRefused(`Not an allowed file name: ${JSON.stringify(name)}`);
  }
}

const defaultOps: WriteOps = {
  link: (a, b) => fs.link(a, b),
  chown: (h, uid, gid) => h.chown(uid, gid),
  chmod: (h, mode) => h.chmod(mode),
};

export class AudioWriter {
  private readonly db: Database.Database;
  readonly root: string;
  private readonly owner: WriteOwner;
  private readonly ops: WriteOps;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private ownerWarned = false;

  constructor(opts: AudioWriterOptions) {
    this.db = opts.db;
    this.root = path.resolve(opts.root);
    this.owner = opts.owner ?? { uid: null, gid: null, mode: null };
    this.ops = { ...defaultOps, ...(opts.ops ?? {}) };
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
  }

  // ---------------------------------------------------------------- where

  /** Root-relative paths of a library's two folders for generated files (WP16/WP17). */
  generatedRoots(libraryId: string): { subtitles: string | null; audio: string | null } {
    const lib = getLibrary(this.db, libraryId);
    return {
      subtitles: lib?.srtArchivePath ? toRel(lib.srtArchivePath, '_generated') : null,
      audio: lib?.audioDir ? `${lib.audioDir.replace(/\/+$/, '')}-generated` : null,
    };
  }

  /** Throws unless `abs` (a folder that exists) really is inside the audiobooks root. */
  private async realInside(abs: string, within: string = this.root): Promise<string> {
    const realRoot = await fs.realpath(this.root);
    const realWithin = within === this.root ? realRoot : await fs.realpath(within);
    const real = await fs.realpath(abs);
    if (!isInside(realRoot, real) || !isInside(realWithin, real)) {
      throw new WriteRefused(`Not inside the allowed folder: ${abs}`);
    }
    return real;
  }

  /**
   * The folder a merged file goes into: a present, indexed audiobook folder inside its
   * library's audio folder. Returns its absolute path.
   */
  async checkMergedTarget(folderRelPath: string): Promise<string> {
    const folder = getAudioFolderByRelPath(this.db, folderRelPath);
    if (!folder || folder.missingAt !== null) {
      throw new WriteRefused(`Not an audiobook folder in the index: ${folderRelPath}`);
    }
    const lib = getLibrary(this.db, folder.libraryId);
    if (!lib?.audioDir)
      throw new WriteRefused(`No audio folder for this library: ${folderRelPath}`);
    let abs: string;
    let audioDir: string;
    try {
      abs = resolveInsideAudio(this.root, folder.relPath);
      audioDir = resolveInsideAudio(this.root, lib.audioDir);
    } catch {
      throw new WriteRefused(`Not inside the audiobooks folder: ${folderRelPath}`);
    }
    if (abs === audioDir || !isInside(audioDir, abs)) {
      throw new WriteRefused(`Not inside the library's audio folder: ${folderRelPath}`);
    }
    try {
      await this.realInside(abs, audioDir);
    } catch (err) {
      if (err instanceof WriteRefused) throw err;
      throw new WriteRefused(`The audiobook folder is not there: ${folderRelPath}`);
    }
    return abs;
  }

  // ---------------------------------------------------------------- what

  /**
   * Saves a merged audiobook into its own folder, under the first free name of
   * mergedNameCandidates(<folder name>). `source` is the finished file (outside the
   * audiobooks folder) or its bytes.
   */
  async createMergedFile({
    folderRelPath,
    source,
    onProgress,
    signal,
  }: {
    folderRelPath: string;
    source: WriteSource;
    onProgress?: WriteProgress;
    signal?: AbortSignal;
  }): Promise<WriteResult> {
    const dirAbs = await this.checkMergedTarget(folderRelPath);
    const folderName = path.posix.basename(folderRelPath);
    const candidates = mergedNameCandidates(folderName);
    candidates.forEach(checkFileName);
    return this.publish('merge', dirAbs, folderRelPath, candidates, source, onProgress, signal);
  }

  /**
   * WP16/WP17: a new file under a library's `<subtitle folder>/_generated/` (area
   * 'subtitles') or `<audio folder>-generated/` (area 'audio'). Folders below are created
   * as needed. A file that exists is never replaced: the call fails instead.
   */
  async createGeneratedFile({
    libraryId,
    area,
    relPath,
    source,
    onProgress,
    signal,
  }: {
    libraryId: string;
    area: 'subtitles' | 'audio';
    relPath: string;
    source: WriteSource;
    onProgress?: WriteProgress;
    signal?: AbortSignal;
  }): Promise<WriteResult> {
    const genRel = this.generatedRoots(libraryId)[area];
    if (!genRel) throw new WriteRefused(`This library has no ${area} folder`);
    const parts = relPath.split(/[/\\]/).filter((p) => p !== '' && p !== '.');
    if (parts.length === 0) throw new WriteRefused('No file name');
    parts.forEach(checkFileName);
    const name = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    let genAbs: string;
    try {
      genAbs = resolveInsideAudio(this.root, genRel);
    } catch {
      throw new WriteRefused(`Not inside the audiobooks folder: ${genRel}`);
    }
    // The generated root's parent must already exist (the library's folder, or the root).
    await this.realInside(path.dirname(genAbs));
    await this.makeFolder(genAbs, path.dirname(genAbs));
    let dirAbs = genAbs;
    for (const part of dirParts) {
      dirAbs = path.join(dirAbs, part);
      await this.makeFolder(dirAbs, genAbs);
    }
    const dirRel = toRel(genRel, ...dirParts);
    return this.publish('generated', dirAbs, dirRel, [name], source, onProgress, signal);
  }

  /** Creates one folder (never recursive) inside `within`, or accepts it if it exists. */
  private async makeFolder(abs: string, within: string): Promise<void> {
    await this.realInside(path.dirname(abs), within);
    try {
      await fs.mkdir(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = await fs.lstat(abs);
    if (!st.isDirectory()) throw new WriteRefused(`Not a folder: ${abs}`);
    await this.realInside(abs, within);
  }

  // ---------------------------------------------------------------- how

  private insertRow(purpose: WriteRow['purpose'], tempRel: string, direct: boolean): number {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO audio_writes (purpose, temp_rel_path, direct, state, created_at, updated_at)
           VALUES (?, ?, ?, 'reserving', ?, ?)`,
        )
        .run(purpose, tempRel, direct ? 1 : 0, now, now).lastInsertRowid,
    );
  }

  private setRow(id: number, state: WriteState, finalRel?: string): void {
    this.db
      .prepare(
        `UPDATE audio_writes SET state = ?, final_rel_path = COALESCE(?, final_rel_path),
           updated_at = ? WHERE id = ?`,
      )
      .run(state, finalRel ?? null, this.now(), id);
  }

  private getRow(id: number): WriteRow | null {
    return (
      (this.db.prepare('SELECT * FROM audio_writes WHERE id = ?').get(id) as
        | WriteRow
        | undefined) ?? null
    );
  }

  /**
   * Removes the file a recorded write created, and only that: the temp file of a write
   * still in progress (or published but not yet tidied), or the directly created file of
   * a write that never finished. A 'reserving' row's file is removed only when it has the
   * random temp name (the create may have succeeded just before an interruption).
   */
  private async removeOwn(id: number): Promise<void> {
    const row = this.getRow(id);
    if (!row) return;
    const isTempName = TEMP_PATTERN.test(path.posix.basename(row.temp_rel_path));
    const mayRemove =
      (row.state === 'writing' && (row.direct === 1 || isTempName)) ||
      (row.state === 'published' && row.direct === 0 && isTempName) ||
      (row.state === 'reserving' && row.direct === 0 && isTempName);
    if (mayRemove) {
      const abs = resolveInsideAudio(this.root, row.temp_rel_path);
      try {
        await fs.unlink(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (row.state !== 'done') {
      this.setRow(id, row.state === 'published' ? 'done' : 'cleaned');
    }
  }

  /** At start: removes the partial files of interrupted writes. Returns how many rows. */
  async recover(): Promise<number> {
    const rows = this.db
      .prepare(
        "SELECT * FROM audio_writes WHERE state IN ('reserving', 'writing', 'published') ORDER BY id",
      )
      .all() as WriteRow[];
    for (const row of rows) {
      try {
        await this.removeOwn(row.id);
        this.log(`Audiobooks: removed an interrupted write (${row.temp_rel_path})`);
      } catch (err) {
        this.log(
          `Audiobooks: could not remove an interrupted write (${row.temp_rel_path}): ${(err as Error).message}`,
        );
      }
    }
    return rows.length;
  }

  private async applyOwner(handle: FileHandle): Promise<void> {
    const { uid, gid, mode } = this.owner;
    try {
      if (uid !== null || gid !== null) await this.ops.chown(handle, uid ?? -1, gid ?? -1);
      if (mode !== null) await this.ops.chmod(handle, mode);
    } catch (err) {
      if (!this.ownerWarned) {
        this.ownerWarned = true;
        this.log(
          `Audiobooks: could not set the owner/mode of a new file (${(err as Error).message}); it is kept as created`,
        );
      }
    }
  }

  private async copyInto(
    handle: FileHandle,
    source: WriteSource,
    onProgress?: WriteProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    if (Buffer.isBuffer(source)) {
      if (signal?.aborted) throw new WriteAborted();
      let written = 0;
      while (written < source.length) {
        const r = await handle.write(source, written, source.length - written, written);
        written += r.bytesWritten;
      }
      onProgress?.(source.length, source.length);
      return;
    }
    const input = await fs.open(source, 'r');
    try {
      const total = (await input.stat()).size;
      const buf = Buffer.alloc(CHUNK_BYTES);
      let position = 0;
      onProgress?.(0, total);
      while (position < total) {
        if (signal?.aborted) throw new WriteAborted();
        const { bytesRead } = await input.read(buf, 0, buf.length, position);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const r = await handle.write(buf, written, bytesRead - written, position + written);
          written += r.bytesWritten;
        }
        position += bytesRead;
        onProgress?.(position, total);
      }
      if (position !== total) throw new Error('The merged file changed while it was being saved');
    } finally {
      await input.close();
    }
  }

  /** Writes into a recorded, exclusively created file; removes it again on any failure. */
  private async writeRecorded(
    rowId: number,
    abs: string,
    source: WriteSource,
    onProgress?: WriteProgress,
    signal?: AbortSignal,
  ): Promise<'created' | 'exists'> {
    let handle: FileHandle;
    try {
      handle = await fs.open(abs, 'wx');
    } catch (err) {
      this.setRow(rowId, 'cleaned');
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
    this.setRow(rowId, 'writing');
    try {
      await this.copyInto(handle, source, onProgress, signal);
      await this.applyOwner(handle);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await this.removeOwn(rowId);
      throw err;
    }
    await handle.close();
    return 'created';
  }

  private async publish(
    purpose: WriteRow['purpose'],
    dirAbs: string,
    dirRel: string,
    candidates: string[],
    source: WriteSource,
    onProgress?: WriteProgress,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const tempName = `.ttsu-write-${randomBytes(6).toString('hex')}.partial`;
    const tempAbs = path.join(dirAbs, tempName);
    const rowId = this.insertRow(purpose, toRel(dirRel, tempName), false);
    if ((await this.writeRecorded(rowId, tempAbs, source, onProgress, signal)) === 'exists') {
      throw new WriteRefused('A temporary file with the same random name exists');
    }
    try {
      for (const name of candidates) {
        if (signal?.aborted) throw new WriteAborted();
        try {
          await this.ops.link(tempAbs, path.join(dirAbs, name));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? '';
          if (code === 'EEXIST') continue;
          if (NO_HARD_LINKS.has(code)) {
            await this.removeOwn(rowId);
            this.log(`Audiobooks: no hard links here (${code}); creating the file directly`);
            return this.publishDirect(
              purpose,
              dirAbs,
              dirRel,
              candidates,
              source,
              onProgress,
              signal,
            );
          }
          throw err;
        }
        const relPath = toRel(dirRel, name);
        this.setRow(rowId, 'published', relPath);
        try {
          await this.removeOwn(rowId);
        } catch (err) {
          // The file is complete under its name; the next start removes the temp name.
          this.log(`Audiobooks: could not remove ${tempName}: ${(err as Error).message}`);
        }
        return { name, relPath };
      }
      throw new WriteRefused(
        candidates.length === 1 ? `${candidates[0]} exists already` : 'No free file name',
      );
    } catch (err) {
      await this.removeOwn(rowId);
      throw err;
    }
  }

  /** Without hard links: the final name is created directly ('wx'), and removed on failure. */
  private async publishDirect(
    purpose: WriteRow['purpose'],
    dirAbs: string,
    dirRel: string,
    candidates: string[],
    source: WriteSource,
    onProgress?: WriteProgress,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    for (const name of candidates) {
      if (signal?.aborted) throw new WriteAborted();
      const relPath = toRel(dirRel, name);
      const rowId = this.insertRow(purpose, relPath, true);
      const result = await this.writeRecorded(
        rowId,
        path.join(dirAbs, name),
        source,
        onProgress,
        signal,
      );
      if (result === 'exists') continue;
      this.setRow(rowId, 'done', relPath);
      return { name, relPath };
    }
    throw new WriteRefused(
      candidates.length === 1 ? `${candidates[0]} exists already` : 'No free file name',
    );
  }
}
