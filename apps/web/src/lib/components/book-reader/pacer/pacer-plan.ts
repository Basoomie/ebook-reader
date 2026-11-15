/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 pacer: what each mode paints for a reading point. Pure; the page code turns
 * the spans into DOM ranges.
 *
 * - Paragraph: the paragraph being read is left as it is, every other one is dimmed.
 * - Reveal: text after the point is hidden (E-ink: the current step appears whole).
 * - Disappearing: text more than `keep` characters behind the point is hidden, with a
 *   short fade before that in smooth movement (E-ink: whole steps, no fade).
 * - Reveal + disappearing: both, so only the stretch behind the point shows.
 */

export type PacerMode = 'off' | 'paragraph' | 'reveal' | 'disappear' | 'reveal-disappear';

export const PACER_MODES: PacerMode[] = [
  'off',
  'paragraph',
  'reveal',
  'disappear',
  'reveal-disappear'
];

export type PaintClass = 'dim' | 'hide' | 'fade1' | 'fade2' | 'fade3';

export const PAINT_CLASSES: PaintClass[] = ['dim', 'hide', 'fade1', 'fade2', 'fade3'];

export type Spans = Record<PaintClass, [number, number][]>;

export interface PlanChar {
  start: number;
  end: number;
  counted: boolean;
}

export interface PlanInput {
  chars: PlanChar[];
  point: number;
  mode: PacerMode;
  /** Characters kept behind the point (disappearing modes). */
  keep: number;
  /** Paragraph number of each character. */
  paragraphs: number[];
  /** E-ink steps: the step number of each character; null = smooth movement. */
  steps: number[] | null;
}

export function emptySpans(): Spans {
  return { dim: [], hide: [], fade1: [], fade2: [], fade3: [] };
}

/**
 * The character being read: the first counted one whose time isn't over. Past the last,
 * the last character; -1 when there is no counted character.
 */
export function currentIndex(chars: PlanChar[], point: number) {
  let lastCounted = -1;

  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].counted) continue;
    if (chars[i].end > point) return i;
    lastCounted = i;
  }

  return lastCounted;
}

/** First and last time of each step number. */
function stepBounds(chars: PlanChar[], steps: number[]) {
  const bounds = new Map<number, { start: number; end: number }>();

  for (let i = 0; i < chars.length; i++) {
    const b = bounds.get(steps[i]);

    if (!b) {
      bounds.set(steps[i], { start: chars[i].start, end: chars[i].end });
    } else {
      b.start = Math.min(b.start, chars[i].start);
      b.end = Math.max(b.end, chars[i].end);
    }
  }

  return bounds;
}

export function planPaint(input: PlanInput): Spans {
  const { chars, point, mode, paragraphs, steps } = input;
  const keep = Math.max(1, input.keep);
  const spans = emptySpans();
  const cur = currentIndex(chars, point);

  if (mode === 'off' || cur < 0) {
    return spans;
  }

  const reveal = mode === 'reveal' || mode === 'reveal-disappear';
  const disappear = mode === 'disappear' || mode === 'reveal-disappear';
  const bounds = steps ? stepBounds(chars, steps) : undefined;
  const curStep = steps ? steps[cur] : 0;
  const curStepStart = bounds?.get(curStep)?.start ?? 0;

  const classOf = (i: number): PaintClass | undefined => {
    if (mode === 'paragraph') {
      return paragraphs[i] === paragraphs[cur] ? undefined : 'dim';
    }

    const c = chars[i];
    let fade: PaintClass | undefined;

    if (disappear) {
      if (steps && bounds) {
        if ((bounds.get(steps[i])?.end ?? c.end) <= curStepStart - keep) {
          return 'hide';
        }
      } else {
        const age = point - c.end;

        if (age >= keep) return 'hide';
        if (age >= (keep * 5) / 6) fade = 'fade3';
        else if (age >= (keep * 4) / 6) fade = 'fade2';
        else if (age >= (keep * 3) / 6) fade = 'fade1';
      }
    }

    if (reveal) {
      const hidden = steps ? steps[i] > curStep : c.start > point;

      if (hidden) return 'hide';
    }

    return fade;
  };

  let runClass: PaintClass | undefined;
  let runStart = 0;

  for (let i = 0; i <= chars.length; i++) {
    const cls = i < chars.length ? classOf(i) : undefined;

    if (i === chars.length || cls !== runClass) {
      if (runClass && i > runStart) {
        spans[runClass].push([runStart, i]);
      }

      runClass = cls;
      runStart = i;
    }
  }

  return spans;
}

export function sameSpans(a: Spans, b: Spans) {
  return PAINT_CLASSES.every(
    (cls) =>
      a[cls].length === b[cls].length &&
      a[cls].every(([s, e], k) => s === b[cls][k][0] && e === b[cls][k][1])
  );
}

/** The end of the last counted character in [from, to]: where the page's reading is done. */
export function readingEnd(chars: PlanChar[], from: number, to: number): number | null {
  for (let i = Math.min(to, chars.length - 1); i >= Math.max(0, from); i--) {
    if (chars[i].counted) return chars[i].end;
  }

  return null;
}

/** The start of the first counted character in [from, to]. */
export function readingStart(chars: PlanChar[], from: number, to: number): number | null {
  for (let i = Math.max(0, from); i <= Math.min(to, chars.length - 1); i++) {
    if (chars[i].counted) return chars[i].start;
  }

  return null;
}
