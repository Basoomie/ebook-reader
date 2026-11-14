/**
 * Batches (WP20a): what the apply sidecar picks up, and the record of what it did.
 *
 * - plan(): a stage-1 batch of at most `batchSize` removals and at most `maxBatchPercent` of
 *   the library's present books (far under the reader's 20 % mass-missing guard), only when
 *   the stage is on and not paused, the safety checks pass, no other batch is open, and the
 *   indexer has taken in the previous batch. Every item is re-checked first (the stage-1
 *   gate): same Calibre record, same file size and mtime, else the file is hashed again;
 *   a copy that is no longer identical pauses the stage.
 * - claim(): hands the oldest open batch to the sidecar with a lease; a verified metadata.db
 *   snapshot is made first (the sidecar stores it in the quarantine folder). An expired
 *   lease makes the batch claimable again; item states are kept, so the sidecar resumes.
 * - report(): one step of one item (verified, exported, removed / restored, skipped,
 *   failed), each acknowledged before the sidecar starts the next. "removed" runs the
 *   reader-side handoff; "restored" (Undo) re-binds a new UUID and reverses the handoff.
 * - undo(): an undo batch for an applied batch (the newest touching those books).
 *
 * The indexer holds its ingest of the library while a batch is claimed, so missing flags
 * and handoffs land together.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { getIndexState, getLibrary } from '../calibre/libraries';
import { snapshotMetadataDb } from '../calibre/snapshot';
import { folderExists, METADATA_DB, resolveInside, statFile } from '../calibre/source-fs';
import {
  applyHandoff,
  findCalibreSource,
  presentBookCount,
  rebindRestoredSource,
  reverseHandoff,
  type Handoff,
} from './handoff';
import { getSettings, isCustomTag } from './settings';
import { hashSourceFile, Pacer, readSnapshotBooks, readSnapshotPresence } from './stage1';
import { currentAnalysisId, getStage, pauseStage, updateStage } from './stages';

export type BatchKind = 'apply' | 'undo';
export type BatchState = 'planned' | 'claimed' | 'applied' | 'partial' | 'failed' | 'undone';
export type ItemState =
  | 'pending'
  | 'verified'
  | 'exported'
  /** The user's own tags of the removed copy were added to the kept copy (decided 2026-11-13). */
  | 'tagged'
  | 'removed'
  | 'restored'
  | 'failed'
  | 'skipped';

export const DEFAULT_LEASE_SECONDS = 120;

export class BatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BatchRow {
  id: string;
  stage: number;
  libraryId: string;
  kind: BatchKind;
  undoOf: string | null;
  state: BatchState;
  itemCount: number;
  snapshotSha256: string | null;
  snapshotSaved: boolean;
  leaseExpiresAt: number | null;
  attempts: number;
  createdAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  ingestedAt: number | null;
  error: string | null;
}

interface RawBatch {
  id: string;
  stage: number;
  library_id: string;
  kind: BatchKind;
  undo_of: string | null;
  state: BatchState;
  item_count: number;
  snapshot_sha256: string | null;
  snapshot_saved: number;
  lease_expires_at: number | null;
  attempts: number;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  ingested_at: number | null;
  error: string | null;
}

function toBatch(r: RawBatch): BatchRow {
  return {
    id: r.id,
    stage: r.stage,
    libraryId: r.library_id,
    kind: r.kind,
    undoOf: r.undo_of,
    state: r.state,
    itemCount: r.item_count,
    snapshotSha256: r.snapshot_sha256,
    snapshotSaved: r.snapshot_saved === 1,
    leaseExpiresAt: r.lease_expires_at,
    attempts: r.attempts,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    finishedAt: r.finished_at,
    ingestedAt: r.ingested_at,
    error: r.error,
  };
}

/** What the sidecar gets for one item. */
export interface SidecarItem {
  itemId: number;
  changeId: number;
  state: ItemState;
  quarantineDir: string | null;
  /** The copy to remove (apply) or bring back (undo). */
  calibreId: number;
  uuid: string;
  title: string;
  /** Calibre's last_modified in the analysed snapshot ("2026-11-09 04:00:11.251060+00:00"). */
  lastModified: string | null;
  formats: string[];
  sha256: string;
  kept: { calibreId: number; uuid: string };
  /**
   * apply: the user's own tags of this copy that the kept copy doesn't have; added to the kept
   * copy before this copy is removed. undo: the tags that were added then, taken off again.
   */
  addTags: string[];
  /**
   * undo only: whether Calibre's trash folder still holds this book (.caltrash/b/<id>, read
   * from the read-only library mount when the batch is handed out). On the NAS every
   * `trash restore` answers HTTP 408, which also hides calibre's "not in the trash" refusal, so
   * the sidecar must know beforehand which books to ask the trash for and which to re-add.
   * null when the library folder can't be read.
   */
  inCalibreTrash?: boolean | null;
}

export interface SidecarBatch {
  id: string;
  kind: BatchKind;
  stage: number;
  createdAt: number;
  leaseSeconds: number;
  itemDelaySeconds: number;
  /** The metadata.db snapshot's SHA-256 (the sidecar checks its download). */
  snapshotSha256: string | null;
  snapshotSaved: boolean;
  items: SidecarItem[];
}

export interface ItemReport {
  step: ItemState;
  detail?: string;
  quarantineDir?: string;
  exportSha256?: string;
  /** Undo: how the copy came back. */
  method?: 'trash' | 'readd';
  calibreId?: number;
  uuid?: string;
}

interface Evidence {
  sha256: string;
  title?: string;
  kept: { calibreId: number; uuid: string; tags: string[] };
  removed: {
    calibreId: number;
    uuid: string;
    title: string;
    tags: string[];
    formats: string[];
    lastModified: string | null;
    filePath: string;
  };
}

export interface BatchDeps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string | null;
  cacheDir: string;
  leaseSeconds?: number;
  log?: (m: string) => void;
}

const TERMINAL_APPLY: ItemState[] = ['removed', 'failed', 'skipped'];
const TERMINAL_UNDO: ItemState[] = ['restored', 'failed', 'skipped'];

const APPLY_STEPS: Record<ItemState, ItemState[]> = {
  pending: ['verified', 'skipped', 'failed'],
  verified: ['exported', 'skipped', 'failed'],
  exported: ['tagged', 'skipped', 'failed'],
  tagged: ['removed', 'skipped', 'failed'],
  removed: [],
  restored: [],
  failed: [],
  skipped: [],
};

/**
 * The user's own tags of the removed copy that the kept copy doesn't have (decided with the
 * user 2026-11-13: copied onto the kept copy instead of leaving with the removed one).
 * Calibre tag names compare case-insensitively.
 */
export function tagsToCopy(ev: Evidence, customTags: string[]): string[] {
  const kept = new Set(ev.kept.tags.map((t) => t.toLowerCase()));
  return (ev.removed.tags ?? []).filter(
    (t) => isCustomTag(t, customTags) && !kept.has(t.toLowerCase()),
  );
}

export function batchSnapshotPath(cacheDir: string, batchId: string): string {
  return path.join(cacheDir, 'cleanup', 'batches', `${batchId}.db`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

export class BatchService {
  private readonly leaseSeconds: number;
  constructor(private readonly deps: BatchDeps) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  private get db() {
    return this.deps.cleanup;
  }

  get(id: string): BatchRow | null {
    const r = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as RawBatch | undefined;
    return r ? toBatch(r) : null;
  }

  list(limit = 100): BatchRow[] {
    return (
      this.db
        .prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?')
        .all(limit) as RawBatch[]
    ).map(toBatch);
  }

  /** A batch that isn't finished (planned or claimed). */
  open(): BatchRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM batches WHERE state IN ('planned', 'claimed') ORDER BY created_at LIMIT 1`,
      )
      .get() as RawBatch | undefined;
    return r ? toBatch(r) : null;
  }

  /** True while a claimed batch with a live lease works on this library (the indexer waits). */
  holdsIngest(libraryId: string, now = Date.now()): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 FROM batches WHERE library_id = ? AND state = 'claimed' AND lease_expires_at > ? LIMIT 1`,
      )
      .get(libraryId, now);
    return r !== undefined;
  }

  /** The finished batch the indexer hasn't taken in yet (the next batch waits for it). */
  awaitingIngest(): BatchRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM batches WHERE state IN ('applied', 'partial', 'failed', 'undone')
           AND ingested_at IS NULL ORDER BY created_at LIMIT 1`,
      )
      .get() as RawBatch | undefined;
    return r ? toBatch(r) : null;
  }

  /**
   * Marks finished batches as taken in once ttsu.db shows their effect: removed copies
   * flagged missing (apply), restored copies present again (undo).
   */
  checkIngested(now = Date.now()): void {
    for (;;) {
      const batch = this.awaitingIngest();
      if (!batch) return;
      const rows = this.db
        .prepare(
          `SELECT i.state, u.removed_uuid, u.restored_uuid FROM batch_items i
           JOIN proposed_changes c ON c.id = i.change_id
           LEFT JOIN undo_records u ON u.change_id = i.change_id
             AND u.batch_id = COALESCE(?, i.batch_id)
           WHERE i.batch_id = ?`,
        )
        .all(batch.undoOf, batch.id) as {
        state: ItemState;
        removed_uuid: string | null;
        restored_uuid: string | null;
      }[];
      let done = true;
      for (const r of rows) {
        if (batch.kind === 'apply' && r.state === 'removed' && r.removed_uuid) {
          const src = findCalibreSource(this.deps.main, batch.libraryId, r.removed_uuid);
          if (src && src.missingAt === null) done = false;
        }
        if (batch.kind === 'undo' && r.state === 'restored') {
          const uuid = r.restored_uuid ?? r.removed_uuid;
          const src = uuid ? findCalibreSource(this.deps.main, batch.libraryId, uuid) : null;
          if (!src || src.missingAt !== null) done = false;
        }
        if (!done) break;
      }
      if (!done) {
        // The indexer took in a newer metadata.db and the batch's effect is still not there
        // (e.g. a copy was put back by hand, or the mass-missing guard held the flags).
        const state = getIndexState(this.deps.main, batch.libraryId);
        const finishedAt = batch.finishedAt ?? now;
        if (state.indexedAt !== null && state.indexedAt > finishedAt && state.status === 'idle') {
          pauseStage(
            this.db,
            batch.stage,
            'ingest_mismatch',
            state.lastWarning
              ? `The reader's library index did not take in the last batch: ${state.lastWarning}`
              : "The reader's library index doesn't show the last batch's result (a copy may have been put back in Calibre). Check the batch, then resume.",
          );
          this.db
            .prepare('UPDATE batches SET ingested_at = ?, updated_at = ? WHERE id = ?')
            .run(now, now, batch.id);
          continue;
        }
        return;
      }
      this.db
        .prepare('UPDATE batches SET ingested_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, batch.id);
    }
  }

  /** Expired leases: the batch can be claimed again (its items keep their states). */
  expireLeases(now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE batches SET state = 'planned', lease_expires_at = NULL, updated_at = ?
         WHERE state = 'claimed' AND lease_expires_at <= ?`,
      )
      .run(now, now);
  }

  /**
   * Plans the next stage-1 batch. The caller checks the stage mode, pauses and the safety
   * checks; this checks the rest. Returns the batch or why none was made.
   */
  async planStage1(
    libraryId: string,
    shouldStop: () => boolean = () => false,
  ): Promise<{ batch: BatchRow | null; reason: string | null }> {
    if (this.open()) return { batch: null, reason: 'A batch is being applied' };
    if (this.awaitingIngest()) {
      return {
        batch: null,
        reason: "Waiting for the reader's library index to take in the last batch",
      };
    }
    const settings = getSettings(this.db);
    const present = presentBookCount(this.deps.main, libraryId);
    const cap = Math.max(
      1,
      Math.min(
        settings.pacing.batchSize,
        Math.floor((present * settings.pacing.maxBatchPercent) / 100),
      ),
    );
    const candidates = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, evidence_json FROM proposed_changes
         WHERE stage = 1 AND library_id = ? AND state = 'proposed' AND class = 'auto'
           AND analysis_id = ?
         ORDER BY id LIMIT ?`,
      )
      .all(libraryId, currentAnalysisId(this.db), cap) as {
      id: number;
      calibre_id: number;
      calibre_uuid: string;
      evidence_json: string;
    }[];
    if (candidates.length === 0) return { batch: null, reason: null };

    const verdict = await this.verifyStage1(libraryId, candidates, shouldStop);
    if (verdict.stopped) return { batch: null, reason: null };
    const progress = getStage(this.db, 1).precision as { checked?: number; identical?: number };
    updateStage(this.db, 1, {
      precision: {
        checked: (progress.checked ?? 0) + verdict.checked,
        identical: (progress.identical ?? 0) + verdict.identical,
        lastCheckedAt: Date.now(),
      },
    });
    // Calibre changed under the analysis for a large share of these copies (books or EPUBs
    // removed or edited outside the cleanup): nothing is skipped or removed, the stage pauses
    // until the analysis has run again (a skip is only for the odd copy someone edited).
    // Measured against a full batch, so the last few copies of a run don't pause the stage
    // over one edited book.
    const changedShare = (100 * verdict.libraryChanged) / Math.max(cap, candidates.length);
    if (verdict.libraryChanged > 0 && changedShare > settings.libraryChangedPausePercent) {
      pauseStage(
        this.db,
        1,
        'library_changed',
        `${verdict.libraryChanged} of the next ${candidates.length} copies to remove changed in Calibre since the analysis (${summarizeReasons(verdict.skipped)}). ` +
          'Nothing was removed or skipped. Run the analysis again: removing goes on by itself after it.',
      );
      return { batch: null, reason: 'Calibre changed since the analysis' };
    }
    if (verdict.changedIds.length > 0) {
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const { id, reason } of verdict.skipped) mark.run(reason, now, id);
      })();
      if (verdict.notIdentical > 0) {
        pauseStage(
          this.db,
          1,
          'not_identical',
          `${verdict.notIdentical} copies are no longer identical to the copy they were matched with. ` +
            'Nothing was removed. Run the analysis again: removing goes on by itself after it.',
        );
        return { batch: null, reason: 'A copy is no longer identical' };
      }
    }
    const ok = candidates.filter((c) => !verdict.changedIds.includes(c.id));
    if (ok.length === 0) return { batch: null, reason: null };
    return {
      batch: this.createBatch(
        1,
        libraryId,
        'apply',
        null,
        ok.map((c) => c.id),
      ),
      reason: null,
    };
  }

  /** The stage-1 gate: each copy and its kept copy are still the same record and the same bytes. */
  private async verifyStage1(
    libraryId: string,
    candidates: { id: number; calibre_id: number; calibre_uuid: string; evidence_json: string }[],
    shouldStop: () => boolean,
  ): Promise<{
    checked: number;
    identical: number;
    notIdentical: number;
    /** Copies skipped because Calibre changed (gone, EPUB gone, edited, unreadable). */
    libraryChanged: number;
    changedIds: number[];
    skipped: { id: number; reason: string }[];
    stopped: boolean;
  }> {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib || !this.deps.calibreDir) throw new Error('The library is not available');
    const libDir = path.join(this.deps.calibreDir, lib.folder);
    const snapshot = snapshotFile(this.deps.cacheDir, libraryId);
    const books = readSnapshotBooks(snapshot);
    const byUuid = new Map([...books.values()].map((b) => [b.uuid, b]));
    const presence = readSnapshotPresence(snapshot);
    const missing = (uuid: string, calibreId: number | null, which: 'copy' | 'kept'): string => {
      const p = presence.get(uuid);
      const what = which === 'copy' ? 'The copy' : 'The copy to keep';
      if (p && (calibreId === null || p.calibreId === calibreId) && !p.hasEpub) {
        return `${what} has no EPUB in Calibre any more`;
      }
      return `${what} is no longer in Calibre`;
    };
    const settings = getSettings(this.db);
    const pacer = new Pacer(settings.pacing.hashMbPerSecond * 1024 * 1024);
    const facts = this.db.prepare(
      'SELECT size, mtime_ms, sha256 FROM file_facts WHERE library_id = ? AND calibre_id = ?',
    );
    const skipped: { id: number; reason: string }[] = [];
    let identical = 0;
    let notIdentical = 0;
    let libraryChanged = 0;

    const sameFile = async (
      calibreId: number,
      filePath: string,
      sha: string,
    ): Promise<boolean | null> => {
      const f = facts.get(libraryId, calibreId) as
        | { size: number; mtime_ms: number; sha256: string | null }
        | undefined;
      const file = resolveInside(libDir, filePath);
      const st = await statFile(file);
      if (!st) return null;
      if (f && f.sha256 === sha && f.size === st.size && f.mtime_ms === st.mtimeMs) return true;
      const h = await hashSourceFile(file, pacer, shouldStop);
      if (!h) return null;
      return h.sha256 === sha;
    };

    for (const c of candidates) {
      if (shouldStop()) {
        return {
          checked: 0,
          identical: 0,
          notIdentical: 0,
          libraryChanged: 0,
          changedIds: [],
          skipped: [],
          stopped: true,
        };
      }
      const ev = JSON.parse(c.evidence_json) as Evidence;
      const removed = byUuid.get(c.calibre_uuid);
      const kept = byUuid.get(ev.kept.uuid);
      if (!removed || removed.calibreId !== c.calibre_id) {
        libraryChanged++;
        skipped.push({ id: c.id, reason: missing(c.calibre_uuid, c.calibre_id, 'copy') });
        continue;
      }
      if (!kept) {
        libraryChanged++;
        skipped.push({ id: c.id, reason: missing(ev.kept.uuid, null, 'kept') });
        continue;
      }
      if (removed.lastModified !== ev.removed.lastModified) {
        libraryChanged++;
        skipped.push({ id: c.id, reason: 'The copy was changed in Calibre since the analysis' });
        continue;
      }
      const a = await sameFile(removed.calibreId, removed.filePath, ev.sha256);
      const b = await sameFile(kept.calibreId, kept.filePath, ev.sha256);
      if (a === null || b === null) {
        if (shouldStop()) {
          return {
            checked: 0,
            identical: 0,
            notIdentical: 0,
            libraryChanged: 0,
            changedIds: [],
            skipped: [],
            stopped: true,
          };
        }
        libraryChanged++;
        skipped.push({ id: c.id, reason: 'A file of the pair could not be read' });
        continue;
      }
      if (a && b) identical++;
      else {
        notIdentical++;
        skipped.push({ id: c.id, reason: 'The files are no longer identical' });
      }
    }
    return {
      checked: identical + notIdentical,
      identical,
      notIdentical,
      libraryChanged,
      changedIds: skipped.map((s) => s.id),
      skipped,
      stopped: false,
    };
  }

  createBatch(
    stage: number,
    libraryId: string,
    kind: BatchKind,
    undoOf: string | null,
    changeIds: number[],
    now = Date.now(),
  ): BatchRow {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO batches (id, stage, library_id, kind, undo_of, state, item_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
        )
        .run(id, stage, libraryId, kind, undoOf, changeIds.length, now, now);
      const item = this.db.prepare(
        `INSERT INTO batch_items (batch_id, change_id, position, state, updated_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      );
      changeIds.forEach((cid, i) => item.run(id, cid, i, now));
      if (kind === 'apply') {
        const queue = this.db.prepare(
          `UPDATE proposed_changes SET state = 'queued', batch_id = ?, updated_at = ? WHERE id = ?`,
        );
        for (const cid of changeIds) queue.run(id, now, cid);
      }
    })();
    this.deps.log?.(`Cleanup: planned ${kind} batch ${id} (${changeIds.length} items)`);
    return this.get(id)!;
  }

  /**
   * Hands the oldest open batch to the sidecar. A batch claimed for the first time gets a
   * verified metadata.db snapshot (taken before any write). Returns null when there is none,
   * or when the snapshot can't be made right now (Calibre is writing): asked again later.
   */
  async claim(now = Date.now()): Promise<{ batch: SidecarBatch | null; wait: string | null }> {
    this.expireLeases(now);
    const raw = this.db
      .prepare(`SELECT * FROM batches WHERE state = 'planned' ORDER BY created_at LIMIT 1`)
      .get() as RawBatch | undefined;
    if (!raw) return { batch: null, wait: null };
    const batch = toBatch(raw);
    if (!batch.snapshotSaved) {
      try {
        await this.makeSnapshot(batch);
      } catch (err) {
        return { batch: null, wait: `metadata.db snapshot postponed: ${(err as Error).message}` };
      }
    }
    const changed = this.db
      .prepare(
        `UPDATE batches SET state = 'claimed', claimed_at = COALESCE(claimed_at, ?),
           lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND state = 'planned'`,
      )
      .run(now, now + this.leaseSeconds * 1000, now, batch.id).changes;
    if (changed !== 1) return { batch: null, wait: null };
    const view = this.sidecarView(batch.id);
    if (view.kind === 'undo') await this.markCalibreTrash(view, batch.libraryId);
    return { batch: view, wait: null };
  }

  /** Undo: which of the batch's books Calibre's trash folder still holds (read-only). */
  private async markCalibreTrash(view: SidecarBatch, libraryId: string): Promise<void> {
    const lib = getLibrary(this.deps.main, libraryId);
    const libDir = lib && this.deps.calibreDir ? path.join(this.deps.calibreDir, lib.folder) : null;
    for (const item of view.items) {
      if (!libDir) {
        item.inCalibreTrash = null;
        continue;
      }
      try {
        item.inCalibreTrash = await folderExists(
          resolveInside(libDir, `.caltrash/b/${item.calibreId}`),
        );
      } catch {
        item.inCalibreTrash = null;
      }
    }
  }

  private async makeSnapshot(batch: BatchRow): Promise<void> {
    const dest = batchSnapshotPath(this.deps.cacheDir, batch.id);
    if (batch.snapshotSha256) {
      try {
        await fs.access(dest);
        return;
      } catch {
        // Made on an earlier claim but gone from the cache: make it again.
      }
    }
    const lib = getLibrary(this.deps.main, batch.libraryId);
    if (!lib || !this.deps.calibreDir) throw new Error('the library is not available');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await snapshotMetadataDb(path.join(this.deps.calibreDir, lib.folder, METADATA_DB), dest, {
      timeoutMs: 600_000,
    });
    const sha = await sha256File(dest);
    this.db
      .prepare('UPDATE batches SET snapshot_sha256 = ?, updated_at = ? WHERE id = ?')
      .run(sha, Date.now(), batch.id);
  }

  /** The sidecar saved the snapshot in the quarantine folder (sha checked by it). */
  snapshotSaved(batchId: string, sha256: string): void {
    const batch = this.requireClaimed(batchId);
    if (batch.snapshotSha256 !== sha256) {
      throw new BatchError(
        409,
        'snapshot_mismatch',
        'The saved snapshot differs from the one sent',
      );
    }
    this.db
      .prepare('UPDATE batches SET snapshot_saved = 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), batchId);
    // The server's own copy (regenerable cache) is no longer needed.
    void fs.unlink(batchSnapshotPath(this.deps.cacheDir, batchId)).catch(() => {});
  }

  snapshotFileFor(batchId: string): string {
    const batch = this.requireClaimed(batchId);
    if (batch.snapshotSaved) throw new BatchError(410, 'gone', 'The snapshot was already saved');
    return batchSnapshotPath(this.deps.cacheDir, batchId);
  }

  sidecarView(batchId: string): SidecarBatch {
    const batch = this.get(batchId)!;
    const settings = getSettings(this.db);
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, i.change_id, i.state, i.quarantine_dir, c.calibre_id, c.calibre_uuid,
                c.evidence_json, u.quarantine_dir AS undo_dir, u.added_tags_json
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         LEFT JOIN undo_records u ON u.change_id = i.change_id AND u.batch_id = ?
         WHERE i.batch_id = ? ORDER BY i.position`,
      )
      .all(batch.undoOf, batch.id) as {
      item_id: number;
      change_id: number;
      state: ItemState;
      quarantine_dir: string | null;
      calibre_id: number;
      calibre_uuid: string;
      evidence_json: string;
      undo_dir: string | null;
      added_tags_json: string | null;
    }[];
    return {
      id: batch.id,
      kind: batch.kind,
      stage: batch.stage,
      createdAt: batch.createdAt,
      leaseSeconds: this.leaseSeconds,
      itemDelaySeconds: settings.pacing.itemDelaySeconds,
      snapshotSha256: batch.snapshotSha256,
      snapshotSaved: batch.snapshotSaved,
      items: rows.map((r) => {
        const ev = JSON.parse(r.evidence_json) as Evidence;
        return {
          itemId: r.item_id,
          changeId: r.change_id,
          state: r.state,
          quarantineDir: batch.kind === 'undo' ? r.undo_dir : r.quarantine_dir,
          calibreId: r.calibre_id,
          uuid: r.calibre_uuid,
          title: ev.removed?.title ?? ev.title ?? '',
          lastModified: ev.removed?.lastModified ?? null,
          formats: ev.removed?.formats ?? [],
          sha256: ev.sha256,
          kept: { calibreId: ev.kept.calibreId, uuid: ev.kept.uuid },
          addTags:
            batch.kind === 'undo'
              ? this.tagsToTakeOff(batch, r.change_id, ev.kept.uuid, r.added_tags_json)
              : tagsToCopy(ev, settings.customTags),
        };
      }),
    };
  }

  /**
   * Undo: the tags this removal added to the kept copy, except those another removal of the
   * same kept copy also added and that stays removed (a set of three copies).
   */
  private tagsToTakeOff(
    batch: BatchRow,
    changeId: number,
    keptUuid: string,
    json: string | null,
  ): string[] {
    const added = JSON.parse(json ?? '[]') as string[];
    if (added.length === 0) return added;
    const undoing = new Set(
      (
        this.db.prepare('SELECT change_id FROM batch_items WHERE batch_id = ?').all(batch.id) as {
          change_id: number;
        }[]
      ).map((r) => r.change_id),
    );
    const others = this.db
      .prepare(
        `SELECT change_id, added_tags_json FROM undo_records
         WHERE kept_uuid = ? AND restored_at IS NULL AND change_id <> ?`,
      )
      .all(keptUuid, changeId) as { change_id: number; added_tags_json: string }[];
    const stillNeeded = new Set(
      others
        .filter((o) => !undoing.has(o.change_id))
        .flatMap((o) => (JSON.parse(o.added_tags_json) as string[]).map((t) => t.toLowerCase())),
    );
    return added.filter((t) => !stillNeeded.has(t.toLowerCase()));
  }

  private requireClaimed(batchId: string): BatchRow {
    const batch = this.get(batchId);
    if (!batch) throw new BatchError(404, 'not_found', 'No such batch');
    if (batch.state !== 'claimed') {
      throw new BatchError(
        409,
        'not_claimed',
        'The batch is not claimed (its lease may have run out)',
      );
    }
    return batch;
  }

  /** Extends the lease (any report does this too). */
  progress(batchId: string, now = Date.now()): void {
    this.requireClaimed(batchId);
    this.db
      .prepare('UPDATE batches SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(now + this.leaseSeconds * 1000, now, batchId);
  }

  /** One step of one item. Idempotent for a repeated report of the state it already has. */
  report(
    batchId: string,
    itemId: number,
    report: ItemReport,
    now = Date.now(),
  ): { state: ItemState } {
    const batch = this.requireClaimed(batchId);
    if (batch.kind === 'apply' && !batch.snapshotSaved && report.step !== 'skipped') {
      throw new BatchError(
        409,
        'snapshot_first',
        'Save the metadata.db snapshot before the first item',
      );
    }
    const item = this.db
      .prepare('SELECT * FROM batch_items WHERE id = ? AND batch_id = ?')
      .get(itemId, batchId) as
      | { id: number; change_id: number; state: ItemState; quarantine_dir: string | null }
      | undefined;
    if (!item) throw new BatchError(404, 'not_found', 'No such item in this batch');
    this.progress(batchId, now);
    if (item.state === report.step) return { state: item.state };

    const detail = report.detail ? String(report.detail).slice(0, 2000) : null;
    if (batch.kind === 'apply') {
      if (!APPLY_STEPS[item.state].includes(report.step)) {
        throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
      }
      if (report.step === 'exported') {
        if (!report.quarantineDir || !report.exportSha256) {
          throw new BatchError(400, 'bad_report', 'exported needs quarantineDir and exportSha256');
        }
        const change = this.change(item.change_id);
        if (report.exportSha256 !== change.evidence.sha256) {
          throw new BatchError(
            409,
            'export_mismatch',
            'The exported EPUB differs from the analysed file',
          );
        }
      }
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE batch_items SET state = ?, quarantine_dir = COALESCE(?, quarantine_dir),
               export_sha256 = COALESCE(?, export_sha256), detail = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            report.step,
            report.quarantineDir ?? null,
            report.exportSha256 ?? null,
            detail,
            now,
            itemId,
          );
        if (report.step === 'removed') this.recordRemoval(batch, item.change_id, itemId, now);
        if (report.step === 'skipped' || report.step === 'failed') {
          this.db
            .prepare(
              `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run(detail ?? report.step, now, item.change_id);
        }
      })();
    } else {
      if (item.state !== 'pending' || !TERMINAL_UNDO.includes(report.step)) {
        throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
      }
      if (report.step === 'restored') this.recordRestore(batch, item.change_id, report, now);
      this.db
        .prepare(
          `UPDATE batch_items SET state = ?, method = ?, detail = ?, updated_at = ? WHERE id = ?`,
        )
        .run(report.step, report.method ?? null, detail, now, itemId);
    }
    return { state: report.step };
  }

  private change(changeId: number): {
    libraryId: string;
    uuid: string;
    calibreId: number;
    evidence: Evidence;
  } {
    const r = this.db
      .prepare(
        'SELECT library_id, calibre_uuid, calibre_id, evidence_json FROM proposed_changes WHERE id = ?',
      )
      .get(changeId) as
      | { library_id: string; calibre_uuid: string; calibre_id: number; evidence_json: string }
      | undefined;
    if (!r) throw new BatchError(404, 'not_found', 'No such change');
    return {
      libraryId: r.library_id,
      uuid: r.calibre_uuid,
      calibreId: r.calibre_id,
      evidence: JSON.parse(r.evidence_json) as Evidence,
    };
  }

  /** Records the removal (intent first), then runs the reader-side handoff. */
  private recordRemoval(batch: BatchRow, changeId: number, itemId: number, now: number): void {
    const change = this.change(changeId);
    const item = this.db
      .prepare('SELECT quarantine_dir FROM batch_items WHERE id = ?')
      .get(itemId) as {
      quarantine_dir: string | null;
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO undo_records (batch_id, change_id, library_id, removed_calibre_id,
           removed_uuid, kept_calibre_id, kept_uuid, tags_json, added_tags_json, quarantine_dir, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        changeId,
        change.libraryId,
        change.calibreId,
        change.uuid,
        change.evidence.kept.calibreId,
        change.evidence.kept.uuid,
        JSON.stringify(change.evidence.removed.tags ?? []),
        JSON.stringify(tagsToCopy(change.evidence, getSettings(this.db).customTags)),
        item.quarantine_dir,
        now,
      );
    const existing = this.db
      .prepare('SELECT handoff_json FROM undo_records WHERE batch_id = ? AND change_id = ?')
      .get(batch.id, changeId) as { handoff_json: string };
    const previous = JSON.parse(existing.handoff_json) as Handoff | Record<string, never>;
    const handoff = applyHandoff(
      this.deps.main,
      change.libraryId,
      change.evidence.kept.uuid,
      change.uuid,
      'kind' in previous ? (previous as Handoff) : null,
      now,
    );
    this.db
      .prepare('UPDATE undo_records SET handoff_json = ? WHERE batch_id = ? AND change_id = ?')
      .run(JSON.stringify(handoff), batch.id, changeId);
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'applied', decided_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, changeId);
  }

  private recordRestore(batch: BatchRow, changeId: number, report: ItemReport, now: number): void {
    if (!batch.undoOf) throw new BatchError(409, 'bad_batch', 'Undo batch without its batch');
    const rec = this.db
      .prepare('SELECT * FROM undo_records WHERE batch_id = ? AND change_id = ?')
      .get(batch.undoOf, changeId) as
      | { removed_uuid: string; handoff_json: string; restored_at: number | null }
      | undefined;
    if (!rec) throw new BatchError(404, 'not_found', 'No undo record for this item');
    if (!report.method || !report.uuid || typeof report.calibreId !== 'number') {
      throw new BatchError(400, 'bad_report', 'restored needs method, calibreId and uuid');
    }
    const handoff = JSON.parse(rec.handoff_json) as Handoff;
    let rebind: string | null = null;
    if (report.uuid !== rec.removed_uuid && handoff.removedSourceId) {
      rebind = rebindRestoredSource(
        this.deps.main,
        handoff.removedSourceId,
        report.uuid,
        report.calibreId,
        now,
      );
    } else if (report.uuid !== rec.removed_uuid) {
      const src = findCalibreSource(this.deps.main, batch.libraryId, rec.removed_uuid);
      if (src)
        rebind = rebindRestoredSource(
          this.deps.main,
          src.sourceId,
          report.uuid,
          report.calibreId,
          now,
        );
    }
    reverseHandoff(this.deps.main, handoff, now);
    this.db
      .prepare(
        `UPDATE undo_records SET restored_at = ?, restore_method = ?, restored_calibre_id = ?,
           restored_uuid = ? WHERE batch_id = ? AND change_id = ?`,
      )
      .run(
        now,
        report.method + (rebind ? `:${rebind}` : ''),
        report.calibreId,
        report.uuid,
        batch.undoOf,
        changeId,
      );
    this.db
      .prepare(`UPDATE proposed_changes SET state = 'undone', updated_at = ? WHERE id = ?`)
      .run(now, changeId);
  }

  /** The sidecar is done with the batch: every item must be in a final state. */
  finish(batchId: string, error: string | null = null, now = Date.now()): BatchRow {
    const batch = this.requireClaimed(batchId);
    const states = (
      this.db.prepare('SELECT state FROM batch_items WHERE batch_id = ?').all(batchId) as {
        state: ItemState;
      }[]
    ).map((r) => r.state);
    const terminal = batch.kind === 'apply' ? TERMINAL_APPLY : TERMINAL_UNDO;
    if (!error && states.some((s) => !terminal.includes(s))) {
      throw new BatchError(409, 'not_done', 'Some items are not finished');
    }
    const good = batch.kind === 'apply' ? 'removed' : 'restored';
    const failed = states.filter((s) => s === 'failed' || !terminal.includes(s)).length;
    const doneCount = states.filter((s) => s === good).length;
    const state: BatchState =
      failed === 0
        ? 'applied'
        : doneCount > 0 || states.some((s) => s === 'skipped')
          ? 'partial'
          : 'failed';
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE batches SET state = ?, finished_at = ?, lease_expires_at = NULL, error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(state, now, error, now, batchId);
      if (error) {
        // The batch stopped: items it never finished are marked, so the batch doesn't show
        // them as still to go (an apply item goes back to the proposals just below).
        this.db
          .prepare(
            `UPDATE batch_items SET state = 'skipped', detail = ?, updated_at = ?
             WHERE batch_id = ? AND state NOT IN ('removed', 'restored', 'failed', 'skipped')`,
          )
          .run(
            batch.kind === 'apply'
              ? 'Not finished: the batch stopped; the copy is tried again in a later batch'
              : 'Not finished: the Undo stopped',
            now,
            batchId,
          );
      }
      if (batch.kind === 'apply') {
        // Items the sidecar never reached go back to the proposals.
        this.db
          .prepare(
            `UPDATE proposed_changes SET state = 'proposed', batch_id = NULL, updated_at = ?
             WHERE batch_id = ? AND state = 'queued'`,
          )
          .run(now, batchId);
      }
      if (batch.kind === 'undo' && batch.undoOf) {
        const left = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM undo_records WHERE batch_id = ? AND restored_at IS NULL`,
            )
            .get(batch.undoOf) as { n: number }
        ).n;
        if (left === 0) {
          this.db
            .prepare(`UPDATE batches SET state = 'undone', updated_at = ? WHERE id = ?`)
            .run(now, batch.undoOf);
        }
      }
    })();
    if (failed > 0 && batch.kind === 'apply') {
      pauseStage(
        this.db,
        batch.stage,
        'batch_failed',
        `${failed} of ${states.length} items failed in the last batch${error ? `: ${error}` : ''}. ` +
          'Check the batch, then resume.',
      );
    }
    this.deps.log?.(`Cleanup: ${batch.kind} batch ${batchId} finished: ${state}`);
    return this.get(batchId)!;
  }

  /**
   * Undo of an applied (or partly applied) batch: a new batch for the sidecar that brings the
   * removed copies back. Only the newest batch touching these books can be undone.
   */
  undo(batchId: string, now = Date.now()): BatchRow {
    const batch = this.get(batchId);
    if (!batch) throw new BatchError(404, 'not_found', 'No such batch');
    if (batch.kind !== 'apply' || !['applied', 'partial', 'failed'].includes(batch.state)) {
      throw new BatchError(409, 'not_undoable', 'Only an applied batch can be undone');
    }
    if (this.open())
      throw new BatchError(409, 'busy', 'Another batch is being applied; try again after it');
    const records = this.db
      .prepare(
        `SELECT change_id, removed_uuid, kept_uuid FROM undo_records
         WHERE batch_id = ? AND restored_at IS NULL`,
      )
      .all(batchId) as { change_id: number; removed_uuid: string; kept_uuid: string }[];
    if (records.length === 0)
      throw new BatchError(409, 'nothing_to_undo', 'Nothing in this batch to bring back');
    const uuids = new Set(records.flatMap((r) => [r.removed_uuid, r.kept_uuid]));
    const later = this.db
      .prepare(
        `SELECT u.removed_uuid, u.kept_uuid FROM undo_records u JOIN batches b ON b.id = u.batch_id
         WHERE b.created_at > ? AND b.kind = 'apply' AND u.restored_at IS NULL`,
      )
      .all(batch.createdAt) as { removed_uuid: string; kept_uuid: string }[];
    if (later.some((r) => uuids.has(r.removed_uuid) || uuids.has(r.kept_uuid))) {
      throw new BatchError(
        409,
        'later_batch',
        'A later batch changed some of these books; undo that one first',
      );
    }
    return this.createBatch(
      batch.stage,
      batch.libraryId,
      'undo',
      batchId,
      records.map((r) => r.change_id),
      now,
    );
  }

  items(batchId: string, offset = 0, limit = 200) {
    return this.db
      .prepare(
        `SELECT i.id, i.state, i.quarantine_dir, i.method, i.detail, i.updated_at, c.calibre_id,
                c.calibre_uuid, c.evidence_json, u.handoff_json, u.restore_method
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         LEFT JOIN undo_records u ON u.change_id = i.change_id
           AND u.batch_id = (SELECT COALESCE(undo_of, id) FROM batches WHERE id = i.batch_id)
         WHERE i.batch_id = ? ORDER BY i.position LIMIT ? OFFSET ?`,
      )
      .all(batchId, limit, offset) as Record<string, unknown>[];
  }

  itemCounts(batchId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM batch_items WHERE batch_id = ? GROUP BY state')
      .all(batchId) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}

/** "3 have no EPUB in Calibre any more, 1 is no longer in Calibre" for a pause message. */
export function summarizeReasons(skipped: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)
    .join('; ');
}
