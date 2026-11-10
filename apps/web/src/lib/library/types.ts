/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Shapes of the storage server's /api/v1 catalog responses (WP2, WP6, WP3b). */

/** Character counts of a library's books (servers before WP3b don't send them). */
export interface CatalogCountTotals {
  counted: number;
  pending: number;
  errors: number;
}

export interface CatalogLibrary {
  id: string;
  folder: string;
  calibreLibraryUuid: string | null;
  name: string;
  language: string | null;
  enabled: boolean;
  available: boolean;
  counts?: CatalogCountTotals;
}

/**
 * The server's character count of a book's EPUB, for the library only (the reader
 * uses its own in-book count). counted: charCount is current; pending: not counted
 * yet or the EPUB changed; error: it could not be counted.
 */
export type CharCountStatus = 'counted' | 'pending' | 'error';

export interface CatalogBook {
  id: string;
  libraryId: string;
  title: string;
  authors: { name: string; sort: string | null }[];
  series: { name: string; index: number | null } | null;
  tags: string[];
  addedAt: number;
  charCount: number | null;
  /** Missing from servers before WP3b. */
  charCountStatus?: CharCountStatus;
  missing: boolean;
  /** Relative, signed thumbnail URL (works in a plain <img>), or null. */
  thumbnail: string | null;
}

export interface CatalogBookSource {
  kind: 'calibre' | 'upload';
  libraryId: string;
  calibreUuid: string | null;
  calibreId: number | null;
  filePath: string | null;
  fileSize: number | null;
  missingAt: number | null;
}

export interface CatalogBookDetail extends CatalogBook {
  sources: CatalogBookSource[];
}

export interface CatalogPage {
  books: CatalogBook[];
  nextCursor: string | null;
}

/** Browse tabs (WP7a): groups are addressed by name; series null = "No series". */
export type GroupBy = 'series' | 'author' | 'tag';

export interface GroupTile {
  bookId: string;
  thumbnail: string | null;
  /** For tag blur rules. */
  tags: string[];
}

export interface GroupChars {
  /** Sum of the counts the group's books have. */
  total: number;
  counted: number;
  /** Not counted yet, or waiting for a recount. */
  pending: number;
  /** Could not be counted. */
  failed: number;
}

export interface CatalogGroup {
  by: GroupBy;
  name: string | null;
  bookCount: number;
  newestAddedAt: number;
  chars: GroupChars;
  /** Series: the lowest-index volume. */
  cover?: GroupTile | null;
  /** Series: every book, in series order (for "3/12 read"). */
  bookIds?: string[];
  /** Authors, tags and "No series": up to four collage tiles. */
  tiles?: GroupTile[];
}

/** A card of the Collections page (WP8b, GET /collections/cards). */
export interface CollectionCardData {
  /** A built-in id ("reading", ...) or a collection id. */
  id: string;
  builtin: boolean;
  query?: string;
  bookCount: number;
  tiles: GroupTile[];
  error?: { code: string; message: string };
}

export interface CatalogGroupPage {
  groups: CatalogGroup[];
  nextCursor: string | null;
}
