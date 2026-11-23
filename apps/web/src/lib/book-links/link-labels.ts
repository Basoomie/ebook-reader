/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * What Settings > Library > Links says about each link (the screen and Settings search read
 * these words from here).
 */

import type { LinkId } from './links';

export const LINK_LABELS: Record<LinkId, { description: string; keywords?: string }> = {
  amazon: { description: 'Direct with an Amazon id (ASIN), else a search.', keywords: 'kindle' },
  bookwalker: {
    description: 'Direct with a BOOK☆WALKER id, else a search.',
    keywords: 'bookwalker'
  },
  bookmeter: {
    description: 'Direct with a 読書メーター id, else a search.',
    keywords: 'bookmeter'
  },
  ranobedb: { description: 'Direct with a RanobeDB id, else a search.' },
  natively: { description: 'Direct with a Natively id, else a search.' },
  rakuten: {
    description: 'Print or Kobo page from 読書メーター’s store list, else a search.',
    keywords: 'rakuten kobo'
  },
  honto: { description: 'Direct with a honto id, else a search. Needs a Japanese connection.' },
  ebookjapan: { description: 'From 読書メーター’s store list, else a search.' },
  unext: { description: 'From 読書メーター’s store list, else a search.', keywords: 'unext' }
};
