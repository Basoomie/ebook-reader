/**
 * The preflight (WP21e-1): read-only checks the sidecar makes before the build may start. Every
 * planned torrent file is looked at (lstat): it must be the file stage 1 saw, and this process
 * must be allowed to hard-link it. With fs.protected_hardlinks = 1 (most Linux systems) a user
 * may link only files it owns, or regular files it may read and write (no setuid, no setgid with
 * group execute); root may link anything. Nothing here writes.
 */
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { LinkWriter, WriteRefused, type PlannedSource } from './writer';

export interface ProcessInfo {
  uid: number | null;
  gid: number | null;
  groups: number[];
  /** /proc/sys/fs/protected_hardlinks (null: unknown, e.g. not Linux). */
  protectedHardlinks: number | null;
}

export async function processInfo(): Promise<ProcessInfo> {
  const text = await fs.readFile('/proc/sys/fs/protected_hardlinks', 'utf8').catch(() => null);
  const n = text === null ? NaN : Number(text.trim());
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    groups: typeof process.getgroups === 'function' ? process.getgroups() : [],
    protectedHardlinks: Number.isFinite(n) ? n : null
  };
}

/** Whether the kernel lets this process link a file with this owner and mode. */
export function mayLink(
  info: ProcessInfo,
  file: { uid: number; gid: number; mode: number }
): boolean {
  if (info.protectedHardlinks === 0 || info.uid === null || info.uid === 0) return true;
  if (file.uid === info.uid) return true;
  if (file.mode & 0o4000) return false;
  if (file.mode & 0o2000 && file.mode & 0o010) return false;
  const inGroup = file.gid === info.gid || info.groups.includes(file.gid);
  const bits = inGroup ? (file.mode >> 3) & 7 : file.mode & 7;
  return (bits & 6) === 6;
}

/** null when the source can be linked, else what is wrong ("missing: …", "changed (…): …", …). */
export async function inspectSource(
  writer: LinkWriter,
  src: PlannedSource,
  info: ProcessInfo
): Promise<string | null> {
  try {
    const s = await writer.source(src);
    const st = await fs.lstat(s.file);
    if (!mayLink(info, { uid: st.uid, gid: st.gid, mode: st.mode }))
      return `cannot link (owner ${st.uid}:${st.gid}, mode ${(st.mode & 0o7777).toString(8)}): ${src.rel}`;
    return null;
  } catch (err) {
    if (err instanceof WriteRefused) return err.message;
    return `unreadable: ${(err as Error).message}`.slice(0, 300);
  }
}

/** WP21f-2: one operation of a library-changes batch, as the preflight sees it. */
export interface LibraryOpCheck {
  kind: string;
  /** media/audiobooks-relative: the book folder, the folder moved, the file linked. */
  src: string | null;
  /** The target: a move's new folder (media), a reader file's name under the torrents. */
  dst: string;
}

/** The nearest folder of `abs` that exists (itself, or a parent), never above `stop`. */
async function nearestFolder(abs: string, stop: string): Promise<string> {
  let cur = abs;
  for (;;) {
    const st = await fs.lstat(cur).catch(() => null);
    if (st && st.isDirectory()) return cur;
    const up = path.dirname(cur);
    if (up === cur || !up.startsWith(stop)) return stop;
    cur = up;
  }
}

async function writable(abs: string, what: string): Promise<string | null> {
  try {
    await fs.access(abs, constants.W_OK);
    return null;
  } catch {
    const st = await fs.lstat(abs).catch(() => null);
    return `cannot write in ${what}${st ? ` (owner ${st.uid}:${st.gid}, mode ${(st.mode & 0o7777).toString(8)})` : ''}`;
  }
}

/**
 * WP21f-2 preflight (read only): whether this process may make a planned change: write access to
 * every folder a move, rename, replacement or removal changes, and, for a reader-written file,
 * that the kernel lets it hard-link the file and that it may write where its name goes.
 */
export async function inspectLibraryOp(
  writer: LinkWriter,
  op: LibraryOpCheck,
  info: ProcessInfo
): Promise<string | null> {
  const media = (rel: string) => path.join(writer.media, ...rel.split('/'));
  try {
    if (op.kind === 'reader_link' && op.src) {
      const st = await fs.lstat(media(op.src)).catch(() => null);
      if (!st || !st.isFile()) return `missing: ${op.src}`;
      if (!mayLink(info, { uid: st.uid, gid: st.gid, mode: st.mode }))
        return `cannot link (owner ${st.uid}:${st.gid}, mode ${(st.mode & 0o7777).toString(8)}): ${op.src}`;
      const target = path.join(writer.torrents, ...op.dst.split('/'));
      const near = await nearestFolder(path.dirname(target), writer.torrents);
      return writable(near, path.relative(writer.torrents, near) || 'the torrents');
    }
    if (op.kind === 'move_book' && op.src) {
      const from = media(op.src);
      for (const [p, w] of [
        [path.dirname(from), path.dirname(op.src)],
        [from, op.src]
      ] as const) {
        const e = await writable(p, w);
        if (e) return e;
      }
      const near = await nearestFolder(path.dirname(media(op.dst)), writer.media);
      return writable(near, path.relative(writer.media, near));
    }
    if ((op.kind === 'rename_file' || op.kind === 'replace_metadata') && op.src)
      return writable(media(op.src), op.src);
    if (op.kind === 'rmdir') return writable(path.dirname(media(op.dst)), path.dirname(op.dst));
    return `not a library operation: ${op.kind}`;
  } catch (err) {
    return `unreadable: ${(err as Error).message}`.slice(0, 300);
  }
}
