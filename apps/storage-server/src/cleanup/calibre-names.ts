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
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

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
