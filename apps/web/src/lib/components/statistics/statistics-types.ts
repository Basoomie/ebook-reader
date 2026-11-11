/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';

/**
 * A row of the old per-title statistics with its averages. The Stats page (WP12b) no
 * longer uses it; the old IndexedDB statistics code (frozen since WP12a) still does.
 */
export interface BookStatistic extends BooksDbStatistic {
  id: string;
  averageReadingTime: number;
  averageWeightedReadingTime: number;
  averageCharactersRead: number;
  averageWeightedCharactersRead: number;
  averageReadingSpeed: number;
  averageWeightedReadingSpeed: number;
}
