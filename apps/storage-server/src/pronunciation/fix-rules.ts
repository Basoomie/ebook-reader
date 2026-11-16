/**
 * Season 2 Phase 12: pronunciation fixes for everything the PC voices read (decided with
 * the user, 2026-11-14/15). A fix is a plain word or a JavaScript regex pattern (Unicode
 * mode), and the reading to say instead. Fixes are applied on the server, before the PC's
 * kana step (the book's own furigana is already in the sentence's reading; SudachiPy then
 * converts the kanji that are left, on the PC).
 *
 * - Matches are looked for in the sentence as shown (`text`), anywhere in it; a pattern sees
 *   one sentence at a time (`^` and `$` are its ends).
 * - The book's list claims its matches first; the global list fills only the text left.
 *   Within a list: the leftmost match, then the longer one, then the older entry. A fix's
 *   reading is never matched again.
 * - The book's own furigana wins: a match that touches text read by its furigana is skipped
 *   there (and counted as skipped).
 * - A sentence without a match keeps its reading exactly; one with a match gets its reading
 *   rebuilt from the text, the furigana runs and the fixes' readings.
 *
 * Pure code without imports from the server: the time-limited worker thread runs it
 * (fix-worker.ts), and the save checks use it.
 */

export type FixKind = 'word' | 'pattern';

export interface FixEntry {
  id: number;
  /** null = the global list. */
  bookId: string | null;
  kind: FixKind;
  match: string;
  reading: string;
  createdAt: number;
}

export interface RubyRun {
  start: number;
  end: number;
  rt: string;
}

/** A sentence as book-script.ts makes it (text as shown, reading, furigana runs). */
export interface FixSentence {
  text: string;
  reading: string;
  ruby?: RubyRun[];
}

export interface FixHit {
  entryId: number;
  start: number;
  end: number;
  /** The reading said there (a pattern's `$1`… filled in). */
  reading: string;
}

export interface SentenceResult {
  /** The reading with the fixes in it; absent when nothing matched (keep `reading`). */
  reading?: string;
  hits: FixHit[];
  /** Entries whose match touched the book's furigana (one per place). */
  skipped: number[];
}

export const FIX_LIMITS = {
  wordMax: 100,
  patternMax: 200,
  readingMax: 200,
  entriesPerList: 1000,
} as const;

export class FixRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entry's regex (global, Unicode). */
export function entryRegExp(entry: Pick<FixEntry, 'kind' | 'match'>): RegExp {
  return new RegExp(entry.kind === 'word' ? escapeRegExp(entry.match) : entry.match, 'gu');
}

const REF = /\$(\$|&|\d{1,2}|<([^>]*)>)/g;

/**
 * Checks an entry before it is saved; returns it trimmed. Throws FixRuleError with a plain
 * message (shown under the field).
 */
export function checkEntry(input: { kind: unknown; match: unknown; reading: unknown }): {
  kind: FixKind;
  match: string;
  reading: string;
} {
  const kind = input.kind === 'pattern' ? 'pattern' : input.kind === 'word' ? 'word' : null;
  if (!kind) throw new FixRuleError('invalid_kind', 'Choose a word or a pattern');
  const rawMatch = typeof input.match === 'string' ? input.match : '';
  // A pattern keeps its spaces (they may be meant); a word is trimmed.
  const match = kind === 'word' ? rawMatch.trim() : rawMatch;
  const reading = typeof input.reading === 'string' ? input.reading.trim() : '';

  if (kind === 'word') {
    if (!match) throw new FixRuleError('invalid_match', 'Type the word to fix');
    if (match.length > FIX_LIMITS.wordMax)
      throw new FixRuleError(
        'invalid_match',
        `A word can have at most ${FIX_LIMITS.wordMax} characters`,
      );
    if (/[\r\n]/.test(match)) throw new FixRuleError('invalid_match', 'A word must be on one line');
  }
  let groups = 0;
  let names: string[] = [];
  if (kind === 'pattern') {
    if (!match.trim()) throw new FixRuleError('invalid_match', 'Type the pattern');
    if (match.length > FIX_LIMITS.patternMax)
      throw new FixRuleError(
        'invalid_match',
        `A pattern can have at most ${FIX_LIMITS.patternMax} characters`,
      );
    let re: RegExp;
    try {
      re = new RegExp(match, 'u');
    } catch (err) {
      throw new FixRuleError(
        'invalid_pattern',
        `This pattern isn't valid: ${(err as Error).message.replace(/^Invalid regular expression: /, '')}`,
      );
    }
    if (re.test('')) {
      throw new FixRuleError(
        'empty_match',
        'This pattern also matches empty text; make it match at least one character',
      );
    }
    // The groups the pattern has: an alternative that matches '' reports them all.
    const probe = new RegExp(`${match}|`, 'u').exec('')!;
    groups = probe.length - 1;
    names = Object.keys(probe.groups ?? {});
  }

  if (!reading) throw new FixRuleError('invalid_reading', 'Type how it should be read');
  if (reading.length > FIX_LIMITS.readingMax)
    throw new FixRuleError(
      'invalid_reading',
      `A reading can have at most ${FIX_LIMITS.readingMax} characters`,
    );
  if (/[\r\n]/.test(reading))
    throw new FixRuleError('invalid_reading', 'A reading must be on one line');
  if (kind === 'pattern') {
    for (const m of reading.matchAll(REF)) {
      const ref = m[1];
      if (ref === '$' || ref === '&') continue;
      if (m[2] !== undefined) {
        if (!names.includes(m[2]))
          throw new FixRuleError(
            'invalid_reading',
            `The pattern has no group named "${m[2]}" (write $$ for a $)`,
          );
      } else if (Number(ref) < 1 || Number(ref) > groups) {
        throw new FixRuleError(
          'invalid_reading',
          groups
            ? `The pattern has ${groups === 1 ? 'one group' : `${groups} groups`}; $${ref} is not one (write $$ for a $)`
            : `The pattern has no groups; $${ref} is not one (write $$ for a $)`,
        );
      }
    }
  }
  return { kind, match, reading };
}

/** A pattern's reading with `$1`, `$<name>`, `$&` and `$$` filled in; a word's as is. */
export function expandReading(
  entry: Pick<FixEntry, 'kind' | 'reading'>,
  m: RegExpExecArray | RegExpMatchArray,
): string {
  if (entry.kind === 'word') return entry.reading;
  return entry.reading.replace(REF, (_all, ref: string, name: string | undefined) => {
    if (ref === '$') return '$';
    if (ref === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    return m[Number(ref)] ?? '';
  });
}

/** Sorts a list the way it is applied: older first (created, then id). */
export function listOrder(a: FixEntry, b: FixEntry): number {
  return a.createdAt - b.createdAt || a.id - b.id;
}

interface Candidate {
  entry: FixEntry;
  order: number;
  start: number;
  end: number;
  reading: string;
}

/** Every non-empty match of one entry in each sentence (entry-major, so a slow entry is known). */
export function entryCandidates(
  entry: FixEntry,
  order: number,
  sentences: FixSentence[],
  into: Candidate[][],
): void {
  const re = entryRegExp(entry);
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i].text;
    for (const m of text.matchAll(re)) {
      if (!m[0].length) continue;
      const start = m.index ?? 0;
      (into[i] ??= []).push({
        entry,
        order,
        start,
        end: start + m[0].length,
        reading: expandReading(entry, m),
      });
    }
  }
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

/** Picks the matches of one sentence: book list first, then global; leftmost, longest, oldest. */
export function resolveSentence(
  sentence: FixSentence,
  bookCandidates: Candidate[] | undefined,
  globalCandidates: Candidate[] | undefined,
): SentenceResult {
  const ruby = sentence.ruby ?? [];
  const taken: FixHit[] = [];
  const skipped: number[] = [];
  for (const list of [bookCandidates, globalCandidates]) {
    if (!list?.length) continue;
    const sorted = [...list].sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order,
    );
    for (const c of sorted) {
      if (taken.some((t) => overlaps(t, c))) continue;
      if (ruby.some((r) => overlaps(r, c))) {
        skipped.push(c.entry.id);
        continue;
      }
      taken.push({ entryId: c.entry.id, start: c.start, end: c.end, reading: c.reading });
    }
  }
  if (!taken.length) return { hits: [], skipped };
  taken.sort((a, b) => a.start - b.start);
  return { reading: buildReading(sentence, taken), hits: taken, skipped };
}

const GAIJI_MARK = /〓/gu;

/**
 * The reading of a sentence from its text, its furigana runs and the fixes (which never
 * overlap a run). Outside both, the text as shown, gaiji marks left out: exactly what
 * book-script.ts makes when there are no fixes.
 */
export function buildReading(sentence: FixSentence, hits: FixHit[]): string {
  const parts = [
    ...(sentence.ruby ?? []).map((r) => ({ start: r.start, end: r.end, say: r.rt })),
    ...hits.map((h) => ({ start: h.start, end: h.end, say: h.reading })),
  ].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const p of parts) {
    out += sentence.text.slice(at, p.start).replace(GAIJI_MARK, '') + p.say;
    at = p.end;
  }
  return out + sentence.text.slice(at).replace(GAIJI_MARK, '');
}

/**
 * Applies both lists to the sentences. `onEntry` is called before each entry runs (the
 * worker reports it, so a pattern that runs too long can be named).
 */
export function applyFixes(
  sentences: FixSentence[],
  entries: FixEntry[],
  onEntry?: (entryId: number) => void,
): SentenceResult[] {
  const book = entries.filter((e) => e.bookId !== null).sort(listOrder);
  const global = entries.filter((e) => e.bookId === null).sort(listOrder);
  const bookC: Candidate[][] = [];
  const globalC: Candidate[][] = [];
  book.forEach((e, i) => {
    onEntry?.(e.id);
    entryCandidates(e, i, sentences, bookC);
  });
  global.forEach((e, i) => {
    onEntry?.(e.id);
    entryCandidates(e, i, sentences, globalC);
  });
  return sentences.map((s, i) => resolveSentence(s, bookC[i], globalC[i]));
}
