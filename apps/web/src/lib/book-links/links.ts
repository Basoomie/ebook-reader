/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Calibre metadata on the book page (docs/design/calibre-metadata-display.md): the store and
 * book-site links of a Calibre book. Every address lives in this one table. A link is direct
 * when the book has a saved id for it in Calibre's identifiers (written by the cleanup), else
 * a search for the title and first author (decided 2026-11-22), unless the device's "Search
 * links" setting is off. Uploaded books have no links. Links open in a new tab and carry no
 * affiliate tags. No stores here, so it is tested on its own.
 */

export type LinkPlace = 'button' | 'menu' | 'hidden';

export type LinkId =
  | 'amazon'
  | 'bookwalker'
  | 'bookmeter'
  | 'ranobedb'
  | 'natively'
  | 'rakuten'
  | 'honto'
  | 'ebookjapan'
  | 'unext';

export interface LinkDef {
  id: LinkId;
  /** The site's own name, as on the page. */
  name: string;
  /** The Calibre identifier key that gives a direct link. */
  key: string;
  /**
   * What a saved id must look like to make a direct link (the forms the cleanup writes,
   * checked on the live library 2026-11-22); anything else gets the search link.
   */
  idPattern: RegExp;
  direct(id: string): string;
  /** `q` is already URL-encoded. */
  search(q: string): string;
  /** Where the link goes on a device that never changed the list. */
  defaultPlace: LinkPlace;
}

/**
 * The links in their default order, with their addresses and default places (the design's
 * table). A link added in a later version goes at the END with `defaultPlace` 'hidden', so no
 * device's book page changes on its own (as the reader toolbars, decision 7).
 */
export const BOOK_LINKS: readonly LinkDef[] = Object.freeze([
  {
    id: 'amazon',
    name: 'Amazon',
    key: 'amazon_jp',
    idPattern: /^[0-9A-Z]{10}$/,
    direct: (id) => `https://www.amazon.co.jp/dp/${id}`,
    search: (q) => `https://www.amazon.co.jp/s?k=${q}&i=digital-text`,
    defaultPlace: 'button'
  },
  {
    id: 'bookwalker',
    name: 'BOOK☆WALKER',
    key: 'bookwalker',
    idPattern: /^[0-9a-f-]{36}$/i,
    direct: (id) => `https://bookwalker.jp/de${id}/`,
    search: (q) => `https://bookwalker.jp/search/?word=${q}`,
    defaultPlace: 'button'
  },
  {
    id: 'bookmeter',
    name: '読書メーター',
    key: 'bookmeter',
    idPattern: /^\d+$/,
    direct: (id) => `https://bookmeter.com/books/${id}`,
    search: (q) => `https://bookmeter.com/search?keyword=${q}`,
    defaultPlace: 'button'
  },
  {
    id: 'ranobedb',
    name: 'RanobeDB',
    key: 'ranobedb',
    idPattern: /^\d+$/,
    direct: (id) => `https://ranobedb.org/book/${id}`,
    search: (q) => `https://ranobedb.org/books?q=${q}`,
    defaultPlace: 'button'
  },
  {
    id: 'natively',
    name: 'Natively',
    key: 'natively',
    idPattern: /^[0-9a-z]+$/i,
    direct: (id) => `https://learnnatively.com/book/${id}/`,
    search: (q) => `https://learnnatively.com/search/jpn/books/?q=${q}`,
    defaultPlace: 'button'
  },
  {
    id: 'rakuten',
    name: '楽天ブックス',
    key: 'rakuten',
    // rk/<id>: the Kobo ebook, rb/<id>: the print book (both forms opened 2026-11-22).
    idPattern: /^r[kb]\/[0-9a-z]+$/i,
    direct: (id) => `https://books.rakuten.co.jp/${id}/`,
    search: (q) => `https://books.rakuten.co.jp/search?sitem=${q}&g=101`,
    defaultPlace: 'menu'
  },
  {
    id: 'honto',
    name: 'honto',
    key: 'honto',
    idPattern: /^\d+$/,
    direct: (id) => `https://honto.jp/ebook/pd_${id}.html`,
    search: (q) => `https://honto.jp/ebook/search_10${q}.html?srchf=1`,
    defaultPlace: 'menu'
  },
  {
    id: 'ebookjapan',
    name: 'ebookjapan',
    key: 'ebookjapan',
    idPattern: /^\d+\/A\d+$/,
    direct: (id) => `https://ebookjapan.yahoo.co.jp/books/${id}/`,
    search: (q) => `https://ebookjapan.yahoo.co.jp/search/?keyword=${q}`,
    defaultPlace: 'menu'
  },
  {
    id: 'unext',
    name: 'U-NEXT',
    key: 'unext',
    // BSD… (the title) or BSD…/BID… (the volume; opened 2026-11-22).
    idPattern: /^BSD\d+(\/BID\d+)?$/,
    direct: (id) => `https://video.unext.jp/book/title/${id}`,
    search: (q) => `https://video.unext.jp/freeword/book?query=${q}`,
    defaultPlace: 'menu'
  }
] satisfies LinkDef[]);

export const LINK_IDS: readonly LinkId[] = BOOK_LINKS.map((l) => l.id);

const BY_ID = new Map<LinkId, LinkDef>(BOOK_LINKS.map((l) => [l.id, l]));

export function linkDef(id: LinkId): LinkDef {
  return BY_ID.get(id)!;
}

export interface BookLink {
  id: LinkId;
  name: string;
  href: string;
  /** 'direct': the book's own page (a saved id); 'search': a search for the title and author. */
  kind: 'direct' | 'search';
}

export interface BookForLinks {
  title: string;
  authors: { name: string }[];
  source?: 'calibre' | 'upload';
  identifiers?: Record<string, string>;
}

/** The search words: the title and the first author. */
export function searchQuery(book: Pick<BookForLinks, 'title' | 'authors'>): string {
  return [book.title, book.authors[0]?.name ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** One link for the book, or null when it has none (no saved id and search links off). */
export function bookLink(def: LinkDef, book: BookForLinks, searchLinks: boolean): BookLink | null {
  const id = book.identifiers?.[def.key]?.trim();
  if (id && def.idPattern.test(id)) {
    return { id: def.id, name: def.name, href: def.direct(id), kind: 'direct' };
  }
  if (!searchLinks) return null;
  const q = searchQuery(book);
  if (!q) return null;
  return { id: def.id, name: def.name, href: def.search(encodeURIComponent(q)), kind: 'search' };
}

export interface PlacedLinks {
  buttons: BookLink[];
  menu: BookLink[];
}

/**
 * The book's links in the device's order: those set to Button and those set to Menu (behind
 * More). Uploaded books have none.
 */
export function bookLinks(
  book: BookForLinks,
  list: readonly { id: LinkId; place: LinkPlace }[],
  searchLinks: boolean
): PlacedLinks {
  const out: PlacedLinks = { buttons: [], menu: [] };
  if (book.source === 'upload') return out;
  for (const entry of list) {
    if (entry.place === 'hidden') continue;
    const link = bookLink(linkDef(entry.id), book, searchLinks);
    if (!link) continue;
    (entry.place === 'button' ? out.buttons : out.menu).push(link);
  }
  return out;
}
