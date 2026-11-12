/**
 * Audiobook and subtitle scanner (WP15a). For every library with an audio or
 * subtitle folder set (`cli library set <id> --audio-dir japanese --subtitle-dir
 * japanese-srt`), it walks that folder under the audiobooks root and
 * records:
 * - each folder that directly holds audio files (`.m4b`, `.m4a`, `.mp3`): the unit a
 *   book links to. Series are folders of volume folders, so the walk is recursive.
 *   `_Archives/` and dot folders are skipped. Audiobookshelf's metadata.json is read
 *   when present (series and sequence help the matcher).
 * - each subtitle file (`.srt`, `.vtt`, `.ass`) anywhere under the subtitle folder.
 *   Archives (`.zip`, `.rar`, `.7z`) are only counted.
 * Then it measures durations from the file headers, folder by folder.
 *
 * Runs at start, every AUDIO_SCAN_HOURS, and when asked (API or CLI). Reads only
 * through audio-fs.ts; never writes. (WP15f: the only writer is audio-write.ts; after a
 * merge, rescanFolder re-indexes that one folder.)
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { listLibraries, type Library } from '../calibre/libraries';
import type { AudioConfig } from '../config';
import { isInside } from '../db/database';
import {
  isFolder,
  isWritable,
  openAudioReader,
  readFolder,
  readSmallFile,
  resolveInsideAudio,
  statAudioFile,
} from './audio-fs';
import {
  type AudioFileEntry,
  type AudioFolder,
  countPresent,
  getAudioFolder,
  foldersNeedingDurations,
  getScanState,
  markUnseenMissing,
  setFolderFiles,
  updateScanState,
  upsertAudioFolder,
  upsertSubtitleFile,
} from './audio-index';
import { audioDuration } from './media-duration';
import {
  ARCHIVE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  baseName,
  entryKeys,
  extractVolume,
  isSkippedFolder,
  parseAbsSeries,
  SUBTITLE_EXTENSIONS,
} from './match';

export interface AudioStatus {
  enabled: boolean;
  /** Why audio linking is off, or null. */
  error: string | null;
  /** WP15f: whether this process may create files in the audiobooks folder (merging). */
  writable: boolean;
}

export interface AudioScanOptions {
  db: Database.Database;
  config: AudioConfig;
  /** Folders the audiobooks root must not overlap (nothing is written near it). */
  otherDirs: { name: string; dir: string | null }[];
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
  now?: () => number;
}

/** A walk never goes deeper than this below a library's audio folder. */
const MAX_DEPTH = 12;
const METADATA_JSON = 'metadata.json';
const METADATA_MAX_BYTES = 512 * 1024;

const ext = (name: string) => path.extname(name).toLowerCase();

/** Checks the setup before anything is read. Returns why scanning can't run, or null. */
export async function checkAudioConfig(
  config: AudioConfig,
  otherDirs: { name: string; dir: string | null }[],
): Promise<string | null> {
  const { dir } = config;
  if (!dir) return 'AUDIOBOOKS_DIR is not set';
  if (!(await isFolder(dir))) return `AUDIOBOOKS_DIR does not exist: ${dir}`;
  for (const other of otherDirs) {
    if (!other.dir) continue;
    if (isInside(dir, other.dir) || isInside(other.dir, dir)) {
      return `${other.name} (${other.dir}) and AUDIOBOOKS_DIR (${dir}) overlap; nothing may be written near the audiobooks`;
    }
  }
  return null;
}

interface ScanCounts {
  folders: number;
  subtitles: number;
  archives: number;
}

export class AudioScanService {
  readonly status: AudioStatus = { enabled: false, error: 'not started', writable: false };
  private readonly db: Database.Database;
  private readonly config: AudioConfig;
  private readonly opts: AudioScanOptions;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: AudioScanOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.config = opts.config;
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.now = opts.now ?? Date.now;
  }

  get root(): string {
    return this.config.dir!;
  }

  /** Validates the setup and, if usable, runs a first pass and starts the poll timer. */
  async start({ timer = true }: { timer?: boolean } = {}): Promise<void> {
    const problem = await checkAudioConfig(this.config, this.opts.otherDirs);
    if (problem) {
      this.status.enabled = false;
      this.status.error = problem;
      this.log(`Audiobooks: off: ${problem}`);
      return;
    }
    this.status.enabled = true;
    this.status.error = null;
    this.status.writable = await isWritable(this.root);
    this.log(
      `Audiobooks: on, folder ${this.root} (${this.status.writable ? 'writable: merged files only' : 'read-only: merging is off'})`,
    );
    this.wake();
    if (timer && !this.stopped) {
      this.timer = setInterval(() => this.wake(), this.config.pollSeconds * 1000);
      this.timer.unref?.();
    }
  }

  /** Runs a pass (coalesced): scans every library that asked for it or is due. */
  wake(): void {
    if (!this.status.enabled || this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = this.tick()
      .catch((err) => this.logError('Audiobooks: scan pass failed:', err))
      .finally(() => {
        this.running = null;
        if (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          this.wake();
        }
      });
  }

  /** Resolves when the current pass (if any) has finished. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
  }

  /** Libraries with an audio or subtitle folder set. */
  libraries(): Library[] {
    return listLibraries(this.db).filter((l) => l.audioDir || l.srtArchivePath);
  }

  private isDue(lib: Library): boolean {
    const state = getScanState(this.db, lib.id);
    if (state.scanRequestedAt !== null) return true;
    if (state.scannedAt === null) return true;
    if (this.config.scanHours <= 0) return false;
    return this.now() - state.scannedAt >= this.config.scanHours * 3600_000;
  }

  /** One pass: scan what is due, then measure durations still missing. */
  async tick(): Promise<void> {
    for (const lib of this.libraries()) {
      if (this.stopped) return;
      if (this.isDue(lib)) await this.scanLibrary(lib);
    }
    for (const lib of this.libraries()) {
      if (this.stopped) return;
      await this.measureDurations(lib);
    }
  }

  /** Scans one library's audio and subtitle folders. Never throws. */
  async scanLibrary(lib: Library): Promise<void> {
    const started = this.now();
    const before = getScanState(this.db, lib.id);
    updateScanState(this.db, lib.id, { status: 'scanning', scanRequestedAt: null });
    try {
      const counts: ScanCounts = { folders: 0, subtitles: 0, archives: 0 };
      if (lib.audioDir) await this.scanAudio(lib, lib.audioDir, started, counts, before.folders);
      if (lib.srtArchivePath) {
        await this.scanSubtitles(lib, lib.srtArchivePath, started, counts, before.subtitles);
      }
      updateScanState(this.db, lib.id, {
        status: 'idle',
        scannedAt: this.now(),
        folders: countPresent(this.db, 'audio_folders', lib.id),
        subtitles: countPresent(this.db, 'subtitle_files', lib.id),
        archivesSkipped: counts.archives,
        lastError: null,
        lastErrorAt: null,
      });
      this.log(
        `Audiobooks: "${lib.name}": ${counts.folders} audiobook folder(s), ${counts.subtitles} subtitle file(s)` +
          (counts.archives ? `, ${counts.archives} archive(s) skipped` : ''),
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      updateScanState(this.db, lib.id, {
        status: 'error',
        lastError: message,
        lastErrorAt: this.now(),
      });
      this.logError(`Audiobooks: scan of "${lib.name}" failed: ${message}`);
    }
  }

  private async scanAudio(
    lib: Library,
    audioDir: string,
    started: number,
    counts: ScanCounts,
    previousCount: number,
  ): Promise<void> {
    const start = resolveInsideAudio(this.root, audioDir);
    if (!(await isFolder(start))) throw new Error(`Audio folder not found: ${audioDir}`);
    await this.walk(start, 0, async (abs, dirName, parentName, entries) => {
      if (await this.indexFolder(lib, abs, dirName, parentName, entries, started)) {
        counts.folders += 1;
      }
    });
    if (counts.folders === 0 && previousCount > 0) {
      throw new Error(
        `No audiobooks found in ${audioDir} (there were ${previousCount}); nothing was marked missing. ` +
          'Is the folder mounted?',
      );
    }
    markUnseenMissing(this.db, 'audio_folders', lib.id, started, this.now());
  }

  /**
   * Records one folder that directly holds audio files (the unit a book links to).
   * Returns null when it holds none.
   */
  private async indexFolder(
    lib: Library,
    abs: string,
    dirName: string,
    parentName: string | null,
    entries: import('fs').Dirent[],
    seenAt: number,
  ): Promise<AudioFolder | null> {
    const audio = entries.filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(ext(e.name)));
    if (audio.length === 0) return null;
    const files: AudioFileEntry[] = [];
    for (const e of audio.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))) {
      const st = await statAudioFile(path.join(abs, e.name));
      if (!st) continue;
      files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs, durationSeconds: null });
    }
    if (files.length === 0) return null;
    const meta = entries.some((e) => e.isFile() && e.name === METADATA_JSON)
      ? await this.readAbsMetadata(path.join(abs, METADATA_JSON))
      : null;
    const relPath = path.relative(this.root, abs).split(path.sep).join('/');
    const sequence = meta?.series?.sequence ?? null;
    const sequenceNumber =
      sequence !== null && /^\d+(\.\d+)?$/.test(sequence) ? Number(sequence) : null;
    return upsertAudioFolder(this.db, {
      libraryId: lib.id,
      relPath,
      name: dirName,
      parentName,
      ...entryKeys(dirName),
      volume: sequenceNumber ?? extractVolume(dirName) ?? extractVolume(baseName(files[0].name)),
      metaTitle: meta?.title ?? null,
      metaSeries: meta?.series?.name ?? null,
      metaSequence: sequence,
      asin: meta?.asin ?? null,
      files,
      seenAt,
    });
  }

  /**
   * WP15f: re-indexes one already indexed folder (after a merge added a file to it) and
   * measures the durations still missing there. Returns the fresh row, or null when the
   * folder is gone or holds no audio any more.
   */
  async rescanFolder(folder: AudioFolder): Promise<AudioFolder | null> {
    const lib = listLibraries(this.db).find((l) => l.id === folder.libraryId);
    if (!lib) return null;
    const abs = resolveInsideAudio(this.root, folder.relPath);
    if (!(await isFolder(abs))) return null;
    const fresh = await this.indexFolder(
      lib,
      abs,
      folder.name,
      folder.parentName,
      await readFolder(abs),
      this.now(),
    );
    if (!fresh) return null;
    await this.measureFolder(fresh);
    return getAudioFolder(this.db, fresh.id);
  }

  private async scanSubtitles(
    lib: Library,
    subtitleDir: string,
    started: number,
    counts: ScanCounts,
    previousCount: number,
  ): Promise<void> {
    const start = resolveInsideAudio(this.root, subtitleDir);
    if (!(await isFolder(start))) throw new Error(`Subtitle folder not found: ${subtitleDir}`);
    await this.walk(start, 0, async (abs, dirName, _parent, entries) => {
      for (const e of entries) {
        if (!e.isFile()) continue;
        const x = ext(e.name);
        if (ARCHIVE_EXTENSIONS.includes(x)) counts.archives += 1;
        if (!SUBTITLE_EXTENSIONS.includes(x)) continue;
        const st = await statAudioFile(path.join(abs, e.name));
        if (!st) continue;
        const base = baseName(e.name);
        upsertSubtitleFile(this.db, {
          libraryId: lib.id,
          relPath: path.relative(this.root, path.join(abs, e.name)).split(path.sep).join('/'),
          name: e.name,
          parentName: abs === start ? null : dirName,
          ...entryKeys(base),
          volume: extractVolume(base),
          size: st.size,
          mtimeMs: st.mtimeMs,
          seenAt: started,
        });
        counts.subtitles += 1;
      }
    });
    if (counts.subtitles === 0 && previousCount > 0) {
      throw new Error(
        `No subtitle files found in ${subtitleDir} (there were ${previousCount}); nothing was marked missing.`,
      );
    }
    markUnseenMissing(this.db, 'subtitle_files', lib.id, started, this.now());
  }

  /** Depth-first walk; skips `_Archives`, dot folders and symlinks. */
  private async walk(
    abs: string,
    depth: number,
    visit: (
      abs: string,
      name: string,
      parentName: string | null,
      entries: import('fs').Dirent[],
    ) => Promise<void>,
    parentName: string | null = null,
  ): Promise<void> {
    if (this.stopped || depth > MAX_DEPTH) return;
    const entries = await readFolder(abs);
    const name = path.basename(abs);
    await visit(abs, name, parentName, entries);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !isSkippedFolder(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      await this.walk(path.join(abs, d.name), depth + 1, visit, name);
      // Lets requests in between on a large tree.
      await new Promise((r) => setImmediate(r));
    }
  }

  private async readAbsMetadata(file: string): Promise<{
    title: string | null;
    series: { name: string; sequence: string | null } | null;
    asin: string | null;
  } | null> {
    try {
      const buf = await readSmallFile(file, METADATA_MAX_BYTES);
      if (!buf) return null;
      const json = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')) as Record<
        string,
        unknown
      >;
      return {
        title: typeof json.title === 'string' && json.title.trim() ? json.title.trim() : null,
        series: parseAbsSeries(json.series),
        asin: typeof json.asin === 'string' && json.asin.trim() ? json.asin.trim() : null,
      };
    } catch {
      return null; // A broken metadata.json only means fewer hints for the matcher.
    }
  }

  /** Measures every file whose duration is still unknown. Never throws. */
  async measureDurations(lib: Library): Promise<number> {
    let measured = 0;
    for (const folder of foldersNeedingDurations(this.db, lib.id)) {
      if (this.stopped) break;
      measured += await this.measureFolder(folder);
      await new Promise((r) => setImmediate(r));
    }
    return measured;
  }

  private async measureFolder(folder: AudioFolder): Promise<number> {
    let measured = 0;
    const files = folder.files.map((f) => ({ ...f }));
    for (const file of files) {
      if (file.durationSeconds !== null || file.durationFailed) continue;
      try {
        const reader = await openAudioReader(
          resolveInsideAudio(this.root, `${folder.relPath}/${file.name}`),
        );
        try {
          file.durationSeconds = await audioDuration(reader, ext(file.name));
        } finally {
          await reader.close();
        }
      } catch {
        file.durationSeconds = null;
      }
      if (file.durationSeconds === null) file.durationFailed = true;
      measured += 1;
    }
    setFolderFiles(this.db, folder.id, files);
    return measured;
  }
}
