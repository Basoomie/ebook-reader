/**
 * The cleanup's stages (plan sections 1-7). Stage 0 is the safety checks (no mode); stages
 * 1-5 each have a mode: off (default for every stage), analyse (analysis only, nothing is
 * applied) or on (analysis and unattended apply behind the automatic gates).
 *
 * Manga part B (cleanup.db v38): every stage belongs to one Calibre library (its reader library
 * id), with its own mode, state, pause and progress. Every function takes the library first, so
 * a call written for the one-library cleanup no longer compiles. A library's rows are made the
 * first time they are read.
 */
import type Database from 'better-sqlite3';

export type StageMode = 'off' | 'analyse' | 'on';

/** Stages that can be switched on in this build. */
export const BUILT_STAGES: readonly number[] = [1, 2, 3, 4, 5];
/** Stages with Off and Preview only (none since WP20e: stage 4 writes after its AI check). */
export const PREVIEW_ONLY_STAGES: readonly number[] = [];

export const STAGE_NAMES: Record<number, string> = {
  0: 'Safety checks',
  1: 'Identical files',
  2: 'Metadata and covers from the files',
  3: 'Content duplicates',
  4: 'Online sources',
  5: 'Genres and tags',
};

export interface StageRow {
  stage: number;
  libraryId: string;
  name: string;
  built: boolean;
  mode: StageMode;
  state: string;
  pauseReason: string | null;
  pauseDetail: string | null;
  pausedAt: number | null;
  progress: Record<string, unknown>;
  precision: Record<string, unknown>;
  updatedAt: number;
}

interface Row {
  stage: number;
  library_id: string;
  mode: StageMode;
  state: string;
  pause_reason: string | null;
  pause_detail: string | null;
  paused_at: number | null;
  progress_json: string;
  precision_json: string;
  updated_at: number;
}

function toStage(r: Row): StageRow {
  return {
    stage: r.stage,
    libraryId: r.library_id,
    name: STAGE_NAMES[r.stage] ?? `Stage ${r.stage}`,
    built: r.stage === 0 || BUILT_STAGES.includes(r.stage),
    mode: r.mode,
    state: r.state,
    pauseReason: r.pause_reason,
    pauseDetail: r.pause_detail,
    pausedAt: r.paused_at,
    progress: JSON.parse(r.progress_json) as Record<string, unknown>,
    precision: JSON.parse(r.precision_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  };
}

/** Makes the library's six rows (0-5) when it has none yet: every stage Off. */
export function ensureStageRows(db: Database.Database, libraryId: string): void {
  // Rows the migration could not give a library (library ''; no ttsu.db to ask) go to the first
  // library that asks for its own.
  if (
    libraryId !== '' &&
    !db.prepare('SELECT 1 FROM stages WHERE library_id = ? LIMIT 1').get(libraryId)
  )
    db.prepare("UPDATE stages SET library_id = ? WHERE library_id = ''").run(libraryId);
  db.prepare(
    `INSERT OR IGNORE INTO stages (stage, library_id, updated_at)
     VALUES (0, @l, 0), (1, @l, 0), (2, @l, 0), (3, @l, 0), (4, @l, 0), (5, @l, 0)`,
  ).run({ l: libraryId });
}

export function listStages(db: Database.Database, libraryId: string): StageRow[] {
  ensureStageRows(db, libraryId);
  return (
    db.prepare('SELECT * FROM stages WHERE library_id = ? ORDER BY stage').all(libraryId) as Row[]
  ).map(toStage);
}

/** The id of the stage's current (or running) analysis, or null before the first one. */
export function currentAnalysisId(
  db: Database.Database,
  libraryId: string,
  stage: number,
): string | null {
  const p = getStage(db, libraryId, stage).progress as { analysisId?: unknown } | null;
  return p && typeof p.analysisId === 'string' ? p.analysisId : null;
}

/**
 * SQL condition for the proposals that count now: those of the current analysis, plus every
 * copy that is queued, removed, brought back or kept, whichever analysis found it. Takes the
 * analysis id as its one parameter.
 */
export const CURRENT_PROPOSALS_SQL =
  "(state IN ('queued', 'applied', 'undone', 'kept') OR analysis_id = ?)";

export function getStage(db: Database.Database, libraryId: string, stage: number): StageRow {
  let row = db
    .prepare('SELECT * FROM stages WHERE stage = ? AND library_id = ?')
    .get(stage, libraryId) as Row | undefined;
  if (!row) {
    ensureStageRows(db, libraryId);
    row = db
      .prepare('SELECT * FROM stages WHERE stage = ? AND library_id = ?')
      .get(stage, libraryId) as Row | undefined;
  }
  if (!row) throw new Error(`No stage ${stage}`);
  return toStage(row);
}

export function setStageMode(
  db: Database.Database,
  libraryId: string,
  stage: number,
  mode: StageMode,
  now = Date.now(),
): StageRow {
  ensureStageRows(db, libraryId);
  db.prepare('UPDATE stages SET mode = ?, updated_at = ? WHERE stage = ? AND library_id = ?').run(
    mode,
    now,
    stage,
    libraryId,
  );
  return getStage(db, libraryId, stage);
}

export function updateStage(
  db: Database.Database,
  libraryId: string,
  stage: number,
  changes: {
    state?: string;
    progress?: Record<string, unknown>;
    precision?: Record<string, unknown>;
  },
  now = Date.now(),
): void {
  const current = getStage(db, libraryId, stage);
  db.prepare(
    `UPDATE stages SET state = ?, progress_json = ?, precision_json = ?, updated_at = ?
     WHERE stage = ? AND library_id = ?`,
  ).run(
    changes.state ?? current.state,
    JSON.stringify(changes.progress ?? current.progress),
    JSON.stringify(changes.precision ?? current.precision),
    now,
    stage,
    libraryId,
  );
}

/** Stops a stage from applying (analysis may go on). Kept until the user resumes it. */
export function pauseStage(
  db: Database.Database,
  libraryId: string,
  stage: number,
  reason: string,
  detail: string | null,
  now = Date.now(),
): void {
  ensureStageRows(db, libraryId);
  const changed = db
    .prepare(
      `UPDATE stages SET pause_reason = ?, pause_detail = ?, paused_at = ?, updated_at = ?
     WHERE stage = ? AND library_id = ?
       AND (pause_reason IS NULL OR pause_reason <> ? OR pause_detail IS NOT ?)`,
    )
    .run(reason, detail, now, now, stage, libraryId, reason, detail).changes;
  if (changed > 0) tellStagePaused(stage, reason, libraryId);
}

/**
 * Notifications (N1): told after a stage pauses, outside the caller's transaction and never
 * able to break it. They read the stage rows themselves; this only makes them look at once.
 */
const stagePauseListeners = new Set<(stage: number, reason: string, libraryId: string) => void>();

export function onStagePaused(
  listener: (stage: number, reason: string, libraryId: string) => void,
): () => void {
  stagePauseListeners.add(listener);
  return () => stagePauseListeners.delete(listener);
}

function tellStagePaused(stage: number, reason: string, libraryId: string): void {
  for (const listener of stagePauseListeners) {
    setImmediate(() => {
      try {
        listener(stage, reason, libraryId);
      } catch {
        // A listener's problem is its own.
      }
    });
  }
}

export function resumeStage(
  db: Database.Database,
  libraryId: string,
  stage: number,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE stages SET pause_reason = NULL, pause_detail = NULL, paused_at = NULL, updated_at = ?
     WHERE stage = ? AND library_id = ?`,
  ).run(now, stage, libraryId);
}

/** Every library that has stage rows (the ones the cleanup has worked on), oldest first. */
export function stageLibraries(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT library_id, MIN(rowid) AS r FROM stages WHERE library_id <> '' GROUP BY library_id ORDER BY r",
      )
      .all() as { library_id: string }[]
  ).map((r) => r.library_id);
}
