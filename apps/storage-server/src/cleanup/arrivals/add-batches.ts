/**
 * The import's add batches (WP20g) for the apply sidecar (arrivals.ts there): which files to add
 * to Calibre, handed out one batch at a time with a lease (extended by every report), each item's
 * steps recorded as the sidecar reports them (fetched → adding → added, or failed), and their
 * Undo (exported to the quarantine, then removed to Calibre's trash).
 *
 * An item reported `adding` is never handed out to be added again: after a restart the sidecar
 * only looks for it in Calibre. The file itself is streamed from the read-only sources mount,
 * checked against the catalog's size and SHA-256 by the sidecar before it is added.
 */
import type Database from 'better-sqlite3';
import { getSettings } from '../settings';

export class ArrivalBatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaimedItem {
  itemId: number;
  fileId: number;
  state: string;
  name: string;
  size: number;
  sha256: string;
  title: string;
  /** The title the add gives Calibre instead of the file's, when the file's makes names too long. */
  addTitle: string | null;
  calibreId: number | null;
  uuid: string | null;
}

export interface ClaimedBatch {
  id: number;
  kind: 'add' | 'undo_add';
  leaseSeconds: number;
  /**
   * Manga part B: the content server's id of the library the batch adds to (or takes out of);
   * the sidecar (1.7.0) works in it, an older one only in its own library.
   */
  calibreLibrary: string | null;
  items: ClaimedItem[];
}

/** The apply sidecar that adds into another library than its own (manga part B). */
export const ARRIVALS_LIBRARY_SIDECAR = { major: 1, minor: 7 };

/** Whether the apply sidecar last seen is at least major.minor (sidecar_status). */
export function sidecarAtLeast(db: Database.Database, major: number, minor: number): boolean {
  const sc = db.prepare('SELECT version FROM sidecar_status WHERE id = 1').get() as
    | { version: string | null }
    | undefined;
  const [a, b] = (sc?.version ?? '0.0.0').split('.').map((x) => parseInt(x, 10) || 0);
  return a > major || (a === major && b >= minor);
}

const STEPS = new Set(['fetched', 'adding', 'added', 'exported', 'removed', 'failed']);

export class ArrivalBatches {
  constructor(private readonly db: Database.Database) {}

  /** Plans add batches for these catalog files (in order); returns the new batch ids. */
  planAdds(runId: number, libraryId: string, fileIds: number[], now = Date.now()): number[] {
    const size = getSettings(this.db).arrivals.addBatchSize;
    const ids: number[] = [];
    const batch = this.db.prepare(
      `INSERT INTO calibre_arrival_batches (run_id, library_id, kind, state, item_count, created_at, updated_at)
       VALUES (?, ?, 'add', 'planned', ?, ?, ?)`,
    );
    const item = this.db.prepare(
      `INSERT INTO calibre_arrival_batch_items (batch_id, file_id, position, state, updated_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    );
    this.db.transaction(() => {
      for (let at = 0; at < fileIds.length; at += size) {
        const chunk = fileIds.slice(at, at + size);
        const id = Number(batch.run(runId, libraryId, chunk.length, now, now).lastInsertRowid);
        chunk.forEach((f, i) => item.run(id, f, i, now));
        ids.push(id);
      }
    })();
    return ids;
  }

  /** An Undo batch for the books an add batch added. */
  planUndo(batchId: number, now = Date.now()): number {
    const b = this.db.prepare('SELECT * FROM calibre_arrival_batches WHERE id = ?').get(batchId) as
      | { id: number; kind: string; state: string; run_id: number | null; library_id: string }
      | undefined;
    if (!b || b.kind !== 'add') throw new ArrivalBatchError(404, 'no_batch', 'No such add batch');
    if (b.state !== 'done')
      throw new ArrivalBatchError(409, 'not_done', 'The batch is not finished');
    const items = this.db
      .prepare(
        `SELECT file_id, calibre_id, calibre_uuid FROM calibre_arrival_batch_items
         WHERE batch_id = ? AND state = 'added' ORDER BY position`,
      )
      .all(batchId) as { file_id: number; calibre_id: number; calibre_uuid: string }[];
    if (!items.length) throw new ArrivalBatchError(409, 'nothing', 'The batch added nothing');
    let id = 0;
    this.db.transaction(() => {
      id = Number(
        this.db
          .prepare(
            `INSERT INTO calibre_arrival_batches (run_id, library_id, kind, state, undo_of, item_count, created_at, updated_at)
             VALUES (?, ?, 'undo_add', 'planned', ?, ?, ?, ?)`,
          )
          .run(b.run_id, b.library_id, batchId, items.length, now, now).lastInsertRowid,
      );
      const put = this.db.prepare(
        `INSERT INTO calibre_arrival_batch_items (batch_id, file_id, position, state, calibre_id, calibre_uuid, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      );
      items.forEach((x, i) => put.run(id, x.file_id, i, x.calibre_id, x.calibre_uuid, now));
    })();
    return id;
  }

  /** The batch the sidecar works on now, if any (claimed, lease not expired). */
  open(now = Date.now()): { id: number; kind: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT id, kind FROM calibre_arrival_batches WHERE state = 'claimed' AND lease_expires_at > ? LIMIT 1`,
        )
        .get(now) as { id: number; kind: string } | undefined) ?? null
    );
  }

  /** The next batch for the sidecar: the oldest planned one, or a claimed one whose lease ran out. */
  /**
   * The next batch for the sidecar. calibreLibraryOf: the content server's id of a reader
   * library; defaultLibrary: the sidecar's own (a batch of another library waits for 1.7.0).
   */
  claim(
    now = Date.now(),
    calibreLibraryOf: (readerLibraryId: string) => string | null = () => null,
    defaultLibrary: string | null = null,
  ): ClaimedBatch | null {
    const lease = getSettings(this.db).arrivals.addLeaseSeconds;
    if (this.open(now)) return null;
    const b = this.db
      .prepare(
        `SELECT id, kind, library_id FROM calibre_arrival_batches
         WHERE state = 'planned' OR (state = 'claimed' AND lease_expires_at <= ?)
         ORDER BY id LIMIT 1`,
      )
      .get(now) as { id: number; kind: 'add' | 'undo_add'; library_id: string } | undefined;
    if (!b) return null;
    // Manga part B: the batch's own library on the content server; another than the sidecar's
    // own only for a sidecar that adds there (an older one would add into its own library).
    // Without either (a test, a sidecar not set up): the sidecar's own library, as before.
    const calibreLibrary = calibreLibraryOf(b.library_id) ?? defaultLibrary;
    if (
      calibreLibrary !== null &&
      defaultLibrary !== null &&
      calibreLibrary !== defaultLibrary &&
      !sidecarAtLeast(this.db, ARRIVALS_LIBRARY_SIDECAR.major, ARRIVALS_LIBRARY_SIDECAR.minor)
    )
      return null;
    // A sidecar before 1.4.0 can't give the add a title (a fitted one for a name too long):
    // such a batch waits for the rebuilt sidecar (a plain add would leave a record without a file).
    if (b.kind === 'add' && !sidecarAtLeast(this.db, 1, 4)) {
      const titled = this.db
        .prepare(
          `SELECT 1 FROM calibre_arrival_batch_items i JOIN calibre_arrival_files f ON f.id = i.file_id
           WHERE i.batch_id = ? AND json_extract(f.facts_json, '$.addTitle') IS NOT NULL LIMIT 1`,
        )
        .get(b.id);
      if (titled) return null;
    }
    this.db
      .prepare(
        `UPDATE calibre_arrival_batches SET state = 'claimed', claimed_at = COALESCE(claimed_at, ?),
           lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now, now + lease * 1000, now, b.id);
    const items = this.db
      .prepare(
        `SELECT i.id AS itemId, i.file_id AS fileId, i.state, i.calibre_id AS calibreId,
           i.calibre_uuid AS uuid, f.rel_path, f.size, f.sha256, f.facts_json
         FROM calibre_arrival_batch_items i JOIN calibre_arrival_files f ON f.id = i.file_id
         WHERE i.batch_id = ? ORDER BY i.position`,
      )
      .all(b.id) as {
      itemId: number;
      fileId: number;
      state: string;
      calibreId: number | null;
      uuid: string | null;
      rel_path: string;
      size: number;
      sha256: string | null;
      facts_json: string | null;
    }[];
    return {
      id: b.id,
      kind: b.kind,
      leaseSeconds: lease,
      calibreLibrary,
      items: items.map((i) => {
        const facts = i.facts_json
          ? (JSON.parse(i.facts_json) as { title?: string | null; addTitle?: string | null })
          : {};
        const name = i.rel_path.slice(i.rel_path.lastIndexOf('/') + 1);
        return {
          itemId: i.itemId,
          fileId: i.fileId,
          state: i.state,
          name,
          size: i.size,
          sha256: i.sha256 ?? '',
          title: facts.addTitle || facts.title || name.replace(/\.epub$/i, ''),
          addTitle: facts.addTitle || null,
          calibreId: i.calibreId,
          uuid: i.uuid,
        };
      }),
    };
  }

  private itemRow(itemId: number) {
    return this.db
      .prepare(
        `SELECT i.*, b.state AS batch_state, b.kind FROM calibre_arrival_batch_items i
         JOIN calibre_arrival_batches b ON b.id = i.batch_id WHERE i.id = ?`,
      )
      .get(itemId) as
      | {
          id: number;
          batch_id: number;
          file_id: number;
          state: string;
          batch_state: string;
          kind: string;
        }
      | undefined;
  }

  /** A step the sidecar reports for an item (safe to send twice). */
  report(
    itemId: number,
    r: { step: string; calibreId?: number; uuid?: string; quarantineDir?: string; detail?: string },
    now = Date.now(),
  ): { state: string } {
    const it = this.itemRow(itemId);
    if (!it) throw new ArrivalBatchError(404, 'no_item', 'No such item');
    if (it.batch_state !== 'claimed')
      throw new ArrivalBatchError(409, 'not_claimed', 'The batch is not being worked on');
    if (!STEPS.has(r.step)) throw new ArrivalBatchError(400, 'bad_report', 'Unknown step');
    if (r.step === 'added' && (!Number.isInteger(r.calibreId) || !r.uuid))
      throw new ArrivalBatchError(400, 'bad_report', 'An added book needs its id and uuid');
    // An item that ended stays as it ended.
    if (['added', 'removed', 'failed'].includes(it.state) && it.state !== r.step)
      return { state: it.state };
    const lease = getSettings(this.db).arrivals.addLeaseSeconds;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE calibre_arrival_batch_items SET state = ?, calibre_id = COALESCE(?, calibre_id),
             calibre_uuid = COALESCE(?, calibre_uuid), quarantine_dir = COALESCE(?, quarantine_dir),
             detail = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          r.step === 'adding' ? 'fetched' : r.step,
          r.calibreId ?? null,
          r.uuid ?? null,
          r.quarantineDir ?? null,
          r.step === 'adding' ? 'adding' : ((r.detail ?? null)?.slice(0, 500) ?? null),
          now,
          itemId,
        );
      this.db
        .prepare(
          'UPDATE calibre_arrival_batches SET lease_expires_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(now + lease * 1000, now, it.batch_id);
      // An Undo's book is out of Calibre: its file is undone at once (the lists show it so, and it
      // is never added again by itself), not only when the next run notices the book gone.
      if (it.kind === 'undo_add' && r.step === 'removed')
        this.db
          .prepare(
            `UPDATE calibre_arrival_files SET outcome = 'undone', detail = ?, decided_at = ?
             WHERE id = ? AND outcome = 'added'`,
          )
          .run('Taken out again by Undo (not added again by itself)', now, it.file_id);
    })();
    return { state: r.step === 'adding' ? 'fetched' : r.step };
  }

  /** The sidecar finished a batch (items not ended are failed: "Not finished"). */
  finish(batchId: number, error: string | null, now = Date.now()): void {
    const b = this.db
      .prepare('SELECT state FROM calibre_arrival_batches WHERE id = ?')
      .get(batchId) as { state: string } | undefined;
    if (!b) throw new ArrivalBatchError(404, 'no_batch', 'No such batch');
    if (b.state !== 'claimed') return;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE calibre_arrival_batch_items SET state = 'failed',
             detail = COALESCE(detail, ?) , updated_at = ?
           WHERE batch_id = ? AND state IN ('pending', 'fetched', 'exported')`,
        )
        .run(error ? `Not finished: ${error.slice(0, 300)}` : 'Not finished', now, batchId);
      this.db
        .prepare(
          `UPDATE calibre_arrival_batches SET state = ?, error = ?, finished_at = ?, lease_expires_at = NULL,
             updated_at = ? WHERE id = ?`,
        )
        .run(error ? 'failed' : 'done', error, now, now, batchId);
    })();
  }

  /** The catalog file an item adds (only while its batch is claimed and the item not added yet). */
  fileOf(itemId: number): { fileId: number } {
    const it = this.itemRow(itemId);
    if (!it || it.kind !== 'add') throw new ArrivalBatchError(404, 'no_item', 'No such item');
    if (it.batch_state !== 'claimed')
      throw new ArrivalBatchError(409, 'not_claimed', 'The batch is not being worked on');
    // A file fetched before a restart may be fetched again; never once its add was sent.
    const detail = (
      this.db
        .prepare('SELECT detail FROM calibre_arrival_batch_items WHERE id = ?')
        .get(itemId) as { detail: string | null }
    ).detail;
    if (!(it.state === 'pending' || (it.state === 'fetched' && detail !== 'adding')))
      throw new ArrivalBatchError(409, 'not_pending', 'The file is being added already');
    return { fileId: it.file_id };
  }

  /** Items of a run's add batches by state. */
  counts(runId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT i.state, COUNT(*) AS n FROM calibre_arrival_batch_items i
         JOIN calibre_arrival_batches b ON b.id = i.batch_id
         WHERE b.run_id = ? AND b.kind = 'add' GROUP BY i.state`,
      )
      .all(runId) as { state: string; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  /** Whether a run still has add or undo batches to finish. */
  busy(runId: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM calibre_arrival_batches WHERE run_id = ? AND state IN ('planned', 'claimed') LIMIT 1`,
      )
      .get(runId);
  }
}
