/** Stage 4 On's progress (WP20e): the pace of the last batches and the time left. */
import { describe, expect, it } from 'vitest';
import { stage4Write, writePace } from '../src/cleanup/stage4/write-progress';

const now = 10_000_000;
const batch = (claimed: number, finished: number | null, items: number) => ({
  claimedAt: now - claimed * 1000,
  finishedAt: finished === null ? null : now - finished * 1000,
  items,
});

describe('stage 4 On progress', () => {
  it('measures changes per second from the first claim to the last finish of the last batches', () => {
    // Three batches of 2,000 changes, each 90 s with 30 s of planning between: 6,000 in 330 s.
    const b = [batch(330, 240, 2000), batch(210, 120, 2000), batch(90, 0, 2000)];
    expect(writePace(b, now)).toBeCloseTo(6000 / 330, 5);
    // A running batch (not finished) and one from hours ago don't count.
    expect(writePace([...b, batch(10, null, 2000), batch(90_000, 89_000, 5)], now)).toBeCloseTo(
      6000 / 330,
      5,
    );
    expect(writePace([], now)).toBeNull();
  });

  it('gives the time left from the changes left at that pace', () => {
    const b = [batch(200, 100, 1000), batch(100, 0, 1000)];
    expect(
      stage4Write(
        { doneChanges: 2000, leftChanges: 10_000, doneBooks: 1000, batches: b, batchCount: 2 },
        now,
      ),
    ).toEqual({
      books: { done: 1000 },
      changes: { done: 2000, total: 12_000 },
      secondsLeft: 1000,
      batches: 2,
    });
    // Nothing measured yet: no time left; all written: none left.
    expect(
      stage4Write({ doneChanges: 0, leftChanges: 5, doneBooks: 0, batches: [], batchCount: 0 }, now)
        .secondsLeft,
    ).toBeNull();
    expect(
      stage4Write({ doneChanges: 5, leftChanges: 0, doneBooks: 1, batches: [], batchCount: 1 }, now)
        .secondsLeft,
    ).toBe(0);
  });
});
