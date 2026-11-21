/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Texts of the Audiobooks tab's stage 7 card (WP21f-1: the daily new arrivals). Pure.
 */
import type { AudioStage7Run, AudioStage7Status } from './cleanup-api';
import { bytesText, eta, etaText, n, type ProgressBar } from './cleanup-text';

export const STAGE7_HINTS: Record<'off' | 'analyse' | 'on', string> = {
  off: 'Off: nothing runs. In Preview, the daily run finds the new audio under the torrents, unpacks new archives into _extracted/, runs stages 1-5 again and plans the new books; nothing is added to the library. On adds them.',
  analyse:
    'Preview: once a day (or Run now) the new audio is checked and planned; archives are unpacked into torrents/…/_extracted/ (new files only; the archives stay as they are). Nothing is added to the library or Audiobookshelf.',
  on: 'On: once a day (or Run now) the new books are added to media/audiobooks/japanese as hard links with their metadata.json; Audiobookshelf picks them up. Existing books are never changed.'
};

export const MODE_LABEL_ON_7 = 'On (add books)';

const PHASES: Record<string, string> = {
  stage1: 'Stage 1: listing and hashing',
  archives: 'Archives: listing and unpacking',
  stage1b: 'Stage 1 again (the unpacked files)',
  stages: 'Stages 2-5 run again',
  classify: 'Sorting the recordings (new, in the library, copies)',
  plan: 'Planning the new books',
  walk_before: 'Listing the torrents and the library (before)',
  build: 'Adding the new books',
  walk_after: 'Listing the torrents and the library (after)',
  check: 'Checking the new books',
  abs: 'Audiobookshelf: showing the new books?',
  report: 'The report',
  done: 'Done'
};

export function phaseLabel(phase: string): string {
  return PHASES[phase] ?? phase;
}

/** The bar of the run's current step (with time left), or null. */
export function stage7Bar(
  run: AudioStage7Run | null | undefined,
  now: number,
  absWaitMinutes = 30
): ProgressBar | null {
  if (!run || run.finishedAt) return null;
  const label = phaseLabel(run.phase);
  if (run.phase === 'archives') {
    const a = run.archives;
    if (a.toList > 0 && a.bytes === 0)
      return {
        label: `${label}: ${n(a.listed)} of ${n(a.listed + a.toList)} archives listed`,
        fraction: a.listed + a.toList ? a.listed / (a.listed + a.toList) : 0,
        eta: eta(a.listed, a.listed + a.toList, run.phaseStartedAt, 0, now)
      };
    return {
      label: `${label}: ${bytesText(a.extractedBytes)} of ${bytesText(a.bytes)} unpacked (${n(a.extracted)} of ${n(a.entries)} files)`,
      fraction: a.bytes ? Math.min(1, a.extractedBytes / a.bytes) : 0,
      eta: eta(a.extractedBytes, a.bytes, run.phaseStartedAt, 0, now)
    };
  }
  if (run.phase === 'build') {
    const b = run.build;
    return {
      label: `${label}: ${n(b.done)} of ${n(b.total)} operations`,
      fraction: b.total ? b.done / b.total : 0,
      eta: eta(b.done, b.total, b.startedAt, 0, now)
    };
  }
  if (
    (run.phase === 'walk_before' || run.phase === 'walk_after' || run.phase === 'check') &&
    run.walk
  ) {
    const w = run.walk;
    const total = Math.max(w.total, w.done);
    return {
      label: `${label}: ${n(w.done)}${total ? ` of ${n(total)}` : ''}`,
      fraction: total ? Math.min(1, w.done / total) : 0,
      eta: total ? eta(w.done, total, w.startedAt, 0, now) : null
    };
  }
  if (run.phase === 'abs' && run.abs.waitingSince) {
    const waited = now - run.abs.waitingSince;
    const wait = absWaitMinutes * 60_000;
    return {
      label: `${label}: ${n(run.abs.found)} shown, ${n(run.abs.missing)} not yet`,
      fraction: wait ? Math.min(1, waited / wait) : 1,
      eta: wait && waited < wait ? `at most ${etaText(wait - waited).replace(/^about /, '')}` : null
    };
  }
  return null;
}

function when(t: number, now: number): string {
  const d = new Date(t);
  const today = new Date(now);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${hm}`;
  const tomorrow = new Date(now + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm}`;
}

/** " (05:00 UTC)": the schedule's own clock, when its zone is not this browser's. */
export function inZone(t: number, zone: string | undefined): string {
  if (!zone) return '';
  let mine = '';
  try {
    mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
  if (zone === mine) return '';
  try {
    const hm = new Date(t).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: zone
    });
    return ` (${hm} ${zone})`;
  } catch {
    return '';
  }
}

/** One line under the card's title. */
export function stage7Summary(s: AudioStage7Status | null | undefined, now: number): string {
  if (!s?.available) return 'Needs the audiobook folders (not set up)';
  if (!s.switched) return 'Starts after the switch to the new library';
  if (s.running && s.run)
    return `Running (${s.run.mode === 'on' ? 'On' : 'Preview'}): ${phaseLabel(s.run.phase)}`;
  const next = s.nextRunAt
    ? `Next run ${when(s.nextRunAt, now)}${inZone(s.nextRunAt, s.timeZone)}`
    : 'No run planned';
  const r = s.report;
  if (!r || !s.run) return `${next}.`;
  const o = r.outcomes ?? {};
  const parts = [
    r.mode === 'on' ? `${n(r.added)} added` : `${n(r.planned)} would be added`,
    o.identical || o.duplicate
      ? `${n((o.identical ?? 0) + (o.duplicate ?? 0))} copies recorded`
      : null,
    o.better ? `${n(o.better)} better copies` : null,
    o.waiting ? `${n(o.waiting)} waiting` : null,
    o.held ? `${n(o.held)} held` : null
  ].filter((x): x is string => x !== null);
  const last = `Last run ${when(s.run.startedAt, now)} (${r.mode === 'on' ? 'On' : 'Preview'}): ${parts.join(', ')}`;
  return `${last}. ${next}.`;
}

/** The last run's report, for Details. */
export function reportLines(s: AudioStage7Status | null | undefined): string[] {
  const r = s?.report;
  const run = s?.run;
  if (!r || !run) return [];
  const o = r.outcomes ?? {};
  const out: string[] = [];
  const c = run.classify;
  if (c)
    out.push(
      `Recordings: ${n(c.existing)} in the library, ${n(c.new)} new, ${n(c.identical)} identical, ${n(c.duplicate)} proven copies, ${n(c.better)} better copies, ${n(c.waiting)} waiting, ${n(c.held)} held, ${n(c.removed)} removed by hand`
    );
  if (run.plan)
    out.push(
      `Plan: ${n(run.plan.books)} books (${n(run.plan.ai)} AI), ${n(run.plan.links)} links, ${n(run.plan.pdfs)} PDFs, ${n(run.plan.folders)} new folders; names: ${n(run.plan.collisions.narrator)} {narrator}, ${n(run.plan.collisions.number)} (2)`
    );
  const a = run.archives;
  if (a.total)
    out.push(
      `Archives: ${n(a.total)}; ${n(a.extracted)} files unpacked (${bytesText(a.extractedBytes)}), ${n(a.thisRun)} in this run; ${
        Object.entries(a.problems)
          .map(([k, v]) => `${n(v)} ${ARCHIVE_STATE[k] ?? k}`)
          .join(', ') || 'no problems'
      }`
    );
  if (run.mode === 'on')
    out.push(
      `Audiobookshelf: ${run.abs.before ?? '?'} → ${run.abs.after ?? '?'} items; ${n(run.abs.found)} new books shown, ${n(run.abs.missing)} not shown${run.abs.nudged ? ` (told ABS about ${n(run.abs.nudged)})` : ''}; values as written: ${n(run.abs.valuesOk)}, different: ${n(run.abs.valuesDiffer)}${run.abs.error ? `; ${run.abs.error}` : ''}`
    );
  if (run.abs.precedence) out.push(`Audiobookshelf reads (low → high): ${run.abs.precedence}`);
  out.push(`To look at: ${n(r.newReview)} new in this run, ${n(r.openReview)} open in all`);
  out.push(`AI cost of this run's analysis: $${r.aiCostUsd.toFixed(4)}`);
  if (r.changedExisting)
    out.push(
      `Existing books whose decided values now differ from what was built: ${n(r.changedExisting.differ)} (not changed: WP21f-2), ${n(r.changedExisting.rekeyed)} recordings with a new key`
    );
  const times = Object.entries(r.times ?? {})
    .filter(([, t]) => t.ms >= 1000)
    .map(
      ([k, t]) =>
        `${phaseLabel(k).split(':')[0]} ${etaText(t.ms)
          .replace(/^about /, '')
          .replace(/ left$/, '')}`
    );
  if (times.length) out.push(`Time: ${times.join(' · ')}`);
  out.push(
    `Disk lock: waited ${Math.round((r.lockWaitMs ?? 0) / 1000)} s, gave way to Calibre ${n(r.yields ?? 0)} times`
  );
  if (o.removed)
    out.push(`${n(o.removed)} recordings were removed from the library by hand: not added again`);
  if (run.check) out.push(...run.check.lines);
  return out;
}

export const ARCHIVE_STATE: Record<string, string> = {
  new: 'waiting',
  listed: 'listed',
  extracted: 'unpacked',
  failed: 'failed',
  password: 'need a password',
  no_audio: 'without audio',
  not_archive: 'not archives',
  names: 'with unreadable names'
};

/** The E/F/J line: what an upgrade would re-check and cost. */
export function designLines(s: AudioStage7Status | null | undefined): string[] {
  if (!s?.designs) return [];
  const d = s.designs;
  const out = [`Recordings by AI setup: E ${n(d.E)} · F ${n(d.F)} · J ${n(d.J)}`];
  const u = s.upgrade;
  if (u) {
    const cost = (x: number | null) => (x === null ? 'cost unknown' : `about $${x.toFixed(2)}`);
    out.push(
      `An F upgrade would re-check ${n(u.F.fields)} fields of ${n(u.F.items)} recordings (${cost(u.F.costUsd)}); a J upgrade ${n(u.J.fields)} fields of ${n(u.J.items)} recordings (${cost(u.J.costUsd)}).`
    );
    out.push(
      u.includeDecided
        ? 'Values already decided by that setup or a stronger one are re-checked too (setting).'
        : 'Values already decided by that setup or a stronger one (the new arrivals decided with J) are left out.'
    );
  }
  return out;
}

export const ARRIVAL_LISTS: { id: string; label: string }[] = [
  { id: 'new', label: 'New books (this run)' },
  { id: 'waiting', label: 'Waiting (still changing)' },
  { id: 'held', label: 'Held (start or end doesn’t play)' },
  { id: 'identical', label: 'Identical to a file in the library' },
  { id: 'duplicate', label: 'Proven copies of a book in the library' },
  { id: 'better', label: 'Better copies of a book in the library' },
  { id: 'removed', label: 'Removed from the library by hand' },
  { id: 'plan', label: 'The plan (folders)' },
  { id: 'archives', label: 'Archives' },
  { id: 'review', label: 'To look at (all)' },
  { id: 'runs', label: 'Runs' }
];

export const REVIEW_CHOICES: Record<string, { id: string; label: string }[]> = {
  better_copy: [
    { id: 'keep_current', label: 'Keep the library’s copy' },
    { id: 'use_new', label: 'Use the new copy (applied later)' }
  ],
  held: [{ id: 'add_anyway', label: 'Add anyway (next run)' }],
  archive: [{ id: 'dismiss', label: 'Dismiss' }],
  abs_missing: [{ id: 'dismiss', label: 'Dismiss' }]
};

export const REVIEW_KIND: Record<string, string> = {
  better_copy: 'Better copy of a book in the library',
  held: 'Held: the start or end doesn’t play',
  archive: 'Archive',
  abs_missing: 'Audiobookshelf doesn’t show it'
};
