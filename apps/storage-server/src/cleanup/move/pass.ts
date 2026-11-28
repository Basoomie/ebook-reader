/**
 * Manga part A (manga-library.md): the move pass, with its own Off / Preview / On on /cleanup.
 *
 *   select  the books of the cleanup's library tagged マンガ or 画像のみ (the reader's snapshot),
 *           each decided by move/select.ts: moved automatically, or held for review with its
 *           reason (real text by the reader's count, no EPUB, no trusted count, names too long);
 *   spot    30 of the automatic moves drawn for the spot check (in proportion to the tags); in
 *           Preview the pass stops here; On is refused until every book is marked and none is
 *           wrong (the user, 2026-11-24);
 *   write   (On) move batches one at a time (move-batches.ts), each after the last one's index;
 *   done    until the library's snapshot changes: then books newly tagged are selected again, a
 *           new round of the same run (the spot check stands): the card's counts and bar start
 *           again from that round, never adding to the last round's.
 *
 * While a new-arrivals run of the library is going the pass waits (the user, 2026-11-27): the
 * run moves its own manga in its phase `move`, and the pass picks up what is left after it.
 *
 * Proposals are stage 11 rows of proposed_changes (field 'book', old: the library folder, new:
 * the target folder) under `move:<run>`; a held book is a review row, "Move it anyway" makes it
 * automatic, "Keep it here" marks it kept. New arrivals' moves use `move:arrivals:<run>`
 * (arrivals/run.ts, the phase `move`).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import { snapshotFile } from '../../calibre/indexer';
import { getLibrary, listLibraries } from '../../calibre/libraries';
import type { BatchRow, BatchService } from '../batches';
import { MOVE_STAGE } from '../field-stages';
import { getSettings } from '../settings';
import type { MoveEvidence } from './move-batches';
import {
  decideMove,
  drawSpot,
  HOLD_TEXT,
  readMoveCandidates,
  readReaderFacts,
  type HoldReason,
  type MoveDecision,
} from './select';
import {
  emptyMoveProgress,
  getMoveState,
  moveAnalysisId,
  resumeMove,
  saveMoveProgress,
  setMoveMode,
  type MoveMode,
  type MovePhase,
  type MoveProgress,
  type MoveState,
} from './state';

export const MOVE_SPOT_SIZE = 30;
/** Proposals inserted per step of the select phase (the server answers between steps). */
const SELECT_CHUNK = 200;
/** The spot check passes with every book marked and at most this many wrong (the user: none). */
export const MOVE_SPOT_MAX_WRONG = 0;
/** The card's line while a new-arrivals run of the library is going. */
export const ARRIVALS_WAIT =
  'Waiting for the new-arrivals run to finish: it moves its own manga, and this picks up the rest after it';

export type MoveStep = 'more' | 'wait' | 'idle';

export interface MovePassDeps {
  db: Database.Database;
  main: Database.Database;
  cacheDir: string;
  batches: BatchService;
  /** The cleanup's library (the books move from it). */
  sourceLibrary: () => string | null;
  /** Why a write must wait now (as the other passes': a batch open, stages 1-3 writing, checks). */
  writeWait: (lib: string, target: string) => string | null;
  /** The reader books (of these) that hold the user's data (handoff.ts). */
  withData: (bookIds: string[]) => Set<string>;
  /** A new-arrivals run of this library is going (the pass waits for it to end). */
  arrivalsRunning?: (lib: string) => boolean;
  log?: (m: string) => void;
}

/** A held book or a spot-check book as the card shows it. */
export interface MoveBookView {
  changeId: number;
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  series: string | null;
  tags: string[];
  matched: string[];
  formats: string[];
  chars: number | null;
  hold: HoldReason | null;
  holdText: string | null;
  holdDetail: string | null;
  readerBookId: string | null;
  readerHasData: boolean;
  state: string;
  klass: string;
  decidedBy: string | null;
  verdict?: 'right' | 'wrong' | null;
}

const orderKeyOf = (run: number) => (uuid: string) =>
  createHash('sha256').update(`move:${run}:${uuid}`).digest('hex');

export class MovePass {
  private readonly db: Database.Database;

  constructor(private readonly deps: MovePassDeps) {
    this.db = deps.db;
  }

  /** The reader library the books move to (settings.move.targetFolder), when the reader has it. */
  targetLibrary(): string | null {
    const folder = getSettings(this.db).move.targetFolder;
    return listLibraries(this.deps.main).find((l) => l.folder === folder)?.id ?? null;
  }

  state(): MoveState {
    return getMoveState(this.db);
  }

  setMode(mode: MoveMode): void {
    if (mode === 'on' && !this.spotPassed())
      throw new Error('Switch On only after the spot check: every book marked, none wrong');
    setMoveMode(this.db, mode);
    this.deps.log?.(`Move to the manga library: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  resume(): void {
    resumeMove(this.db);
  }

  /** Selects again from the library as it is now (a new run; moved books stay moved). */
  again(): void {
    const p = this.state().progress;
    if (p.libraryId)
      this.db
        .prepare(
          `DELETE FROM proposed_changes WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ?
             AND state IN ('proposed', 'skipped') AND batch_id IS NULL`,
        )
        .run(p.libraryId, moveAnalysisId(p.run));
    this.db.prepare('DELETE FROM calibre_move_spot').run();
    this.selecting = null;
    resumeMove(this.db);
    saveMoveProgress(this.db, emptyMoveProgress(p.run + 1, p.libraryId, p.targetId));
  }

  /** One step; 'idle' when there is nothing to do now. */
  async step(shouldStop: () => boolean = () => false): Promise<MoveStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.sourceLibrary();
    const target = this.targetLibrary();
    let p = st.progress;
    if (!lib || !target || lib === target) {
      p.write.waiting = !target
        ? `The reader has no library in the folder "${getSettings(this.db).move.targetFolder}"`
        : 'Choose the library to clean';
      saveMoveProgress(this.db, p);
      return 'idle';
    }
    if (p.libraryId !== lib || p.targetId !== target) {
      p = emptyMoveProgress(p.run + (p.libraryId ? 1 : 0), lib, target);
      saveMoveProgress(this.db, p);
    }
    if (st.pausedReason) return 'idle';
    if (this.deps.arrivalsRunning?.(lib)) {
      if (p.write.waiting !== ARRIVALS_WAIT) {
        p.write.waiting = ARRIVALS_WAIT;
        saveMoveProgress(this.db, p);
      }
      return 'idle';
    }
    if (p.write.waiting === ARRIVALS_WAIT) p.write.waiting = null;
    if (p.phase === 'done') {
      // Books tagged since (by hand in Calibre, or by a new-arrivals run) are selected when the
      // library's snapshot changes: a new round, counted on its own.
      const mtime = this.snapshotMtime(lib);
      if (mtime === null || mtime === p.snapshotMtimeMs) return 'idle';
      p.counts = { ...emptyMoveProgress().counts, alreadyMoved: p.counts.alreadyMoved };
      p.write = { ...p.write, waiting: null, startedAt: null, movedAtStart: null };
      this.next(p, 'select');
    }
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    const phase = p.phase;
    const t0 = performance.now();
    let r: MoveStep = 'idle';
    try {
      if (p.phase === 'select') r = this.selectStep(p, lib, target);
      else if (p.phase === 'spot') r = this.spotStep(p, st.mode);
      else if (p.phase === 'write')
        r = st.mode === 'on' ? await this.writeStep(p, lib, target, shouldStop) : 'idle';
    } catch (err) {
      p.error = String((err as Error).message ?? err).slice(0, 500);
      this.deps.log?.(`Move to the manga library failed: ${p.error}`);
      r = 'idle';
    } finally {
      const ms = performance.now() - t0;
      const t = ((p.times ??= {})[phase] ??= { n: 0, maxMs: 0, totalMs: 0 });
      t.n++;
      t.maxMs = Math.max(t.maxMs, Math.round(ms));
      t.totalMs += Math.round(ms);
      saveMoveProgress(this.db, p);
    }
    return r;
  }

  private next(p: MoveProgress, phase: MovePhase): void {
    p.phase = phase;
    p.phaseStartedAt = Date.now();
    p.error = null;
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private snapshotMtime(lib: string): number | null {
    try {
      return Math.round(fs.statSync(snapshotFile(this.deps.cacheDir, lib)).mtimeMs);
    } catch {
      return null;
    }
  }

  /** The decisions for the library's tagged books as they are now (read only). */
  decide(lib: string): { decisions: MoveDecision[]; snapshotMtimeMs: number | null } {
    const settings = getSettings(this.db);
    const file = snapshotFile(this.deps.cacheDir, lib);
    const mtime = this.snapshotMtime(lib);
    if (mtime === null) return { decisions: [], snapshotMtimeMs: null };
    const candidates = readMoveCandidates(file, settings.move.tags);
    const reader = readReaderFacts(this.deps.main, lib, candidates, this.deps.withData);
    return {
      decisions: candidates.map((c) =>
        decideMove(c, reader.get(c.uuid) ?? null, settings.move.realTextChars),
      ),
      snapshotMtimeMs: mtime,
    };
  }

  /**
   * Proposes a move for each decided book that has none yet: a book proposed, queued, moved or
   * kept before is never proposed again, and neither is one you moved back by Undo (found in the
   * e2e at NAS scale: the pass, still On, selected the undone books again as soon as the reader's
   * snapshot showed them back, and moved them again). A book re-added from the quarantine by
   * that Undo has a new UUID: its move record names it (back_uuid). Returns the counts.
   */
  propose(
    lib: string,
    target: string,
    analysisId: string,
    decisions: MoveDecision[],
    now = Date.now(),
  ): { auto: number; held: Record<string, number>; withData: number; already: number } {
    const settings = getSettings(this.db);
    const targetFolder = settings.move.targetFolder;
    const sourceFolder = getLibrary(this.deps.main, lib)?.folder ?? lib;
    const has = this.db.prepare(
      `SELECT 1 FROM proposed_changes WHERE library_id = @lib AND calibre_uuid = @uuid AND stage = ${MOVE_STAGE}
         AND state IN ('proposed', 'queued', 'applied', 'kept', 'undone')
       UNION ALL
       SELECT 1 FROM calibre_moves WHERE from_library_id = @lib AND back_uuid = @uuid AND state = 'undone'
       LIMIT 1`,
    );
    const insert = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (${MOVE_STAGE}, ?, ?, ?, 'book', ?, ?, 'move', ?, ?, ?, 'proposed', ?, ?, ?)`,
    );
    const out = { auto: 0, held: {} as Record<string, number>, withData: 0, already: 0 };
    this.db.transaction(() => {
      for (const d of decisions) {
        const c = d.candidate;
        if (has.get({ lib, uuid: c.uuid })) {
          out.already++;
          continue;
        }
        const ev: MoveEvidence = {
          title: c.title,
          authors: c.authors,
          series: c.series,
          formats: c.formats,
          tags: c.tags,
          matched: c.matched,
          lastModified: c.lastModified,
          epubPath: c.epubPath,
          epubSize: c.epubSize,
          chars: d.reader?.chars ?? null,
          hold: d.hold,
          holdDetail: d.detail,
          readerBookId: d.reader?.bookId ?? null,
          readerHasData: d.reader?.hasData ?? false,
          targetLibraryId: target,
        };
        insert.run(
          lib,
          c.calibreId,
          c.uuid,
          JSON.stringify(sourceFolder),
          JSON.stringify(targetFolder),
          JSON.stringify(ev),
          d.hold ? 'review' : 'auto',
          d.hold ? HOLD_TEXT[d.hold] : null,
          analysisId,
          now,
          now,
        );
        if (d.hold) out.held[d.hold] = (out.held[d.hold] ?? 0) + 1;
        else out.auto++;
        if (ev.readerHasData) out.withData++;
      }
    })();
    return out;
  }

  /**
   * The decisions of the select step under way, proposed a chunk per step: inserting 1,730
   * proposals into the live-size cleanup.db took 1.1 s in one transaction on the PC (stop 1), too
   * long to hold the server (lessons 3); a chunk is a fraction of that. A restart reads again
   * (the reads take ~150 ms) and the never-again check skips what was already proposed.
   */
  private selecting: { run: number; decisions: MoveDecision[]; mtime: number; at: number } | null =
    null;

  private selectStep(p: MoveProgress, lib: string, target: string): MoveStep {
    if (!this.selecting || this.selecting.run !== p.run) {
      const { decisions, snapshotMtimeMs } = this.decide(lib);
      if (snapshotMtimeMs === null) {
        p.write.waiting = "The reader's copy of the library isn't there yet";
        return 'idle';
      }
      this.selecting = { run: p.run, decisions, mtime: snapshotMtimeMs, at: 0 };
      p.counts.tagged = decisions.length;
    }
    const s = this.selecting;
    const chunk = s.decisions.slice(s.at, s.at + SELECT_CHUNK);
    const r = this.propose(lib, target, moveAnalysisId(p.run), chunk);
    s.at += chunk.length;
    p.counts.auto += r.auto;
    for (const [k, n] of Object.entries(r.held)) p.counts.held[k] = (p.counts.held[k] ?? 0) + n;
    p.counts.withData += r.withData;
    if (s.at < s.decisions.length) return 'more';
    // The counts are the run's books still open, read once the round is in: a book proposed
    // again in a later round (skipped because Calibre changed it, or failed) is counted once.
    p.counts = { ...p.counts, ...this.openCounts(lib, p.run) };
    p.snapshotMtimeMs = s.mtime;
    p.counts.alreadyMoved = this.movedCount(lib);
    this.selecting = null;
    this.next(p, 'spot');
    return 'more';
  }

  private spotStep(p: MoveProgress, mode: MoveMode): MoveStep {
    const lib = p.libraryId!;
    const drawn = (
      this.db.prepare('SELECT COUNT(*) AS n FROM calibre_move_spot').get() as { n: number }
    ).n;
    if (drawn === 0) {
      const rows = this.db
        .prepare(
          `SELECT id, calibre_uuid, evidence_json FROM proposed_changes INDEXED BY proposed_changes_move
           WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'proposed'
             AND class = 'auto'`,
        )
        .all(lib, moveAnalysisId(p.run)) as {
        id: number;
        calibre_uuid: string;
        evidence_json: string;
      }[];
      const books = rows.map((r) => ({
        changeId: r.id,
        uuid: r.calibre_uuid,
        matched: (JSON.parse(r.evidence_json) as MoveEvidence).matched,
      }));
      const tags = getSettings(this.db).move.tags;
      const pick = drawSpot(books, tags, MOVE_SPOT_SIZE, orderKeyOf(p.run));
      const put = this.db.prepare(
        `INSERT OR IGNORE INTO calibre_move_spot (library_id, calibre_uuid, change_id, position, tag)
         VALUES (?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        pick.forEach((b, i) =>
          put.run(lib, b.uuid, b.changeId, i, tags.find((t) => b.matched.includes(t)) ?? tags[0]),
        );
      })();
    }
    if (mode !== 'on' || !this.spotPassed()) return 'idle';
    this.next(p, 'write');
    return 'more';
  }

  private async writeStep(
    p: MoveProgress,
    lib: string,
    target: string,
    shouldStop: () => boolean,
  ): Promise<MoveStep> {
    const wait = this.deps.writeWait(lib, target);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const left = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_move
           WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND state IN ('proposed', 'queued')
             AND class = 'auto'`,
        )
        .get(lib, moveAnalysisId(p.run)) as { n: number }
    ).n;
    if (left === 0) {
      p.write.waiting = null;
      this.next(p, 'done');
      return 'idle';
    }
    const { batch, reason } = await this.deps.batches.moves.plan(
      lib,
      target,
      moveAnalysisId(p.run),
      shouldStop,
    );
    p.write.waiting = reason;
    if (batch) {
      p.write.startedAt ??= Date.now();
      p.write.movedAtStart ??= this.movedCount(lib);
      p.write.batches.push(batch.id);
      this.deps.log?.(`Move to the manga library: batch ${batch.id} (${batch.itemCount} books)`);
    }
    return 'wait';
  }

  /** The run's open proposals: to move, held (by reason, as the held list) and with reader data. */
  private openCounts(
    lib: string,
    run: number,
  ): { auto: number; held: Record<string, number>; withData: number } {
    const rows = this.db
      .prepare(
        `SELECT class, json_extract(evidence_json, '$.hold') AS hold,
           json_extract(evidence_json, '$.readerHasData') AS data, COUNT(*) AS n
         FROM proposed_changes INDEXED BY proposed_changes_move
         WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ?
           AND ((class = 'auto' AND state IN ('proposed', 'queued'))
             OR (class = 'review' AND state IN ('proposed', 'kept')))
         GROUP BY 1, 2, 3`,
      )
      .all(lib, moveAnalysisId(run)) as {
      class: string;
      hold: string | null;
      data: number | null;
      n: number;
    }[];
    const out = { auto: 0, held: {} as Record<string, number>, withData: 0 };
    for (const r of rows) {
      if (r.class === 'auto') out.auto += r.n;
      else {
        const k = r.hold ?? 'other';
        out.held[k] = (out.held[k] ?? 0) + r.n;
      }
      if (r.data) out.withData += r.n;
    }
    return out;
  }

  /** Books of this library moved and not brought back. */
  movedCount(lib: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_moves WHERE from_library_id = ? AND state = 'moved'`,
        )
        .get(lib) as { n: number }
    ).n;
  }

  /** The run's proposals by class and state. */
  proposalCounts(lib: string, run: number): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT class, state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_move
         WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? GROUP BY class, state`,
      )
      .all(lib, moveAnalysisId(run)) as { class: string; state: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.class}:${r.state}`] = r.n;
    return out;
  }

  // ---- the spot check ----

  spotCounts(): { total: number; right: number; wrong: number; open: number } {
    const rows = this.db
      .prepare('SELECT verdict, COUNT(*) AS n FROM calibre_move_spot GROUP BY verdict')
      .all() as { verdict: string | null; n: number }[];
    const by = (v: string | null) => rows.find((r) => r.verdict === v)?.n ?? 0;
    const total = rows.reduce((a, r) => a + r.n, 0);
    return { total, right: by('right'), wrong: by('wrong'), open: by(null) };
  }

  spotPassed(): boolean {
    const c = this.spotCounts();
    return c.total > 0 && c.open === 0 && c.wrong <= MOVE_SPOT_MAX_WRONG;
  }

  setVerdict(uuid: string, verdict: 'right' | 'wrong' | null, now = Date.now()): void {
    const p = this.state().progress;
    if (p.phase === 'write' || p.phase === 'done')
      throw new Error('The spot check is closed: the move is writing or done');
    const changed = this.db
      .prepare('UPDATE calibre_move_spot SET verdict = ?, decided_at = ? WHERE calibre_uuid = ?')
      .run(verdict, verdict ? now : null, uuid).changes;
    if (changed === 0) throw new Error('No such book in the spot check');
  }

  spotList(): MoveBookView[] {
    const rows = this.db
      .prepare(
        `SELECT s.verdict, c.* FROM calibre_move_spot s JOIN proposed_changes c ON c.id = s.change_id
         ORDER BY s.position`,
      )
      .all() as (ProposalRow & { verdict: 'right' | 'wrong' | null })[];
    return rows.map((r) => ({ ...this.view(r), verdict: r.verdict }));
  }

  // ---- the held books ----

  /** Held books (review), newest run, paged; `reason` narrows to one hold. */
  heldList(lib: string, run: number, offset = 0, limit = 50, reason?: HoldReason) {
    const where = `stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND class = 'review'
      AND state IN ('proposed', 'kept')${reason ? ` AND json_extract(evidence_json, '$.hold') = ?` : ''}`;
    const params: unknown[] = [lib, moveAnalysisId(run), ...(reason ? [reason] : [])];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM proposed_changes WHERE ${where}`)
        .get(...params) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM proposed_changes WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ProposalRow[];
    return { total, books: rows.map((r) => this.view(r)) };
  }

  /** "Move it anyway" (automatic from now on) or "Keep it here" for a held book. */
  choose(changeId: number, choice: 'move' | 'keep', now = Date.now()): void {
    const r = this.db
      .prepare(
        `SELECT state, class, evidence_json FROM proposed_changes WHERE id = ? AND stage = ${MOVE_STAGE}`,
      )
      .get(changeId) as { state: string; class: string; evidence_json: string } | undefined;
    if (!r) throw new Error('No such book');
    if (!['proposed', 'kept'].includes(r.state))
      throw new Error('This book is being moved or was moved');
    const ev = { ...(JSON.parse(r.evidence_json) as MoveEvidence), choice };
    if (choice === 'move' && !ev.epubPath)
      throw new Error('A book without an EPUB is not moved (the reader shows EPUB only)');
    this.db
      .prepare(
        `UPDATE proposed_changes SET class = ?, state = ?, decided_by = 'you', decided_at = ?,
           evidence_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        choice === 'move' ? 'auto' : 'review',
        choice === 'move' ? 'proposed' : 'kept',
        now,
        JSON.stringify(ev),
        now,
        changeId,
      );
    // A book moved anyway goes in the next batch of a finished run.
    const p = this.state().progress;
    if (choice === 'move' && p.phase === 'done') {
      this.next(p, 'write');
      saveMoveProgress(this.db, p);
    }
  }

  private view(r: ProposalRow): MoveBookView {
    const ev = JSON.parse(r.evidence_json) as MoveEvidence;
    return {
      changeId: r.id,
      calibreId: r.calibre_id,
      uuid: r.calibre_uuid,
      title: ev.title,
      authors: ev.authors,
      series: ev.series,
      tags: ev.tags,
      matched: ev.matched,
      formats: ev.formats,
      chars: ev.chars,
      hold: (ev.hold as HoldReason | null) ?? null,
      holdText: ev.hold ? HOLD_TEXT[ev.hold as HoldReason] : null,
      holdDetail: ev.holdDetail,
      readerBookId: ev.readerBookId,
      readerHasData: ev.readerHasData,
      state: r.state,
      klass: r.class,
      decidedBy: r.decided_by,
    };
  }

  /** Batches of the move, newest first (the card's list; Undo is the shared batches route). */
  batchesOf(limit = 50): BatchRow[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM batches WHERE stage = ${MOVE_STAGE} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => this.deps.batches.get(r.id)!);
  }
}

interface ProposalRow {
  id: number;
  calibre_id: number;
  calibre_uuid: string;
  evidence_json: string;
  state: string;
  class: string;
  decided_by: string | null;
}
