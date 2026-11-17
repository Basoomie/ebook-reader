/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  CleanupStage,
  PairBookFacts,
  PairMeasure,
  Stage3Gate,
  Stage3Pair,
  Stage3Progress,
  Stage3Status,
  StageMode
} from './cleanup-api';
import { eta, n, paceEta, pauseTitle, type ProgressBar } from './cleanup-text';

/** Plain wording for stage 3 on the /cleanup page (WP20c): copies with the same text. */

export const STAGE3_MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Reads every book’s text and lists the copies with the same text and which one would stay; nothing in Calibre is changed.',
  on: 'Removes the worse copy of books with the same text in batches on its own, behind the safety checks and the check on the measured pairs.'
};

/** The lists of pairs on the page. */
export const PAIR_VIEWS: { id: string; label: string }[] = [
  { id: 'review', label: 'For review' },
  { id: 'duplicate', label: 'Same text' },
  { id: 'superset', label: 'One holds the other' },
  { id: 'keep_both', label: 'Both stay' },
  { id: 'never', label: 'Never the same book' },
  { id: 'different', label: 'Different books' },
  { id: 'image_only', label: 'Picture books' },
  { id: 'spread', label: 'Extra text inside the chapters' },
  { id: 'errors', label: 'Couldn’t be compared' }
];

export const EXAMPLE_CLASSES: { id: string; label: string }[] = [
  { id: 'duplicate', label: 'Same text' },
  { id: 'superset', label: 'One holds the other' },
  { id: 'review', label: 'For review' },
  { id: 'never', label: 'Never the same book' },
  { id: 'different', label: 'Different books' },
  { id: 'keep_both', label: 'Both stay' }
];

const CLASS_TEXT: Record<string, string> = {
  duplicate: 'Same text',
  superset: 'One copy holds the other',
  keep_both: 'Both copies stay',
  review: 'For review',
  never: 'Never the same book',
  different: 'Different books'
};

export function classText(cls: string | null): string {
  return cls ? (CLASS_TEXT[cls] ?? cls) : 'Not measured yet';
}

const KIND_TEXT: Record<string, string> = {
  sample: 'free preview',
  bonus: 'store-bonus story',
  omnibus: 'omnibus',
  special: 'special edition',
  full: 'book'
};

export function kindText(kind: string | null | undefined): string {
  return kind ? (KIND_TEXT[kind] ?? kind) : 'book';
}

/** "92.5 %" from a share. */
export function pct(share: number | null | undefined, digits = 1): string {
  if (typeof share !== 'number' || !Number.isFinite(share)) return '–';
  return `${(share * 100).toFixed(digits)} %`;
}

const PHASES: Record<string, string> = {
  text: 'Reading every book’s text',
  candidates: 'Finding books that share text',
  compare: 'Comparing those books word for word',
  quality: 'Comparing pictures, covers and layout',
  group: 'Choosing the copy that stays'
};

const PHASE_STEP: Record<string, number> = {
  text: 1,
  candidates: 2,
  compare: 3,
  quality: 4,
  group: 5
};

function progressOf(stage: CleanupStage, status: Stage3Status | undefined): Stage3Progress | null {
  const p = (status?.progress ?? stage.progress) as Stage3Progress | null;
  return p && typeof p.phase === 'string' ? p : null;
}

/** The analysis' progress bar. */
export function stage3Progress(
  stage: CleanupStage,
  status: Stage3Status | undefined,
  now = Date.now()
): ProgressBar | null {
  const p = progressOf(stage, status);
  if (!p || stage.mode === 'off' || p.phase === 'done') return null;
  const step = `Step ${PHASE_STEP[p.phase] ?? '?'} of 5 · ${PHASES[p.phase] ?? p.phase}`;
  const bar = (done: number, total: number, what: string): ProgressBar => ({
    label: `${step}: ${n(done)} of ${n(total)} ${what}`,
    fraction: total > 0 ? Math.min(1, done / total) : 0,
    eta: eta(done, total, p.phaseStartedAt ?? null, p.phaseStartDone ?? 0, now)
  });
  if (p.phase === 'text' && p.textTotal > 0) return bar(p.textDone, p.textTotal, 'books');
  if (p.phase === 'compare' && p.compareTotal > 0)
    return bar(p.compareDone + p.compareErrors, p.compareTotal, 'pairs');
  if (p.phase === 'quality' && p.qualityTotal > 0)
    return bar(p.qualityDone, p.qualityTotal, 'books');
  return { label: step, fraction: 0, eta: null };
}

/** Removing copies once stage 3 is on. */
export function stage3ApplyProgress(
  status: Stage3Status | undefined,
  stage: CleanupStage,
  now = Date.now()
): ProgressBar | null {
  if (!status || stage.mode !== 'on') return null;
  const c = status.counts;
  const done = c.applied ?? 0;
  const total = done + (c.proposed ?? 0) + (c.queued ?? 0);
  if (total <= 0 || done >= total || (done === 0 && (c.queued ?? 0) === 0)) return null;
  return {
    label: `Removing copies: ${n(done)} of ${n(total)}`,
    fraction: done / total,
    eta: paceEta(total - done, status.pace, now)
  };
}

/** Seconds per book from the analysis' own timing ("0.42 s per book"). */
export function secondsPerBook(p: Stage3Progress): string | null {
  if (!p.textRead || !p.times?.text?.ms) return null;
  return `${(p.times.text.ms / 1000 / p.textRead).toFixed(2)} s per book`;
}

/** The lines under stage 3's name: what the analysis found. */
export function stage3Lines(stage: CleanupStage, status: Stage3Status | undefined): string[] {
  const p = progressOf(stage, status);
  if (!p) return stage.mode === 'off' ? [] : ['Waiting to start.'];
  const lines: string[] = [];
  if (p.phase !== 'done') {
    // While it runs: one line per finished step, named like the progress bar's step, so no
    // line reads as if it were about the step running now.
    const current = PHASE_STEP[p.phase] ?? 0;
    const done = (phase: string, text: string) => {
      if (PHASE_STEP[phase] < current)
        lines.push(`Step ${PHASE_STEP[phase]} done · ${PHASES[phase]}: ${text}`);
    };
    done(
      'text',
      `${n(p.textDone)} books read${p.textErrors ? ` (${n(p.textErrors)} couldn’t be read)` : ''}${
        secondsPerBook(p) ? `, ${secondsPerBook(p)}` : ''
      }.`
    );
    done('candidates', `${n(p.candidates)} pairs to compare.`);
    done(
      'compare',
      `${n(p.compareDone)} pairs compared${
        p.compareErrors ? ` (${n(p.compareErrors)} couldn’t be compared)` : ''
      }.`
    );
    done(
      'quality',
      `${n(p.qualityDone)} books checked${
        p.qualityErrors ? ` (${n(p.qualityErrors)} couldn’t be checked)` : ''
      }.`
    );
    return lines;
  }
  if (p.error) return [`The analysis stopped: ${p.error}`];
  const c = p.classes ?? {};
  lines.push(
    `Read ${n(p.textDone)} books${p.textErrors ? ` (${n(p.textErrors)} couldn’t be read)` : ''}` +
      `${p.imageOnly ? `, ${n(p.imageOnly)} of them picture books` : ''}; ${n(p.candidates)} pairs share text.`
  );
  lines.push(
    `${n(p.toRemove)} copies to remove. Same text: ${n(c.duplicate)} pairs · one holds the other: ${n(c.superset)}` +
      ` · for review: ${n(p.review)} · both stay: ${n(c.keep_both)} · never the same book: ${n(c.never)}` +
      ` · different books: ${n(c.different)}.`
  );
  const extras: string[] = [];
  const has = (count: number) => (count === 1 ? 'has' : 'have');
  if (p.omnibusByText) extras.push(`${n(p.omnibusByText)} omnibus files found by their text`);
  if (p.setsWithoutKeeper)
    extras.push(`${n(p.setsWithoutKeeper)} sets with no copy better than all others (review)`);
  if (p.tagsCopied)
    extras.push(
      `${n(p.tagsCopied)} removed ${p.tagsCopied === 1 ? 'copy has' : 'copies have'} your own tags, which go to the copy that stays`
    );
  if (p.removedWithData)
    extras.push(
      `${n(p.removedWithData)} ${has(p.removedWithData)} reading data, which goes to the copy that stays`
    );
  if (p.bothWithData)
    extras.push(`${n(p.bothWithData)} where both copies have reading data (each keeps its own)`);
  if (p.readerCompared && p.readerDiffering)
    extras.push(
      `${n(p.readerDiffering)} of ${n(p.readerCompared)} books’ text length differs from the reader’s count`
    );
  if (extras.length) lines.push(`${extras.join('; ')}.`);
  const spb = secondsPerBook(p);
  const total = Object.values(p.times ?? {}).reduce((a, t) => a + (t?.ms ?? 0), 0);
  if (spb) lines.push(`Took ${durationText(total)} (${spb}).`);
  return lines;
}

/** "2 h 10 min", "25 min", "40 s". */
export function durationText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** The gate in a few lines; passed = nothing is held back by it. */
export function gateLines(gate: Stage3Gate | null): string[] {
  if (!gate) return [];
  const lines: string[] = [];
  if (gate.pairs) {
    lines.push(
      `Measured pairs: ${n(gate.pairs.asMeasured)} of ${n(gate.pairs.checked)} come out as measured` +
        `${gate.pairs.sameAfterStage1 ? ` (${n(gate.pairs.sameAfterStage1)} became one copy earlier)` : ''}` +
        `${gate.pairs.notInLibrary ? ` (${n(gate.pairs.notInLibrary)} not in the library any more)` : ''}.`
    );
  }
  if (gate.spread) lines.push(gate.spread.detail);
  if (gate.kinds) {
    lines.push(
      `Labeled books: ${n(gate.kinds.recognized)} of ${n(gate.kinds.guards)} previews, bonus stories and omnibus files recognized; ` +
        `${n(gate.kinds.imageOnlyRecognized)} of ${n(gate.kinds.imageOnly)} picture books.`
    );
  }
  if (gate.textLength) {
    lines.push(
      `Text length equal to the reader’s count: ${n(gate.textLength.equal)} of ${n(gate.textLength.compared)} labeled books.`
    );
  }
  return lines;
}

/** Stage 3's pauses: a changed file is its own reason. */
export function stage3PauseTitle(reason: string): string {
  return reason === 'not_identical'
    ? 'A copy’s file changed since the analysis'
    : pauseTitle(reason);
}

const MEASURE_LABELS: Record<PairMeasure['name'], string> = {
  text: 'Text',
  images: 'Pictures',
  ruby: 'Furigana',
  toc: 'Contents',
  cover: 'Cover',
  direction: 'Writing direction'
};

export function measureLabel(m: PairMeasure): string {
  return MEASURE_LABELS[m.name] ?? m.name;
}

/** Which side a measure favors, from the point of view of a pair (left = a, right = b). */
export function measureWinner(m: PairMeasure): string {
  if (m.winner === 'a') return 'left is better';
  if (m.winner === 'b') return 'right is better';
  if (m.winner === 'tradeoff') return 'each better somewhere';
  return 'the same';
}

/** The facts of one copy in a line. */
export function bookFactsLine(b: PairBookFacts): string {
  const parts: string[] = [];
  if (typeof b.chars === 'number') parts.push(`${n(b.chars)} characters`);
  if (b.kind && b.kind !== 'full')
    parts.push(`${kindText(b.kind)}${b.kind_by === 'text' ? ' (by its text)' : ''}`);
  const pictures = typeof b.images === 'number' ? b.images : b.image_entries;
  if (typeof pictures === 'number')
    parts.push(`${n(pictures)} ${pictures === 1 ? 'picture' : 'pictures'}`);
  if (b.ruby) parts.push('furigana');
  if (typeof b.toc_entries === 'number')
    parts.push(`${n(b.toc_entries)} ${b.toc_entries === 1 ? 'chapter' : 'chapters'}`);
  if (b.vertical === 1) parts.push('vertical');
  else if (b.vertical === 0) parts.push('horizontal');
  if (b.cover_side) parts.push(`cover ${n(b.cover_side)} px`);
  return parts.join(' · ');
}

/** "98.2 % of the left copy is in the right one, 100.0 % the other way". */
export function overlapLine(p: Stage3Pair): string | null {
  if (p.aInB === null || p.bInA === null) {
    if (p.estAInB === null || p.estBInA === null) return null;
    return `About ${pct(p.estAInB, 0)} of the left copy is in the right one, ${pct(p.estBInA, 0)} the other way (estimate; not measured word for word).`;
  }
  return `${pct(p.aInB)} of the left copy’s text is in the right one, ${pct(p.bInA)} the other way.`;
}

/** The extra text inside the chapters, if any, in words. */
export function spreadLine(p: Stage3Pair): string | null {
  const sides = [
    ['left', p.spread?.a],
    ['right', p.spread?.b]
  ] as const;
  const parts: string[] = [];
  for (const [side, e] of sides) {
    if (!e || !e.interleavedRuns) continue;
    parts.push(
      `the ${side} copy has ${pct(e.interleavedShare)} extra text inside the chapters (${n(e.interleavedRuns)} passages in ${n(e.chaptersTouched)} chapters)`
    );
  }
  if (!parts.length) return null;
  const line = parts.join('; ');
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/** Which copy stays, in words ("The right copy stays", or a decision). */
export function keepLine(p: Stage3Pair): string | null {
  if (p.decision === 'keep_both') return 'You chose: both copies stay.';
  if (p.decision === 'remove_a') return 'You chose: remove the left copy.';
  if (p.decision === 'remove_b') return 'You chose: remove the right copy.';
  if (p.class !== 'duplicate' && p.class !== 'superset') return null;
  if (p.keepId === null) return 'No copy is better on every measure: waiting for your decision.';
  return p.keepId === p.a.calibreId ? 'The left copy stays.' : 'The right copy stays.';
}
