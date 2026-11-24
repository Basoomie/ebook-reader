/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Manga part A on /cleanup: the card "Move manga to the manga library" (its words, lines and
 * bar). Pure: the server's answers in, text out.
 */

export type MoveMode = 'off' | 'analyse' | 'on';
export type MovePhase = 'select' | 'spot' | 'write' | 'done';
export type MoveHold = 'real_text' | 'no_epub' | 'no_count' | 'too_long' | 'not_in_reader';

export interface MoveStatus {
  mode: MoveMode;
  pausedReason: string | null;
  pausedDetail: string | null;
  analysisId: string;
  progress: {
    run: number;
    phase: MovePhase;
    counts: {
      tagged: number;
      auto: number;
      held: Partial<Record<MoveHold, number>>;
      withData: number;
      alreadyMoved: number;
    };
    write: { batches: string[]; waiting: string | null; startedAt: number | null };
    finishedAt: number | null;
    error: string | null;
  };
  bar: { label: string; done: number; total: number; leftMs: number | null } | null;
  proposals: Record<string, number>;
  moved: number;
  spot: { total: number; right: number; wrong: number; open: number };
  spotPassed: boolean;
  target: {
    id?: string;
    folder: string;
    name?: string;
    enabled?: boolean;
    language?: string | null;
    calibreLibrary?: string | null;
    missing?: boolean;
  };
  source: { id: string; folder: string | null } | null;
}

export interface MoveBook {
  changeId: number;
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  series: string | null;
  tags: string[];
  matched: string[];
  formats: string[];
  chars: number | null;
  hold: MoveHold | null;
  holdText: string | null;
  holdDetail: string | null;
  readerBookId: string | null;
  readerHasData: boolean;
  state: string;
  klass: string;
  decidedBy: string | null;
  verdict?: 'right' | 'wrong' | null;
}

export const MOVE_MODE_LABELS: Record<MoveMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const MOVE_HINTS: Record<MoveMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Preview: finds the books tagged マンガ or 画像のみ, holds the ones that look like text, and draws 30 for the spot check. Nothing is changed in Calibre.',
  on: 'Moves the books to the manga library in batches: each is added there with every field and checked, then removed here the usual way. Your reading data stays with each book. Undo per batch in the batches list.'
};

export const MOVE_PHASES: Record<MovePhase, string> = {
  select: 'Finding the books',
  spot: 'The spot check',
  write: 'Moving the books',
  done: 'Done'
};

export const MOVE_HOLDS: { hold: MoveHold; label: string }[] = [
  { hold: 'real_text', label: 'Real text' },
  { hold: 'no_epub', label: 'No EPUB' },
  { hold: 'no_count', label: 'Not counted' },
  { hold: 'too_long', label: 'Name too long' },
  { hold: 'not_in_reader', label: 'Not in the reader' }
];

const n = (x: number) => x.toLocaleString('en-US');

/** The card's lines: what was found, what was moved, what the move waits for. */
export function moveLines(s: MoveStatus | null): string[] {
  if (!s || s.mode === 'off') return [];
  const p = s.progress;
  const out: string[] = [];
  if (p.error) out.push(`Stopped: ${p.error}`);
  if (s.target.missing)
    out.push(`The reader has no library in the folder "${s.target.folder}" yet.`);
  else if (s.target.enabled === false || !s.target.language)
    out.push(
      `Switch the library "${s.target.folder}" on in the reader (with its language) before On.`
    );
  if (p.phase !== 'select') {
    const held = Object.values(p.counts.held).reduce((a, b) => a + (b ?? 0), 0);
    out.push(
      `${n(p.counts.tagged)} books tagged マンガ or 画像のみ: ${n(p.counts.auto)} to move, ${n(held)} held for you to look at.`
    );
    if (p.counts.withData > 0)
      out.push(
        `${n(p.counts.withData)} of them have your reading data; it stays with each book (the same book in the reader).`
      );
  }
  const left = (s.proposals['auto:proposed'] ?? 0) + (s.proposals['auto:queued'] ?? 0);
  if (s.moved > 0 || (s.mode === 'on' && left > 0))
    out.push(`Moved: ${n(s.moved)}${left > 0 ? `, ${n(left)} to move` : ''}.`);
  if (s.spot.total > 0 && p.phase !== 'write' && p.phase !== 'done') out.push(spotLine(s));
  return out;
}

/** The spot check's line (On waits for it). */
export function spotLine(s: MoveStatus): string {
  const c = s.spot;
  if (s.spotPassed) return `Spot check passed: ${n(c.right)} of ${n(c.total)} marked right.`;
  if (c.wrong > 0)
    return `Spot check: ${n(c.wrong)} marked wrong. On stays off until none is wrong.`;
  return `Spot check: ${n(c.total - c.open)} of ${n(c.total)} marked. Mark every book before On.`;
}

/** The bar: label, fraction and the time left. */
export function moveBar(
  s: MoveStatus | null
): { label: string; fraction: number; eta: string | null } | null {
  const b = s?.bar;
  if (!b || b.total <= 0) return null;
  const mins = b.leftMs === null ? null : Math.ceil(b.leftMs / 60000);
  return {
    label: `Moving the books: ${n(b.done)} of ${n(b.total)}`,
    fraction: Math.min(1, b.done / b.total),
    eta: mins === null ? null : mins <= 1 ? 'about a minute left' : `about ${n(mins)} minutes left`
  };
}

/** A book's line: title, authors, its count and formats. */
export function moveBookLine(b: MoveBook): string {
  const parts = [
    b.title,
    b.authors.length ? b.authors.slice(0, 2).join(', ') : null,
    b.chars === null ? null : `${n(b.chars)} characters`,
    b.formats.length ? b.formats.join(', ') : null
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Why a book is held, with its detail. */
export function holdLine(b: MoveBook): string {
  if (b.state === 'kept') return 'Kept here (your choice)';
  if (b.decidedBy === 'you' && b.klass === 'auto') return 'Moved anyway (your choice)';
  return [b.holdText, b.holdDetail].filter(Boolean).join(': ');
}
