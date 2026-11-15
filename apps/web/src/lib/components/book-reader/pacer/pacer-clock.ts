/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 pacer: speed and time. The speed is in counted characters per hour, the unit
 * of the reader's stats (tracker "Reading Speed: N / h", Stats page, speed goals).
 */

export const PACER_SPEED_DEFAULT = 18000;
export const PACER_SPEED_MIN = 600;
export const PACER_SPEED_MAX = 120000;
export const PACER_SPEED_STEP = 600;

/** The longest stretch of time one frame may move the point (a stalled or hidden page). */
export const PACER_MAX_FRAME_MS = 1000;

export function clampSpeed(speed: number) {
  const n = Number(speed);

  if (!Number.isFinite(n)) return PACER_SPEED_DEFAULT;

  return Math.min(PACER_SPEED_MAX, Math.max(PACER_SPEED_MIN, Math.round(n)));
}

/** Speed `by` steps of 600 faster (or slower), rounded to the step. */
export function stepSpeed(speed: number, by: number) {
  const steps = Math.round(clampSpeed(speed) / PACER_SPEED_STEP) + by;
  return clampSpeed(steps * PACER_SPEED_STEP);
}

/** The point after `ms` at `speed`, never past `cap` (null = no cap). */
export function advance(point: number, ms: number, speed: number, cap: number | null) {
  const elapsed = Math.min(PACER_MAX_FRAME_MS, Math.max(0, ms));
  const next = point + (elapsed * clampSpeed(speed)) / 3_600_000;
  return cap === null ? next : Math.min(cap, Math.max(point, next));
}
