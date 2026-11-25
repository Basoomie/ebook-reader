/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  clampSetting,
  entryOf,
  groupByDay,
  keepMode,
  kept,
  trimIds,
  type ViewedEntry
} from './recently-viewed';
import { ViewTimer } from './view-timer';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 24, 15, 0).getTime();
const e = (bookId: string, viewedAt: number): ViewedEntry => ({ bookId, viewedAt });

describe('recently viewed rules', () => {
  it('reads records, leaving out deleted and broken ones', () => {
    expect(entryOf({ id: 'a', deletedAt: null, data: { viewedAt: 5 } })).toEqual(e('a', 5));
    expect(entryOf({ id: 'a', deletedAt: 9, data: {} })).toBeNull();
    expect(entryOf({ id: 'a', deletedAt: null, data: { viewedAt: 'x' } })).toBeNull();
  });

  const list = [e('old', NOW - 40 * DAY), e('new', NOW - 1000), e('mid', NOW - 10 * DAY)];

  it('keeps the last N books, newest first', () => {
    const keep = { mode: 'books' as const, books: 2, days: 30 };
    expect(kept(list, keep, NOW).map((x) => x.bookId)).toEqual(['new', 'mid']);
    expect(trimIds(list, keep, NOW)).toEqual(['old']);
  });

  it('keeps the last N days', () => {
    const keep = { mode: 'days' as const, books: 1, days: 30 };
    expect(trimIds(list, keep, NOW)).toEqual(['old']);
    // Time alone ages an entry.
    expect(trimIds(list, keep, NOW + 25 * DAY).sort()).toEqual(['mid', 'old']);
  });

  it('keeps everything', () => {
    expect(trimIds(list, { mode: 'all', books: 1, days: 1 }, NOW + 1000 * DAY)).toEqual([]);
  });

  it('reads bad settings as the defaults', () => {
    expect(keepMode('weird')).toBe('books');
    expect(keepMode('days')).toBe('days');
    expect(clampSetting('x', 1, 10, 5)).toBe(5);
    expect(clampSetting(50, 1, 10, 5)).toBe(10);
    expect(clampSetting(2.7, 1, 10, 5)).toBe(2);
  });

  it('groups by day: Today, Yesterday, then dates', () => {
    const items = [
      e('a', NOW - 1000),
      e('b', NOW - 2000),
      e('c', NOW - DAY),
      e('d', NOW - 3 * DAY),
      e('f', new Date(2025, 0, 2).getTime())
    ];
    const days = groupByDay(items, (x) => x.viewedAt, NOW);
    expect(days.map((d) => [d.label, d.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Saturday, November 21', 1],
      ['Thursday, January 2, 2025', 1]
    ]);
  });
});

describe('the view timer', () => {
  function setup(visible = true) {
    let now = 0;
    let shown = visible;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const recorded: string[] = [];
    const timer = new ViewTimer({
      now: () => now,
      setTimeout: (fn, ms) => {
        timers.set(next, { at: now + ms, fn });
        return next++;
      },
      clearTimeout: (h) => timers.delete(h as number),
      visible: () => shown,
      record: (id) => recorded.push(id)
    });
    const advance = (ms: number) => {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(h);
          t.fn();
        }
      }
    };
    const setVisible = (v: boolean) => {
      shown = v;
      timer.visibilityChanged();
    };
    return { timer, advance, setVisible, recorded };
  }

  it('records after the time, once', () => {
    const { timer, advance, recorded } = setup();
    timer.start('a', 3);
    advance(2999);
    expect(recorded).toEqual([]);
    advance(1);
    expect(recorded).toEqual(['a']);
    timer.start('a', 3);
    advance(5000);
    expect(recorded).toEqual(['a']);
  });

  it('records at once with 0 seconds', () => {
    const { timer, recorded } = setup();
    timer.start('a', 0);
    expect(recorded).toEqual(['a']);
  });

  it('records nothing when the page is left early or another book opens', () => {
    const { timer, advance, recorded } = setup();
    timer.start('a', 3);
    advance(2000);
    timer.start('b', 3);
    advance(2000);
    timer.stop();
    advance(5000);
    expect(recorded).toEqual([]);
  });

  it('counts only visible time', () => {
    const { timer, advance, setVisible, recorded } = setup(false);
    timer.start('a', 3);
    advance(10_000);
    expect(recorded).toEqual([]);
    setVisible(true);
    advance(2000);
    setVisible(false);
    advance(10_000);
    expect(recorded).toEqual([]);
    setVisible(true);
    advance(1000);
    expect(recorded).toEqual(['a']);
  });
});
