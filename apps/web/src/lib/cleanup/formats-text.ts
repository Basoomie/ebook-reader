/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { etaText } from './cleanup-text';

/**
 * Books without an EPUB on /cleanup: the card "Books without an EPUB" (its words, lines and bars).
 * Pure: the server's answers in, text out.
 */

export type FormatsMode = 'off' | 'analyse' | 'on';
export type FormatsPhase = 'select' | 'convert' | 'compare' | 'propose' | 'spot' | 'write' | 'done';
export type FormatsList = 'listed' | 'review' | 'fold' | 'convert' | 'all';

export interface FormatsBar {
  phase: string;
  label: string;
  done: number;
  total: number;
  leftMs: number | null;
  note: string | null;
}

export interface FormatsStatus {
  mode: FormatsMode;
  pausedReason: string | null;
  pausedDetail: string | null;
  analysisId: string;
  progress: {
    run: number;
    phase: FormatsPhase;
    write: { batches: string[]; waiting: string | null; startedAt: number | null };
    finishedAt: number | null;
    error: string | null;
  };
  bars: FormatsBar[];
  counts: {
    byState: Record<string, number>;
    listed: Record<string, number>;
    proposals: Record<string, number>;
    written: { convert: number; fold: number; undone: number };
    stored: Record<string, number>;
  } | null;
  listedText: Record<string, string>;
  spot: { total: number; right: number; wrong: number; open: number };
  spotPassed: boolean;
  sidecar: { ready: boolean; need: string };
  library: { id: string; folder: string | null } | null;
}

export interface FormatsBook {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  formats: string[];
  sourceFormat: string | null;
  state: string;
  listedReason: string | null;
  detail: string | null;
  kind: string | null;
  method: string | null;
  group: string | null;
  sourceChars: number | null;
  epubChars: number | null;
  readerChars: number | null;
  sourceImages: number | null;
  epubImages: number | null;
  epubSize: number | null;
  checkReason: string | null;
  verdict: string | null;
  reason: string | null;
  twin: { calibreId: number; title: string } | null;
  change: {
    id: number;
    state: string;
    klass: string;
    field: string;
    reason: string | null;
    decidedBy: string | null;
  } | null;
  hasEpub: boolean;
  mark?: 'right' | 'wrong' | null;
}

export const FORMATS_MODE_LABELS: Record<FormatsMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const FORMATS_HINTS: Record<FormatsMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Preview: the sidecar converts each book without an EPUB in its own folder (nothing is written to Calibre), the reader checks every EPUB, copies of EPUB books are compared by their text, and 30 converted books are drawn for the spot check.',
  on: 'Adds each checked EPUB to its own Calibre book (the original file stays) and folds proven copies into their EPUB book (the copy’s file kept there, the copy removed the usual way). The next new-arrivals run takes the converted books in. Undo per batch in the batches list.'
};

export const FORMATS_PHASES: Record<FormatsPhase, string> = {
  select: 'Finding the books',
  convert: 'Converting and checking the books',
  compare: 'Comparing copies with their EPUB books',
  propose: 'Making the proposals',
  spot: 'The spot check',
  write: 'Writing to Calibre',
  done: 'Done'
};

export const FORMATS_GROUPS: Record<string, string> = {
  text: 'text book',
  picture: 'picture book',
  extracted: 'EPUB taken out of an archive',
  rebuilt: 'rebuilt by calibre'
};

const n = (x: number) => x.toLocaleString('en-US');
/** "1 copy", "2 copies". */
const count = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;

/** A bar's line: "Converted 120 of 1,066 · about 3 h left". */
export function barLine(b: FormatsBar): string {
  const left = b.done >= b.total ? null : b.leftMs === null ? null : etaText(Math.max(0, b.leftMs));
  return `${b.label}: ${n(b.done)} of ${n(b.total)}${left ? ` · ${left}` : ''}`;
}

export function barFraction(b: FormatsBar): number {
  return b.total > 0 ? Math.min(1, b.done / b.total) : 0;
}

/** The card's lines: what was found, what is proposed, what was written. */
export function formatsLines(s: FormatsStatus | null): string[] {
  if (!s || !s.counts) return [];
  const out: string[] = [];
  const p = s.progress;
  if (p.error) out.push(`Stopped: ${p.error}`);
  if (!s.sidecar.ready)
    out.push(
      `The cleanup sidecar must be ${s.sidecar.need} or newer (rebuild ttsu-cleanup-apply) before books are converted.`
    );
  const c = s.counts;
  const books = Object.values(c.byState).reduce((a, x) => a + x, 0);
  const listed = c.byState.listed ?? 0;
  if (books > 0)
    out.push(
      `${n(books)} books without an EPUB: ${n(books - listed)} to convert or compare, ${n(listed)} listed and left.`
    );
  const prop = (field: string, klass: string) =>
    Object.entries(c.proposals)
      .filter(([k]) => k.startsWith(`${field}:${klass}:`))
      .reduce((a, [k, v]) => a + (k.endsWith(':proposed') || k.endsWith(':queued') ? v : 0), 0);
  const convert = prop('epub', 'auto');
  const fold = prop('fold', 'auto');
  const review = prop('fold', 'review');
  if (convert + fold + review > 0)
    out.push(
      `To write: ${count(convert, 'EPUB for its own book', 'EPUBs for their own books')}, ${count(fold, 'copy folded into its EPUB book', 'copies folded into their EPUB book')}; ${count(review, 'near copy', 'near copies')} for you to look at.`
    );
  if (c.written.convert + c.written.fold + c.written.undone > 0)
    out.push(
      `Written: ${count(c.written.convert, 'EPUB', 'EPUBs')} added, ${count(c.written.fold, 'copy', 'copies')} folded${c.written.undone ? `, ${n(c.written.undone)} undone` : ''}.`
    );
  if (s.spot.total > 0 && p.phase !== 'write' && p.phase !== 'done')
    out.push(
      s.spotPassed
        ? `The spot check passed (${n(s.spot.right)} right, ${n(s.spot.wrong)} wrong): On can be switched on.`
        : `The spot check: ${n(s.spot.total - s.spot.open)} of ${n(s.spot.total)} marked${s.spot.wrong ? `, ${n(s.spot.wrong)} wrong` : ''}. On waits for every book marked and none wrong.`
    );
  return out;
}

/** "AZW3 → EPUB · text 210,741 of 210,792 characters · 15 pictures". */
export function bookFacts(b: FormatsBook): string {
  const parts: string[] = [];
  if (b.sourceFormat) parts.push(`${b.sourceFormat} → EPUB`);
  if (b.group) parts.push(FORMATS_GROUPS[b.group] ?? b.group);
  if (b.sourceChars !== null && b.epubChars !== null && b.sourceChars > 0)
    parts.push(`text ${n(b.epubChars)} of ${n(b.sourceChars)} characters`);
  if (b.readerChars !== null) parts.push(`the reader counts ${n(b.readerChars)}`);
  if (b.epubImages !== null)
    parts.push(
      b.sourceImages !== null
        ? `${n(b.epubImages)} pictures (${n(b.sourceImages)} in the archive)`
        : `${n(b.epubImages)} pictures`
    );
  if (b.epubSize !== null) parts.push(`${(b.epubSize / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
}

export function bookLine(b: FormatsBook): string {
  return `${b.title}${b.authors.length ? ` — ${b.authors.join(', ')}` : ''} (Calibre #${b.calibreId})`;
}
