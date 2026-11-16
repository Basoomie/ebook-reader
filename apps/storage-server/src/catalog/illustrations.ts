/**
 * Season 2 §6: a book's illustrations for the book page, for a device that doesn't store
 * the book. The list is made by the reader's own import and the same rule the device
 * applies to its stored copy (the counter bundle's `illustrationsForServer`, run in a
 * short-lived child process with a time limit, one book at a time). The pictures are read
 * straight from the EPUB: the original bytes, or a webp thumbnail made with sharp.
 *
 * - Calibre files are only read (calibre/source-fs); uploads through the upload store.
 * - Everything written goes to CACHE_DIR/illustrations/<id[0:2]>/<book id>/<version>/:
 *   list.json and t<n>.webp. The version folder is named after the file's SHA-256
 *   (file_hashes, migration 18), the counter bundle's build and the import settings, so a
 *   changed file or rule gets a new folder; the book's older folders are then removed.
 * - A list that can't be made (a damaged EPUB, the time limit) is remembered until the
 *   server restarts, so the book page shows the reason instead of trying again each time.
 */
import { createHash } from 'crypto';
import { fork } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { openSourceFile } from '../calibre/source-fs';
import { COUNTER_BUNDLE, readCounterInfo, type CountImportOptions } from '../counts/counter-bundle';
import { type ReadOnlyOpener, ZipFile } from '../migration/zip-read';
import { readEntryBytes } from '../uploads/epub-meta';
import type { UploadStore } from '../uploads/upload-store';
import { fileHashes, locateCalibreFile } from './file-hashes';
import { getBookFileFor, type CatalogUser } from './queries';

export const ILLUSTRATIONS_DIRNAME = 'illustrations';
/** Thumbnail height in px (the strip shows them at most ~220 px high, sharp on 2x screens). */
export const THUMB_HEIGHT = 360;
const THUMB_QUALITY = 75;
/** Largest picture read from an EPUB. */
export const MAX_ILLUSTRATION_BYTES = 32 * 1024 * 1024;
/** How long a list request waits for a list being made before answering "preparing". */
const ANSWER_WAIT_MS = 1500;

export interface IllustrationItem {
  key: string;
  entry: string;
  beforeToc: boolean;
  width: number | null;
  height: number | null;
}

export interface StoredList {
  /** The rule version of the web code that made it. */
  rule: number;
  sha256: string;
  items: IllustrationItem[];
}

export type ListReader = (
  file: string,
  importOptions: CountImportOptions,
  timeoutMs: number,
) => Promise<{ version: number; items: IllustrationItem[] }>;

export type ListAnswer =
  | { status: 'ready'; version: string; items: IllustrationItem[] }
  | { status: 'preparing' }
  | { status: 'failed'; message: string };

export type SourceProblem = 'not_found' | 'missing' | 'file_missing' | 'off';

export type ImageAnswer =
  | { ok: true; type: string; data: Buffer }
  | { ok: false; problem: SourceProblem | 'stale' | 'changed' | 'unreadable'; message?: string };

export interface IllustrationServiceOptions {
  db: Database.Database;
  cacheDir: string;
  /** The Calibre root while the indexer is on, else null. */
  calibreDir: () => string | null;
  uploads: UploadStore | null;
  importOptions: CountImportOptions;
  timeoutMs: number;
  /** Tests: a stand-in for the child process. */
  read?: ListReader;
  /** Tests: the bundle build in the version (default: the counter bundle's header). */
  build?: string;
}

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

export function imageType(entry: string): string {
  return IMAGE_TYPES[path.extname(entry).toLowerCase()] ?? 'application/octet-stream';
}

const RUNNING_TS = path.extname(__filename) === '.ts';
const CHILD_SCRIPT = path.join(__dirname, `illustrations-child${RUNNING_TS ? '.ts' : '.js'}`);
const CHILD_EXEC_ARGV = RUNNING_TS ? ['-r', 'ts-node/register/transpile-only'] : [];
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/** Reads a book's illustrations list with the counter bundle in a child process. */
export const readIllustrations: ListReader = (file, importOptions, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [COUNTER_BUNDLE], {
      cwd: SERVER_ROOT,
      execArgv: [...CHILD_EXEC_ARGV, '--max-old-space-size=2048'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Lower priority is a nicety only.
    }
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000);
    });
    let settled = false;
    const done = (err: Error | null, list?: { version: number; items: IllustrationItem[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (err) reject(err);
      else resolve(list!);
    };
    const timer = setTimeout(
      () => done(new Error(`Reading the book took longer than ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    child.on(
      'message',
      (m: {
        ok: boolean;
        list?: { version: number; items: IllustrationItem[] };
        message?: string;
      }) => {
        if (m.ok && m.list) done(null, m.list);
        else done(new Error(`The book could not be read: ${m.message ?? 'unknown error'}`));
      },
    );
    child.on('error', (err) => done(err));
    child.on('exit', (code) => {
      const last = stderr.trim().split(/\r?\n/).pop();
      done(new Error(`The book could not be read (exit ${code}${last ? `: ${last}` : ''})`));
    });
    child.send({ file, options: importOptions });
  });

interface Source {
  ok: true;
  file: string;
  opener: ReadOnlyOpener;
  sha256: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class IllustrationService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly read: ListReader;
  private buildId: string | null;

  constructor(private readonly options: IllustrationServiceOptions) {
    this.read = options.read ?? readIllustrations;
    this.buildId = options.build ?? null;
  }

  private build(): string {
    if (this.buildId === null) this.buildId = readCounterInfo().build;
    return this.buildId;
  }

  /** The cache folder name for a file: changes with the file, the bundle and the import. */
  version(sha256: string): string {
    const { importHTMLFixMode, restrictImportFixToAnchor } = this.options.importOptions;
    return createHash('sha1')
      .update(`${sha256}|${this.build()}|${importHTMLFixMode}|${restrictImportFixToAnchor}`)
      .digest('hex')
      .slice(0, 16);
  }

  bookDir(bookId: string): string {
    return path.join(this.options.cacheDir, ILLUSTRATIONS_DIRNAME, bookId.slice(0, 2), bookId);
  }

  private async source(
    user: CatalogUser,
    bookId: string,
  ): Promise<Source | { ok: false; problem: SourceProblem }> {
    const { db, uploads } = this.options;
    const location = getBookFileFor(db, user, bookId);
    if (!location) return { ok: false, problem: 'not_found' };
    if (location.missing) return { ok: false, problem: 'missing' };
    let file: string;
    let opener: ReadOnlyOpener;
    if (location.kind === 'upload') {
      if (!uploads) return { ok: false, problem: 'off' };
      file = uploads.resolve(location.filePath);
      opener = uploads.openFile;
    } else {
      const calibreDir = this.options.calibreDir();
      if (!calibreDir) return { ok: false, problem: 'off' };
      const found = await locateCalibreFile(calibreDir, location);
      if (!found) return { ok: false, problem: 'file_missing' };
      file = found.file;
      opener = openSourceFile;
    }
    const [hash] = await fileHashes(db, user, [bookId], {
      calibreDir: this.options.calibreDir(),
      uploadSize: async (filePath) =>
        uploads ? ((await uploads.stat(filePath).catch(() => null))?.size ?? null) : null,
    });
    if (!hash?.sha256) return { ok: false, problem: 'file_missing' };
    return { ok: true, file, opener, sha256: hash.sha256 };
  }

  private async stored(bookId: string, version: string): Promise<StoredList | null> {
    try {
      const text = await fs.readFile(path.join(this.bookDir(bookId), version, 'list.json'), 'utf8');
      return JSON.parse(text) as StoredList;
    } catch {
      return null;
    }
  }

  /** The book's list: ready, still being made, or why it couldn't be made. */
  async list(
    user: CatalogUser,
    bookId: string,
  ): Promise<ListAnswer | { status: 'problem'; problem: SourceProblem }> {
    const src = await this.source(user, bookId);
    if (!src.ok) return { status: 'problem', problem: src.problem };
    const version = this.version(src.sha256);
    const answer = async (): Promise<ListAnswer | null> => {
      const stored = await this.stored(bookId, version);
      if (stored) return { status: 'ready', version, items: stored.items };
      const failure = this.failed.get(version);
      return failure ? { status: 'failed', message: failure } : null;
    };
    const first = await answer();
    if (first) return first;
    const job = this.running.get(version) ?? this.start(bookId, version, src);
    await Promise.race([job, delay(ANSWER_WAIT_MS)]);
    return (await answer()) ?? { status: 'preparing' };
  }

  private start(bookId: string, version: string, src: Source): Promise<void> {
    const job = this.queue
      .then(() => this.make(bookId, version, src))
      .finally(() => this.running.delete(version));
    this.running.set(version, job);
    this.queue = job.catch(() => undefined);
    return job.catch(() => undefined);
  }

  private async make(bookId: string, version: string, src: Source): Promise<void> {
    try {
      const made = await this.read(src.file, this.options.importOptions, this.options.timeoutMs);
      const list: StoredList = { rule: made.version, sha256: src.sha256, items: made.items };
      const dir = path.join(this.bookDir(bookId), version);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `list.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(list));
      await fs.rename(tmp, path.join(dir, 'list.json'));
      // The book's lists for an earlier file, bundle or import setting.
      for (const other of await fs.readdir(this.bookDir(bookId)).catch(() => [] as string[])) {
        if (other !== version) {
          await fs.rm(path.join(this.bookDir(bookId), other), { recursive: true, force: true });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      this.failed.set(version, message);
      console.error(`Illustrations: book ${bookId} could not be read: ${message}`);
    }
  }

  /** One picture of a list: the original bytes, or its webp thumbnail. */
  async image(
    user: CatalogUser,
    bookId: string,
    version: string,
    n: number,
    kind: 'thumb' | 'full',
  ): Promise<ImageAnswer> {
    if (!/^[0-9a-f]{16}$/.test(version)) return { ok: false, problem: 'stale' };
    const stored = await this.stored(bookId, version);
    const item = stored?.items[n];
    if (!stored || !item) return { ok: false, problem: 'stale' };
    const thumbFile = path.join(this.bookDir(bookId), version, `t${n}.webp`);
    if (kind === 'thumb') {
      const cached = await fs.readFile(thumbFile).catch(() => null);
      if (cached) return { ok: true, type: 'image/webp', data: cached };
    }
    const src = await this.source(user, bookId);
    if (!src.ok) return { ok: false, problem: src.problem };
    if (src.sha256 !== stored.sha256) return { ok: false, problem: 'changed' };
    let bytes: Buffer;
    try {
      const zip = await ZipFile.open(src.file, src.opener);
      let entry;
      try {
        entry = zip.get(item.entry);
      } finally {
        await zip.close();
      }
      if (!entry)
        return { ok: false, problem: 'unreadable', message: 'The picture is not in the book' };
      bytes = await readEntryBytes(src.file, src.opener, entry, MAX_ILLUSTRATION_BYTES);
    } catch (err) {
      return { ok: false, problem: 'unreadable', message: (err as Error).message };
    }
    if (kind === 'full') return { ok: true, type: imageType(item.entry), data: bytes };
    let thumb: Buffer;
    try {
      thumb = await sharp(bytes)
        .resize({ height: THUMB_HEIGHT, withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toBuffer();
    } catch (err) {
      return { ok: false, problem: 'unreadable', message: (err as Error).message };
    }
    const tmp = `${thumbFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, thumb);
    await fs.rename(tmp, thumbFile);
    return { ok: true, type: 'image/webp', data: thumb };
  }
}
