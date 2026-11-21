/**
 * The audiobook cleanup's stages (WP21a): 0 = the Audiobookshelf snapshot (taken on request),
 * 1 = identity, 2 = books and file health, 3 = duplicates (WP21b), 4 = online sources (WP21c),
 * 5 = metadata decisions (WP21d), 6 = building japanese-new (WP21e-1), 7 = the daily new arrivals
 * (WP21f-1; On adds new books to the library).
 * Stages 1-5 are Off (default) or Preview (`analyse`: analysis only); On is refused. Stage 6 can
 * also be On (WP21e-1): it then builds the new library next to the live one (hard links only;
 * the service checks its conditions first).
 */
import type Database from 'better-sqlite3';

export type AudioStageMode = 'off' | 'analyse' | 'on';

export const AUDIO_STAGE_NAMES: Record<number, string> = {
  0: 'Audiobookshelf snapshot',
  1: 'Identity (which files are copies)',
  2: 'Books and file health',
  3: 'Duplicates (same recording)',
  4: 'Online sources (Audible, kikubon, audiobook.jp)',
  5: 'Metadata (rules and AI setup E)',
  6: 'Build the new library (japanese-new)',
  7: 'New arrivals (daily)',
};

/** Stages with a mode in this build (stage 0 is taken on request). */
export const AUDIO_ANALYSIS_STAGES: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
/** Stages that can be switched On (WP21e-1: the build; WP21f-1: the new arrivals). */
export const AUDIO_ON_STAGES: readonly number[] = [6, 7];

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
  if (mode === 'on' && !AUDIO_ON_STAGES.includes(stage))
    throw new Error('Only stages 6 (the build) and 7 (new arrivals) can be switched on');
  db.prepare('UPDATE audio_stages SET mode = ?, updated_at = ? WHERE stage = ?').run(
    mode,
    now,
    stage,
  );
  // Off ends a stage's AI wait (no limit, a key, a model check): it is judged again when the
  // stage is switched back to Preview, so the card shows no old pause while it is off.
  if (mode === 'off')
    db.prepare(
      `UPDATE audio_stages SET pause_reason = NULL, pause_detail = NULL, paused_at = NULL
       WHERE stage = ? AND pause_reason = 'ai'`,
    ).run(stage);
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
  tellAudioStagePaused(stage, reason);
}

/**
 * Notifications (N1): told after an audiobook stage pauses, outside the caller's transaction
 * and never able to break it. They read the stage rows themselves (a repeat is no new alert).
 */
const audioStagePauseListeners = new Set<(stage: number, reason: string) => void>();

export function onAudioStagePaused(listener: (stage: number, reason: string) => void): () => void {
  audioStagePauseListeners.add(listener);
  return () => audioStagePauseListeners.delete(listener);
}

function tellAudioStagePaused(stage: number, reason: string): void {
  for (const listener of audioStagePauseListeners) {
    setImmediate(() => {
      try {
        listener(stage, reason);
      } catch {
        // A listener's problem is its own.
      }
    });
  }
}

export function resumeAudioStage(db: Database.Database, stage: number, now = Date.now()): void {
  db.prepare(
    `UPDATE audio_stages SET pause_reason = NULL, pause_detail = NULL, paused_at = NULL,
     updated_at = ? WHERE stage = ?`,
  ).run(now, stage);
}
