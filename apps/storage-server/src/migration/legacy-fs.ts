/**
 * The ONLY module of the new code that reads the old file sync's folder
 * (DATA_DIR, written by the selfhost storage handler and served by legacy.ts).
 *
 * WP5 decision: the old sync's files stay untouched for rollback. Everything
 * here is read-only: one-level readdir, stat, and opening files with flag 'r'.
 * There is deliberately no write, mkdir, rename or delete in this file; keep
 * it that way (a test proves DATA_DIR is byte-identical after scan, import
 * and check).
 */
import fs from 'fs/promises';
import path from 'path';
import { isInside } from '../db/database';

/** One book folder of the old sync, as the selfhost handler laid it out. */
export interface LegacyFolder {
  folder: string;
  /** The book title on the devices (desanitized folder name); null if undecodable. */
  title: string | null;
  bookData: {
    file: string;
    characters: number;
    lastBookModified: number;
    lastBookOpen: number;
    /** More than one bookdata zip (the newest is used, as WP3a did). */
    count: number;
  } | null;
  progressFile: { file: string; modified: number } | null;
  statisticsFile: { file: string; modified: number } | null;
  hasAudioBook: boolean;
  hasSubtitles: boolean;
}

const BOOK_DATA_RE = /^bookdata_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\.zip$/;
const PROGRESS_RE = /^progress_\d+_\d+_(\d+)_[^_]*\.json$/;
const STATISTICS_RE = /^statistics_\d+_\d+_(\d+)_.*\.json$/;

/** Reverse of BaseStorageHandler.sanitizeForFilename (web app). */
export function desanitizeFolderName(name: string): string | null {
  try {
    return decodeURIComponent(name)
      .replaceAll('~ttu-star~', '*')
      .replaceAll('~ttu-dend~', '.')
      .replaceAll('~ttu-spc~', ' ');
  } catch {
    return null;
  }
}

function resolveFolder(dataRoot: string, folder: string): string {
  const full = path.resolve(dataRoot, folder);
  if (!isInside(dataRoot, full) || full === path.resolve(dataRoot) || folder.includes('/')) {
    throw new Error(`Folder leaves the old sync folder: ${folder}`);
  }
  return full;
}

/** Book folders (one level, never recursive). Dot-folders are skipped. */
export async function listLegacyFolders(dataRoot: string): Promise<string[]> {
  const entries = await fs.readdir(dataRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function newest<T extends { modified: number }>(items: T[]): T | null {
  return items.reduce<T | null>((a, b) => (a && a.modified >= b.modified ? a : b), null);
}

export async function readLegacyFolder(dataRoot: string, folder: string): Promise<LegacyFolder> {
  const dir = resolveFolder(dataRoot, folder);
  const names = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name);

  const books = names
    .map((name) => ({ name, m: BOOK_DATA_RE.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .map((x) => ({
      file: path.join(dir, x.name),
      characters: Number(x.m[3]),
      lastBookModified: Number(x.m[4]),
      lastBookOpen: Number(x.m[5]),
      modified: Number(x.m[4]),
    }));
  const book = newest(books);
  const timed = (re: RegExp) =>
    newest(
      names
        .map((name) => ({ name, m: re.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
        .map((x) => ({ file: path.join(dir, x.name), modified: Number(x.m[1]) })),
    );

  return {
    folder,
    title: desanitizeFolderName(folder),
    bookData: book
      ? {
          file: book.file,
          characters: book.characters,
          lastBookModified: book.lastBookModified,
          lastBookOpen: book.lastBookOpen,
          count: books.length,
        }
      : null,
    progressFile: timed(PROGRESS_RE),
    statisticsFile: timed(STATISTICS_RE),
    hasAudioBook: names.some((n) => n.startsWith('audioBook_')),
    hasSubtitles: names.some((n) => n.startsWith('subtitles_')),
  };
}

/** Opens a file inside DATA_DIR read-only (for the ZIP reader). */
export function openLegacyFile(dataRoot: string): (file: string) => Promise<fs.FileHandle> {
  return async (file: string) => {
    if (!isInside(dataRoot, path.resolve(file))) {
      throw new Error(`File outside the old sync folder: ${file}`);
    }
    return fs.open(file, 'r');
  };
}

/** Reads a JSON file inside DATA_DIR read-only. */
export async function readLegacyJson(dataRoot: string, file: string): Promise<unknown> {
  if (!isInside(dataRoot, path.resolve(file))) {
    throw new Error(`File outside the old sync folder: ${file}`);
  }
  return JSON.parse(await fs.readFile(file, { encoding: 'utf8', flag: 'r' }));
}

/** The old bookmark (= saved place) from a progress file. */
export interface LegacyProgress {
  exploredCharCount: number;
  progress: number | null;
  lastBookmarkModified: number;
}

export async function readLegacyProgress(
  dataRoot: string,
  file: string,
): Promise<LegacyProgress | null> {
  const raw = (await readLegacyJson(dataRoot, file)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;
  const explored = Number(raw.exploredCharCount ?? 0);
  const progressRaw = raw.progress;
  const progress =
    typeof progressRaw === 'number'
      ? progressRaw
      : typeof progressRaw === 'string' && progressRaw.trim() !== ''
        ? Number(progressRaw)
        : null;
  const modified = Number(raw.lastBookmarkModified ?? 0);
  if (!Number.isFinite(explored) || !Number.isFinite(modified)) return null;
  return {
    exploredCharCount: Math.max(0, explored),
    progress: progress !== null && Number.isFinite(progress) ? progress : null,
    lastBookmarkModified: Math.max(0, Math.floor(modified)),
  };
}

/** The old per-day statistic rows of one book. */
export interface LegacyStatistic {
  dateKey: string;
  charactersRead: number;
  readingTime: number;
  minReadingSpeed: number;
  altMinReadingSpeed: number;
  lastReadingSpeed: number;
  maxReadingSpeed: number;
  lastStatisticModified: number;
  completedBook?: number;
  completedData?: Record<string, unknown>;
}

export async function readLegacyStatistics(
  dataRoot: string,
  file: string,
): Promise<LegacyStatistic[]> {
  const raw = await readLegacyJson(dataRoot, file);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (row): row is LegacyStatistic =>
      !!row && typeof row === 'object' && typeof (row as LegacyStatistic).dateKey === 'string',
  );
}
