/**
 * The preflight (WP21e-1): read-only checks the sidecar makes before the build may start. Every
 * planned torrent file is looked at (lstat): it must be the file stage 1 saw, and this process
 * must be allowed to hard-link it. With fs.protected_hardlinks = 1 (most Linux systems) a user
 * may link only files it owns, or regular files it may read and write (no setuid, no setgid with
 * group execute); root may link anything. Nothing here writes.
 */
import fs from 'fs/promises';
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
