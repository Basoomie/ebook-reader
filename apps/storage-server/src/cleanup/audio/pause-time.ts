/**
 * The time a stage-6 run (the switch, Undo, the deletion, the covers) spends paused counts
 * neither toward its steps' times nor toward the bar's time left. Found live 2026-11-20: the
 * deletion paused on a folder it couldn't write, and after Continue its time left read 23 h,
 * because the speed was measured from the step's start, across the pause.
 *
 * The pause's start is kept in the row's progress_json as `pausedAt` (it survives a restart,
 * e.g. a deploy while paused). Continue moves the phase's and the bar's start later by the
 * pause's length.
 */

export interface PausableProgress {
  startedAt: number;
  pausedAt?: number | null;
  phaseStartedAt?: number;
  current: { startedAt: number } | null;
}

/** SQL for the new progress_json (the one `?`): `pausedAt` kept from the row as it is. */
export const KEEP_PAUSED_AT = `json_set(?, '$.pausedAt', json_extract(progress_json, '$.pausedAt'))`;

/** SQL for progress_json: `pausedAt` set to the one `?` unless a pause already started. */
export const MARK_PAUSED_AT = `json_set(progress_json, '$.pausedAt', coalesce(json_extract(progress_json, '$.pausedAt'), ?))`;

/** The progress after a pause ends at `now`: the starts moved past the pause, no `pausedAt`. */
export function shiftPastPause<T extends PausableProgress>(p: T, now: number): T {
  const at = p.pausedAt;
  const out: T = { ...p, pausedAt: null };
  // A pause from an earlier run (or a clock step back) moves nothing.
  if (typeof at !== 'number' || at < p.startedAt || at > now) return out;
  const d = now - at;
  if (typeof out.phaseStartedAt === 'number' && out.phaseStartedAt <= at) out.phaseStartedAt += d;
  if (out.current && out.current.startedAt <= at)
    out.current = { ...out.current, startedAt: out.current.startedAt + d };
  return out;
}
