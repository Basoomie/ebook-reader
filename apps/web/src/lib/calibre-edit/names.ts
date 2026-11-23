/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Calibre's folder and file names for a book (the edit form's live "N / 255 bytes"): the same
 * code as the server's `calibreNameBytes` (apps/storage-server/src/cleanup/calibre-names.ts,
 * mirroring calibre 9.18's construct_path_name / construct_file_name; a parity test runs both
 * on the same cases). The disk takes at most 255 bytes per name; the server refuses a save
 * that would make a longer one.
 */
export const NAME_MAX_BYTES = 255;
const CALIBRE_PATH_LIMIT = 100;
const CALIBRE_EXT_LEN = 14;

const cut = (s: string, n: number) => [...s].slice(0, n).join('');
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

export function calibreNameBytes(calibreId: number, title: string, firstAuthor: string): number {
  const idPart = ` (${calibreId})`;
  const l = CALIBRE_PATH_LIMIT - Math.floor(idPart.length / 2) - 2;
  const folder = cut(title.trimStart(), l).trimEnd() + idPart;
  const authorFolder = cut(firstAuthor, l).replace(/[ .]+$/u, '');
  const l2 = Math.floor((CALIBRE_PATH_LIMIT - CALIBRE_EXT_LEN - 2) / 2);
  const file = `${cut(title.trimStart(), l2).trimEnd()} - ${cut(firstAuthor, l2)}.original_epub`;
  return Math.max(bytes(folder), bytes(authorFolder), bytes(file));
}

/** The first author's own folder name (the second counter). */
export function authorNameBytes(calibreId: number, firstAuthor: string): number {
  return calibreNameBytes(calibreId, '', firstAuthor);
}
