/**
 * Stage 1 analysis (plan section 3): identical-file duplicates.
 *
 * 1. Books with an EPUB from the indexer's latest metadata.db snapshot (read-only copy).
 * 2. stat of every EPUB through source-fs (read-only); group by size.
 * 3. SHA-256 only of files that share a size with another file.
 * 4. Same SHA-256 = duplicate set. Keep the copy with the most of the user's custom tags;
 *    tie: the older Calibre record (date added, then the lower id). Every other copy gets
 *    one proposed change (field 'book', present -> removed), class auto (decided with the
 *    user 2026-11-13: also with extra formats or reader data on both copies).
 *
 * Runs in small steps (the service calls step() until it says done), paced (MB/s), and
 * resumes after a restart from its saved phase and cursor. Nothing here writes outside
 * cleanup.db; Calibre is only read through source-fs.ts.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { parseCalibreDate } from '../calibre/ingest';
import { getLibrary } from '../calibre/libraries';
import { openSourceStream, resolveInside, statFile } from '../calibre/source-fs';
import { booksWithReaderData, findCalibreSource } from './handoff';
import { getSettings, isCustomTag } from './settings';
import { getStage, updateStage } from './stages';

export type Stage1Phase = 'stat' | 'hash' | 'group' | 'done';

export interface Stage1Progress {
  analysisId: string;
  phase: Stage1Phase;
  libraryId: string;
  startedAt: number;
  finishedAt: number | null;
  /** Calibre id the stat phase has reached. */
  statCursor: number;
  statDone: number;
  statTotal: number;
  statErrors: number;
  hashDone: number;
  hashTotal: number;
  bytesHashed: number;
  hashErrors: number;
  sizeGroups: number;
  duplicateSets: number;
  toRemove: number;
  keptByTags: number;
  keptByDate: number;
  extraFormat: number;
  removedWithData: number;
  bothWithData: number;
  /** Removed copies whose own tags are added to the kept copy (decided 2026-11-13). */
  tagsCopied: number;
  /**
   * For the page's progress bar and time left: when the current step began (stat or hash)
   * and how far it was then (files stat'ed, or bytes hashed), and the bytes the hash step
   * has to read. Older analyses don't have them (the page then uses startedAt and counts).
   */
  phaseStartedAt?: number;
  phaseStartDone?: number;
  hashBytesTotal?: number;
  booksWithoutEpubFile: number;
  error: string | null;
}

export interface SnapshotBook {
  calibreId: number;
  uuid: string;
  title: string;
  timestamp: number | null;
  lastModified: string | null;
  filePath: string;
  formats: string[];
  tags: string[];
}

/** Reads the books with an EPUB (and their formats and tags) from a metadata.db snapshot. */
export function readSnapshotBooks(file: string): Map<number, SnapshotBook> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.timestamp, b.last_modified, b.path, d.name AS file_name
         FROM books b JOIN data d ON d.book = b.id AND d.format = 'EPUB'
         WHERE b.uuid IS NOT NULL AND b.uuid <> '' ORDER BY b.id`,
      )
      .all() as {
      id: number;
      uuid: string;
      title: string;
      timestamp: string | null;
      last_modified: string | null;
      path: string;
      file_name: string;
    }[];
    const books = new Map<number, SnapshotBook>();
    for (const r of rows) {
      books.set(r.id, {
        calibreId: r.id,
        uuid: r.uuid,
        title: r.title,
        timestamp: parseCalibreDate(r.timestamp),
        lastModified: r.last_modified,
        filePath: `${r.path}/${r.file_name}.epub`,
        formats: [],
        tags: [],
      });
    }
    for (const f of db.prepare('SELECT book, format FROM data ORDER BY format').all() as {
      book: number;
      format: string;
    }[]) {
      books.get(f.book)?.formats.push(f.format.toUpperCase());
    }
    for (const t of db
      .prepare(
        `SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag ORDER BY t.name`,
      )
      .all() as { book: number; name: string }[]) {
      books.get(t.book)?.tags.push(t.name);
    }
    return books;
  } finally {
    db.close();
  }
}

/** Token bucket for the MB/s limit. 0 = no limit. */
export class Pacer {
  private allowance = 0;
  private last = Date.now();
  constructor(private readonly bytesPerSecond: number) {}

  async take(bytes: number): Promise<void> {
    if (this.bytesPerSecond <= 0) return;
    const now = Date.now();
    this.allowance = Math.min(
      this.bytesPerSecond,
      this.allowance + ((now - this.last) / 1000) * this.bytesPerSecond,
    );
    this.last = now;
    this.allowance -= bytes;
    if (this.allowance < 0) {
      const wait = (-this.allowance / this.bytesPerSecond) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
    }
  }
}

/** SHA-256 of a file read through source-fs (read-only), paced. */
export async function hashSourceFile(
  file: string,
  pacer: Pacer,
  shouldStop: () => boolean = () => false,
): Promise<{ sha256: string; bytes: number } | null> {
  const stream = await openSourceStream(file);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      await pacer.take(buf.length);
      if (shouldStop()) return null;
    }
  } finally {
    stream.destroy();
  }
  return { sha256: hash.digest('hex'), bytes };
}

export interface Keeper {
  keep: SnapshotBook;
  rule: 'tags' | 'older';
}

/** The copy to keep: most custom tags; tie: older record (date added, then lower id). */
export function chooseKeeper(copies: SnapshotBook[], customTags: string[]): Keeper {
  const count = (b: SnapshotBook) => b.tags.filter((t) => isCustomTag(t, customTags)).length;
  const sorted = [...copies].sort((a, b) => {
    const tags = count(b) - count(a);
    if (tags !== 0) return tags;
    const ta = a.timestamp ?? Number.MAX_SAFE_INTEGER;
    const tb = b.timestamp ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.calibreId - b.calibreId;
  });
  const keep = sorted[0];
  const maxTags = count(keep);
  const tagsDecided = copies.some((c) => count(c) !== maxTags);
  return { keep, rule: tagsDecided ? 'tags' : 'older' };
}

const STAT_CHUNK = 200;
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export interface Stage1Deps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string;
  cacheDir: string;
  log?: (m: string) => void;
}

export function emptyProgress(libraryId: string, now = Date.now()): Stage1Progress {
  return {
    analysisId: randomUUID(),
    phase: 'stat',
    libraryId,
    startedAt: now,
    finishedAt: null,
    statCursor: 0,
    statDone: 0,
    statTotal: 0,
    statErrors: 0,
    hashDone: 0,
    hashTotal: 0,
    bytesHashed: 0,
    hashErrors: 0,
    sizeGroups: 0,
    duplicateSets: 0,
    toRemove: 0,
    keptByTags: 0,
    keptByDate: 0,
    extraFormat: 0,
    removedWithData: 0,
    bothWithData: 0,
    tagsCopied: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    hashBytesTotal: 0,
    booksWithoutEpubFile: 0,
    error: null,
  };
}

export class Stage1Analysis {
  private books: Map<number, SnapshotBook> | null = null;
  private booksFor: string | null = null;

  constructor(private readonly deps: Stage1Deps) {}

  progress(): Stage1Progress | null {
    const p = getStage(this.deps.cleanup, 1).progress as unknown as Stage1Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage1Progress, state?: string): void {
    updateStage(this.deps.cleanup, 1, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  /** Starts a fresh analysis (keeps the file facts, so unchanged files aren't hashed again). */
  restart(libraryId: string): Stage1Progress {
    const p = emptyProgress(libraryId);
    this.books = null;
    this.save(p, 'analysing');
    return p;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new Error('The chosen library is not in the reader any more');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  private loadBooks(libraryId: string): Map<number, SnapshotBook> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (this.books && this.booksFor === file) return this.books;
    this.books = readSnapshotBooks(file);
    this.booksFor = file;
    return this.books;
  }

  /** Forget the cached book list (the indexer made a new snapshot). */
  invalidate(): void {
    this.books = null;
  }

  /**
   * One unit of work. Returns true when the analysis is finished (or failed). Never
   * throws: an error is recorded in the progress and the analysis stops.
   */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      if (p.phase === 'stat') p = await this.statStep(p, shouldStop);
      else if (p.phase === 'hash') p = await this.hashStep(p, shouldStop);
      else if (p.phase === 'group') p = this.groupStep(p);
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    }
  }

  private async statStep(p: Stage1Progress, shouldStop: () => boolean): Promise<Stage1Progress> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    p.statTotal = books.size;
    const ids = [...books.keys()].filter((id) => id > p.statCursor).slice(0, STAT_CHUNK);
    if (ids.length === 0) {
      p.phase = 'hash';
      // Files of this library that share a size with another present file.
      const present = new Set([...books.keys()]);
      const sizes = this.deps.cleanup
        .prepare(
          `SELECT calibre_id, size, sha256 FROM file_facts
           WHERE library_id = ? AND size IS NOT NULL AND error IS NULL`,
        )
        .all(p.libraryId) as { calibre_id: number; size: number; sha256: string | null }[];
      const bySize = new Map<number, number>();
      for (const r of sizes) {
        if (present.has(r.calibre_id)) bySize.set(r.size, (bySize.get(r.size) ?? 0) + 1);
      }
      const shared = new Set([...bySize].filter(([, n]) => n > 1).map(([s]) => s));
      p.sizeGroups = shared.size;
      p.hashTotal = sizes.filter((r) => present.has(r.calibre_id) && shared.has(r.size)).length;
      p.hashDone = sizes.filter(
        (r) => present.has(r.calibre_id) && shared.has(r.size) && r.sha256 !== null,
      ).length;
      // For the page's progress bar and time left: what this step still has to read.
      p.hashBytesTotal = sizes
        .filter((r) => present.has(r.calibre_id) && shared.has(r.size) && r.sha256 === null)
        .reduce((sum, r) => sum + r.size, 0);
      p.phaseStartedAt = Date.now();
      p.phaseStartDone = 0;
      return p;
    }
    const get = this.deps.cleanup.prepare(
      'SELECT file_path, size, mtime_ms, sha256 FROM file_facts WHERE library_id = ? AND calibre_id = ?',
    );
    const put = this.deps.cleanup.prepare(
      `INSERT INTO file_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
         calibre_last_modified, sha256, stat_at, hashed_at, error)
       VALUES (@lib, @id, @uuid, @path, @size, @mtime, @lm, @sha, @now, @hashedAt, @error)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
         file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
         calibre_last_modified = excluded.calibre_last_modified, sha256 = excluded.sha256,
         stat_at = excluded.stat_at, hashed_at = excluded.hashed_at, error = excluded.error`,
    );
    const results: Record<string, unknown>[] = [];
    for (const id of ids) {
      const book = books.get(id)!;
      const now = Date.now();
      let size: number | null = null;
      let mtime: number | null = null;
      let error: string | null = null;
      try {
        const st = await statFile(resolveInside(libDir, book.filePath));
        if (st) {
          size = st.size;
          mtime = st.mtimeMs;
        } else {
          error = 'file_missing';
        }
      } catch (err) {
        error = `stat: ${(err as Error).message}`;
      }
      const old = get.get(p.libraryId, id) as
        | { file_path: string; size: number | null; mtime_ms: number | null; sha256: string | null }
        | undefined;
      const unchanged =
        old && old.file_path === book.filePath && old.size === size && old.mtime_ms === mtime;
      results.push({
        lib: p.libraryId,
        id,
        uuid: book.uuid,
        path: book.filePath,
        size,
        mtime,
        lm: book.lastModified,
        sha: unchanged ? old.sha256 : null,
        now,
        hashedAt: unchanged && old.sha256 ? now : null,
        error,
      });
      if (error) p.statErrors++;
      if (error === 'file_missing') p.booksWithoutEpubFile++;
      if (shouldStop()) break;
    }
    this.deps.cleanup.transaction(() => {
      for (const r of results) put.run(r);
    })();
    p.statDone += results.length;
    p.statCursor = (results[results.length - 1]?.id as number | undefined) ?? p.statCursor;
    await yieldNow();
    return p;
  }

  private async hashStep(p: Stage1Progress, shouldStop: () => boolean): Promise<Stage1Progress> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const pacer = new Pacer(settings.pacing.hashMbPerSecond * 1024 * 1024);
    const next = this.deps.cleanup
      .prepare(
        `SELECT f.calibre_id, f.file_path, f.size, f.mtime_ms FROM file_facts f
         WHERE f.library_id = ? AND f.sha256 IS NULL AND f.error IS NULL AND f.size IS NOT NULL
           AND f.size IN (SELECT size FROM file_facts WHERE library_id = ? AND error IS NULL
                          AND size IS NOT NULL GROUP BY size HAVING COUNT(*) > 1)
         ORDER BY f.size DESC, f.calibre_id LIMIT 20`,
      )
      .all(p.libraryId, p.libraryId) as {
      calibre_id: number;
      file_path: string;
      size: number;
      mtime_ms: number;
    }[];
    if (next.length === 0) {
      p.phase = 'group';
      return p;
    }
    const todo = next.filter((r) => books.has(r.calibre_id));
    const setHash = this.deps.cleanup.prepare(
      `UPDATE file_facts SET sha256 = ?, hashed_at = ?, error = ? WHERE library_id = ? AND calibre_id = ?`,
    );
    // Rows of books no longer in the snapshot are skipped for good.
    for (const r of next.filter((x) => !books.has(x.calibre_id))) {
      setHash.run(null, null, 'not_in_library', p.libraryId, r.calibre_id);
    }
    for (const r of todo) {
      if (shouldStop()) break;
      try {
        const file = resolveInside(libDir, r.file_path);
        const before = await statFile(file);
        if (!before || before.size !== r.size || before.mtimeMs !== r.mtime_ms) {
          // Changed since the stat: stat again in the next analysis.
          setHash.run(null, null, 'changed', p.libraryId, r.calibre_id);
          p.hashErrors++;
          continue;
        }
        const result = await hashSourceFile(file, pacer, shouldStop);
        if (!result) break;
        const after = await statFile(file);
        if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          setHash.run(null, null, 'changed', p.libraryId, r.calibre_id);
          p.hashErrors++;
          continue;
        }
        setHash.run(result.sha256, Date.now(), null, p.libraryId, r.calibre_id);
        p.hashDone++;
        p.bytesHashed += result.bytes;
        // After every file, so the page's progress bar moves (one large file can take minutes).
        this.save(p, 'analysing');
      } catch (err) {
        setHash.run(null, null, `hash: ${(err as Error).message}`, p.libraryId, r.calibre_id);
        p.hashErrors++;
      }
    }
    return p;
  }

  private groupStep(p: Stage1Progress): Stage1Progress {
    const books = this.loadBooks(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const rows = this.deps.cleanup
      .prepare(
        `SELECT calibre_id, sha256, size FROM file_facts
         WHERE library_id = ? AND sha256 IS NOT NULL AND error IS NULL
           AND sha256 IN (SELECT sha256 FROM file_facts WHERE library_id = ? AND sha256 IS NOT NULL
                          AND error IS NULL GROUP BY sha256 HAVING COUNT(*) > 1)`,
      )
      .all(p.libraryId, p.libraryId) as { calibre_id: number; sha256: string; size: number }[];
    const sets = new Map<string, { size: number; copies: SnapshotBook[] }>();
    for (const r of rows) {
      const book = books.get(r.calibre_id);
      if (!book) continue;
      const set = sets.get(r.sha256) ?? { size: r.size, copies: [] };
      set.copies.push(book);
      sets.set(r.sha256, set);
    }

    // Reader books for the data check (evidence only; the handoff decides at apply time).
    const readerBook = (uuid: string) =>
      findCalibreSource(this.deps.main, p.libraryId, uuid)?.bookId;
    const allReaderBooks: string[] = [];
    for (const { copies } of sets.values()) {
      for (const c of copies) {
        const id = readerBook(c.uuid);
        if (id) allReaderBooks.push(id);
      }
    }
    const withData = booksWithReaderData(this.deps.main, allReaderBooks);

    const now = Date.now();
    const cleanup = this.deps.cleanup;
    // Copies already queued or removed, copies the user kept, and copies an Undo brought
    // back (under their old or their new UUID) are never proposed again.
    const active = new Set(
      (
        cleanup
          .prepare(
            `SELECT calibre_uuid AS uuid FROM proposed_changes
             WHERE stage = 1 AND library_id = ? AND state IN ('queued', 'applied', 'undone', 'kept')
             UNION SELECT restored_uuid AS uuid FROM undo_records
             WHERE library_id = ? AND restored_uuid IS NOT NULL`,
          )
          .all(p.libraryId, p.libraryId) as { uuid: string }[]
      ).map((r) => r.uuid),
    );
    const insert = cleanup.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (1, @lib, @id, @uuid, 'book', '"present"', '"removed"', 'stage1:sha256', @evidence,
         'auto', 'proposed', @analysis, @now, @now)`,
    );
    let duplicateSets = 0;
    let toRemove = 0;
    let keptByTags = 0;
    let keptByDate = 0;
    let extraFormat = 0;
    let removedWithData = 0;
    let bothWithData = 0;
    let tagsCopied = 0;
    cleanup.transaction(() => {
      // Earlier proposals that were never queued are replaced by this analysis.
      cleanup
        .prepare(
          `DELETE FROM proposed_changes WHERE stage = 1 AND library_id = ? AND state = 'proposed'`,
        )
        .run(p.libraryId);
      for (const [sha256, { size, copies }] of sets) {
        if (copies.length < 2) continue;
        duplicateSets++;
        const { keep, rule } = chooseKeeper(copies, settings.customTags);
        const keptReader = readerBook(keep.uuid);
        const keptHasData = keptReader ? withData.has(keptReader) : false;
        for (const copy of copies) {
          if (copy === keep || active.has(copy.uuid)) continue;
          const removedReader = readerBook(copy.uuid);
          const removedHasData = removedReader ? withData.has(removedReader) : false;
          const extra = copy.formats.filter((f) => !keep.formats.includes(f));
          toRemove++;
          if (rule === 'tags') keptByTags++;
          else keptByDate++;
          if (extra.length > 0) extraFormat++;
          const keptTags = new Set(keep.tags.map((t) => t.toLowerCase()));
          if (
            copy.tags.some(
              (t) => isCustomTag(t, settings.customTags) && !keptTags.has(t.toLowerCase()),
            )
          ) {
            tagsCopied++;
          }
          if (removedHasData && keptHasData) bothWithData++;
          else if (removedHasData) removedWithData++;
          insert.run({
            lib: p.libraryId,
            id: copy.calibreId,
            uuid: copy.uuid,
            analysis: p.analysisId,
            now,
            evidence: JSON.stringify({
              sha256,
              size,
              setSize: copies.length,
              rule,
              title: copy.title,
              kept: {
                calibreId: keep.calibreId,
                uuid: keep.uuid,
                title: keep.title,
                tags: keep.tags,
                formats: keep.formats,
                addedAt: keep.timestamp,
                lastModified: keep.lastModified,
                readerData: keptHasData,
              },
              removed: {
                calibreId: copy.calibreId,
                uuid: copy.uuid,
                title: copy.title,
                tags: copy.tags,
                customTags: copy.tags.filter((t) => isCustomTag(t, settings.customTags)),
                formats: copy.formats,
                extraFormats: extra,
                addedAt: copy.timestamp,
                lastModified: copy.lastModified,
                filePath: copy.filePath,
                readerData: removedHasData,
              },
            }),
          });
        }
      }
    })();
    Object.assign(p, {
      duplicateSets,
      toRemove,
      keptByTags,
      keptByDate,
      extraFormat,
      removedWithData,
      bothWithData,
      tagsCopied,
      phase: 'done' as const,
      finishedAt: now,
    });
    this.deps.log?.(
      `Cleanup stage 1: analysis done: ${duplicateSets} sets of identical files, ${toRemove} copies to remove`,
    );
    return p;
  }
}
