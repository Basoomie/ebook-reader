/**
 * Manga part A: the move bar's time left from the recent pace (2026-11-25). The first estimate
 * divided the time since the first batch by the books moved, so a stop (the half hour the move
 * stood still on 2026-11-25) or a slower start counted for the whole run: "about 9 h" with 2.5 h
 * to go. Now: the books moved in the last `windowMs` (the waits between batches inside it count,
 * as they will again), from the oldest of them to now.
 */

/** At least this many recent moves before an estimate is shown. */
export const PACE_MIN_BOOKS = 10;

export function recentPaceLeftMs(
  movedAt: number[],
  left: number,
  now: number,
  windowMs = 60 * 60_000,
): number | null {
  if (left <= 0) return null;
  const recent = movedAt.filter((t) => t > now - windowMs && t <= now);
  if (recent.length < PACE_MIN_BOOKS) return null;
  const oldest = Math.min(...recent);
  const perBook = (now - oldest) / recent.length;
  return Math.round(perBook * left);
}
