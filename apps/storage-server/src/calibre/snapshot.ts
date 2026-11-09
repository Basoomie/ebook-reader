/**
 * Copies a Calibre metadata.db to the SSD cache with SQLite's online backup
 * API (design doc 4.1, risk R2). The indexer only ever reads the copy.
 *
 * The copy is accepted only if the source did not change while it was being
 * copied, no Calibre journal was present, and the copy passes quick_check.
 * This also covers Calibre writing from another machine over SMB, where
 * SQLite's file locks may not reach this process.
 */
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import { METADATA_DB, openSourceDatabase, readHeader, SourceStat, statFile } from './source-fs';

/** Pages copied per backup step (4 KiB pages: 400 KiB per read lock). */
const BACKUP_STEP_PAGES = 100;

/** A temporary reason not to snapshot now; the next poll retries. */
export class SnapshotSkipped extends Error {}

/** The source can't be snapshotted as it is (e.g. WAL mode); reported as a library error. */
export class SnapshotFailed extends Error {}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

export function journalFiles(metadataDb: string): string[] {
  return [`${metadataDb}-journal`, `${metadataDb}-wal`];
}

/** True when Calibre has a journal or WAL file next to metadata.db (it is mid-write). */
export async function hasJournal(metadataDb: string): Promise<boolean> {
  for (const file of journalFiles(metadataDb)) {
    if (await statFile(file)) return true;
  }
  return false;
}

export function sameStat(a: SourceStat | null, b: SourceStat | null): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface SnapshotResult {
  /** stat of the source taken before the copy (identical after it). */
  sourceStat: SourceStat;
  /** Calibre's library UUID (library_id table). */
  libraryUuid: string;
  file: string;
}

export interface SnapshotOptions {
  timeoutMs: number;
}

async function removeQuietly(file: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await fs.unlink(`${file}${suffix}`).catch(() => {});
  }
}

export async function snapshotMetadataDb(
  source: string,
  dest: string,
  { timeoutMs }: SnapshotOptions,
): Promise<SnapshotResult> {
  const before = await statFile(source);
  if (!before) throw new SnapshotSkipped(`${METADATA_DB} is not there`);
  if (await hasJournal(source)) {
    throw new SnapshotSkipped('Calibre is writing (a journal file is present)');
  }

  const header = await readHeader(source);
  if (header.length < 100 || header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    throw new SnapshotFailed(`${METADATA_DB} is not a SQLite database`);
  }
  if (header[18] === 2 || header[19] === 2) {
    throw new SnapshotFailed(
      `${METADATA_DB} is in WAL mode, which can't be read safely from a read-only mount`,
    );
  }

  const tmp = `${dest}.tmp`;
  await removeQuietly(tmp);
  try {
    const deadline = Date.now() + timeoutMs;
    const src = openSourceDatabase(source);
    try {
      await src.backup(tmp, {
        // Steps of 100 pages: each read lock lasts milliseconds, so
        // Calibre is never blocked for long. A source that keeps changing makes
        // SQLite restart the copy; the deadline stops that from running forever.
        progress: () => {
          if (Date.now() > deadline) {
            throw new SnapshotSkipped(`the copy took longer than ${timeoutMs / 1000} s`);
          }
          return BACKUP_STEP_PAGES;
        },
      });
    } finally {
      src.close();
    }

    const after = await statFile(source);
    if (!sameStat(before, after) || (await hasJournal(source))) {
      throw new SnapshotSkipped(`${METADATA_DB} changed during the copy`);
    }

    let libraryUuid: string;
    const copy = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok')
        throw new SnapshotSkipped(`the copy failed quick_check: ${String(check)}`);
      const row = copy.prepare('SELECT uuid FROM library_id LIMIT 1').get() as
        | { uuid: string }
        | undefined;
      if (!row?.uuid) throw new SnapshotFailed(`${METADATA_DB} has no library_id`);
      libraryUuid = row.uuid;
    } catch (err) {
      if (err instanceof SnapshotSkipped || err instanceof SnapshotFailed) throw err;
      throw new SnapshotFailed(
        `${METADATA_DB} does not look like a Calibre library: ${(err as Error).message}`,
      );
    } finally {
      copy.close();
    }

    await fs.rename(tmp, dest);
    return { sourceStat: before, libraryUuid, file: dest };
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}
