/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  CleanupStage,
  FieldEvidence,
  FieldPause,
  Proposal,
  Stage2Status,
  StageMode
} from './cleanup-api';
import { eta, n, paceEta, type ProgressBar } from './cleanup-text';

/** Plain wording for stage 2 on the /cleanup page (WP20b): metadata and covers from the files. */

export const STAGE2_MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Reads each book’s own file and lists what it would change; nothing in Calibre is changed.',
  on:
    'Writes titles, authors, covers and more from the books’ own files into Calibre in batches on ' +
    'its own, behind the safety checks and the check on the labeled books.'
};

export const FIELDS = [
  'title',
  'authors',
  'cover',
  'identifiers',
  'publisher',
  'languages',
  'illustrator'
];

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  authors: 'Authors',
  cover: 'Cover',
  identifiers: 'Amazon id',
  publisher: 'Publisher',
  languages: 'Language',
  illustrator: 'Illustrator'
};

export function fieldLabel(field: string | undefined): string {
  return field ? (FIELD_LABELS[field] ?? field) : '';
}

const SOURCE_TEXT: Record<string, string> = {
  'file-unconfirmed': 'From the book’s file (not confirmed yet)',
  file: 'From the book’s file',
  normalize: 'Calibre’s own value, tidied'
};

export function sourceText(source: string | undefined): string {
  return source ? (SOURCE_TEXT[source] ?? source) : '';
}

/** A field's value in words ("(none)" when empty). */
export function valueText(field: string | undefined, value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (field === 'cover') {
    const v = value as { width?: number | null; height?: number | null };
    return v.width && v.height ? `a picture of ${v.width} × ${v.height}` : 'a picture';
  }
  if (field === 'identifiers') {
    const entries = Object.entries(value as Record<string, string>);
    return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join(', ') : '(none)';
  }
  if (Array.isArray(value))
    return value.length ? value.join(field === 'authors' ? ' & ' : ', ') : '(none)';
  if (typeof value === 'string') return value === '' ? '(none)' : value;
  return String(value);
}

export function fieldEvidence(p: Proposal): FieldEvidence | null {
  const ev = p.evidence;
  return ev && 'group' in ev ? ev : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The analysis' progress bar: reading each book's file, then working out the changes. */
export function stage2Progress(stage: CleanupStage, now = Date.now()): ProgressBar | null {
  const p = stage.progress as Record<string, unknown>;
  if (!p || stage.mode === 'off') return null;
  const started = typeof p.phaseStartedAt === 'number' ? p.phaseStartedAt : null;
  if (p.phase === 'read') {
    const total = num(p.readTotal);
    if (total <= 0) return null;
    if (p.pass === 'labeled') {
      return { label: 'Step 1 of 2 · Reading the labeled books first', fraction: 0, eta: null };
    }
    const done = num(p.readDone);
    return {
      label: `Step 1 of 2 · Reading each book’s file: ${n(done)} of ${n(total)} books`,
      fraction: Math.min(1, done / total),
      eta: eta(done, total, started, num(p.phaseStartDone), now)
    };
  }
  if (p.phase === 'propose') {
    const total = num(p.readTotal);
    const done = num(p.proposeDone);
    if (total <= 0) return null;
    return {
      label: `Step 2 of 2 · Working out the changes: ${n(done)} of ${n(total)} books`,
      fraction: Math.min(1, done / total),
      eta: eta(done, total, started, num(p.phaseStartDone), now)
    };
  }
  return null;
}

/** Writing into Calibre once stage 2 is on: books written of the books with changes. */
export function stage2ApplyProgress(
  stage: CleanupStage,
  s: Stage2Status | undefined,
  now = Date.now()
): ProgressBar | null {
  if (!s || stage.mode !== 'on') return null;
  const total = num((stage.progress as Record<string, unknown>).booksWithChanges);
  const left = Math.min(total, s.booksLeft);
  const done = total - left;
  if (total <= 0 || left <= 0) return null;
  return {
    label: `Writing into Calibre: ${n(done)} of ${n(total)} books`,
    fraction: done / total,
    eta: paceEta(left, { removed: s.pace.written, firstAt: s.pace.firstAt }, now)
  };
}

/** The lines under stage 2's name once the analysis has run. */
export function stage2Lines(stage: CleanupStage): string[] {
  const p = stage.progress as Record<string, unknown>;
  if (!p || typeof p.phase !== 'string') return stage.mode === 'off' ? [] : ['Waiting to start.'];
  if (p.phase !== 'done') return [];
  if (p.error) return [`The analysis stopped: ${String(p.error)}`];
  const lines = [
    `Read ${n(p.books)} books: ${n(p.booksWithChanges)} get changes written automatically.`
  ];
  const fields = (p.fields ?? {}) as Record<string, { auto?: number; review?: number }>;
  const parts = FIELDS.filter((f) => fields[f]?.auto).map(
    (f) => `${fieldLabel(f).toLowerCase()} ${n(fields[f].auto)}`
  );
  if (parts.length) lines.push(`Changes by field: ${parts.join(' · ')}.`);
  const review = FIELDS.reduce((a, f) => a + num(fields[f]?.review), 0);
  if (review)
    lines.push(
      `${n(review)} wait for your review (Calibre has its own value, or the file’s looks wrong).`
    );
  if (num(p.folderMoves)) {
    lines.push(
      `${n(p.folderMoves)} books get a new title or first author, so Calibre moves their folders.`
    );
  }
  if (num(p.readErrors)) lines.push(`${n(p.readErrors)} files couldn’t be read and were left out.`);
  if (num(p.calibreUnknownJa)) {
    lines.push(
      `${n(p.calibreUnknownJa)} books have the author “不明” in Calibre (treated as Unknown).`
    );
  }
  return lines;
}

export interface GateRow {
  label: string;
  right: string;
  calibre: string | null;
  bar: string;
  ok: boolean | null;
}

const pctText = (part: number, whole: number) =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)} %` : '–';

/** The check on the labeled books, as table rows (titles per group, authors, illustrators). */
export function gateRows(
  stage: CleanupStage,
  bars: { title: number; margin: number; authors: number } | null
): GateRow[] {
  const gate = (stage.precision as { gate?: any } | undefined)?.gate;
  if (!gate) return [];
  const t = gate.score?.title ?? {};
  const a = gate.score?.authors ?? {};
  const rows: GateRow[] = [];
  const titleOk = gate.fields?.title?.ok ?? null;
  for (const [g, words] of [
    ['unknown', 'Titles · author “Unknown” in Calibre'],
    ['processed', 'Titles · tagged metadata-processed'],
    ['agree', 'Titles · Calibre and the file agree']
  ] as const) {
    const x = t[g];
    if (!x?.n) continue;
    rows.push({
      label: `${words} (${n(x.n)} books)`,
      right: pctText(x.applied, x.n),
      calibre: pctText(x.calibre, x.n),
      bar: bars
        ? g === 'agree'
          ? `≥ ${bars.title} %`
          : `≥ ${bars.title} %, ${bars.margin} points above Calibre`
        : '',
      ok: titleOk
    });
  }
  let an = 0;
  let ar = 0;
  for (const g of ['unknown', 'processed', 'agree']) {
    an += num(a[g]?.n);
    ar += num(a[g]?.applied);
  }
  if (an) {
    rows.push({
      label: `Authors (${n(an)} books)`,
      right: pctText(ar, an),
      calibre: null,
      bar: bars ? `≥ ${bars.authors} %` : '',
      ok: gate.fields?.authors?.ok ?? null
    });
  }
  const il = gate.score?.illustrator;
  if (il?.n)
    rows.push({
      label: `Illustrators (${n(il.n)} books)`,
      right: pctText(il.applied, il.n),
      calibre: null,
      bar: 'shown only',
      ok: null
    });
  return rows;
}

const FIELD_PAUSE_TEXT: Record<string, string> = {
  gate: 'below its bar on the labeled books',
  no_labels: 'the labeled books can’t be read',
  review_alarm: 'far more books need review than in the labeled books',
  failures: 'writes failed'
};

export function fieldPauseTitle(p: FieldPause): string {
  return `${fieldLabel(p.field)} paused: ${FIELD_PAUSE_TEXT[p.reason] ?? p.reason}`;
}

/** A gate pause lifts by itself after a new analysis that passes; the others are resumed by hand. */
export function fieldPauseResumable(p: FieldPause): boolean {
  return p.reason !== 'gate' && p.reason !== 'no_labels';
}

/** One line per field: "Title: 30,000 to write · 1,200 written · 52 in review · 3 skipped". */
export function stage2CountLines(s: Stage2Status | undefined): string[] {
  if (!s) return [];
  const by = new Map<string, Record<string, number>>();
  for (const c of s.counts) {
    const m = by.get(c.field) ?? {};
    const key = c.class === 'review' && c.state === 'proposed' ? 'review' : c.state;
    m[key] = (m[key] ?? 0) + c.n;
    by.set(c.field, m);
  }
  const out: string[] = [];
  for (const f of FIELDS) {
    const m = by.get(f);
    if (!m) continue;
    const parts: string[] = [];
    const toWrite = (m.proposed ?? 0) + (m.queued ?? 0);
    if (toWrite) parts.push(`${n(toWrite)} to write`);
    if (m.applied) parts.push(`${n(m.applied)} written`);
    if (m.review) parts.push(`${n(m.review)} in review`);
    if (m.kept) parts.push(`${n(m.kept)} kept as they were`);
    if (m.undone) parts.push(`${n(m.undone)} put back`);
    if (m.skipped) parts.push(`${n(m.skipped)} skipped`);
    if (parts.length) out.push(`${fieldLabel(f)}: ${parts.join(' · ')}`);
  }
  return out;
}

const STATE_TEXT: Record<string, string> = {
  proposed: 'To write',
  queued: 'In a batch',
  applied: 'Written',
  kept: 'Kept as it was',
  undone: 'Put back',
  skipped: 'Skipped',
  pending: 'Waiting',
  verified: 'Checked',
  written: 'Written in Calibre',
  restored: 'Put back',
  failed: 'Failed'
};

export function fieldStateText(state: string, cls?: string): string {
  if (state === 'proposed' && cls === 'review') return 'Waiting for your review';
  return STATE_TEXT[state] ?? state;
}
