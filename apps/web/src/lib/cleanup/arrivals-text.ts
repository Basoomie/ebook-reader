/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The words of the Calibre library's new arrivals card on /cleanup (WP20g): the run's steps,
 * its bar with the time left, the summary, the last run's report and the lists' outcomes.
 */
import { etaText, n, type ProgressBar } from './cleanup-text';

export type ArrivalsMode = 'off' | 'analyse' | 'on';

export interface ArrivalsBar {
  phase: string;
  index: number;
  phases: number;
  done: number;
  total: number;
  bytesDone: number | null;
  bytesTotal: number | null;
  secondsLeft: number | null;
  /** The compare step's part (six in turn, each counted on its own); null in other steps. */
  part?: { index: number; count: number; stage: string } | null;
}

export interface ArrivalsReport {
  mode: 'analyse' | 'on';
  outcomes: Record<string, number>;
  formats: Record<string, number>;
  added: number;
  hand: number;
  written: Record<string, number>;
  /** Proposed but not written: a field paused by its gate. */
  held?: Record<string, number>;
  reviews: number;
  newReview: number;
  bestGuesses: number;
  existingSeriesChanges: number;
  aiCost: number;
  check: { fields: number; same: number; differ: { calibreId: number; field: string }[] } | null;
  estimate: { books: number; aiUsd: number; seconds: number } | null;
}

export interface ArrivalsPair {
  key: string;
  id: string;
  source: string;
  libraryId: string;
  firstRunId: number | null;
  firstDoneAt: number | null;
  wouldAdd: number;
  added: number;
  /** Books and archives not looked at yet (waiting to settle); older servers leave it out. */
  waiting?: number;
  settleMinutes?: number;
}

export interface ArrivalsStatus {
  mode: ArrivalsMode;
  pause: { reason: string; detail: string | null; at: number | null } | null;
  nextRunAt: number | null;
  timeZone: string;
  importProblem: string | null;
  design: 'E' | 'F' | 'J';
  pairs: ArrivalsPair[];
  reviews: number;
  run: {
    id: number;
    trigger: string;
    mode: 'analyse' | 'on';
    phase: string;
    startedAt: number;
    waiting: string | null;
    bar: ArrivalsBar;
    scope: { import: number; hand: number };
    cost: number;
    jGate: { passed: boolean; below: string[]; design: string } | null;
    times: Record<string, number>;
  } | null;
  last: {
    id: number;
    trigger: string;
    mode: string;
    state: string;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    report: ArrivalsReport | null;
  } | null;
}

export const ARRIVALS_MODE_LABELS: Record<ArrivalsMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const ARRIVALS_HINTS: Record<ArrivalsMode, string> = {
  off: 'New books are not looked at.',
  analyse:
    'Preview: each day the source folders are checked and every new book is compared with the library; books added in Calibre get their proposals. Nothing is added or written.',
  on: 'On: new EPUBs that are not copies of library books are added to Calibre, and the new books go through stages 1-5 (their changes written). A folder adds only after its first run (a Preview) has finished.'
};

/** The steps of a run as the card names them. */
export const PHASE_LABELS: Record<string, string> = {
  scan: 'Looking through the source folders',
  archives: 'Unpacking archives',
  identify: 'Reading the new files',
  compare: 'Comparing them with the library',
  plan: 'Planning what to add',
  add: 'Adding books to Calibre',
  index: "Waiting for the reader's index",
  stage1: 'Stage 1: identical files',
  stage3: 'Stage 3: the same text',
  removals: 'Removing copies',
  stage2: 'Stage 2: metadata from the files',
  write2: 'Writing stage 2’s changes',
  stage4: 'Stage 4: looking the books up online',
  ai: 'Stage 4: the AI check',
  write4: 'Writing stage 4’s changes',
  stage5: 'Stage 5: genres and tags',
  write5: 'Writing stage 5’s tags',
  check: 'Checking what was written against Calibre',
  move: 'Moving manga to the manga library',
  report: 'Writing the report',
  done: 'Done'
};

/** The compare step's parts as the card names them. */
export const COMPARE_PART_LABELS: Record<string, string> = {
  library: 'reading library books stage 3 has not read',
  identical: 'looking for identical files',
  text: 'reading the new books and measuring them against the library',
  pairs: 'finding books with the same text',
  measure: 'measuring the pairs with the same text',
  decide: 'deciding each book'
};

/** Outcomes of a file in plain words (the lists' names and the summary). */
export const OUTCOME_LABELS: Record<string, string> = {
  new: 'Would add',
  better: 'Better copies (the older copy goes)',
  better_review: 'Better copies to look at (the library’s copy has reading data)',
  added: 'Added',
  identical: 'Identical to a library book',
  duplicate: 'Same text as a library book',
  not_imported: 'Not imported',
  unreadable: 'Not imported (the reader can’t open it)',
  too_long: 'Too long for a folder name in Calibre',
  waiting: 'Waiting (changed lately)',
  downloading: 'Still downloading',
  skipped: 'Passed over (not a book)',
  removed_by_you: 'Removed by you (never added again)',
  undone: 'Taken out by Undo',
  failed: 'Failed',
  pending: 'Not looked at yet'
};

/** The run's bar: its step, how far, the time left (from the step's own pace). */
export function arrivalsBar(s: ArrivalsStatus | null): ProgressBar | null {
  const run = s?.run;
  if (!run) return null;
  const b = run.bar;
  const step = `Step ${b.index + 1} of ${b.phases}: ${PHASE_LABELS[b.phase] ?? b.phase}`;
  // The compare step runs six parts, each counted from its own start: say which one this is.
  const part = b.part ?? null;
  const label = part
    ? `${step}, part ${part.index + 1} of ${part.count}: ${COMPARE_PART_LABELS[part.stage] ?? part.stage}`
    : step;
  const total = b.bytesTotal ?? b.total;
  const done = b.bytesTotal !== null ? (b.bytesDone ?? 0) : b.done;
  // With nothing counted yet the bar shows how far the run is through its steps.
  const fraction =
    total > 0 ? Math.min(1, done / total) : Math.min(1, b.index / Math.max(1, b.phases));
  return {
    label: total > 0 && b.bytesTotal === null ? `${label} (${n(b.done)} of ${n(b.total)})` : label,
    fraction,
    // After measuring, only deciding is left (minutes): the time left is the whole step's. Before
    // it, the later parts' size is not known yet, so it is this part's.
    eta:
      b.secondsLeft === null
        ? null
        : part && part.stage !== 'measure' && part.stage !== 'decide'
          ? `${etaText(b.secondsLeft * 1000)} in this part`
          : etaText(b.secondsLeft * 1000)
  };
}

function sum(o: Record<string, number> | undefined, keys: string[]): number {
  return keys.reduce((a, k) => a + (o?.[k] ?? 0), 0);
}

/** The card's one-line summary of the last finished run. */
export function arrivalsSummary(s: ArrivalsStatus | null): string {
  if (!s) return '';
  const r = s.last?.report;
  if (!s.last) return 'No run yet.';
  if (s.last.state === 'failed') return `The last run stopped: ${s.last.error ?? 'an error'}`;
  if (s.last.state === 'stopped') return 'The last run was stopped.';
  if (!r) return 'The last run is done.';
  const o = r.outcomes;
  const parts = [
    r.mode === 'on'
      ? `${n(r.added)} added`
      : `${n(r.estimate?.books ?? sum(o, ['new', 'better']))} would be added (Preview)`,
    r.hand ? `${n(r.hand)} added in Calibre checked` : null,
    sum(o, ['identical', 'duplicate'])
      ? `${n(sum(o, ['identical', 'duplicate']))} copies of library books`
      : null,
    sum(o, ['not_imported', 'unreadable'])
      ? `${n(sum(o, ['not_imported', 'unreadable']))} not imported`
      : null,
    sum(o, ['waiting', 'downloading']) ? `${n(sum(o, ['waiting', 'downloading']))} waiting` : null,
    r.newReview ? `${n(r.newReview)} to look at` : null
  ].filter((x): x is string => x !== null);
  return `Last run: ${parts.join(', ')}.`;
}

function seconds(s: number): string {
  if (s < 3600) return `about ${Math.max(1, Math.round(s / 60))} min`;
  const h = Math.round(s / 3600);
  return h < 48 ? `about ${h} h` : `about ${Math.round(h / 24)} days`;
}

/** The last run's report, line by line (Details). */
export function arrivalsReportLines(s: ArrivalsStatus | null): string[] {
  const r = s?.last?.report;
  if (!r) return [];
  const lines: string[] = [];
  const fmt = Object.entries(r.formats)
    .sort((a, b) => b[1] - a[1])
    .map(([f, k]) => `${f} ${n(k)}`)
    .join(', ');
  if (fmt) lines.push(`Files looked at by format: ${fmt}.`);
  const o = r.outcomes;
  const outs = Object.entries(o)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${OUTCOME_LABELS[k] ?? k}: ${n(v)}`);
  if (outs.length) lines.push(outs.join(' · '));
  if (r.estimate)
    lines.push(
      `On would add ${n(r.estimate.books)} books: AI about $${r.estimate.aiUsd.toFixed(2)}, ${seconds(r.estimate.seconds)} (the online lookups decide the time).`
    );
  const w = Object.entries(r.written).filter(([, v]) => v > 0);
  if (w.length)
    lines.push(
      `Written: ${w.map(([k, v]) => `stage ${k.replace('s', '')} ${n(v)} changes`).join(', ')}.`
    );
  const h = Object.entries(r.held ?? {}).filter(([, v]) => v > 0);
  if (h.length)
    lines.push(
      `Held (a field is paused by its check): ${h.map(([k, v]) => `stage ${k.replace('s', '')} ${n(v)} changes`).join(', ')}; a later run writes them once the field is resumed.`
    );
  if (r.check && r.check.fields > 0)
    lines.push(
      r.check.differ.length
        ? `Checked against Calibre: ${n(r.check.same)} of ${n(r.check.fields)} as written; ${n(r.check.differ.length)} differ (listed in the run).`
        : `Checked against Calibre: all ${n(r.check.fields)} written fields as written.`
    );
  if (r.bestGuesses)
    lines.push(
      `${n(r.bestGuesses)} series numbers are best guesses (stage 4’s Best guesses list).`
    );
  if (r.existingSeriesChanges)
    lines.push(
      `${n(r.existingSeriesChanges)} books already in Calibre would get another number in their series: listed under stage 4’s Best guesses, written only by stage 4’s own On.`
    );
  if (r.aiCost) lines.push(`AI this run: $${r.aiCost.toFixed(2)}.`);
  return lines;
}

/** A source folder's first-run state in words. */
export function pairLine(p: ArrivalsPair, mode: ArrivalsMode = 'analyse'): string {
  if (p.firstDoneAt === null) {
    if (p.waiting)
      return `First run not done yet: ${n(p.waiting)} files wait until they have been unchanged for ${n(p.settleMinutes ?? 30)} minutes; a run looks at them then by itself (a Preview).`;
    return 'First run not done yet: it checks every file (a Preview).';
  }
  // No "Add these" (user, 2026-11-23): On is the go-ahead; runs after the first one add.
  if (mode !== 'on')
    return `First run done: ${n(p.wouldAdd)} books would be added once New arrivals is On${p.added ? ` (${n(p.added)} added so far)` : ''}.`;
  return `${n(p.added)} added so far; ${n(p.wouldAdd)} to be added at the next run.`;
}

/** The next scheduled run in the schedule's own time zone. */
export function nextRunText(s: ArrivalsStatus | null, now = Date.now()): string | null {
  if (!s || s.nextRunAt === null) return null;
  const t = new Date(s.nextRunAt);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: s.timeZone || undefined,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  const mins = Math.round((s.nextRunAt - now) / 60_000);
  return `Next run ${fmt.format(t)} (${s.timeZone})${mins >= 0 && mins < 120 ? `, in ${mins} min` : ''}.`;
}
