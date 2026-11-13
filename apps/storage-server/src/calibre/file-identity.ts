/**
 * File identity (fix-count-file-identity): a file's size and modified time, read with
 * stat only (never opened). Character counts and cover thumbnails store the identity of the
 * file they were made from, so a book whose Calibre last_modified changed (any metadata
 * edit bumps it) or whose folder moved (a title or author change) keeps its count and
 * thumbnail when the file itself is the same. Calibre writes a new file when a format is
 * added or replaced, or a cover changes, which gives it a new modified time.
 */
import fs from 'fs/promises';

export interface FileIdentity {
  bytes: number;
  /** Modified time in nanoseconds, as text (exact; the database stores it as TEXT). */
  mtimeNs: string;
  mtimeMs: number;
}

/** The identity of a file, or null when it can't be read (missing, no access). */
export async function fileIdentity(file: string): Promise<FileIdentity | null> {
  try {
    const st = await fs.stat(file, { bigint: true });
    if (!st.isFile()) return null;
    return { bytes: Number(st.size), mtimeNs: st.mtimeNs.toString(), mtimeMs: Number(st.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * Whether `now` is the file a stored result was made from. With a stored identity: same
 * size and modified time. Without one (made before migration 17): the file must be older
 * than the result, i.e. not modified after it was made.
 */
export function sameFile(
  now: FileIdentity,
  stored: { bytes: number | null; mtimeNs: string | null },
  madeAt: number,
): boolean {
  if (stored.bytes !== null && stored.mtimeNs !== null) {
    return now.bytes === stored.bytes && now.mtimeNs === stored.mtimeNs;
  }
  return now.mtimeMs < madeAt;
}
