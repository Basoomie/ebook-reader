/**
 * Calibre records without files (tier 4, part 2; known-bugs "The 11 Calibre records without
 * files"). Calibre's own import made such a record and the disk then refused its folder (a name
 * over 255 bytes), so the record has no formats and no folder. Decided with the user
 * (2026-11-23): each one is deleted once its EPUB is in Calibre as a new book (a WP20g On run
 * adds it with a fitted title); a record whose EPUB is not in yet stays and is listed.
 *
 * The delete is a batch of its own stage (EMPTY_RECORD_STAGE) on the cleanup's batch tables
 * and the sidecar's existing `remove <one id>` (Calibre's trash, never --permanent). Before
 * each delete the sidecar checks Calibre live (same UUID, still no formats, the new book there
 * with its EPUB) and saves the whole record (`list --fields all`) in the batch's quarantine
 * folder; the batch's metadata.db copy is saved first, as for every batch. The record's own
 * tags (PeepoHappyBooks, TMW-collection-*) go to the new book first, as stage 1 does for a
 * copy it removes (decided 2026-11-13).
 *
 * No Undo (user, 2026-11-23): checked on calibre 9.18, `remove` of a record without a folder
 * succeeds but leaves nothing in Calibre's trash ("No entries in the trash bin" on restore).
 * The book itself lives on as the new record with its EPUB.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { getLibrary } from '../calibre/libraries';
import { folderExists, resolveInside } from '../calibre/source-fs';
import { BatchError, type BatchRow, type BatchService } from './batches';
import { NAME_MAX_BYTES } from './calibre-names';
import { EMPTY_RECORD_SIDECAR_VERSION, EMPTY_RECORD_STAGE } from './field-stages';
import { booksWithReaderData, findCalibreSource } from './handoff';
import { getSettings, isCustomTag } from './settings';

export const EMPTY_RECORD_FIELD = 'record';
export const EMPTY_RECORD_ANALYSIS = 'empty-records';

export type EmptyRecordState =
  /** Its EPUB is not in Calibre as a new book yet: the record stays. */
  | 'waiting'
  /** The new book is there with its EPUB: the record can be deleted. */
  | 'ready'
  /** The reader holds data for this record: never deleted by the cleanup. */
  | 'held'
  | 'deleting'
  | 'deleted'
  | 'failed';

export interface EmptyRecord {
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  tags: string[];
  path: string;
  lastModified: string | null;
  state: EmptyRecordState;
  /** Why it waits, is held or failed. */
  reason: string | null;
  /** The new book with the record's EPUB (from the new arrivals). */
  newBook: { calibreId: number; uuid: string; title: string; relPath: string } | null;
  /** The record's own tags the new book gets before the delete. */
  addTags: string[];
  batchId: string | null;
}

interface SnapRecord {
  id: number;
  uuid: string;
  title: string;
  path: string;
  last_modified: string | null;
}

const encoder = new TextEncoder();
/** A part of the record's path the disk can't take (Linux NAME_MAX), so its folder was never made. */
export const folderTooLong = (recordPath: string) =>
  recordPath.split('/').some((part) => encoder.encode(part).length > NAME_MAX_BYTES);

/** Title or name as compared: width, case and spaces aside. */
export const sameText = (a: string, b: string) => fold(a) === fold(b);
const fold = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

/** The records without formats in a metadata.db (snapshot), with their authors and tags. */
export function recordsWithoutFiles(file: string): {
  records: (SnapRecord & { authors: string[]; tags: string[] })[];
  epubBooks: Map<number, { uuid: string; title: string }>;
} {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.path, b.last_modified FROM books b
         WHERE NOT EXISTS (SELECT 1 FROM data d WHERE d.book = b.id) ORDER BY b.id`,
      )
      .all() as SnapRecord[];
    const authors = db.prepare(
      `SELECT a.name FROM authors a JOIN books_authors_link l ON l.author = a.id
       WHERE l.book = ? ORDER BY l.id`,
    );
    const tags = db.prepare(
      `SELECT t.name FROM tags t JOIN books_tags_link l ON l.tag = t.id WHERE l.book = ? ORDER BY t.name`,
    );
    const records = rows.map((r) => ({
      ...r,
      authors: (authors.all(r.id) as { name: string }[]).map((x) => x.name),
      tags: (tags.all(r.id) as { name: string }[]).map((x) => x.name),
    }));
    const epubBooks = new Map<number, { uuid: string; title: string }>();
    for (const r of db
      .prepare(
        `SELECT b.id, b.uuid, b.title FROM books b
         WHERE EXISTS (SELECT 1 FROM data d WHERE d.book = b.id AND d.format = 'EPUB')`,
      )
      .all() as { id: number; uuid: string; title: string }[])
      epubBooks.set(r.id, { uuid: r.uuid, title: r.title });
    return { records, epubBooks };
  } finally {
    db.close();
  }
}

export class EmptyRecords {
  constructor(
    private readonly batches: BatchService,
    private readonly deps: {
      cleanup: Database.Database;
      main: Database.Database;
      calibreDir: string | null;
      cacheDir: string;
    },
  ) {}

  private get db() {
    return this.deps.cleanup;
  }

  private libDir(libraryId: string): string | null {
    const lib = getLibrary(this.deps.main, libraryId);
    return lib && this.deps.calibreDir ? path.join(this.deps.calibreDir, lib.folder) : null;
  }

  /**
   * The new book holding this record's EPUB: an arrival file added to Calibre (outcome added,
   * or better with `$.addedAs`) whose EPUB title (and first author, when both are known) is the
   * record's; the new book must be in the reader's copy of Calibre with its EPUB.
   */
  private newBookFor(
    rec: { title: string; authors: string[] },
    epubBooks: Map<number, { uuid: string; title: string }>,
    arrivals: ArrivalRow[],
  ): EmptyRecord['newBook'] {
    for (const a of arrivals) {
      if (!a.title || !sameText(a.title, rec.title)) continue;
      const fileAuthor = a.authors[0];
      const recAuthor = rec.authors[0];
      if (fileAuthor && recAuthor && recAuthor !== 'Unknown' && !sameText(fileAuthor, recAuthor))
        continue;
      if (a.calibreId === null || !a.uuid) continue;
      const book = epubBooks.get(a.calibreId);
      if (!book || book.uuid !== a.uuid) continue;
      return { calibreId: a.calibreId, uuid: a.uuid, title: book.title, relPath: a.relPath };
    }
    return null;
  }

  private arrivalsAdded(): ArrivalRow[] {
    let rows: {
      rel_path: string;
      outcome: string;
      calibre_id: number | null;
      calibre_uuid: string | null;
      facts_json: string | null;
    }[];
    try {
      rows = this.db
        .prepare(
          `SELECT rel_path, outcome, calibre_id, calibre_uuid, facts_json FROM calibre_arrival_files
           INDEXED BY calibre_arrival_files_outcome WHERE outcome IN ('added', 'better')`,
        )
        .all() as typeof rows;
    } catch {
      return [];
    }
    return rows.map((r) => {
      const f = (r.facts_json ? JSON.parse(r.facts_json) : {}) as {
        title?: string | null;
        authors?: string[];
        addedAs?: { calibreId?: number; uuid?: string };
      };
      // For "better", calibre_id/uuid stay the beaten library book; the new one is $.addedAs.
      const better = r.outcome === 'better';
      return {
        relPath: r.rel_path,
        title: f.title ?? null,
        authors: Array.isArray(f.authors) ? f.authors : [],
        calibreId: better ? (f.addedAs?.calibreId ?? null) : r.calibre_id,
        uuid: better ? (f.addedAs?.uuid ?? null) : r.calibre_uuid,
      };
    });
  }

  /** The records without files and what can be done with each (reads the reader's snapshot). */
  async list(libraryId: string): Promise<EmptyRecord[]> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    let snap: ReturnType<typeof recordsWithoutFiles>;
    try {
      snap = recordsWithoutFiles(file);
    } catch {
      return [];
    }
    const libDir = this.libDir(libraryId);
    const arrivals = this.arrivalsAdded();
    const customTags = getSettings(this.db).customTags;
    const ours = new Map(
      (
        this.db
          .prepare(
            `SELECT calibre_uuid, state, review_reason, batch_id FROM proposed_changes
             WHERE stage = ${EMPTY_RECORD_STAGE} AND library_id = ? ORDER BY id`,
          )
          .all(libraryId) as {
          calibre_uuid: string;
          state: string;
          review_reason: string | null;
          batch_id: string | null;
        }[]
      ).map((r) => [r.calibre_uuid, r]),
    );
    const out: EmptyRecord[] = [];
    for (const r of snap.records) {
      // Only records whose folder the disk refused (a name over 255 bytes): a record without
      // files for another reason, or whose folder exists, is not one of these.
      if (!folderTooLong(r.path)) continue;
      if (libDir && (await folderExists(resolveInside(libDir, r.path)))) continue;
      const newBook = this.newBookFor(r, snap.epubBooks, arrivals);
      const mine = ours.get(r.uuid);
      const src = findCalibreSource(this.deps.main, libraryId, r.uuid);
      const readerData = src ? booksWithReaderData(this.deps.main, [src.bookId]).size > 0 : false;
      let state: EmptyRecordState = newBook ? 'ready' : 'waiting';
      let reason: string | null = newBook ? null : 'Its EPUB is not in Calibre as a new book yet';
      if (readerData) {
        state = 'held';
        reason = 'The reader holds data for this record';
      }
      if (mine?.state === 'queued') state = 'deleting';
      else if (mine?.state === 'skipped' && state === 'ready') {
        state = 'failed';
        reason = mine.review_reason;
      }
      out.push({
        calibreId: r.id,
        uuid: r.uuid,
        title: r.title,
        authors: r.authors,
        tags: r.tags,
        path: r.path,
        lastModified: r.last_modified,
        state,
        reason,
        newBook,
        addTags: r.tags.filter((t) => isCustomTag(t, customTags)),
        batchId: mine?.batch_id ?? null,
      });
    }
    // Deleted ones are no longer in the snapshot: listed from the cleanup's own records.
    for (const [uuid, mine] of ours) {
      if (mine.state !== 'applied' || out.some((o) => o.uuid === uuid)) continue;
      const row = this.db
        .prepare(
          `SELECT calibre_id, old_json, evidence_json FROM proposed_changes
           WHERE stage = ${EMPTY_RECORD_STAGE} AND library_id = ? AND calibre_uuid = ? AND state = 'applied'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(libraryId, uuid) as { calibre_id: number; old_json: string; evidence_json: string };
      const old = JSON.parse(row.old_json) as {
        title: string;
        authors: string[];
        tags: string[];
        path: string;
        lastModified: string | null;
      };
      const ev = JSON.parse(row.evidence_json) as {
        newBook: EmptyRecord['newBook'];
        addTags?: string[];
      };
      out.push({
        calibreId: row.calibre_id,
        uuid,
        ...old,
        state: 'deleted',
        reason: null,
        newBook: ev.newBook,
        addTags: ev.addTags ?? [],
        batchId: mine.batch_id,
      });
    }
    return out.sort((a, b) => a.calibreId - b.calibreId);
  }

  /**
   * Plans one batch deleting the ready records among `ids` (all ready ones when omitted).
   * Only on the user's word (the page's "Delete" or the CLI); nothing runs by itself.
   */
  async plan(libraryId: string, ids?: number[], now = Date.now()): Promise<BatchRow> {
    if (!this.batches.sidecarAtLeast(EMPTY_RECORD_SIDECAR_VERSION))
      throw new BatchError(
        409,
        'old_sidecar',
        `The cleanup sidecar is older than ${EMPTY_RECORD_SIDECAR_VERSION}: rebuild ttsu-cleanup-apply first`,
      );
    if (this.batches.open())
      throw new BatchError(409, 'busy', 'A batch is being applied; try again after it');
    const ready = (await this.list(libraryId)).filter(
      (r) => r.state === 'ready' && (!ids || ids.includes(r.calibreId)),
    );
    if (ready.length === 0)
      throw new BatchError(409, 'nothing_ready', 'No record without files is ready to delete');
    const insert = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (${EMPTY_RECORD_STAGE}, ?, ?, ?, '${EMPTY_RECORD_FIELD}', ?, 'null', 'empty-record', ?,
         'auto', NULL, 'proposed', '${EMPTY_RECORD_ANALYSIS}', ?, ?)`,
    );
    const changeIds = this.db.transaction(() =>
      ready.map((r) => {
        const old = {
          title: r.title,
          authors: r.authors,
          tags: r.tags,
          path: r.path,
          lastModified: r.lastModified,
        };
        // The shape the batch's sidecar view reads (as a removal's), plus what was decided on.
        const evidence = {
          sha256: '',
          title: r.title,
          kept: { calibreId: r.newBook!.calibreId, uuid: r.newBook!.uuid, tags: [] as string[] },
          removed: {
            calibreId: r.calibreId,
            uuid: r.uuid,
            title: r.title,
            tags: r.tags,
            formats: [] as string[],
            lastModified: r.lastModified,
            filePath: '',
          },
          newBook: r.newBook,
          addTags: r.addTags,
          emptyRecord: true,
        };
        return Number(
          insert.run(
            libraryId,
            r.calibreId,
            r.uuid,
            JSON.stringify(old),
            JSON.stringify(evidence),
            now,
            now,
          ).lastInsertRowid,
        );
      }),
    )();
    return this.batches.createBatch(EMPTY_RECORD_STAGE, libraryId, 'apply', null, changeIds, now);
  }
}

interface ArrivalRow {
  relPath: string;
  title: string | null;
  authors: string[];
  calibreId: number | null;
  uuid: string | null;
}
