/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { Pacer, type PacerSettings, type PacerState, type PacerView } from './pacer';
import type { PacerSnapshot } from './pacer-page';
import type { PacerChar } from './pacer-text';
import { emptySpans, type Spans } from './pacer-plan';

/** A page of counted characters with times [start, start + text.length). */
function page(start: number, text: string, key: string, opts: { next?: string } = {}) {
  const all = text + (opts.next ?? '');
  const node = { textContent: all } as unknown as Node;
  const chars: PacerChar[] = Array.from(all).map((ch, i) => ({
    node,
    offset: i,
    len: 1,
    gaiji: false,
    counted: !'。「」'.includes(ch),
    start: 0,
    end: 0,
    block: null
  }));
  let count = start;
  let last: PacerChar | undefined;
  for (const c of chars) {
    if (c.counted) {
      c.start = count;
      c.end = count + 1;
      count += 1;
      last = c;
    } else {
      c.start = last ? last.start : count;
      c.end = last ? last.end : count;
    }
  }
  return {
    chars,
    firstVisible: text.length ? 0 : -1,
    lastVisible: text.length ? text.length - 1 : -1,
    paragraphs: chars.map(() => 0),
    key
  } satisfies PacerSnapshot;
}

class FakeView implements PacerView {
  supported = true;
  snap: PacerSnapshot | null = null;
  paints: Spans[] = [];
  cleared = 0;
  scrolls: number[] = [];
  fail = false;

  measure() {
    if (this.fail) throw new Error('boom');
    return this.snap;
  }
  lineSteps(s: PacerSnapshot) {
    return s.chars.map((_, i) => Math.floor(i / 4));
  }
  scrollToChar(_s: PacerSnapshot, index: number) {
    this.scrolls.push(index);
    return true;
  }
  paint(_s: PacerSnapshot, spans: Spans) {
    this.paints.push(spans);
  }
  clear() {
    this.cleared += 1;
  }
  destroy() {}
}

function setup(over: Partial<PacerSettings> = {}, paginated = true) {
  let now = 0;
  let frames: ((t: number) => void)[] = [];
  let timeouts: { at: number; cb: () => void; id: number }[] = [];
  let nextId = 1;
  const settings: PacerSettings = {
    mode: 'reveal',
    speed: 18000, // 5 characters a second
    turnPages: true,
    keep: 40,
    einkStep: 'sentence',
    lookupResume: 1,
    idleMinutes: 0,
    textlessSeconds: 3,
    eink: false,
    ...over
  };
  const view = new FakeView();
  const states: PacerState[] = [];
  const warnings: string[] = [];
  let nextPages = 0;
  const pacer = new Pacer(
    view,
    {
      paginated: () => paginated,
      settings: () => settings,
      nextPage: () => {
        nextPages += 1;
      },
      onState: (s) => states.push(s),
      warn: (m) => warnings.push(m)
    },
    {
      now: () => now,
      frame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => {
        frames = [];
      },
      setTimeout: (cb, ms) => {
        const id = nextId++;
        timeouts.push({ at: now + ms, cb, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id) => {
        timeouts = timeouts.filter((t) => t.id !== (id as unknown as number));
      }
    }
  );

  /** Runs time forward in 100 ms frames. */
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100);
      const due = timeouts.filter((t) => t.at <= now);
      timeouts = timeouts.filter((t) => t.at > now);
      due.forEach((t) => t.cb());
      const queued = frames;
      frames = [];
      queued.forEach((cb) => cb(now));
    }
  };

  return {
    pacer,
    view,
    settings,
    states,
    warnings,
    run,
    nextPages: () => nextPages,
    lastHide: () => (view.paints.at(-1) ?? emptySpans()).hide
  };
}

describe('Pacer', () => {
  it('starts at the first character on the screen and reveals at the speed', () => {
    const t = setup();
    t.view.snap = page(100, 'あいうえおかきくけこさしすせそ', 'p1');
    t.pacer.start();
    expect(t.pacer.position).toBe(100);
    expect(t.lastHide()).toEqual([[1, 15]]);
    // The first frame only starts the clock.
    t.run(1100);
    expect(t.pacer.position).toBeCloseTo(105, 5);
    expect(t.lastHide()).toEqual([[6, 15]]);
  });

  it('turns the page at its end and goes on from the new page', () => {
    const t = setup();
    t.view.snap = page(0, 'あいうえお', 'p1', { next: 'かきくけこ' });
    t.pacer.start();
    t.run(1100);
    expect(t.pacer.position).toBe(5);
    expect(t.nextPages()).toBe(1);
    t.run(500);
    expect(t.nextPages()).toBe(1);
    // The reader shows the next page.
    t.view.snap = page(5, 'かきくけこ', 'p2');
    t.pacer.invalidate(true);
    t.run(200);
    expect(t.pacer.position).toBeGreaterThanOrEqual(5);
    expect(t.pacer.position).toBeLessThan(6.5);
    t.run(1000);
    expect(t.pacer.position).toBe(10);
  });

  it('waits at the page end when turning pages by itself is off', () => {
    const t = setup({ turnPages: false });
    t.view.snap = page(0, 'あいうえお', 'p1');
    t.pacer.start();
    t.run(3000);
    expect(t.pacer.position).toBe(5);
    expect(t.nextPages()).toBe(0);
    expect(t.pacer.state().running).toBe(true);
  });

  it('a page turn of yours moves the point to the new page start, both ways', () => {
    const t = setup();
    t.view.snap = page(100, 'あいうえおかきくけこ', 'p2');
    t.pacer.start();
    t.run(400);
    t.view.snap = page(110, 'さしすせそ', 'p3');
    t.pacer.invalidate(true);
    t.run(100);
    expect(t.pacer.position).toBeGreaterThanOrEqual(110);
    expect(t.pacer.position).toBeLessThan(111);
    t.view.snap = page(90, 'あいうえおかきくけこ', 'p1');
    t.pacer.invalidate(true);
    t.run(100);
    expect(t.pacer.position).toBeGreaterThanOrEqual(90);
    expect(t.pacer.position).toBeLessThan(91);
  });

  it('pauses for a lookup and goes on a set time after it closes', () => {
    const t = setup({ lookupResume: 1 });
    t.view.snap = page(0, 'あいうえおかきくけこさしすせそたちつてと', 'p1');
    t.pacer.start();
    t.run(400);
    const at = t.pacer.position!;
    t.pacer.lookup('start');
    t.run(2000);
    expect(t.pacer.position).toBe(at);
    t.pacer.lookup('end');
    t.run(800);
    expect(t.pacer.position).toBe(at);
    // Moving to another word: end then start again cancels the resume.
    t.pacer.lookup('start');
    t.pacer.lookup('end');
    t.run(1500);
    expect(t.pacer.position!).toBeGreaterThan(at);
    expect(t.pacer.state().running).toBe(true);
  });

  it('stays paused after a lookup when the resume time is 0', () => {
    const t = setup({ lookupResume: 0 });
    t.view.snap = page(0, 'あいうえお', 'p1');
    t.pacer.start();
    t.pacer.lookup('start');
    t.pacer.lookup('end');
    t.run(2000);
    expect(t.pacer.position).toBe(0);
    expect(t.pacer.state()).toMatchObject({ running: false, pausedFor: [] });
  });

  it('dialogs and relayouts pause it; a relayout keeps the absolute point', () => {
    const t = setup();
    t.view.snap = page(200, 'あいうえおかきくけこさしすせそ', 'a');
    t.pacer.start();
    t.run(600);
    const at = t.pacer.position!;
    t.pacer.setPaused('layout', true);
    // The remounted reader shows the same text in a new layout (other page start).
    t.view.snap = page(198, 'xxあいうえおかきくけこ'.replace(/x/g, 'ま'), 'b');
    t.pacer.invalidate(true);
    t.run(500);
    expect(t.pacer.position).toBe(at);
    t.pacer.setPaused('layout', false);
    t.run(200);
    expect(t.pacer.position!).toBeGreaterThan(at);
  });

  it('pauses itself after the idle time without input', () => {
    const t = setup({ idleMinutes: 1 });
    t.view.snap = page(0, 'あ'.repeat(1000), 'p1');
    t.pacer.start();
    t.run(50_000);
    t.pacer.input();
    t.run(50_000);
    expect(t.pacer.state().running).toBe(true);
    t.run(15_000);
    expect(t.pacer.state().running).toBe(false);
  });

  it('turns past a page without text after the set time', () => {
    const t = setup({ textlessSeconds: 3 });
    t.view.snap = page(0, '', 'img', { next: 'あいう' });
    t.pacer.start();
    t.run(2500);
    expect(t.nextPages()).toBe(0);
    t.run(700);
    expect(t.nextPages()).toBe(1);
  });

  it('continuous mode scrolls to the next character instead of turning', () => {
    const t = setup({}, false);
    t.view.snap = page(0, 'あいう', 's1', { next: 'えお' });
    t.pacer.start();
    t.run(700);
    expect(t.view.scrolls).toEqual([3]);
  });

  it('stops at the end of the book when a turn changes nothing', () => {
    const t = setup();
    t.view.snap = page(0, 'あいう', 'last');
    t.pacer.start();
    t.run(700);
    expect(t.nextPages()).toBe(1);
    t.pacer.invalidate(true);
    t.run(3500);
    expect(t.pacer.state()).toMatchObject({ running: false, ended: true });
  });

  it('E-ink steps by sentence paint only when a sentence starts', () => {
    const t = setup({ eink: true, einkStep: 'sentence' });
    t.view.snap = page(0, 'あいう。えおかきく。けこ', 'p1');
    t.pacer.start();
    expect(t.lastHide()).toEqual([[4, 12]]);
    const paints = t.view.paints.length;
    t.run(400); // point 2: same sentence
    expect(t.view.paints.length).toBe(paints);
    t.run(300); // point 3.5: second sentence
    expect(t.lastHide()).toEqual([[10, 12]]);
  });

  it('stops cleanly and clears the painting when something fails', () => {
    const t = setup();
    t.view.snap = page(0, 'あいう', 'p1');
    t.view.fail = true;
    t.pacer.start();
    expect(t.pacer.state()).toMatchObject({ running: false, failed: true });
    expect(t.view.cleared).toBe(1);
    expect(t.warnings[0]).toContain('boom');
  });

  it('does nothing in a browser without the highlight API', () => {
    const t = setup();
    t.view.supported = false;
    t.view.snap = page(0, 'あいう', 'p1');
    t.pacer.start();
    expect(t.pacer.state().running).toBe(false);
    expect(t.view.paints.length).toBe(0);
  });
});
