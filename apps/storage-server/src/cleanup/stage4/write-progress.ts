/**
 * Stage 4 On's progress for the page (WP20e, 2026-11-21): books and changes written, what is
 * left, and the time left at the pace of the last batches. The run started with no bar (the
 * card said only "A batch is being applied"); every long step shows one.
 */

export interface WriteBatchRow {
  claimedAt: number | null;
  finishedAt: number | null;
  /** Changes in the batch. */
  items: number;
}

/** How many recent batches the pace is measured over. */
const PACE_BATCHES = 5;
/** Batches finished longer ago than this don't count (a run stopped and started again later). */
const PACE_WINDOW_MS = 2 * 3600_000;

/**
 * Changes written per second over the last finished batches: each batch's own time plus the
 * planning between batches; null with fewer than one batch.
 *
 * A wait between two batches longer than the longest of those batches is a pause (a restart, a
 * stage waiting for another, Off and On again), not planning: it counts as the usual wait
 * between the other batches. Before (WP20f On, 2026-11-22) one 17-minute restart in the window
 * made 2 hours of writing show as 6.
 */
export function writePace(batches: WriteBatchRow[], now: number): number | null {
  const done = batches
    .filter(
      (b): b is WriteBatchRow & { claimedAt: number; finishedAt: number } =>
        b.claimedAt !== null && b.finishedAt !== null && now - b.finishedAt <= PACE_WINDOW_MS,
    )
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, PACE_BATCHES)
    .reverse();
  if (!done.length) return null;
  const own = done.map((b) => Math.max(0, b.finishedAt - b.claimedAt));
  const longest = Math.max(...own);
  const gaps = done.slice(1).map((b, i) => Math.max(0, b.claimedAt - done[i].finishedAt));
  const usual = gaps.filter((g) => g <= longest).sort((a, b) => a - b);
  const typical = usual.length ? usual[Math.floor(usual.length / 2)] : 0;
  const ms =
    own.reduce((a, b) => a + b, 0) + gaps.reduce((a, g) => a + (g <= longest ? g : typical), 0);
  const items = done.reduce((a, b) => a + b.items, 0);
  return ms > 0 && items > 0 ? (items * 1000) / ms : null;
}

export interface Stage4Write {
  /** Books written (in finished batches; a book's changes are written together). */
  books: { done: number };
  changes: { done: number; total: number };
  /** Seconds left at the measured pace; null before a batch has finished. */
  secondsLeft: number | null;
  /** Batches written in this analysis. */
  batches: number;
}

export function stage4Write(
  a: {
    doneChanges: number;
    leftChanges: number;
    doneBooks: number;
    batches: WriteBatchRow[];
    batchCount: number;
  },
  now: number,
): Stage4Write {
  const pace = writePace(a.batches, now);
  return {
    books: { done: a.doneBooks },
    changes: { done: a.doneChanges, total: a.doneChanges + a.leftChanges },
    secondsLeft: a.leftChanges === 0 ? 0 : pace ? Math.round(a.leftChanges / pace) : null,
    batches: a.batchCount,
  };
}
