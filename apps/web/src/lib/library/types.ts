/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Shapes of the storage server's /api/v1 catalog responses (WP2, WP6). */

export interface CatalogLibrary {
  id: string;
  folder: string;
  calibreLibraryUuid: string | null;
  name: string;
  language: string | null;
  enabled: boolean;
  available: boolean;
}

export interface CatalogBook {
  id: string;
  libraryId: string;
  title: string;
  authors: { name: string; sort: string | null }[];
  series: { name: string; index: number | null } | null;
  tags: string[];
  addedAt: number;
  charCount: number | null;
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
