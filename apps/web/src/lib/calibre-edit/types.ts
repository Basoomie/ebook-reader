/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Calibre metadata editing from the reader (design calibre-metadata-editing.md): the server's
 * shapes (apps/storage-server/src/cleanup/edits/).
 */

export interface SeriesValue {
  name: string | null;
  index: number | null;
}

/** A book's editable values as the server keeps them. */
export interface EditValues {
  title: string;
  sort: string;
  authors: string[];
  author_sort: string;
  illustrator: string[];
  series: SeriesValue;
  publisher: string | null;
  /** ms (noon UTC of the day), null = none. */
  pubdate: number | null;
  languages: string[];
  /** 1-10 half stars, null = none. */
  rating: number | null;
  description: string | null;
  tags: string[];
  identifiers: Record<string, string>;
}

export type EditField = keyof EditValues | 'cover';

export type EditState = 'waiting' | 'writing' | 'written' | 'shown' | 'not_written';

export interface FieldStatus {
  field: string;
  changeId: number;
  state: EditState;
  reason: string | null;
  value: unknown;
  savedAt: number;
}

export interface EditForm {
  calibreId: number;
  hasCover: boolean;
  values: EditValues;
  unconfirmed: { field: string; reason: string | null }[];
  yours: { field: string; source: string; since: number }[];
  status: FieldStatus[];
  writer: { ready: boolean; wait: string | null };
}

export interface SharedRename {
  field: string;
  from: string;
  to: string;
  books: number;
}

export interface SaveResult {
  batchId: string | null;
  changed: string[];
  confirmed: string[];
  status?: FieldStatus[];
}

export interface HistoryEntry {
  id: string;
  at: number;
  who: 'you' | 'cleanup' | 'calibre' | 'shared_rename' | 'confirm' | 'copied';
  stage: number | null;
  via: string | null;
  field: string;
  old: unknown;
  new: unknown;
  state: 'done' | 'undone' | 'waiting' | 'not_written';
  reason: string | null;
  cause: string | null;
  undo: { possible: boolean; why: string | null; to: unknown };
}

export interface SeriesPair {
  name: string;
  books: number;
  onlySeries: boolean;
}

export interface SeriesView {
  libraryId: string;
  name: string;
  books: {
    bookId: string;
    calibreId: number;
    title: string;
    index: number | null;
    firstAuthor: string;
    unconfirmed: string | null;
    yours: string[];
  }[];
  pairs: SeriesPair[];
}

/** Book covers: a picture the book's cover had, kept by the server (oldest first). */
export interface EarlierCover {
  sha256: string;
  width: number | null;
  height: number | null;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** Calibre's cover now (its exact bytes). */
  current: boolean;
  /** Looks like the cover now (another file of the same picture, e.g. another size). */
  same: boolean;
}

export interface EarlierCovers {
  current: { width: number; height: number } | null;
  covers: EarlierCover[];
}

export type CoverStore = 'amazon' | 'bookwalker';

/** Book covers: one store's picture, fetched by the server through its fetch queue. */
export interface StoreCover {
  store: CoverStore;
  id: string;
  state: 'waiting' | 'ready' | 'none' | 'failed';
  reason: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  same: boolean;
}

export type TagGroupId = 'format' | 'genre' | 'subject' | 'tag' | 'adaptation' | 'yours';

export interface TagList {
  groups: { id: TagGroupId; title: string; tags: { label: string; builtIn: boolean }[] }[];
  /** The library's tags that match the user's own tag patterns (TMW-collection-* → each). */
  yoursInLibrary: string[];
}
