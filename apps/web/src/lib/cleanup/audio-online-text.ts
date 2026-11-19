/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The words of audiobook stage 4 on /cleanup (WP21c): online lookups on Audible, kikubon and
 * audiobook.jp. Pure, tested.
 */
import type {
  AudioOnlineGate,
  AudioOnlineGateBook,
  AudioSiteLine,
  AudioStage4Status
} from './cleanup-api';
import { count } from './audio-text';
import { etaText, n, type ProgressBar } from './cleanup-text';

export const STAGE4_HINTS: Record<'off' | 'analyse', string> = {
  off: 'Off: nothing is looked up.',
  analyse:
    'Preview: each recording is looked up once on Audible, kikubon and audiobook.jp; what matches is only recorded here.'
};

export const SITE_LABELS: Record<string, string> = {
  audible: 'Audible',
  'audible-sample': 'Audible sample audio',
  kikubon: 'kikubon',
  audiobookjp: 'audiobook.jp',
  'audiobookjp-sample': 'audiobook.jp sample audio'
};

export const SOURCE_LABELS: Record<string, string> = {
  audible: 'Audible',
  kikubon: 'kikubon',
  audiobookjp: 'audiobook.jp',
  'audiobook.jp': 'audiobook.jp',
  none: 'no store record',
  'no lookup': 'not looked up (AI, radio clips)'
};

/** Why a match waits for review (the first check that failed). */
export const REASON_LABELS: Record<string, string> = {
  title: 'the title differs',
  author: 'the author differs',
  volume: 'the volume differs or is missing',
  runtime: 'the length differs (another edition?)',
  narrator: 'the narrator differs from the file’s tags',
  editions: 'several editions fit and their sample audio didn’t decide',
  fraction: 'matches only half or a third of the files’ total length (the files may be copies)'
};

export const ONLINE_LISTS: { id: string; label: string }[] = [
  { id: 'review', label: 'To review: the best match found, and why it isn’t certain' },
  ...Object.entries(REASON_LABELS).map(([id, label]) => ({
    id: `review:${id}`,
    label: `To review: ${label}`
  })),
  { id: 'auto', label: 'Matched' },
  { id: 'auto:audible', label: 'Matched on Audible' },
  { id: 'auto:kikubon', label: 'Matched on kikubon' },
  { id: 'auto:audiobookjp', label: 'Matched on audiobook.jp' },
  { id: 'unknown', label: 'Not found' },
  { id: 'none_expected', label: 'No store record expected (AI books, radio clips)' },
  { id: 'error', label: 'Lookups that failed' },
  { id: 'gate', label: 'Checked on the labeled books' }
];

export function storeName(source: string | null): string {
  return source ? (SOURCE_LABELS[source] ?? source) : '';
}

/** "Audible B0…", "audiobook.jp 264535". */
export function recordName(source: string | null, id: string | null): string {
  return source && id ? `${storeName(source)} ${id}` : '';
}

/** Lookups: recordings decided of those to look up, with the time left the server measured. */
export function audioStage4Bar(s: AudioStage4Status | null | undefined): ProgressBar | null {
  const p = s?.progress;
  if (!p || p.phase !== 'lookups' || p.units === 0) return null;
  const left = s.secondsLeft;
  return {
    label: `Looking up: ${n(p.decided)} of ${n(p.units)} recordings decided`,
    fraction: Math.min(1, p.decided / p.units),
    eta: left !== null && left > 0 ? `${etaText(left * 1000)} (estimate)` : null
  };
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "one every 3.0 s" with what holds the site up. */
export function siteLine(l: AudioSiteLine, now = Date.now()): string {
  const name = SITE_LABELS[l.site] ?? l.site;
  if (!l.enabled) return `${name}: switched off`;
  const parts = [
    `${n(l.done + l.gone)} answered`,
    l.queued + l.leased > 0 ? `${n(l.queued + l.leased)} waiting` : null,
    l.failed ? `${n(l.failed)} given up` : null,
    l.refused || l.busy ? `${n(l.refused + l.busy)} refused or busy` : null,
    l.errors ? `${n(l.errors)} network errors` : null
  ].filter(Boolean);
  let s = `${name}: ${parts.join(', ')} · one request every ${l.secondsPerRequest.toFixed(1)} s`;
  if (l.secondsLeft > 0) s += ` · ${etaText(l.secondsLeft * 1000)}`;
  if (l.pausedReason) s += ` · paused: ${l.pausedReason}`;
  else if (l.backoffUntil && l.backoffUntil > now)
    s += ` · waiting ${minutes(l.backoffUntil - now)}: ${l.backoffReason ?? 'backing off'}`;
  return s;
}

const PHASES: Record<string, string> = {
  units: 'Finding the recordings',
  lookups: 'Looking up',
  gate: 'Checking the labeled books',
  done: 'Done'
};

/** What the stage is doing and has done. */
export function audioStage4Lines(s: AudioStage4Status | null | undefined): string[] {
  const p = s?.progress;
  if (!s || !p) return [];
  const out: string[] = [];
  if (p.error) out.push(`The analysis stopped: ${p.error}`);
  out.push(
    `${n(p.units)} recordings: ${n(p.lookupUnits)} to look up, ${n(p.noRecordUnits)} with no store record by nature (AI books, radio clips)${p.labeledUnits ? `; the ${n(p.labeledUnits)} labeled ones first` : ''}.`
  );
  if (p.phase !== 'done') {
    const u = s.units;
    const bits = [
      u.waiting ? `${n(u.waiting)} waiting for answers` : null,
      u.ready || u.planned ? `${n((u.ready ?? 0) + (u.planned ?? 0))} about to go on` : null,
      u.audio ? `${n(u.audio)} comparing sample audio` : null,
      u.error ? `${n(u.error)} failed` : null
    ].filter(Boolean);
    out.push(`${PHASES[p.phase] ?? p.phase}${bits.length ? `: ${bits.join(', ')}` : ''}.`);
    if (p.phase === 'lookups') out.push(`Requests per recording ${s.ratios}.`);
  }
  if (p.openingsRead || p.samplesRead || p.openingErrors || p.sampleErrors) {
    out.push(
      `Sample audio: ${count(p.openingsRead, 'opening', 'openings')} and ${count(p.samplesRead, 'store sample', 'store samples')} compared${p.openingErrors + p.sampleErrors ? `, ${n(p.openingErrors + p.sampleErrors)} unreadable` : ''}${p.yields ? `; gave the disk to the Calibre cleanup ${count(p.yields, 'time', 'times')}` : ''}.`
    );
  }
  const times = Object.entries(p.phaseTimes ?? {})
    .filter(([, t]) => t.ms > 0)
    .map(([k, t]) => `${(PHASES[k] ?? k).toLowerCase()} ${minutes(t.ms)} (${n(t.items)})`);
  if (times.length) out.push(`Work time: ${times.join(', ')}.`);
  return out;
}

/** What the lookups found (the counts of a finished analysis, or so far). */
export function onlineFoundLines(c: Record<string, number> | null | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const auto = c.auto ?? 0;
  if (auto) {
    const by = ['audible', 'kikubon', 'audiobookjp']
      .filter((s) => c[`auto:${s}`])
      .map((s) => `${storeName(s)} ${n(c[`auto:${s}`])}`);
    out.push(`Matched: ${n(auto)} (${by.join(', ')}).`);
  }
  const review = c.review ?? 0;
  if (review) {
    const reasons = Object.entries(c)
      .filter(([k]) => k.startsWith('review:'))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${REASON_LABELS[k.slice(7)] ?? k.slice(7)}: ${n(v)}`);
    out.push(`To review: ${n(review)} (${reasons.join('; ')}).`);
  }
  if (c.unknown) out.push(`Not found: ${n(c.unknown)}.`);
  if (c.none_expected) out.push(`No store record expected: ${n(c.none_expected)}.`);
  if (c.open) out.push(`Still being looked up: ${n(c.open)}.`);
  return out;
}

const OUTCOMES: Record<string, string> = {
  auto_agrees: 'matched as labeled',
  review: 'to review',
  unknown: 'not found',
  none_expected: 'not looked up',
  not_found: 'not followed to a recording',
  miss: 'matched wrongly'
};

/** Per labeled source: how the labeled books came out. */
export function onlineGateLines(g: AudioOnlineGate | null | undefined): string[] {
  if (!g) return [];
  if (g.error) return [`The labeled books can’t be read: ${g.error}`];
  return Object.entries(g.bySource).map(
    ([source, outcomes]) =>
      `Labeled ${storeName(source)}: ${Object.entries(outcomes)
        .map(([o, v]) => `${n(v)} ${OUTCOMES[o] ?? o}`)
        .join(', ')}`
  );
}

export function onlineMissLine(m: AudioOnlineGateBook): string {
  return `${m.id} ${m.title ?? ''}: labeled ${m.expected}, found ${m.got}${m.note ? ` (${m.note})` : ''}`;
}

/** "9:58:44" for a length in seconds. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '–';
  const t = Math.round(seconds);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** One check's line on the review page: "Length: file 9:58:44, store 9:57:00 (+1.7 min) ✓". */
export function checkLine(
  name: string,
  c: { ok: boolean; unknown?: boolean; file: unknown; store: unknown; detail?: string }
): string {
  const label: Record<string, string> = {
    title: 'Title',
    author: 'Author',
    volume: 'Volume',
    runtime: 'Length',
    narrator: 'Narrator'
  };
  const v = (x: unknown) =>
    x === null || x === undefined || (Array.isArray(x) && x.length === 0)
      ? '–'
      : name === 'runtime' && typeof x === 'number'
        ? clock(x)
        : Array.isArray(x)
          ? x.join(', ')
          : String(x);
  const mark = c.unknown ? '(not known on one side)' : c.ok ? '✓' : '✗';
  return `${label[name] ?? name}: file ${v(c.file)}, store ${v(c.store)}${c.detail ? ` (${c.detail})` : ''} ${mark}`;
}

/** Stage 4's settings on the Settings tab (every threshold is a user setting). */
export const ONLINE_FIELDS: {
  key:
    | 'onlineRuntimeMinutes'
    | 'onlineTitleScore'
    | 'onlineSearchProducts'
    | 'onlineStorePages'
    | 'onlineOpeningSeconds';
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  {
    key: 'onlineRuntimeMinutes',
    label: 'A store’s length agrees within (minutes)',
    min: 0,
    max: 60,
    step: 0.5
  },
  {
    key: 'onlineTitleScore',
    label: 'Titles agree at a score of (0.3–1)',
    min: 0.3,
    max: 1,
    step: 0.01
  },
  {
    key: 'onlineSearchProducts',
    label: 'Audible records read per search',
    min: 1,
    max: 10,
    step: 1
  },
  {
    key: 'onlineStorePages',
    label: 'kikubon / audiobook.jp product pages read per search',
    min: 1,
    max: 10,
    step: 1
  },
  {
    key: 'onlineOpeningSeconds',
    label: 'Opening compared with a store’s sample audio (s; at least 360 are read)',
    min: 30,
    max: 900,
    step: 1
  }
];

/** The folders without a store record, one per line on the Settings tab. */
export function foldersFromText(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}
