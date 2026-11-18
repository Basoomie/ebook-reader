/**
 * The audiobook cleanup's stages (WP21a): 0 = the Audiobookshelf snapshot (taken on request),
 * 1 = identity, 2 = books and file health, 3 = duplicates (WP21b). Stages 1-3 are Off (default)
 * or Preview (`analyse`: analysis only). Nothing applies anything yet, so On is refused.
 */
import type Database from 'better-sqlite3';

export type AudioStageMode = 'off' | 'analyse' | 'on';

export const AUDIO_STAGE_NAMES: Record<number, string> = {
  0: 'Audiobookshelf snapshot',
  1: 'Identity (which files are copies)',
  2: 'Books and file health',
  3: 'Duplicates (same recording)',
};

/** Stages with a mode in this build (stage 0 is taken on request). */
export const AUDIO_ANALYSIS_STAGES: readonly number[] = [1, 2, 3];

export interface AudioStageRow {
  stage: number;
  name: string;
  mode: AudioStageMode;
  state: string;
  pauseReason: string | null;
  pauseDetail: string | null;
  pausedAt: number | null;
  progress: Record<string, unknown>;
  updatedAt: number;
}

interface Row {
  stage: number;
  mode: AudioStageMode;
  state: string;
  pause_reason: string | null;
  pause_detail: string | null;
  paused_at: number | null;
  progress_json: string;
  updated_at: number;
}

function toRow(r: Row): AudioStageRow {
  return {
    stage: r.stage,
    name: AUDIO_STAGE_NAMES[r.stage] ?? `Stage ${r.stage}`,
    mode: r.mode,
    state: r.state,
    pauseReason: r.pause_reason,
    pauseDetail: r.pause_detail,
    pausedAt: r.paused_at,
    progress: JSON.parse(r.progress_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  };
}

export function listAudioStages(db: Database.Database): AudioStageRow[] {
  return (db.prepare('SELECT * FROM audio_stages ORDER BY stage').all() as Row[]).map(toRow);
}

export function getAudioStage(db: Database.Database, stage: number): AudioStageRow {
  const r = db.prepare('SELECT * FROM audio_stages WHERE stage = ?').get(stage) as Row | undefined;
  if (!r) throw new Error(`No audiobook stage ${stage}`);
  return toRow(r);
}

export function setAudioStageMode(
  db: Database.Database,
  stage: number,
  mode: AudioStageMode,
  now = Date.now(),
): void {
  if (!AUDIO_ANALYSIS_STAGES.includes(stage)) throw new Error('This stage has no mode');
  if (mode === 'on') throw new Error('Nothing in the audiobook cleanup can be switched on yet');
  db.prepare('UPDATE audio_stages SET mode = ?, updated_at = ? WHERE stage = ?').run(
    mode,
    now,
    stage,
  );
}

export function updateAudioStage(
  db: Database.Database,
  stage: number,
  changes: { state?: string; progress?: Record<string, unknown> },
  now = Date.now(),
): void {
  const cur = getAudioStage(db, stage);
  db.prepare(
    'UPDATE audio_stages SET state = ?, progress_json = ?, updated_at = ? WHERE stage = ?',
  ).run(changes.state ?? cur.state, JSON.stringify(changes.progress ?? cur.progress), now, stage);
}

export function pauseAudioStage(
  db: Database.Database,
  stage: number,
  reason: string,
  detail: string | null,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE audio_stages SET pause_reason = ?, pause_detail = ?, paused_at = ?, updated_at = ?
     WHERE stage = ?`,
  ).run(reason, detail, now, now, stage);
}

export function resumeAudioStage(db: Database.Database, stage: number, now = Date.now()): void {
  db.prepare(
    `UPDATE audio_stages SET pause_reason = NULL, pause_detail = NULL, paused_at = NULL,
     updated_at = ? WHERE stage = ?`,
  ).run(now, stage);
}
