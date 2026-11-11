/**
 * "Export my data" (WP18): everything synced for one user, as one readable JSON file.
 *
 * Meant as a backup and as the input of a future "restore from export", so nothing is
 * left out or changed: every record of every kind, deletion markers included (a restore
 * must not bring a deleted item back), each with its kind, id, book, last writer,
 * timestamps, rev and data exactly as devices receive them. Read-only.
 *
 * Never included: tokens and token hashes, pairing codes, book and font files (backed up
 * with appdata), settings a browser keeps for itself and never syncs.
 */
import type Database from 'better-sqlite3';
import { listDevices, type Device } from '../db/devices';
import { DEFAULT_KINDS, type KindRegistry } from '../sync/kinds';
import type { SyncStore, SyncRecord } from '../sync/store';
import { SERVER_VERSION } from '../version';

export const EXPORT_FORMAT = 'ttsu-reader-export' as const;
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportedRecord extends SyncRecord {
  /** The device that alone may write this record (positions, device settings), else null. */
  ownerDeviceId: string | null;
}

export interface ExportedBook {
  title: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  sources: string[];
}

export interface DataExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  serverVersion: string;
  about: string[];
  user: { id: string; name: string };
  devices: Device[];
  counts: Record<string, { live: number; deleted: number }>;
  /** For reading the file only (a restore ignores it): the books the records name. */
  books: Record<string, ExportedBook>;
  records: Record<string, ExportedRecord[]>;
}

const ABOUT = [
  'Everything synced for this user: one list per kind of record under "records".',
  'Each record keeps its kind, id, book, deviceId (the device that wrote it last), ' +
    'ownerDeviceId (the device that alone may write it, or null), updatedAt, deletedAt, ' +
    'rev and data, exactly as the devices receive them.',
  'Times are milliseconds since 1970-01-01 UTC. A record with a deletedAt time is a ' +
    'deletion marker: the item was deleted then.',
  '"setting" records with ids "global:<key>" are shared by every device; ' +
    '"device:<device id>:<key>" belong to one device (named under "devices").',
  '"stat-session" records are the reading statistics: one per stretch of reading of a ' +
    'book on one device (day, seconds, characters, dictionary lookups). Day totals are ' +
    'their sums. "stat-session-fix" records correct or exclude one session (same id).',
  '"stat-day" records are the reading statistics per book and day from before device ' +
    'tracking (frozen; no device changes them).',
  '"books" only helps reading this file: titles of the books the records name.',
  'Not included: book and font files (they are backed up with the server data), ' +
    'tokens and pairing codes, and settings a browser keeps for itself.',
];

interface RecordRow {
  kind: string;
  id: string;
  book_id: string | null;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
  rev: number;
  data: string;
}

function bookIndex(db: Database.Database, bookIds: Set<string>): Record<string, ExportedBook> {
  const out: Record<string, ExportedBook> = {};
  const book = db.prepare(
    `SELECT b.title, b.series_index, s.name AS series
       FROM books b LEFT JOIN series s ON s.id = b.series_id WHERE b.id = ?`,
  );
  const authors = db.prepare(
    `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
      WHERE ba.book_id = ? ORDER BY ba.position`,
  );
  const sources = db.prepare(
    'SELECT DISTINCT kind FROM book_sources WHERE book_id = ? ORDER BY kind',
  );
  for (const id of [...bookIds].sort()) {
    const row = book.get(id) as
      | { title: string; series_index: number | null; series: string | null }
      | undefined;
    if (!row) continue;
    out[id] = {
      title: row.title,
      authors: (authors.all(id) as { name: string }[]).map((a) => a.name),
      series: row.series,
      seriesIndex: row.series_index,
      sources: (sources.all(id) as { kind: string }[]).map((s) => s.kind),
    };
  }
  return out;
}

export function buildExport(
  db: Database.Database,
  store: SyncStore,
  user: { id: string; name: string },
  { kinds = DEFAULT_KINDS, now = Date.now() }: { kinds?: KindRegistry; now?: number } = {},
): DataExport {
  // One read transaction, so the records, devices and counts belong together.
  return db.transaction(() => {
    const rows = db
      .prepare('SELECT * FROM sync_records WHERE user_id = ? ORDER BY kind, id')
      .all(user.id) as RecordRow[];
    const records: Record<string, ExportedRecord[]> = {};
    const counts: Record<string, { live: number; deleted: number }> = {};
    const bookIds = new Set<string>();
    for (const row of rows) {
      let owner: string | null = null;
      try {
        owner = kinds[row.kind]?.ownerOf?.(row.id) ?? null;
      } catch {
        owner = null;
      }
      const record: ExportedRecord = {
        kind: row.kind,
        id: row.id,
        bookId: row.book_id,
        deviceId: row.device_id,
        ownerDeviceId: owner,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        rev: row.rev,
        data: JSON.parse(row.data) as Record<string, unknown>,
      };
      (records[row.kind] ??= []).push(record);
      const count = (counts[row.kind] ??= { live: 0, deleted: 0 });
      if (row.deleted_at === null) count.live += 1;
      else count.deleted += 1;
      if (row.book_id) bookIds.add(row.book_id);
    }
    return {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date(now).toISOString(),
      serverVersion: SERVER_VERSION,
      about: ABOUT,
      user: { id: user.id, name: user.name },
      devices: listDevices(db, store, user.id),
      counts,
      books: bookIndex(db, bookIds),
      records,
    };
  })();
}

/** `ttsu-export-2026-11-10.json` (UTC date; the web app names the file itself). */
export function exportFileName(now = Date.now()): string {
  return `ttsu-export-${new Date(now).toISOString().slice(0, 10)}.json`;
}
