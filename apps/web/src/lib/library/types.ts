/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Shapes of the storage server's /api/v1 catalog responses (WP2, WP6, WP3b). */

import type { SeriesFigure } from './series-figures';

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
  /**
   * Calibre's title and author sort (sent since WP19a; the server sorts by them). Kept by
   * the offline Library, which sorts the same way.
   */
  titleSort?: string | null;
  authorSort?: string | null;
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
  /** WP7b: 'upload' shows the "Uploaded" badge. Missing from servers before WP7b. */
  source?: 'calibre' | 'upload';
  /** WP19c (sent since WP2): Calibre's publisher and publication date (ms), when known. */
  publisher?: string | null;
  publishedAt?: number | null;
  /**
   * Calibre's #illustrator names in Calibre's order ([] for uploads). Missing from servers
   * before ttsu.db 30 and from offline copies stored before it.
   */
  illustrators?: string[];
  /**
   * The Natively level last read from the book's Natively page (a book with a direct Natively
   * link only); `temporary` is Natively's "Level 25??". Null without one; missing from servers
   * before ttsu.db 32 and from offline copies stored before it.
   */
  nativelyLevel?: NativelyLevel | null;
  /**
   * Store ratings (ttsu.db 33): the stores' pooled stars (Amazon and BOOK☆WALKER; `avg` to one
   * decimal), how many rated it and the Rating sort's score (x1000). Null without one; missing
   * from older servers and offline copies.
   */
  storeRating?: StoreRating | null;
  /** 読書メーター's 登録数 (people who logged it); null without one. */
  readers?: number | null;
  /** Calibre's rating (yours), 1-10 half stars (9 = four and a half); null or missing without one. */
  rating?: number | null;
}

export interface StoreRating {
  avg: number;
  count: number;
  score: number;
}

export interface NativelyLevel {
  level: number;
  temporary: boolean;
}

/** Whether the server takes uploads (WP7b), and their size limit in bytes. */
export interface UploadInfo {
  enabled: boolean;
  maxBytes: number;
}

/** Why an upload looks like a book that is already in the library (WP7b). */
export type DuplicateMatch = 'same-file' | 'fingerprint' | 'title-author';

/** An upload waiting for the user's decision (POST /uploads). */
export interface StagedUpload {
  uploadId: string;
  libraryId: string;
  title: string;
  authors: string[];
  series: { name: string; index: number | null } | null;
  size: number;
  duplicates: { match: DuplicateMatch; book: CatalogBook }[];
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
  /** WP19c: Calibre's description ("comments", HTML); shown as text only. */
  description?: string | null;
  /**
   * Calibre's identifiers, type (lower case) -> value, for the book page's links ({} for
   * uploads). Missing from older servers and older offline copies.
   */
  identifiers?: Record<string, string>;
  /** Calibre's language codes ("jpn"). Missing from older servers. */
  languages?: string[];
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
  /** For the cover blur rules (lib/library/cover-blur.ts). */
  tags: string[];
  /** Since 2026-11-21 (older servers send only the tags): for author, series and collection rules. */
  title?: string;
  authors?: string[];
  /** Since ttsu.db 30: Calibre's #illustrator names (an illustrator: smart collection). */
  illustrators?: string[];
  series?: string | null;
  charCount?: number | null;
  /** Store ratings (ttsu.db 33): a series card's cover is volume 1, so these are its figures. */
  storeRating?: StoreRating | null;
  readers?: number | null;
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
  /**
   * Series: volume 1's stars and readers and "Went on to vol 2"; authors: over their works
   * (series-figures.ts). Missing for tags, without any figure, and from older servers.
   */
  figures?: SeriesFigure;
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
  /** WP19a: how many groups the whole list has (missing from older servers). */
  total?: number;
}
