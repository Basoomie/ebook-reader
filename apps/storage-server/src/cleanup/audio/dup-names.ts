/**
 * Title keys for stage 3's "same title and printed volume" candidates (WP21b). Pure.
 *
 * Two names get the same key when they differ only in the decorations the sources add: TMW's
 * reading-order prefix `[NN]`, Discord's `[N巻]` tag, ASINs, `[audiobook.jp N]` / `[kikubon N]`
 * ids, a trailing `_ (出版社)`, imprint labels, widths, spacing and punctuation. What says which
 * book it is stays in the key: printed volume numbers (also `(5)`, `第3巻`, `１９`), 上/中/下,
 * subtitles. (The sample's first title grouping dropped 上/下 and bracketed numbers and paired
 * different volumes: pairs 40-79 of labels.json.)
 *
 * A key only proposes a pair; the audio fingerprints decide.
 */
import { extractVolume, stripAudioName } from '../../audio/match';

/** Imprint labels that some names carry and others don't (seen in the reference sample). */
const IMPRINTS = [
  'ガガガ文庫',
  'HJ文庫',
  '講談社文庫',
  '角川文庫',
  '新潮文庫',
  '文春文庫',
  '幻冬舎文庫',
  '集英社文庫',
  '光文社文庫',
  '双葉文庫',
  '電撃文庫',
  '富士見ファンタジア文庫',
  'MF文庫J',
  'ファミ通文庫',
  'GA文庫',
  'オーバーラップ文庫',
  'スニーカー文庫',
  'Kラノベブックス',
  'ハヤカワ文庫',
  '創元推理文庫',
  '中公文庫',
  '徳間文庫',
  '宝島社文庫',
  '幻冬舎新書',
];

const STORE_MARKERS = /【[^】]*(?:特典|電子|限定|期間)[^】]*】/g;

/** The name a key is made from: decorations removed, widths unified. */
export function cleanTitle(name: string): string {
  let s = stripAudioName(name);
  s = s.replace(/\[\s*audiobook\.jp\s*\d+\s*\]/gi, ' ');
  s = s.replace(/\[\s*kikubon\s*\d+\s*\]/gi, ' ');
  s = s.replace(/\(\s*(?:audiobook\.jp|kikubon)\s*\d*\s*\)/gi, ' ');
  s = s.replace(STORE_MARKERS, ' ');
  // A publisher after "_" anywhere (the ASIN after it kept it from being cut at the end).
  s = s.replace(/_\s*\([^()]*\)/g, ' ').replace(/_+(?=\s|$)/g, ' ');
  for (const imprint of IMPRINTS) {
    const n = imprint.normalize('NFKC');
    s = s.split(n).join(' ');
  }
  // Leftover empty brackets and a publisher in brackets at the end: "(KADOKAWA)".
  s = s.replace(/[(（][^()（）]*[)）]\s*$/u, (m) => (/\d/.test(m) ? m : ' '));
  s = s.replace(/[[\]【】]\s*[[\]【】]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Lower case, no spaces or punctuation (numbers and kana/kanji kept). */
export function titleKey(name: string): string {
  const s = cleanTitle(name).toLowerCase();
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 上/中/下 or the printed number, as text; null when none. */
export function printedVolume(name: string): string | null {
  const s = cleanTitle(name);
  // (\s includes the full-width space.)
  const part = /(?:^|[\s・(（])(上|中|下)(?:巻)?(?:$|[\s)）])/u.exec(s);
  const n = extractVolume(s);
  if (n !== null && part) return `${n}${part[1]}`;
  if (n !== null) return String(n);
  return part ? part[1] : null;
}
