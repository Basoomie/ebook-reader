/** Calibre's folder and file names for a book, and the disk's limit (lessons 2). */

/**
 * The longest file or folder name the NAS's disks accept, in bytes (Linux NAME_MAX). Calibre
 * doesn't check it: a title or first author that makes a longer name is refused by the disk
 * ("File name too long", seen on the NAS 2026-11-14), after Calibre already took the title.
 */
export const NAME_MAX_BYTES = 255;
/** calibre's PATH_LIMIT on Linux (db/backend.py). */
const CALIBRE_PATH_LIMIT = 100;
/** calibre reserves room for the longest format name (ORIGINAL_EPUB). */
const CALIBRE_EXT_LEN = 14;

const cut = (s: string, n: number) => [...s].slice(0, n).join('');
// TextEncoder rather than Buffer: the web app's copy (lib/calibre-edit/names.ts) is the same
// code, checked against this one by a parity test.
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

/**
 * The longest name Calibre would make for a book with this title and first author
 * (construct_path_name / construct_file_name of calibre 9.18), in bytes. Worst case: the
 * NAS's Calibre keeps Japanese characters in names (3 bytes each); one that transliterates
 * makes shorter ones.
 */
export function calibreNameBytes(calibreId: number, title: string, firstAuthor: string): number {
  const idPart = ` (${calibreId})`;
  const l = CALIBRE_PATH_LIMIT - Math.floor(idPart.length / 2) - 2;
  const folder = cut(title.trimStart(), l).trimEnd() + idPart;
  const authorFolder = cut(firstAuthor, l).replace(/[ .]+$/u, '');
  const l2 = Math.floor((CALIBRE_PATH_LIMIT - CALIBRE_EXT_LEN - 2) / 2);
  const file = `${cut(title.trimStart(), l2).trimEnd()} - ${cut(firstAuthor, l2)}.original_epub`;
  return Math.max(bytes(folder), bytes(authorFolder), bytes(file));
}

/**
 * Whether Calibre would split this one name into several authors (or #illustrator names).
 * calibre 9.18's `string_to_authors` splits on "&" and turns ",? and " / ",? with " (any case,
 * any whitespace, full-width too) into "&" first: "Tôwa and Huuka Kazabana" becomes two names
 * (checked on calibre 9.18, 2026-11-23; stage 2's write of book 29728 then never showed).
 * "A, B", "Rand Paul", "Withers" and a full-width "＆" stay one name.
 */
export function calibreSplitsName(name: string): boolean {
  return name.includes('&') || CALIBRE_AUTHOR_WORDS.test(name);
}

/** calibre's `_author_pat` (ebooks/metadata/__init__.py), as JavaScript. */
export const CALIBRE_AUTHOR_WORDS = /,?\s+(?:and|with)\s+/iu;
