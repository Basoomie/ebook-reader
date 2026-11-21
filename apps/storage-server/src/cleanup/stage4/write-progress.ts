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
 * Changes written per second over the last finished batches, from the first one's claim to the
 * last one's finish (the planning between batches counts); null with fewer than one batch.
 */
export function writePace(batches: WriteBatchRow[], now: number): number | null {
  const done = batches
    .filter(
      (b): b is WriteBatchRow & { claimedAt: number; finishedAt: number } =>
        b.claimedAt !== null && b.finishedAt !== null && now - b.finishedAt <= PACE_WINDOW_MS,
    )
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, PACE_BATCHES);
  if (!done.length) return null;
  const from = Math.min(...done.map((b) => b.claimedAt));
  const to = Math.max(...done.map((b) => b.finishedAt));
  const items = done.reduce((a, b) => a + b.items, 0);
  return to > from && items > 0 ? (items * 1000) / (to - from) : null;
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
