/**
 * Stage 3 (WP20c): a file's edition kind from its titles (plan P2), decided before any pair
 * rule. Read from the EPUB's own dc:title, Calibre's current title and the file name: stage 2
 * removed the store markers from Calibre's titles, the EPUB still has them.
 *
 *   sample  free previews and trial sets          never a duplicate of the full book
 *   bonus   a store-bonus SS on its own           never a duplicate of the full book
 *   omnibus 合本 / 総集編 / sets                   never a duplicate of its volumes
 *   special special editions, attached-bonus SS   measured with the spread check
 *   full    everything else
 *
 * Errors here are on the safe side for removals: a full book taken for a sample, bonus or
 * omnibus is only kept, and a real bonus or sample overlaps the full book by far less than
 * the duplicate classes need (≤ 12 % measured).
 */

export type EditionKind = 'sample' | 'bonus' | 'omnibus' | 'special' | 'full';

const SAMPLE =
  /試し読み|試読|お試し|立ち読み|体験版|prelude版|トライアルセット|サンプル版|無料版|【[^】]*無料[^】]*】/i;
const BONUS_ITEM = /ショートストーリー|購入特典/;
/** "…SS付き", "…ショートストーリー付", "特典付き": the bonus comes with the full book. */
const ATTACHED = /(ss|ショートストーリー|特典|小説|短編|掌編)[^】)）\]」』]{0,8}(付|つき)/i;
/** Also "5巻セット" and "1~5巻セット" (after NFKC; found in the Preview, 2026-11-17). */
const OMNIBUS =
  /合本|総集編|全\d+巻セット|\d+冊セット|全巻セット|\d+\s*(?:[~〜\-–]\s*\d+\s*)?巻\s*セット/;
const SPECIAL =
  /特別版|特装版|増量版|special edition|☆walker special|完全版|限定版|記念|メモリアル|豪華版|特典付|特典あり|(ss|ショートストーリー|短編|掌編|小説集)[^】)）]{0,8}(付|つき)|付録/i;

const norm = (s: string) => s.normalize('NFKC');

export interface KindResult {
  kind: EditionKind;
  /** The marker text that decided it (for the page and the report). */
  marker: string | null;
}

function first(re: RegExp, titles: string[]): string | null {
  for (const t of titles) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

/** The kind from every title the file has (empty ones ignored). */
export function editionKind(titles: (string | null | undefined)[]): KindResult {
  const ts = titles.filter((t): t is string => !!t && t.trim() !== '').map(norm);
  const sample = first(SAMPLE, ts);
  if (sample) return { kind: 'sample', marker: sample };
  const bonusTitles = ts.filter((t) => BONUS_ITEM.test(t) && !ATTACHED.test(t));
  if (bonusTitles.length > 0) return { kind: 'bonus', marker: first(BONUS_ITEM, bonusTitles) };
  const omnibus = first(OMNIBUS, ts);
  if (omnibus) return { kind: 'omnibus', marker: omnibus };
  const special = first(SPECIAL, ts);
  if (special) return { kind: 'special', marker: special };
  return { kind: 'full', marker: null };
}
