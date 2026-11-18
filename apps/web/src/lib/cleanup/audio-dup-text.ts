/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  AudioDupCopy,
  AudioDupGroup,
  AudioDupPair,
  AudioGateResult,
  AudioStage3Progress
} from './cleanup-api';
import { count, durationText } from './audio-text';
import { eta, n, type ProgressBar } from './cleanup-text';

/**
 * Plain wording for stage 3 of the Audiobooks tab (WP21b): copies of the same recording.
 * Nothing here changes any file: the choices are only recorded (the library is rebuilt later).
 */

export const STAGE3_HINTS = {
  off: 'Nothing runs.',
  analyse:
    'Finds copies of the same recording (identical files, the same ASIN, the same title and volume, copies in one folder), compares them by listening to a few stretches of each, and picks the best copy. Nothing is changed: the choices are only recorded.'
};

const PHASES: Record<AudioStage3Progress['phase'], string> = {
  copies: 'Collecting the books to compare',
  candidates: 'Finding books that could be the same recording',
  fingerprints: 'Listening to a few stretches of each copy',
  compare: 'Comparing what was heard',
  decode: 'Playing the chosen copies all the way through',
  decide: 'Picking the best copies',
  done: 'Done'
};

export const TEST_LABELS: Record<string, string> = {
  identical: 'identical files',
  asin: 'same ASIN in the names',
  abs_asin: 'same ASIN in Audiobookshelf',
  title: 'same title and volume',
  in_folder: 'copies in one folder'
};

export const RULE_LABELS: Record<string, string> = {
  '0': 'damaged or incomplete copy loses',
  '1': 'keeps the original chapters',
  '2': 'single file',
  '3': 'has chapters',
  '4': 'AAC over MP3',
  '5': 'higher bitrate / sample rate',
  '6': 'has a cover',
  '7': 'ASIN in the name',
  tie: 'nothing separates them',
  identical: 'identical files (either)'
};

export const DUP_LISTS: { id: string; label: string }[] = [
  { id: 'review', label: 'To review (both copies stay until you choose)' },
  { id: 'auto', label: 'Decided: same recording, best copy picked' },
  { id: 'unsure', label: 'Not sure it is the same recording' },
  { id: 'damaged', label: 'Groups with a damaged copy' },
  { id: 'different', label: 'Same name, different recordings' },
  { id: 'excluded', label: 'Left out (written by the reader)' },
  { id: 'gate', label: 'Checked on the labeled pairs' }
];

/** Hours and minutes of audio. */
function audioHours(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function audioStage3Bar(
  p: AudioStage3Progress | null | undefined,
  now = Date.now()
): ProgressBar | null {
  if (!p) return null;
  if (p.phase === 'fingerprints' && p.windowsTotal > 0) {
    return {
      label: `${PHASES.fingerprints}: ${n(p.windowsDone)} of ${n(p.windowsTotal)}`,
      fraction: Math.min(1, p.windowsDone / p.windowsTotal),
      eta: eta(p.windowsDone, p.windowsTotal, p.phaseStartedAt, p.phaseStartDone, now)
    };
  }
  if (p.phase === 'compare' && p.compareTotal) {
    const done = p.compareDone ?? 0;
    return {
      label: `${PHASES.compare}: ${n(done)} of ${count(p.compareTotal, 'pair', 'pairs')}`,
      fraction: Math.min(1, done / p.compareTotal),
      eta: null
    };
  }
  if (p.phase === 'decode' && p.decodesLeft !== undefined) {
    const doneFiles = p.decodesDone;
    const total = doneFiles + p.decodesLeft;
    // Time left from the audio decoded since the server started (the list can still grow).
    const audioDone = p.decodeAudioDone ?? 0;
    const from = p.decodeRateFrom;
    const left = p.decodeAudioLeft ?? 0;
    let time: string | null = null;
    if (from && left > 0) {
      time = eta(audioDone, audioDone + left, from.at, from.audio, now);
      if (time) time = `${time} (estimate; more may be added)`;
    }
    return {
      label: `${PHASES.decode}: ${n(doneFiles)} of ${count(total, 'file', 'files')} (${audioHours(left)} of audio left)`,
      fraction: total > 0 ? Math.min(1, doneFiles / total) : 0,
      eta: time
    };
  }
  return null;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function audioStage3Lines(p: AudioStage3Progress | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.phase !== 'done') out.push(`Now: ${PHASES[p.phase]}.`);
  if (p.copies) {
    out.push(
      `${count(p.copies, 'copy', 'copies')} of books compared${p.excluded ? ` (${n(p.excluded)} left out)` : ''}.`
    );
  }
  const pairs = Object.entries(p.pairsByTest ?? {}).filter(([k, v]) => TEST_LABELS[k] && v > 0);
  if (pairs.length) {
    out.push(
      `Possible duplicates: ${pairs.map(([k, v]) => `${n(v)} by ${TEST_LABELS[k]}`).join(', ')}.`
    );
  }
  if (p.windowsTotal) {
    out.push(
      `${n(p.windowsDone)} of ${count(p.windowsTotal, 'stretch', 'stretches')} heard${p.windowsReused ? ` (${n(p.windowsReused)} heard before, not read again)` : ''}${p.windowErrors ? `; ${n(p.windowErrors)} could not be read` : ''}.`
    );
  }
  if (p.decodesDone)
    out.push(`${count(p.decodesDone, 'file', 'files')} played all the way through.`);
  if (p.yields)
    out.push(`Gave the disk to the Calibre cleanup ${count(p.yields, 'time', 'times')}.`);
  if (p.error) out.push(`The analysis failed: ${p.error}`);
  if (p.phase === 'done' && p.finishedAt)
    out.push(`Finished in ${minutes(p.finishedAt - p.startedAt)}.`);
  return out;
}

const c = (counts: Record<string, number>, key: string) => counts[key] ?? 0;

/** What stage 3 found: groups by the test that found them, decisions by rule, review items. */
export function dupLines(counts: Record<string, number> | null | undefined): string[] {
  if (!counts) return [];
  const lines: string[] = [];
  const byTest = Object.keys(TEST_LABELS)
    .map(
      (t) =>
        [t, c(counts, `groups.group.${t}.auto`) + c(counts, `groups.group.${t}.review`)] as const
    )
    .filter(([, v]) => v > 0);
  const groups = byTest.reduce((a, [, v]) => a + v, 0);
  lines.push(
    `${count(groups, 'recording has', 'recordings have')} more than one copy${byTest.length ? ` (found by ${byTest.map(([t, v]) => `${TEST_LABELS[t]} ${n(v)}`).join(', ')})` : ''}.`
  );
  const rules = Object.keys(counts)
    .filter((k) => k.startsWith('decisions.auto.rule.'))
    .map((k) => [k.slice('decisions.auto.rule.'.length), counts[k]] as const)
    .sort((a, b) => b[1] - a[1]);
  if (rules.length) {
    lines.push(
      `Best copy decided: ${rules.map(([r, v]) => `${RULE_LABELS[r] ?? r} ${n(v)}`).join(', ')}; ${count(c(counts, 'dropped'), 'copy', 'copies')} not needed.`
    );
  }
  lines.push(
    `${count(c(counts, 'review'), 'item waits', 'items wait')} for review (both copies stay until you choose).`
  );
  const diff = Object.keys(counts)
    .filter((k) => k.startsWith('pairs.') && k.endsWith('.different'))
    .reduce((a, k) => a + counts[k], 0);
  if (diff)
    lines.push(
      `${count(diff, 'pair', 'pairs')} with the same name turned out to be different recordings.`
    );
  if (c(counts, 'damaged_groups'))
    lines.push(`${count(c(counts, 'damaged_groups'), 'group has', 'groups have')} a damaged copy.`);
  if (c(counts, 'decodes.ffmpeg.errors') || c(counts, 'decodes.faad.errors')) {
    lines.push(
      `Played all the way through: ${n(c(counts, 'decodes.ffmpeg.errors'))} with errors in ffmpeg, of which ${n(c(counts, 'decodes.faad.errors'))} also failed in the second player (faad2).`
    );
  }
  return lines;
}

/** The gate: how the decisions came out on the labeled pairs. */
export function gateLines(g: AudioGateResult | null | undefined): string[] {
  if (!g) return [];
  if (g.error) return [`The labeled pairs can’t be read: ${g.error}`];
  return [
    `${n(g.correct)} of ${count(g.checked, 'labeled pair', 'labeled pairs')} came out as labeled (same or not: ${n(g.sameCorrect)} of ${n(g.sameChecked)}; best copy: ${n(g.bestCorrect)} of ${n(g.bestChecked)})${g.skipped ? `; ${n(g.skipped)} without a label left out` : ''}.`
  ];
}

export function missLine(m: AudioGateResult['misses'][number]): string {
  return `Pair ${m.n} (${m.kind}): labeled ${m.expected}, came out ${m.got}.`;
}

function kbps(b: number | null): string {
  return b ? `${Math.round(b / 1000)} kbps` : '? kbps';
}

/** One copy's facts on one line. */
export function copyFacts(c: AudioDupCopy): string {
  const parts = [
    durationText(c.seconds),
    c.files > 1 ? `${n(c.files)} files` : 'one file',
    `${n(c.chapters)} chapters`,
    `${c.codec ?? '?'} ${kbps(c.bitrate)}${c.sampleRate ? ` ${c.sampleRate / 1000} kHz` : ''}`,
    c.cover ? 'cover' : 'no cover'
  ];
  if (c.asins.length) parts.push(`ASIN ${c.asins.join(', ')}`);
  if (c.kind === 'library_only') parts.push('only in the library');
  return parts.join(' · ');
}

export function damageLine(c: AudioDupCopy): string | null {
  if (c.damage === 'damaged') return `Damaged: ${c.damageDetail ?? ''}`.trim();
  if (c.damage === 'suspect')
    return `Possibly damaged (not confirmed by a second player): ${c.damageDetail ?? ''}`.trim();
  if (c.damage === 'ok') return 'Played all the way through without errors.';
  return null;
}

/** The fingerprint scores of a pair: start, middle, end. */
export function scoresLine(p: AudioDupPair): string {
  const w = p.scores?.windows ?? [];
  const parts = (['start', 'middle', 'end'] as const).map((name) => {
    const s = w.find((x) => x.name === name);
    if (!s || s.score === null) return `${name} –`;
    const shift = s.shiftSeconds
      ? ` (${s.shiftSeconds > 0 ? '+' : ''}${s.shiftSeconds.toFixed(1)} s)`
      : '';
    return `${name} ${s.score.toFixed(2)}${shift}`;
  });
  const diff =
    p.length_diff !== null && p.length_diff !== undefined
      ? `; lengths ${p.length_diff > 0 ? '+' : ''}${p.length_diff.toFixed(1)} s`
      : '';
  return `Heard alike: ${parts.join(', ')}${diff}`;
}

/** Which two copies a pair of scores is about ("Copies 1 and 3: "), by the copies' order. */
export function pairCopies(g: AudioDupGroup, p: AudioDupPair): string {
  const a = g.copies.findIndex((c) => c.id === p.a_id);
  const b = g.copies.findIndex((c) => c.id === p.b_id);
  if (a < 0 || b < 0) return '';
  const [x, y] = [a + 1, b + 1].sort((m, k) => m - k);
  return `Copies ${x} and ${y}: `;
}

export function groupHeadline(g: AudioDupGroup): string {
  // Every test that joined copies of the group, cheapest first.
  const tests = g.tests?.length ? g.tests : [g.firstTest];
  const how = tests.map((t) => TEST_LABELS[t] ?? t).join(', ');
  if (g.kind === 'unsure') return `Not sure it is the same recording (${how})`;
  const rule = g.rule ? (RULE_LABELS[g.rule] ?? g.rule) : '';
  return g.outcome === 'review'
    ? `Same recording, to review (${how}); best guess by: ${rule}`
    : `Same recording (${how}); best copy by: ${rule}`;
}

export function decisionText(g: AudioDupGroup): string | null {
  if (!g.decision) return null;
  if (g.decision.decision === 'keep_all') return 'Your choice: keep all copies.';
  const key = g.decision.decision.replace(/^keep:/, '');
  const i = g.copies.findIndex((c) => c.key === key);
  return i >= 0
    ? `Your choice: keep only copy ${i + 1}.`
    : 'Your choice no longer matches these copies.';
}

/** Stage 3's settings on the Settings tab (all thresholds are user settings). */
export const DUP_FIELDS: {
  key:
    | 'dupSameScore'
    | 'dupWindowSeconds'
    | 'dupShiftSeconds'
    | 'dupMiddleSearchMinutes'
    | 'dupCandidatePercent'
    | 'dupAsinToleranceSeconds'
    | 'dupLengthEqualSeconds'
    | 'dupIncompleteSeconds'
    | 'dupBitrateMarginPercent'
    | 'dupChapterToleranceSeconds'
    | 'dupFingerprintWorkers'
    | 'dupDecodeWorkers'
    | 'dupClipSeconds';
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  {
    key: 'dupSameScore',
    label: 'Same recording when every stretch scores at least (0.5–1)',
    min: 0.5,
    max: 1,
    // Fine enough for a line between two measured scores (a coarser step blocked saving 0.995).
    step: 0.001
  },
  {
    key: 'dupWindowSeconds',
    label: 'Length of each stretch heard (s)',
    min: 10,
    max: 300,
    step: 1
  },
  {
    key: 'dupShiftSeconds',
    label: 'How far copies may be shifted at the start and the end (s)',
    min: 0,
    max: 600,
    step: 1
  },
  {
    key: 'dupMiddleSearchMinutes',
    label: 'The middle stretch searches at most (minutes)',
    min: 1,
    max: 120,
    step: 1
  },
  {
    key: 'dupCandidatePercent',
    label: 'Same title and volume: compared when the lengths are within (%)',
    min: 0,
    max: 50,
    step: 0.5
  },
  {
    key: 'dupAsinToleranceSeconds',
    label: 'Same ASIN: the same recording when the lengths are within (s)',
    min: 0,
    max: 3600,
    step: 1
  },
  {
    key: 'dupLengthEqualSeconds',
    label: 'Lengths count as equal within (s)',
    min: 0,
    max: 600,
    step: 0.5
  },
  {
    key: 'dupIncompleteSeconds',
    label: 'A copy this much shorter than its twin is incomplete (s)',
    min: 1,
    max: 36000,
    step: 1
  },
  {
    key: 'dupBitrateMarginPercent',
    label: 'Bitrates count as equal within (%)',
    min: 0,
    max: 50,
    step: 0.5
  },
  {
    key: 'dupChapterToleranceSeconds',
    label: 'Chapters count as equal within (s)',
    min: 0,
    max: 600,
    step: 0.5
  },
  {
    key: 'dupFingerprintWorkers',
    label: 'Stretches heard at the same time',
    min: 1,
    max: 16,
    step: 1
  },
  {
    key: 'dupDecodeWorkers',
    label: 'Files played all the way through at the same time',
    min: 1,
    max: 8,
    step: 1
  },
  { key: 'dupClipSeconds', label: 'Seconds played on the review page', min: 2, max: 60, step: 1 }
];
