/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BehaviorSubject } from 'rxjs';
import type { BooksDbBookmarkData } from '$lib/data/database/books-db/versions/books-db';

export interface AutoScroller {
  wasAutoScrollerEnabled$: BehaviorSubject<boolean>;
  toggle: () => void;
  off: () => void;
}

export interface BookmarkManager {
  formatBookmarkData: (
    bookId: number,
    customReadingPointScrollOffset: number
  ) => BooksDbBookmarkData;

  formatBookmarkDataByRange: (
    bookId: number,
    customReadingPointRange: Range | undefined
  ) => BooksDbBookmarkData;

  scrollToBookmark: (
    bookmarkData: BooksDbBookmarkData,
    customReadingPointScrollOffset?: number
  ) => void;

  /**
   * WP11a: counted characters before the part of the book on the page (paginated mode
   * shows one section at a time); absent = the whole book is on the page.
   */
  sectionStartCount?: () => number;
}

export interface PageManager {
  nextPage: () => void;

  prevPage: () => void;

  updateSectionDataByOffset: (offset: number) => void;
}
