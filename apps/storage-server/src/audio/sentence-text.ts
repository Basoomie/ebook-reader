/**
 * Season 2 Phase 12: the text the PC reads for an Enrich sentence clip (decided with the
 * user, 2026-11-15): exactly the sentence Enrich put in the card (the lookup's sentence or
 * the user's selection, which may hold several sentences), found in the book's script by
 * its text near its position, so the book's own furigana is kept (the script's ruby runs).
 * The pronunciation fixes are applied afterwards (tts-jobs.ts), then the PC's kana step.
 *
 * - The Enrich sentence and the script both come from the reader's text index
 *   (buildBookTextIndex: furigana and hidden text left out), so the characters are the same;
 *   only line breaks and spaces may differ (a selection across paragraphs has "\n"). Matching
 *   leaves every whitespace character out on both sides.
 * - Of several places with the same text, the one whose position is nearest wins.
 * - The first and last script sentences are cut to the span; a furigana run that the cut
 *   crosses is dropped (its kanji are then read by SudachiPy). A whole sentence keeps its
 *   reading exactly as the script has it.
 * - Not found (the book's file changed since the tap): the text as it is, without furigana.
 *
 * Pure code, no server imports.
 */
import { buildReading, type RubyRun } from '../pronunciation/fix-rules';

/** A script sentence as book-script.ts makes it (the fields used here). */
export interface SourceSentence {
  text: string;
  reading: string;
  ruby?: RubyRun[];
  position: number;
  paragraphEnd: boolean;
}

/** One piece the PC reads (a script sentence, or the part of one inside the span). */
export interface ClipSentence {
  text: string;
  reading: string;
  ruby: RubyRun[];
  position: number;
  paragraphEnd: boolean;
}

export interface ClipText {
  sentences: ClipSentence[];
  /** Whether the text was found in the book (false: read as it is, without furigana). */
  found: boolean;
}

const SPACE = /\s/u;

/** The text without any whitespace (how both sides are compared). */
export function squeeze(text: string): string {
  let out = '';
  for (const ch of text) if (!SPACE.test(ch)) out += ch;
  return out;
}

/** The text's pieces between line breaks, spaces folded (the not-found case). */
function plainSentences(text: string, position: number): ClipSentence[] {
  const lines = text
    .split(/\r?\n/u)
    .map((l) => l.replace(/\s+/gu, ' ').trim())
    .filter((l) => l !== '');
  // Each line was its own paragraph in the book.
  return lines.map((line) => ({
    text: line,
    reading: line,
    ruby: [],
    position,
    paragraphEnd: true,
  }));
}

/**
 * The clip's sentences for `text` (the Enrich sentence) at reader position `position`,
 * from the book's script sentences in reading order.
 */
export function clipText(source: SourceSentence[], text: string, position: number): ClipText {
  const wanted = squeeze(text);
  if (wanted === '') return { sentences: [], found: false };
  // The script without whitespace, and where each of its characters (UTF-16 units) is.
  const units: number[] = [];
  const owner: number[] = [];
  let flat = '';
  source.forEach((s, k) => {
    for (let j = 0; j < s.text.length; j++) {
      const c = s.text[j];
      // A surrogate pair stays together: both units are kept or left out with it.
      if (SPACE.test(c)) continue;
      flat += c;
      units.push(j);
      owner.push(k);
    }
  });
  let best = -1;
  let bestDistance = Infinity;
  for (let at = flat.indexOf(wanted); at >= 0; at = flat.indexOf(wanted, at + 1)) {
    const distance = Math.abs(source[owner[at]].position - position);
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
  }
  if (best < 0) return { sentences: plainSentences(text, position), found: false };

  const first = owner[best];
  const last = owner[best + wanted.length - 1];
  const sentences: ClipSentence[] = [];
  for (let k = first; k <= last; k++) {
    const s = source[k];
    const start = k === first ? units[best] : 0;
    const end = k === last ? units[best + wanted.length - 1] + 1 : s.text.length;
    const piece = s.text.slice(start, end);
    if (squeeze(piece) === '') continue;
    const whole = start === 0 && end === s.text.length;
    const ruby = (s.ruby ?? [])
      .filter((r) => r.start >= start && r.end <= end)
      .map((r) => ({ start: r.start - start, end: r.end - start, rt: r.rt }));
    sentences.push({
      text: piece,
      reading: whole ? s.reading : buildReading({ text: piece, reading: piece, ruby }, []),
      ruby,
      position: s.position,
      paragraphEnd: k === last ? true : s.paragraphEnd,
    });
  }
  return { sentences, found: true };
}
