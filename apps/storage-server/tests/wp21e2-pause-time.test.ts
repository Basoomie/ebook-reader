import { describe, expect, it } from 'vitest';
import { shiftPastPause } from '../src/cleanup/audio/pause-time';

// WP21e-2 follow-up: a stage-6 run's pause counts toward neither its steps' times nor the
// bar's time left (found live 2026-11-20: 23 h left after the deletion's pause).
describe('shiftPastPause', () => {
  const base = { startedAt: 1_000, phaseStartedAt: 2_000, current: { startedAt: 3_000 } };

  it('moves the phase’s and the bar’s start later by the pause’s length', () => {
    expect(shiftPastPause({ ...base, pausedAt: 5_000 }, 65_000)).toEqual({
      startedAt: 1_000,
      phaseStartedAt: 62_000,
      current: { startedAt: 63_000 },
      pausedAt: null,
    });
  });

  it('moves nothing without a pause, for a pause from before the run, or one in the future', () => {
    for (const pausedAt of [undefined, null, 500, 90_000])
      expect(shiftPastPause({ ...base, pausedAt }, 65_000)).toEqual({ ...base, pausedAt: null });
  });

  it('leaves a bar that began during the pause, and no bar, as they are', () => {
    expect(
      shiftPastPause({ ...base, current: { startedAt: 6_000 }, pausedAt: 5_000 }, 65_000),
    ).toMatchObject({ phaseStartedAt: 62_000, current: { startedAt: 6_000 } });
    expect(shiftPastPause({ ...base, current: null, pausedAt: 5_000 }, 65_000)).toMatchObject({
      phaseStartedAt: 62_000,
      current: null,
    });
  });
});
