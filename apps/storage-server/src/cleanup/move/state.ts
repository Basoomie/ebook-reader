/**
 * Manga part A: the move's own Off/Preview/On, progress and pause (cleanup.db v33,
 * calibre_move_state; the stages table holds stages 0-5 only, as for the other passes).
 */
import type Database from 'better-sqlite3';

export type MoveMode = 'off' | 'analyse' | 'on';
export type MovePhase = 'select' | 'spot' | 'write' | 'done';

export interface MoveProgress {
  run: number;
  /** The library the books move from (the cleanup's library) and the one they move to. */
  libraryId: string | null;
  targetId: string | null;
  phase: MovePhase;
  startedAt: number | null;
  phaseStartedAt: number | null;
  finishedAt: number | null;
  /** The snapshot the selection read (its mtime): a newer one selects again. */
  snapshotMtimeMs: number | null;
  counts: {
    tagged: number;
    auto: number;
    held: Record<string, number>;
    withData: number;
    alreadyMoved: number;
  };
  write: {
    batches: string[];
    waiting: string | null;
    startedAt: number | null;
    movedAtStart: number | null;
  };
  error: string | null;
  times?: Record<string, { n: number; maxMs: number; totalMs: number }>;
}

export function emptyMoveProgress(
  run = 1,
  libraryId: string | null = null,
  targetId: string | null = null,
): MoveProgress {
  return {
    run,
    libraryId,
    targetId,
    phase: 'select',
    startedAt: null,
    phaseStartedAt: null,
    finishedAt: null,
    snapshotMtimeMs: null,
    counts: { tagged: 0, auto: 0, held: {}, withData: 0, alreadyMoved: 0 },
    write: { batches: [], waiting: null, startedAt: null, movedAtStart: null },
    error: null,
  };
}

export const moveAnalysisId = (run: number) => `move:${run}`;
export const moveArrivalsAnalysisId = (run: number) => `move:arrivals:${run}`;

export interface MoveState {
  mode: MoveMode;
  progress: MoveProgress;
  pausedReason: string | null;
  pausedDetail: string | null;
}

export function getMoveState(db: Database.Database): MoveState {
  const r = db.prepare('SELECT * FROM calibre_move_state WHERE id = 1').get() as {
    mode: MoveMode;
    progress_json: string;
    paused_reason: string | null;
    paused_detail: string | null;
  };
  const stored = JSON.parse(r.progress_json) as Partial<MoveProgress>;
  const base = emptyMoveProgress();
  return {
    mode: r.mode,
    progress: stored.phase
      ? {
          ...base,
          ...stored,
          counts: { ...base.counts, ...(stored.counts ?? {}) },
          write: { ...base.write, ...(stored.write ?? {}) },
        }
      : base,
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
  };
}

export function saveMoveProgress(db: Database.Database, p: MoveProgress): void {
  db.prepare(
    `UPDATE calibre_move_state SET progress_json = ?, library_id = ?, target_id = ?, updated_at = ?
     WHERE id = 1`,
  ).run(JSON.stringify(p), p.libraryId, p.targetId, Date.now());
}

export function setMoveMode(db: Database.Database, mode: MoveMode): void {
  db.prepare('UPDATE calibre_move_state SET mode = ?, updated_at = ? WHERE id = 1').run(
    mode,
    Date.now(),
  );
}

/** Pauses the move with a reason the card shows (Resume on the card lifts it). */
export function pauseMove(db: Database.Database, reason: string, detail: string): void {
  db.prepare(
    'UPDATE calibre_move_state SET paused_reason = ?, paused_detail = ?, updated_at = ? WHERE id = 1',
  ).run(reason, detail.slice(0, 2000), Date.now());
  onMovePaused?.(reason, detail);
}

export function resumeMove(db: Database.Database): void {
  db.prepare(
    'UPDATE calibre_move_state SET paused_reason = NULL, paused_detail = NULL, updated_at = ? WHERE id = 1',
  ).run(Date.now());
}

/** Set by the server: a pause pokes the notifications (one alert per pause). */
export let onMovePaused: ((reason: string, detail: string) => void) | null = null;
export function setOnMovePaused(fn: ((reason: string, detail: string) => void) | null): void {
  onMovePaused = fn;
}
