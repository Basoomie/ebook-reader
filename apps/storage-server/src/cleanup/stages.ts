/**
 * The cleanup's stages (plan sections 1-7). Stage 0 is the safety checks (no mode); stages
 * 1-5 each have a mode: off (default for every stage), analyse (analysis only, nothing is
 * applied) or on (analysis and unattended apply behind the automatic gates). Stages 1 and 2
 * are built (WP20a, WP20b); 3-5 exist so the page and later work packages have their rows.
 */
import type Database from 'better-sqlite3';

export type StageMode = 'off' | 'analyse' | 'on';

/** Stages that can be switched on in this build. */
export const BUILT_STAGES: readonly number[] = [1, 2];

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

export function listStages(db: Database.Database): StageRow[] {
  return (db.prepare('SELECT * FROM stages ORDER BY stage').all() as Row[]).map(toStage);
}

/** The id of the stage's current (or running) analysis, or null before the first one. */
export function currentAnalysisId(db: Database.Database, stage = 1): string | null {
  const p = getStage(db, stage).progress as { analysisId?: unknown } | null;
  return p && typeof p.analysisId === 'string' ? p.analysisId : null;
}

/**
 * SQL condition for the proposals that count now: those of the current analysis, plus every
 * copy that is queued, removed, brought back or kept, whichever analysis found it. Takes the
 * analysis id as its one parameter.
 */
export const CURRENT_PROPOSALS_SQL =
  "(state IN ('queued', 'applied', 'undone', 'kept') OR analysis_id = ?)";

export function getStage(db: Database.Database, stage: number): StageRow {
  const row = db.prepare('SELECT * FROM stages WHERE stage = ?').get(stage) as Row | undefined;
  if (!row) throw new Error(`No stage ${stage}`);
  return toStage(row);
}

export function setStageMode(
  db: Database.Database,
  stage: number,
  mode: StageMode,
  now = Date.now(),
): StageRow {
  db.prepare('UPDATE stages SET mode = ?, updated_at = ? WHERE stage = ?').run(mode, now, stage);
  return getStage(db, stage);
}

export function updateStage(
  db: Database.Database,
  stage: number,
  changes: {
    state?: string;
    progress?: Record<string, unknown>;
    precision?: Record<string, unknown>;
  },
  now = Date.now(),
): void {
  const current = getStage(db, stage);
  db.prepare(
    `UPDATE stages SET state = ?, progress_json = ?, precision_json = ?, updated_at = ?
     WHERE stage = ?`,
  ).run(
    changes.state ?? current.state,
    JSON.stringify(changes.progress ?? current.progress),
    JSON.stringify(changes.precision ?? current.precision),
    now,
    stage,
  );
}

/** Stops a stage from applying (analysis may go on). Kept until the user resumes it. */
export function pauseStage(
  db: Database.Database,
  stage: number,
  reason: string,
  detail: string | null,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE stages SET pause_reason = ?, pause_detail = ?, paused_at = ?, updated_at = ?
     WHERE stage = ? AND (pause_reason IS NULL OR pause_reason <> ? OR pause_detail IS NOT ?)`,
  ).run(reason, detail, now, now, stage, reason, detail);
}

export function resumeStage(db: Database.Database, stage: number, now = Date.now()): void {
  db.prepare(
    `UPDATE stages SET pause_reason = NULL, pause_detail = NULL, paused_at = NULL, updated_at = ?
     WHERE stage = ?`,
  ).run(now, stage);
}
