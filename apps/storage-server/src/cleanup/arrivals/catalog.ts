/**
 * The import's catalog (WP20g, plan section 11): every file in a source folder, one row per
 * file version (path, size, modified time), so each file is looked at once. A file whose size or
 * modified time changes is a new version, looked at again.
 *
 * What a file is, from its name (and for a name without an extension, its first bytes):
 *   epub      an EPUB: the only format that is imported;
 *   book      another ebook or document format (AZW3, MOBI, KFX, PDF, CBZ, DjVu, files without
 *             an extension …): never imported, listed under "Not imported" with its format;
 *   archive   zip, rar, 7z and a split set's first volume (.001): unpacked into _extracted/;
 *   volume    a split set's later volume (.002 …): read with its .001;
 *   partial   a download still in progress (.parts, .part, .!qB): never opened;
 *   other     anything else (audio, images, .anki, .opf, text …): skipped without a word.
 *
 * The walk never enters hidden or system folders, nor `_extracted/` (the import's own output:
 * its files are known as archive entries). A file counts once its size and modified time have
 * not changed for the settle time (the version's first sighting and its mtime both that old).
 */
import type Database from 'better-sqlite3';
import { lstatSource, readHead, readSourceDir } from './sources-fs';

export type FileKind = 'epub' | 'book' | 'archive' | 'volume' | 'partial' | 'other';

export const EXTRACTED = '_extracted';

/** Downloads still in progress (decided 2026-11-17: never read). */
const PARTIAL = /\.(parts|part|!qb)$/i;
/** Ebook and document formats: listed under "Not imported" (decided 2026-11-17). */
const BOOK_FORMATS: Record<string, string> = {
  azw: 'AZW',
  azw3: 'AZW3',
  azw4: 'AZW4',
  mobi: 'MOBI',
  prc: 'PRC',
  kfx: 'KFX',
  kpf: 'KPF',
  pdf: 'PDF',
  cbz: 'CBZ',
  cbr: 'CBR',
  cb7: 'CB7',
  djvu: 'DjVu',
  djv: 'DjVu',
  fb2: 'FB2',
  lit: 'LIT',
  lrf: 'LRF',
  pdb: 'PDB',
};

export interface NameClass {
  kind: FileKind;
  /** A label for the page: EPUB, AZW3, "no extension", zip … */
  format: string | null;
  /** True when the first bytes decide (a name without an extension). */
  sniff: boolean;
}

/** The extension after the last dot of the last part (lower case), or '' when there is none. */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function classifyName(name: string): NameClass {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (PARTIAL.test(base)) return { kind: 'partial', format: 'download', sniff: false };
  const ext = extOf(base);
  if (ext === 'epub') return { kind: 'epub', format: 'EPUB', sniff: false };
  if (ext === 'zip' || ext === 'rar' || ext === '7z')
    return { kind: 'archive', format: ext, sniff: false };
  if (/^\d{3}$/.test(ext)) {
    if (ext === '001') return { kind: 'archive', format: 'split set', sniff: false };
    return { kind: 'volume', format: 'split set', sniff: false };
  }
  if (BOOK_FORMATS[ext]) return { kind: 'book', format: BOOK_FORMATS[ext], sniff: false };
  if (ext === '') return { kind: 'book', format: 'no extension', sniff: true };
  return { kind: 'other', format: ext, sniff: false };
}

/** What a file without an extension holds, from its first bytes. */
export function sniffFormat(head: Buffer | null): string {
  if (!head || head.length === 0) return 'no extension (empty)';
  if (head.length >= 68 && head.subarray(60, 68).toString('latin1') === 'BOOKMOBI')
    return 'no extension (MOBI by content)';
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === '%PDF')
    return 'no extension (PDF by content)';
  if (head.length >= 8 && head.subarray(0, 8).toString('latin1') === 'AT&TFORM')
    return 'no extension (DjVu by content)';
  if (
    head.length >= 58 &&
    head.subarray(0, 4).toString('latin1') === 'PK\x03\x04' &&
    head.subarray(30, 58).toString('latin1') === 'mimetypeapplication/epub+zip'
  )
    return 'no extension (EPUB by content)';
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'PK\x03\x04')
    return 'no extension (zip by content)';
  if (head.length >= 8 && head.subarray(0, 8).toString('latin1') === '\xeaDRMION\xee')
    return 'no extension (KFX by content)';
  return 'no extension';
}

/** Folders the walk never enters. */
export function skippedFolder(name: string): boolean {
  return name.startsWith('.') || name === '@eaDir' || name === '#recycle' || name === EXTRACTED;
}

/** Whether a file version has settled (unchanged for `settleMs`). */
export function settled(
  row: { first_seen_at: number; mtime_ms: number },
  now: number,
  settleMs: number,
): boolean {
  return now - row.first_seen_at >= settleMs && now - row.mtime_ms >= settleMs;
}

export interface WalkTotals {
  files: number;
  bytes: number;
  newVersions: number;
  gone: number;
  skippedFolders: number;
  rawNames: number;
  errors: string[];
}

export interface WalkOptions {
  shouldStop?: () => boolean;
  /** Waits while true (a Calibre job uses the disk). */
  shouldPause?: () => boolean;
  onFile?: (n: number) => void;
  now?: () => number;
}

const BATCH = 500;

/**
 * Walks one source folder (read only) and brings the catalog up to date: a new path or a new
 * size/mtime is a new version row (the earlier version of the path is marked gone); a seen
 * version gets its `seen_at`; versions not seen by a complete walk are marked gone (never
 * deleted), unless the folder came back empty where it had files (an unmounted share).
 * Returns null when stopped on the way (nothing is marked gone then).
 */
export async function walkSource(
  db: Database.Database,
  pairKey: string,
  root: string,
  opts: WalkOptions = {},
): Promise<WalkTotals | null> {
  const { shouldStop = () => false, shouldPause = () => false, onFile } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  const totals: WalkTotals = {
    files: 0,
    bytes: 0,
    newVersions: 0,
    gone: 0,
    skippedFolders: 0,
    rawNames: 0,
    errors: [],
  };
  const latest = db.prepare(
    `SELECT id, size, mtime_ms FROM calibre_arrival_files
     WHERE pair_key = ? AND rel_path = ? AND archive_id IS NULL AND gone_at IS NULL
     ORDER BY id DESC LIMIT 1`,
  );
  const seen = db.prepare(
    'UPDATE calibre_arrival_files SET seen_at = ?, dev = ?, ino = ? WHERE id = ?',
  );
  const supersede = db.prepare('UPDATE calibre_arrival_files SET gone_at = ? WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, dev, ino, first_seen_at,
       seen_at, kind, format, outcome)
     VALUES (@pair, @rel, @size, @mtime, @dev, @ino, @now, @now, @kind, @format, @outcome)
     ON CONFLICT(pair_key, rel_path, size, mtime_ms) DO UPDATE SET gone_at = NULL,
       seen_at = excluded.seen_at, dev = excluded.dev, ino = excluded.ino`,
  );
  type Pending = {
    rel: string;
    size: number;
    mtime: number;
    dev: number;
    ino: number;
    cls: NameClass;
    sniffed: string | null;
  };
  let pending: Pending[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    const t = now();
    db.transaction(() => {
      for (const r of rows) {
        const last = latest.get(pairKey, r.rel) as
          | { id: number; size: number; mtime_ms: number }
          | undefined;
        if (last && last.size === r.size && last.mtime_ms === r.mtime) {
          seen.run(t, r.dev, r.ino, last.id);
          continue;
        }
        if (last) supersede.run(t, last.id);
        insert.run({
          pair: pairKey,
          rel: r.rel,
          size: r.size,
          mtime: r.mtime,
          dev: r.dev,
          ino: r.ino,
          now: t,
          kind: r.cls.kind,
          format: r.sniffed ?? r.cls.format,
          outcome:
            r.cls.kind === 'partial'
              ? 'downloading'
              : r.cls.kind === 'other'
                ? 'skipped'
                : 'pending',
        });
        totals.newVersions += 1;
      }
    })();
  };
  const giveWay = async (): Promise<boolean> => {
    while (shouldPause()) {
      if (shouldStop()) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return !shouldStop();
  };

  const stack: { full: string | Buffer; rel: string }[] = [{ full: root, rel: '' }];
  while (stack.length > 0) {
    if (!(await giveWay())) {
      flush();
      return null;
    }
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readSourceDir(dir.full);
    } catch (err) {
      if (totals.errors.length < 20)
        totals.errors.push(`${dir.rel || '.'}: ${(err as Error).message}`.slice(0, 300));
      continue;
    }
    for (const e of entries) {
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      const st = await lstatSource(e.fullPath).catch(() => null);
      if (!st) continue;
      if (st.isDir) {
        if (skippedFolder(e.name)) totals.skippedFolders += 1;
        else stack.push({ full: e.fullPath, rel });
        continue;
      }
      if (!st.isFile) continue;
      if (e.name.startsWith('.')) continue;
      if (e.rawHex !== null) {
        // A name that isn't UTF-8 can't be named to Calibre or the sidecar: listed as a book file.
        totals.rawNames += 1;
      }
      const cls: NameClass =
        e.rawHex !== null
          ? { kind: 'book', format: 'name not UTF-8', sniff: false }
          : classifyName(e.name);
      let sniffed: string | null = null;
      if (cls.sniff) {
        const last = latest.get(pairKey, rel) as { size: number; mtime_ms: number } | undefined;
        if (!last || last.size !== st.size || last.mtime_ms !== st.mtimeMs)
          sniffed = sniffFormat(await readHead(e.fullPath, 68));
      }
      totals.files += 1;
      totals.bytes += st.size;
      pending.push({
        rel,
        size: st.size,
        mtime: st.mtimeMs,
        dev: st.dev,
        ino: st.ino,
        cls,
        sniffed,
      });
      if (pending.length >= BATCH) {
        flush();
        await new Promise((r) => setImmediate(r));
      }
      onFile?.(totals.files);
    }
  }
  flush();
  // Versions not seen by this complete walk are gone, unless the folder came back empty.
  const before = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM calibre_arrival_files
         WHERE pair_key = ? AND archive_id IS NULL AND gone_at IS NULL`,
      )
      .get(pairKey) as { n: number }
  ).n;
  if (totals.files === 0 && before > 0) {
    totals.errors.push('The folder looked empty: nothing was marked gone (is the share mounted?)');
    return totals;
  }
  totals.gone = db
    .prepare(
      `UPDATE calibre_arrival_files SET gone_at = ?
       WHERE pair_key = ? AND archive_id IS NULL AND gone_at IS NULL AND seen_at < ?`,
    )
    .run(now(), pairKey, started).changes;
  return totals;
}
