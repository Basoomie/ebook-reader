/**
 * Book summaries: readings from an offline dictionary (kuromoji with its IPAdic, in the server's
 * own files; nothing leaves the server), for a heading's name or term that the book itself prints
 * without furigana (agreed with the user 2026-11-23). The book's own ruby always comes first
 * (RubyIndex); the dictionary only fills what the book leaves out.
 *
 * Words the dictionary doesn't know (most invented names) get no reading from it: kuromoji marks
 * them with the reading "*", and they stay plain.
 */
import path from 'path';
import kuromoji from 'kuromoji';
import type { RubyPiece } from './book-text';

const KANJI = /[\p{Unified_Ideograph}々〆ヶ]/u;

type Tokenizer = kuromoji.Tokenizer<kuromoji.IpadicFeatures>;
let loading: Promise<Tokenizer | null> | null = null;

/** The dictionary, loaded once (about a second); null when it can't be loaded. */
export function japaneseDictionary(): Promise<Tokenizer | null> {
  loading ??= new Promise((resolve) => {
    const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err) {
        console.error('Summaries: the reading dictionary could not be loaded:', err);
        resolve(null);
      } else resolve(tokenizer);
    });
  });
  return loading;
}

/** Katakana to hiragana (readings are shown in hiragana, as most books print furigana). */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * A word split into pieces with readings from the dictionary: each kanji token gets its reading,
 * with the kana it shares with the reading at its ends left outside the ruby (白い: 白(しろ)い).
 * Null when no kanji token has a reading.
 */
export function dictionaryPieces(tokenizer: Tokenizer, word: string): RubyPiece[] | null {
  const out: RubyPiece[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.r === undefined) last.t += t;
    else out.push({ t });
  };
  let any = false;
  for (const tok of tokenizer.tokenize(word)) {
    const surface = tok.surface_form;
    const reading = tok.reading && tok.reading !== '*' ? toHiragana(tok.reading) : null;
    // A lone kanji the dictionary split out of a word it doesn't know (翠 of 翠龍師団, 帝 of a
    // name) gets a guessed reading: only whole words count (two kanji or more, or a kanji with its
    // kana ending, 白い).
    const kanji = [...surface].filter((c) => KANJI.test(c)).length;
    const lone = kanji === 1 && [...surface].every((c) => KANJI.test(c));
    if (!KANJI.test(surface) || !reading || lone) {
      plain(surface);
      continue;
    }
    // Kana at both ends of the surface that the reading repeats stay outside the ruby.
    const s = [...surface];
    const r = [...reading];
    let head = 0;
    while (head < s.length - 1 && !KANJI.test(s[head]) && toHiragana(s[head]) === r[head]) head++;
    let tail = 0;
    while (
      tail < s.length - head - 1 &&
      !KANJI.test(s[s.length - 1 - tail]) &&
      toHiragana(s[s.length - 1 - tail]) === r[r.length - 1 - tail]
    )
      tail++;
    const core = s.slice(head, s.length - tail).join('');
    const coreReading = r.slice(head, r.length - tail).join('');
    if (!coreReading) {
      plain(surface);
      continue;
    }
    plain(s.slice(0, head).join(''));
    out.push({ t: core, r: coreReading });
    plain(s.slice(s.length - tail).join(''));
    any = true;
  }
  return any ? out : null;
}
