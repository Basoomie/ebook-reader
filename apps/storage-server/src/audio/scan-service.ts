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
  countPresentOf,
  getAudioFolder,
  getAudioFolderByPath,
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

/**
 * WP17: a library's folder of generated audiobooks, `<audio folder>-generated` (e.g.
 * japanese-generated), next to its audio folder. Same rule as audio-write.ts.
 */
export function generatedAudioDir(lib: Pick<Library, 'audioDir'>): string | null {
  return lib.audioDir ? `${lib.audioDir.replace(/\/+$/, '')}-generated` : null;
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
    updateScanState(this.db, lib.id, { status: 'scanning', scanRequestedAt: null });
    try {
      const counts: ScanCounts = { folders: 0, subtitles: 0, archives: 0 };
      // WP17: generated audiobooks first, so the missing-marking below sees them as seen.
      // Their own counters: they never hide an empty audio or subtitle folder.
      const generated: ScanCounts = { folders: 0, subtitles: 0, archives: 0 };
      await this.scanGenerated(lib, started, generated);
      const previousFolders = countPresentOf(this.db, 'audio_folders', lib.id, false);
      const previousSubtitles = countPresentOf(this.db, 'subtitle_files', lib.id, false);
      if (lib.audioDir) await this.scanAudio(lib, lib.audioDir, started, counts, previousFolders);
      if (lib.srtArchivePath) {
        await this.scanSubtitles(lib, lib.srtArchivePath, started, counts, previousSubtitles);
      } else {
        markUnseenMissing(this.db, 'subtitle_files', lib.id, started, this.now());
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
          (counts.archives ? `, ${counts.archives} archive(s) skipped` : '') +
          (generated.folders ? `, ${generated.folders} generated audiobook(s)` : ''),
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
   * WP17: walks `<audio folder>-generated/` (if it exists; it is made by the first generated
   * audiobook): every folder with audio is indexed as a generated audiobook, and the
   * subtitle files next to the audio as generated subtitles.
   */
  private async scanGenerated(lib: Library, started: number, counts: ScanCounts): Promise<void> {
    const rel = generatedAudioDir(lib);
    if (!rel) return;
    const start = resolveInsideAudio(this.root, rel);
    if (!(await isFolder(start))) return;
    await this.walk(start, 0, async (abs, dirName, parentName, entries) => {
      const folder = await this.indexFolder(lib, abs, dirName, parentName, entries, started, true);
      if (!folder) return;
      counts.folders += 1;
      counts.subtitles += await this.indexSubtitlesIn(lib, start, abs, entries, started);
    });
  }

  /** WP17: the subtitle files directly in a generated audiobook's folder. */
  private async indexSubtitlesIn(
    lib: Library,
    start: string,
    abs: string,
    entries: import('fs').Dirent[],
    seenAt: number,
  ): Promise<number> {
    let n = 0;
    for (const e of entries) {
      if (!e.isFile() || !SUBTITLE_EXTENSIONS.includes(ext(e.name))) continue;
      const file = path.join(abs, e.name);
      const st = await statAudioFile(file);
      if (!st) continue;
      this.indexSubtitle(lib, start, file, st, seenAt, true);
      n += 1;
    }
    return n;
  }

  /**
   * WP17: indexes one generated audiobook folder (just saved) and the subtitles in it, and
   * measures its durations. Returns the folder, or null when it is not under the library's
   * generated folder or holds no audio.
   */
  async rescanGeneratedFolder(libraryId: string, relPath: string): Promise<AudioFolder | null> {
    const lib = listLibraries(this.db).find((l) => l.id === libraryId);
    const rel = lib ? generatedAudioDir(lib) : null;
    if (!lib || !rel) return null;
    const start = resolveInsideAudio(this.root, rel);
    const abs = resolveInsideAudio(this.root, relPath);
    if (!isInside(start, abs) || abs === start || !(await isFolder(abs))) return null;
    const entries = await readFolder(abs);
    const now = this.now();
    const folder = await this.indexFolder(
      lib,
      abs,
      path.basename(abs),
      path.basename(path.dirname(abs)),
      entries,
      now,
      true,
    );
    if (!folder) return null;
    await this.indexSubtitlesIn(lib, start, abs, entries, now);
    await this.measureFolder(folder);
    return getAudioFolderByPath(this.db, lib.id, folder.relPath);
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
    generated = false,
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
      generated,
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

  /**
   * WP16: indexes one subtitle file (a new SubPlz result in `<subtitle folder>/_generated/`)
   * without a full scan. Returns false when the file is not there or not a subtitle file
   * under the library's subtitle folder.
   */
  async rescanSubtitleFile(libraryId: string, relPath: string): Promise<boolean> {
    const lib = listLibraries(this.db).find((l) => l.id === libraryId);
    if (!lib || !SUBTITLE_EXTENSIONS.includes(ext(relPath))) return false;
    const abs = resolveInsideAudio(this.root, relPath);
    // The subtitle folder, or (WP17) the generated audiobooks' folder.
    const roots: { start: string; generated: boolean }[] = [];
    if (lib.srtArchivePath) {
      roots.push({ start: resolveInsideAudio(this.root, lib.srtArchivePath), generated: false });
    }
    const gen = generatedAudioDir(lib);
    if (gen) roots.push({ start: resolveInsideAudio(this.root, gen), generated: true });
    const root = roots.find((r) => isInside(r.start, abs) && abs !== r.start);
    if (!root) return false;
    const st = await statAudioFile(abs);
    if (!st) return false;
    this.indexSubtitle(lib, root.start, abs, st, this.now(), root.generated);
    return true;
  }

  private indexSubtitle(
    lib: Library,
    start: string,
    abs: string,
    st: { size: number; mtimeMs: number },
    seenAt: number,
    generated = false,
  ): void {
    const name = path.basename(abs);
    const dir = path.dirname(abs);
    const base = baseName(name);
    upsertSubtitleFile(this.db, {
      libraryId: lib.id,
      relPath: path.relative(this.root, abs).split(path.sep).join('/'),
      name,
      parentName: dir === start ? null : path.basename(dir),
      ...entryKeys(base),
      volume: extractVolume(base),
      size: st.size,
      mtimeMs: st.mtimeMs,
      seenAt,
      generated,
    });
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
    await this.walk(start, 0, async (abs, _dirName, _parent, entries) => {
      for (const e of entries) {
        if (!e.isFile()) continue;
        const x = ext(e.name);
        if (ARCHIVE_EXTENSIONS.includes(x)) counts.archives += 1;
        if (!SUBTITLE_EXTENSIONS.includes(x)) continue;
        const file = path.join(abs, e.name);
        const st = await statAudioFile(file);
        if (!st) continue;
        this.indexSubtitle(lib, start, file, st, started);
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
