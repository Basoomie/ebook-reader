/**
 * The inventory walk of both audiobook roots (WP21a), shared by stages 1 and 2: every file
 * gets a row in audio_files with size, mtime, device, inode and link count. Read-only (through
 * audio-source-fs). Symlinks are recorded, never followed. A file whose path, size, mtime or
 * inode changed loses its hash. Files not seen by a complete walk are marked gone (never
 * deleted), unless a root came back empty where it had files (an unmounted share).
 */
import type Database from 'better-sqlite3';
import { lstatEntry, readDir } from './audio-source-fs';
import { decodePath } from './mojibake';
import type { RootName } from './book-units';

export const AUDIO_EXTS = new Set([
  '.m4b',
  '.m4a',
  '.mp3',
  '.mp4',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
]);
export const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z']);
/** Folders the walk never enters (counted). */
export function skippedFolder(name: string): boolean {
  return name.startsWith('.') || name === '@eaDir' || name === '#recycle';
}

export interface AudioRoots {
  torrents: string;
  library: string;
}

export interface WalkResult {
  startedAt: number;
  finishedAt: number;
  files: Record<RootName, number>;
  audio: Record<RootName, number>;
  bytes: Record<RootName, number>;
  skippedFolders: number;
  links: number;
  errors: string[];
  gone: number;
  /** Non-UTF-8 names (kept as exact bytes). */
  rawNames: number;
  /** Time spent waiting for the Calibre cleanup to finish using the disk. */
  pausedMs: number;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

const BATCH = 500;

/** One walk at a time per database (stages 1 and 2 both walk). */
const running = new WeakMap<Database.Database, Promise<unknown>>();

export function walkRoots(
  db: Database.Database,
  roots: AudioRoots,
  opts: WalkOptions = {},
): Promise<WalkResult | null> {
  const before = running.get(db) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(() => walkOnce(db, roots, opts));
  running.set(db, next);
  return next;
}

export interface WalkOptions {
  shouldStop?: () => boolean;
  /**
   * True while a Calibre job uses the disk: the walk waits (its stat and readdir calls are
   * small reads scattered over the disk and slowed Calibre stage 3 down 3-4x on the NAS,
   * measured 2026-11-17).
   */
  shouldPause?: () => boolean;
  onFile?: (n: number) => void;
}

async function walkOnce(
  db: Database.Database,
  roots: AudioRoots,
  { shouldStop = () => false, shouldPause = () => false, onFile }: WalkOptions = {},
): Promise<WalkResult | null> {
  const startedAt = Date.now();
  const result: WalkResult = {
    startedAt,
    finishedAt: 0,
    files: { torrents: 0, library: 0 },
    audio: { torrents: 0, library: 0 },
    bytes: { torrents: 0, library: 0 },
    skippedFolders: 0,
    links: 0,
    errors: [],
    gone: 0,
    rawNames: 0,
    pausedMs: 0,
  };
  /** Waits while a Calibre job uses the disk. False when stopped meanwhile. */
  const giveWay = async (): Promise<boolean> => {
    while (shouldPause()) {
      if (shouldStop()) return false;
      const t = Date.now();
      await new Promise((r) => setTimeout(r, 1000));
      result.pausedMs += Date.now() - t;
    }
    return !shouldStop();
  };
  const upsert = db.prepare(
    `INSERT INTO audio_files (root, rel_path, rel_path_raw, decoded_path, ext, kind, size, mtime_ms,
       dev, ino, nlink, first_seen_at, seen_at)
     VALUES (@root, @rel, @raw, @decoded, @ext, @kind, @size, @mtime, @dev, @ino, @nlink, @now, @now)
     ON CONFLICT(root, rel_path) DO UPDATE SET
       rel_path_raw = excluded.rel_path_raw, decoded_path = excluded.decoded_path,
       ext = excluded.ext, kind = excluded.kind,
       sha256 = CASE WHEN audio_files.size = excluded.size AND audio_files.mtime_ms = excluded.mtime_ms
                      AND audio_files.ino = excluded.ino AND audio_files.dev = excluded.dev
                     THEN audio_files.sha256 ELSE NULL END,
       hashed_at = CASE WHEN audio_files.size = excluded.size AND audio_files.mtime_ms = excluded.mtime_ms
                      AND audio_files.ino = excluded.ino AND audio_files.dev = excluded.dev
                     THEN audio_files.hashed_at ELSE NULL END,
       hash_error = CASE WHEN audio_files.size = excluded.size AND audio_files.mtime_ms = excluded.mtime_ms
                      AND audio_files.ino = excluded.ino AND audio_files.dev = excluded.dev
                     THEN audio_files.hash_error ELSE NULL END,
       hash_source = CASE WHEN audio_files.size = excluded.size AND audio_files.mtime_ms = excluded.mtime_ms
                      AND audio_files.ino = excluded.ino AND audio_files.dev = excluded.dev
                     THEN audio_files.hash_source ELSE NULL END,
       size = excluded.size, mtime_ms = excluded.mtime_ms, dev = excluded.dev, ino = excluded.ino,
       nlink = excluded.nlink, seen_at = excluded.seen_at, gone_at = NULL`,
  );
  let pending: Record<string, unknown>[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    db.transaction(() => {
      for (const r of rows) upsert.run(r);
    })();
  };
  let seen = 0;
  for (const root of ['torrents', 'library'] as const) {
    const base = roots[root];
    const stack: { full: string | Buffer; rel: string; relBytes: Buffer; raw: boolean }[] = [
      { full: base, rel: '', relBytes: Buffer.alloc(0), raw: false },
    ];
    while (stack.length) {
      if (!(await giveWay())) return null;
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readDir(dir.full);
      } catch (err) {
        result.errors.push(`${root}/${dir.rel}: ${(err as Error).message}`.slice(0, 300));
        continue;
      }
      for (const e of entries) {
        const nameBytes = e.rawHex !== null ? Buffer.from(e.rawHex, 'hex') : Buffer.from(e.name);
        const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
        const relBytes = dir.rel
          ? Buffer.concat([dir.relBytes, Buffer.from('/'), nameBytes])
          : nameBytes;
        const raw = dir.raw || e.rawHex !== null;
        if (shouldPause() && !(await giveWay())) return null;
        let st;
        try {
          st = await lstatEntry(e.fullPath);
        } catch (err) {
          result.errors.push(`${root}/${rel}: ${(err as Error).message}`.slice(0, 300));
          continue;
        }
        if (!st) continue;
        if (st.isDir) {
          if (skippedFolder(e.name)) result.skippedFolders++;
          else stack.push({ full: e.fullPath, rel, relBytes, raw });
          continue;
        }
        if (!st.isFile && !st.isLink) continue;
        const ext = extOf(e.name);
        const kind = st.isLink
          ? 'link'
          : AUDIO_EXTS.has(ext)
            ? 'audio'
            : ARCHIVE_EXTS.has(ext)
              ? 'archive'
              : 'other';
        if (kind === 'link') result.links++;
        if (raw) result.rawNames++;
        result.files[root]++;
        if (kind === 'audio') {
          result.audio[root]++;
          result.bytes[root] += st.size;
        }
        pending.push({
          root,
          rel,
          raw: raw ? relBytes.toString('hex') : null,
          decoded: decodePath(rel),
          ext,
          kind,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
          dev: st.dev,
          ino: st.ino,
          nlink: st.nlink,
          now: startedAt,
        });
        if (pending.length >= BATCH) flush();
        seen++;
        if (onFile && seen % 1000 === 0) onFile(seen);
      }
    }
    flush();
  }
  flush();
  // A root that came back empty where it had files is an unmounted share: mark nothing gone.
  const before = db
    .prepare(
      `SELECT root, COUNT(*) AS n FROM audio_files WHERE gone_at IS NULL AND seen_at < ? GROUP BY root`,
    )
    .all(startedAt) as { root: RootName; n: number }[];
  for (const b of before) {
    if (result.files[b.root] === 0 && b.n > 0) {
      result.errors.push(`The ${b.root} folder came back empty; nothing is marked gone`);
    }
  }
  if (result.errors.length === 0) {
    result.gone = db
      .prepare('UPDATE audio_files SET gone_at = ? WHERE gone_at IS NULL AND seen_at < ?')
      .run(startedAt, startedAt).changes;
  }
  result.finishedAt = Date.now();
  return result;
}
