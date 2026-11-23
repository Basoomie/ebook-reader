/**
 * The import's archives (WP20g, decided 2026-11-17): zip, rar and 7z files and split sets
 * (.001, .002 …) in a source folder are listed and their EPUBs unpacked into
 * `<source folder>/_extracted/<archive path>/<entry path>` by the linking sidecar (1.4.0: the only
 * new files ever made under /torrents; the archives themselves are only read). Other ebook
 * formats inside an archive are listed under "Not imported" without being unpacked; anything else
 * inside is passed over. An unpacked EPUB becomes a catalog file of its own (its archive's id),
 * settled with its archive (it is complete once it appears: the sidecar links it into place only
 * after checking its size). As in WP21f-1, archives are unpacked in Preview too, so the Preview
 * shows each archive's real contents.
 *
 * Batches for the sidecar are kept in memory (one list or one entry each, with a lease): after a
 * restart they are planned again from the states in cleanup.db, and an entry already unpacked
 * counts as done (the sidecar finds it with its listed size).
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { classifyName, EXTRACTED } from './catalog';

/**
 * Ids of the import's archive batches: from 4e9, above every other batch the linking sidecar is
 * handed (the audiobooks' switch from 1e9, arrivals from 2e9, library changes from 3e9). They were
 * from 3e9 too, so the report route took the library changes' reports for archive batches, refused
 * them ("No such batch"), and a library-changes run never got past its preflight (found in WP21g's
 * e2e, 2026-11-23).
 */
export const BOOK_ARCHIVE_BATCH_BASE = 4_000_000_000;
const LEASE_MS = 30 * 60 * 1000;

export interface ArchiveRow {
  id: number;
  pair_key: string;
  rel_path: string;
  volumes_json: string;
  size: number;
  mtime_ms: number;
  dev: number | null;
  ino: number | null;
  state: string;
  encoding: string | null;
}

interface Planned {
  rel: string;
  raw: null;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface BookLinkBatch {
  id: number;
  kind: 'book_list' | 'book_extract';
  leaseSeconds: number;
  ops: {
    id: number;
    kind: 'book_list' | 'book_extract';
    root: string;
    dst: string;
    src: { rel: string; raw: null };
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    volumes: Planned[];
    entry?: { name: string; size: number; encoding: 'utf8' | 'cp932' } | null;
  }[];
}

/** Why an entry is never unpacked (unsafe or hidden). */
export function entrySkip(name: string): string | null {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const parts = name.split('/');
  if (parts.some((p) => p === '..')) return 'leaves the folder';
  if (parts[0] === '__MACOSX' || parts.some((p) => p.startsWith('._'))) return 'macOS extra';
  if (parts.some((p) => p.startsWith('.'))) return 'hidden';
  if (parts.some((p) => Buffer.byteLength(p, 'utf8') > 255)) return 'name too long';
  return null;
}

export class BookArchives {
  private batches = new Map<
    number,
    { kind: string; at: number; archiveId: number; name?: string }
  >();
  private nextId = BOOK_ARCHIVE_BATCH_BASE + (Date.now() % 1_000_000) * 100;

  constructor(
    private readonly db: Database.Database,
    /** The source folder of a pair, relative to /torrents (the sidecar's root), by pair key. */
    private readonly rootOf: (pairKey: string) => string | null,
  ) {}

  /**
   * Brings the archive rows up to date from the catalog: every settled archive (and a split set's
   * first volume with all its later volumes settled) of the pairs; a changed archive starts over.
   */
  sync(
    pairKeys: string[],
    isSettled: (row: { first_seen_at: number; mtime_ms: number }) => boolean,
    now = Date.now(),
  ): void {
    const files = this.db.prepare(
      `SELECT id, rel_path, size, mtime_ms, dev, ino, first_seen_at, kind FROM calibre_arrival_files
       WHERE pair_key = ? AND kind IN ('archive', 'volume') AND gone_at IS NULL AND archive_id IS NULL`,
    );
    const get = this.db.prepare(
      'SELECT * FROM calibre_arrival_archives WHERE pair_key = ? AND rel_path = ?',
    );
    const put = this.db.prepare(
      `INSERT INTO calibre_arrival_archives (pair_key, rel_path, volumes_json, size, mtime_ms, dev, ino, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pair_key, rel_path) DO UPDATE SET volumes_json = excluded.volumes_json, size = excluded.size,
         mtime_ms = excluded.mtime_ms, dev = excluded.dev, ino = excluded.ino, state = excluded.state,
         detail = NULL, updated_at = excluded.updated_at`,
    );
    const dropEntries = this.db.prepare(
      `DELETE FROM calibre_arrival_archive_entries WHERE archive_id = ? AND state IN ('planned', 'failed')`,
    );
    for (const pair of pairKeys) {
      const rows = files.all(pair) as {
        id: number;
        rel_path: string;
        size: number;
        mtime_ms: number;
        dev: number | null;
        ino: number | null;
        first_seen_at: number;
        kind: string;
      }[];
      const volumes = rows.filter((r) => r.kind === 'volume');
      this.db.transaction(() => {
        for (const a of rows.filter((r) => r.kind === 'archive')) {
          const split = /\.001$/i.test(a.rel_path);
          const base = a.rel_path.slice(0, -3);
          const vols = split
            ? volumes
                .filter(
                  (v) =>
                    v.rel_path.startsWith(base) && /^\d{3}$/.test(v.rel_path.slice(base.length)),
                )
                .sort((x, y) => x.rel_path.localeCompare(y.rel_path))
            : [];
          // A split set waits until its numbers run on without a gap and every volume settled.
          const numbers = vols.map((v) => Number(v.rel_path.slice(base.length)));
          const complete = numbers.every((n, i) => n === i + 2);
          const ready = isSettled(a) && vols.every((v) => isSettled(v)) && complete;
          const volumesJson = JSON.stringify(
            vols.map((v) => ({
              rel: v.rel_path,
              raw: null,
              size: v.size,
              mtimeMs: v.mtime_ms,
              dev: v.dev ?? -1,
              ino: v.ino ?? -1,
            })),
          );
          const old = get.get(pair, a.rel_path) as ArchiveRow | undefined;
          const same =
            old &&
            old.size === a.size &&
            old.mtime_ms === a.mtime_ms &&
            old.volumes_json === volumesJson;
          if (same && (old.state !== 'waiting' || !ready)) continue;
          if (old && !same) dropEntries.run(old.id);
          put.run(
            pair,
            a.rel_path,
            volumesJson,
            a.size,
            a.mtime_ms,
            a.dev,
            a.ino,
            ready ? 'new' : 'waiting',
            now,
          );
        }
      })();
    }
  }

  /** Archives still to list or unpack (the run's phase waits for these). */
  open(): { list: number; extract: number; waiting: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      list: n(`SELECT COUNT(*) AS n FROM calibre_arrival_archives WHERE state = 'new'`),
      extract: n(
        `SELECT COUNT(*) AS n FROM calibre_arrival_archive_entries WHERE state = 'planned'`,
      ),
      waiting: n(`SELECT COUNT(*) AS n FROM calibre_arrival_archives WHERE state = 'waiting'`),
    };
  }

  private planned(a: ArchiveRow): Planned {
    return {
      rel: a.rel_path,
      raw: null,
      size: a.size,
      mtimeMs: a.mtime_ms,
      dev: a.dev ?? -1,
      ino: a.ino ?? -1,
    };
  }

  /** The next batch for the linking sidecar (a list, else one entry to unpack), or null. */
  claim(now = Date.now()): BookLinkBatch | null {
    for (const [id, b] of this.batches) if (now - b.at > LEASE_MS) this.batches.delete(id);
    if (this.batches.size > 0) return null;
    const busy = new Set([...this.batches.values()].map((b) => b.archiveId));
    const list = this.db
      .prepare(`SELECT * FROM calibre_arrival_archives WHERE state = 'new' ORDER BY id LIMIT 1`)
      .get() as ArchiveRow | undefined;
    const make = (
      a: ArchiveRow,
      kind: 'book_list' | 'book_extract',
      entry?: { name: string; size: number; dst: string },
    ) => {
      const root = this.rootOf(a.pair_key);
      if (!root) return null;
      const id = this.nextId++;
      this.batches.set(id, { kind, at: now, archiveId: a.id, name: entry?.name });
      const p = this.planned(a);
      return {
        id,
        kind,
        leaseSeconds: LEASE_MS / 1000,
        ops: [
          {
            id,
            kind,
            root,
            dst: entry?.dst ?? '',
            src: { rel: p.rel, raw: null },
            size: p.size,
            mtimeMs: p.mtimeMs,
            dev: p.dev,
            ino: p.ino,
            volumes: JSON.parse(a.volumes_json) as Planned[],
            entry: entry
              ? {
                  name: entry.name,
                  size: entry.size,
                  encoding: (a.encoding === 'cp932' ? 'cp932' : 'utf8') as 'utf8' | 'cp932',
                }
              : null,
          },
        ],
      } satisfies BookLinkBatch;
    };
    if (list && !busy.has(list.id)) return make(list, 'book_list');
    const e = this.db
      .prepare(
        `SELECT e.archive_id, e.name, e.size, e.dst FROM calibre_arrival_archive_entries e
         JOIN calibre_arrival_archives a ON a.id = e.archive_id
         WHERE e.state = 'planned' AND a.state = 'listed' ORDER BY e.archive_id, e.name LIMIT 1`,
      )
      .get() as { archive_id: number; name: string; size: number; dst: string } | undefined;
    if (!e) return null;
    const a = this.db
      .prepare('SELECT * FROM calibre_arrival_archives WHERE id = ?')
      .get(e.archive_id) as ArchiveRow;
    return make(a, 'book_extract', e);
  }

  /** The sidecar's results for one of our batches (safe to send twice). */
  report(
    batchId: number,
    results: {
      id: number;
      ok: boolean;
      error?: string | null;
      bytes?: number;
      entries?: { name: string; kind: string; size: number }[];
      encoding?: 'utf8' | 'cp932';
      listProblem?: string | null;
    }[],
    now = Date.now(),
  ): { ok: true } {
    const b = this.batches.get(batchId);
    if (!b) return { ok: true };
    this.batches.delete(batchId);
    const r = results.find((x) => x.id === batchId);
    const a = this.db
      .prepare('SELECT * FROM calibre_arrival_archives WHERE id = ?')
      .get(b.archiveId) as ArchiveRow | undefined;
    if (!r || !a) return { ok: true };
    if (b.kind === 'book_list') this.takeListing(a, r, now);
    else this.takeExtract(a, b.name!, r, now);
    return { ok: true };
  }

  private setState(
    a: ArchiveRow,
    state: string,
    detail: string | null,
    now: number,
    extra: Record<string, unknown> = {},
  ) {
    this.db
      .prepare(
        `UPDATE calibre_arrival_archives SET state = ?, detail = ?, encoding = COALESCE(?, encoding),
           books = COALESCE(?, books), listed_at = COALESCE(?, listed_at), unpacked_at = COALESCE(?, unpacked_at),
           updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        detail,
        (extra.encoding as string | undefined) ?? null,
        (extra.books as number | undefined) ?? null,
        (extra.listedAt as number | undefined) ?? null,
        (extra.unpackedAt as number | undefined) ?? null,
        now,
        a.id,
      );
  }

  private takeListing(
    a: ArchiveRow,
    r: {
      entries?: { name: string; kind: string; size: number }[];
      encoding?: 'utf8' | 'cp932';
      listProblem?: string | null;
    },
    now: number,
  ): void {
    const problem = r.listProblem ?? null;
    if (problem) {
      const state = /password/i.test(problem)
        ? 'password'
        : /two encodings|can't be read as/i.test(problem)
          ? 'names'
          : /not an archive|unrecognized|Can't open|Unexpected end/i.test(problem)
            ? 'not_archive'
            : 'failed';
      this.setState(a, state, problem.slice(0, 500), now, { listedAt: now });
      return;
    }
    const entries = r.entries ?? [];
    const insertEntry = this.db.prepare(
      `INSERT INTO calibre_arrival_archive_entries (archive_id, name, size, dst, state, detail, updated_at)
       VALUES (?, ?, ?, ?, 'planned', NULL, ?)
       ON CONFLICT(archive_id, name) DO NOTHING`,
    );
    const bookRow = this.db.prepare(
      `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at, kind,
         format, archive_id, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, 'book', ?, ?, 'not_imported', 'Inside an archive (not unpacked)')
       ON CONFLICT(pair_key, rel_path, size, mtime_ms) DO NOTHING`,
    );
    let books = 0;
    this.db.transaction(() => {
      for (const e of entries) {
        if (e.kind !== 'file' || entrySkip(e.name)) continue;
        const cls = classifyName(e.name);
        const dst = `${EXTRACTED}/${a.rel_path}/${e.name}`;
        if (cls.kind === 'epub') {
          insertEntry.run(a.id, e.name, e.size, dst, now);
          books++;
        } else if (cls.kind === 'book') {
          bookRow.run(a.pair_key, dst, e.size, a.mtime_ms, now, now, cls.format, a.id);
        }
      }
    })();
    this.setState(a, books ? 'listed' : 'no_books', books ? null : 'No EPUB inside', now, {
      encoding: r.encoding ?? 'utf8',
      books,
      listedAt: now,
    });
  }

  private takeExtract(
    a: ArchiveRow,
    name: string,
    r: { ok: boolean; error?: string | null; bytes?: number },
    now: number,
  ): void {
    const e = this.db
      .prepare('SELECT * FROM calibre_arrival_archive_entries WHERE archive_id = ? AND name = ?')
      .get(a.id, name) as { name: string; size: number; dst: string } | undefined;
    if (!e) return;
    this.db.transaction(() => {
      if (!r.ok) {
        this.db
          .prepare(
            `UPDATE calibre_arrival_archive_entries SET state = 'failed', detail = ?, updated_at = ?
             WHERE archive_id = ? AND name = ?`,
          )
          .run((r.error ?? 'failed').slice(0, 500), now, a.id, name);
      } else {
        this.db
          .prepare(
            `UPDATE calibre_arrival_archive_entries SET state = 'done', detail = NULL, updated_at = ?
             WHERE archive_id = ? AND name = ?`,
          )
          .run(now, a.id, name);
        // The unpacked EPUB: a catalog file of its own, settled with its archive.
        const first = (
          this.db
            .prepare(
              `SELECT MIN(first_seen_at) AS t FROM calibre_arrival_files WHERE pair_key = ? AND rel_path = ?`,
            )
            .get(a.pair_key, a.rel_path) as { t: number | null }
        ).t;
        this.db
          .prepare(
            `INSERT INTO calibre_arrival_files (pair_key, rel_path, size, mtime_ms, first_seen_at, seen_at,
               kind, format, archive_id, outcome)
             VALUES (?, ?, ?, ?, ?, ?, 'epub', 'EPUB', ?, 'pending')
             ON CONFLICT(pair_key, rel_path, size, mtime_ms) DO NOTHING`,
          )
          .run(a.pair_key, e.dst, e.size, a.mtime_ms, first ?? now, now, a.id);
      }
      const left = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM calibre_arrival_archive_entries WHERE archive_id = ? AND state = 'planned'`,
          )
          .get(a.id) as { n: number }
      ).n;
      if (left === 0) this.setState(a, 'unpacked', null, now, { unpackedAt: now });
    })();
  }

  /** The path of an unpacked file under the sources mount (pair root + dst). */
  static unpackedPath(root: string, dst: string): string {
    return path.posix.join(root, dst);
  }
}
