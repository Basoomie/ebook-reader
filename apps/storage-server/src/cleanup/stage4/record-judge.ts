/**
 * How well a store record fits the book it was looked up for, from the book's own file: used
 * where a record already found could be replaced by another (the one-time pass that picks again,
 * and a new page arriving for a book that had a record). A record that is the book is never
 * replaced by one that fits it less (changed-series follow-up, 2026-11-22: the pass that picked
 * again from BookWalker's first 40 volumes replaced 「Re：ゼロから始める異世界生活 6」 with the
 * guide book 「Re：zeropedia」, and Amazon's book with an empty page of another format).
 */
import { nfkc } from '../title-rules';
import { COMIC, EDITION, nums, subtitleAfterNumber, titleKey, titleMatch } from './pick';

/** The book as its file shows it. */
export interface BookFacts {
  /** The file's title (its own volume mark: 「…④」). */
  title: string;
  /** The colophon and front text (imprints: 「角川文庫」, 「電撃文庫」). */
  text: string;
  /** A text book (not manga). */
  textBook: boolean;
}

/** A store record as the judge reads it. */
export interface RecordFacts {
  title: string | null | undefined;
  /** Store words beside the title: BookWalker's keywords, Amazon's categories. */
  words?: string | null;
}

/** The imprints a book's own text names (「角川文庫」, 「電撃文庫」, 「HJ NOVELS」). */
export function imprintsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of nfkc(text).matchAll(
    /([\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}A-Za-z]{1,10}(?:文庫|ノベルス|ノベルズ|新書|ブックス|BOOKS|NOVELS|Novels))/gu,
  ))
    out.add(m[1]);
  return out;
}

/**
 * A store word naming manga: 「マンガ」, 「少年マンガ」, 「コミック」 (not Amazon's mixed category
 * 「コミック・ラノベ・BL」, which every light novel carries: the live check of 2026-11-22 threw
 * out 青春ブタ野郎's own record for it).
 */
function mangaWord(words: string): boolean {
  return words
    .split(/[,、>＞/]/u)
    .map((w) => w.trim())
    .some(
      (w) => /マンガ|漫画|コミック|COMIC/iu.test(w) && !/ラノベ|ライトノベル|小説|ノベル/u.test(w),
    );
}

/**
 * A manga record (its title's label or its store words: BookWalker's 「マンガ」, a manga label in
 * Amazon's categories). Never a text book's record (the live check of 2026-11-22: 3,882 text books
 * held a BookWalker manga edition, 161 of them took its description).
 */
export function isMangaRecord(rec: RecordFacts): boolean {
  return COMIC.test(nfkc(rec.title ?? '')) || mangaWord(nfkc(rec.words ?? ''));
}

/** Store words of an item that is no book (a CD, a video): 「ミュージック」, 「DVD」. */
const NOT_A_BOOK = /ミュージック|DVD|Blu-ray|ブルーレイ|CD・レコード|ビデオ/u;

/**
 * The record's fit, higher is better; null when it is not the book: another volume (the book's
 * number missing from it, or a numbered record with no subtitle of its own for a file without a
 * number), a manga for a text book, or a title that is not the book's.
 */
export function recordFit(book: BookFacts, rec: RecordFacts): number | null {
  const title = nfkc(rec.title ?? '');
  if (!title.trim()) return null;
  const words = nfkc(rec.words ?? '');
  if (book.textBook && isMangaRecord(rec)) return null;
  if (NOT_A_BOOK.test(words)) return null;
  const qn = nums(book.title);
  const tn = nums(title);
  const qk = titleKey(book.title);
  const tk = titleKey(title);
  if (!qk || !tk) return null;
  let fit = 0;
  if (qn.size) {
    // The book's number must be there (「…異世界生活 6」 is not 「…Re：zeropedia」 nor 「… 29」), all
    // of its numbers best (「11月3日～11月7日生まれ」 is not 「11月13日～11月17日生まれ」).
    const has = [...qn].filter((x) => tn.has(x)).length;
    if (!has && !(qn.has(1) && !tn.size)) return null;
    fit += has === qn.size ? 3 : 1;
  } else if (tn.size && !tn.has(1)) {
    // A numbered record for a file without a number: only with a subtitle of its own after the
    // number, the file's (「事情3 ～…新婚旅行～」 for 「事情～…新婚旅行!?～」; not 「…ともに。32」 for
    // volume 1 「…ともに。」).
    if (!(tk === qk && subtitleAfterNumber(title))) return null;
  }
  if (titleMatch(qk, title)) fit += 3;
  else if (tk.startsWith(qk) || qk.startsWith(tk) || tk.includes(qk)) fit += 1;
  else return null;
  // Another edition's mark the file doesn't carry (【完全版】, 単話版).
  const ed = EDITION.exec(title);
  if (ed && !nfkc(book.title).includes(ed[0])) fit -= 2;
  // The file's imprint named by the record: the edition itself (角川文庫's 「海と毒薬」, not 新潮文庫's).
  const imps = imprintsOf(book.text);
  if (imps.size && [...imps].some((i) => title.includes(i) || words.includes(i))) fit += 1;
  return fit;
}

/** Whether a new record should replace the one a book has: only one that fits it better. */
export function replaces(book: BookFacts, current: RecordFacts | null, next: RecordFacts): boolean {
  const n = recordFit(book, next);
  if (n === null) return false;
  const c = current ? recordFit(book, current) : null;
  return c === null || n > c;
}

/** Amazon's product page as the judge reads it (its categories name the imprint). */
export function amazonFacts(
  product:
    | { title?: string | null; rank_categories?: string[]; breadcrumbs?: string[] }
    | null
    | undefined,
): RecordFacts {
  return {
    title: product?.title ?? null,
    words: [...(product?.rank_categories ?? []), ...(product?.breadcrumbs ?? [])].join(','),
  };
}

/** BookWalker's book page as the judge reads it (its keywords name the imprint and the kind). */
export function bwFacts(
  detail: { title?: string | null; keywords?: string | null } | null | undefined,
): RecordFacts {
  return { title: detail?.title ?? null, words: detail?.keywords ?? null };
}
