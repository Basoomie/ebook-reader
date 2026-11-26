/**
 * Books without an EPUB: the pass's own Off/Preview/On, progress and pause (cleanup.db v38,
 * calibre_formats_state; the stages table holds stages 0-5 only, as for the other passes).
 */
import type Database from 'better-sqlite3';

export type FormatsMode = 'off' | 'analyse' | 'on';
/**
 * select   the library's books with no EPUB (the reader's snapshot), each listed and left or
 *          waiting for its conversion;
 * convert  the sidecar converts one book at a time (Preview too: nothing is written to Calibre),
 *          and the server checks each EPUB as it comes (the reader's own import);
 * compare  each checked book against its EPUB twins (same title) with stage 3's text code;
 * propose  the proposals: an EPUB for the book's own record, or the copy folded into its twin;
 * spot     30 converted books for the user to mark (Preview stops here);
 * write    (On) stage-12 batches, one at a time;
 * done     until the library's snapshot changes (books added since are selected then).
 */
export type FormatsPhase = 'select' | 'convert' | 'compare' | 'propose' | 'spot' | 'write' | 'done';

export const FORMATS_PHASES: FormatsPhase[] = [
  'select',
  'convert',
  'compare',
  'propose',
  'spot',
  'write',
  'done',
];

export interface FormatsProgress {
  run: number;
  libraryId: string | null;
  phase: FormatsPhase;
  startedAt: number | null;
  phaseStartedAt: number | null;
  finishedAt: number | null;
  /** The snapshot the selection read (its mtime): a newer one selects again (new books only). */
  snapshotMtimeMs: number | null;
  write: {
    batches: string[];
    waiting: string | null;
    startedAt: number | null;
    doneAtStart: number | null;
  };
  error: string | null;
  times?: Record<string, { n: number; maxMs: number; totalMs: number }>;
}

export function emptyFormatsProgress(run = 1, libraryId: string | null = null): FormatsProgress {
  return {
    run,
    libraryId,
    phase: 'select',
    startedAt: null,
    phaseStartedAt: null,
    finishedAt: null,
    snapshotMtimeMs: null,
    write: { batches: [], waiting: null, startedAt: null, doneAtStart: null },
    error: null,
  };
}

export const formatsAnalysisId = (run: number) => `formats:${run}`;

export interface FormatsState {
  mode: FormatsMode;
  progress: FormatsProgress;
  pausedReason: string | null;
  pausedDetail: string | null;
}

export function getFormatsState(db: Database.Database): FormatsState {
  const r = db.prepare('SELECT * FROM calibre_formats_state WHERE id = 1').get() as {
    mode: FormatsMode;
    progress_json: string;
    paused_reason: string | null;
    paused_detail: string | null;
  };
  const stored = JSON.parse(r.progress_json) as Partial<FormatsProgress>;
  const base = emptyFormatsProgress();
  return {
    mode: r.mode,
    progress: stored.phase
      ? { ...base, ...stored, write: { ...base.write, ...(stored.write ?? {}) } }
      : base,
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
  };
}

export function saveFormatsProgress(db: Database.Database, p: FormatsProgress): void {
  db.prepare(
    `UPDATE calibre_formats_state SET progress_json = ?, library_id = ?, updated_at = ? WHERE id = 1`,
  ).run(JSON.stringify(p), p.libraryId, Date.now());
}

export function setFormatsMode(db: Database.Database, mode: FormatsMode): void {
  db.prepare('UPDATE calibre_formats_state SET mode = ?, updated_at = ? WHERE id = 1').run(
    mode,
    Date.now(),
  );
}

/** Pauses the pass with a reason the card shows (Resume on the card lifts it). */
export function pauseFormats(db: Database.Database, reason: string, detail: string): void {
  db.prepare(
    'UPDATE calibre_formats_state SET paused_reason = ?, paused_detail = ?, updated_at = ? WHERE id = 1',
  ).run(reason, detail.slice(0, 2000), Date.now());
  onFormatsPaused?.(reason, detail);
}

export function resumeFormats(db: Database.Database): void {
  db.prepare(
    'UPDATE calibre_formats_state SET paused_reason = NULL, paused_detail = NULL, updated_at = ? WHERE id = 1',
  ).run(Date.now());
}

/** Set by the server: a pause pokes the notifications (one alert per pause). */
export let onFormatsPaused: ((reason: string, detail: string) => void) | null = null;
export function setOnFormatsPaused(fn: ((reason: string, detail: string) => void) | null): void {
  onFormatsPaused = fn;
}
