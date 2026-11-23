/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { moveLink, moveLinkTo, resetLinks, setLinkPlace } from './link-edit';
import { LINKS_DEFAULT, resolveLinks } from './link-layout';
import { BOOK_LINKS, LINK_IDS, bookLinks, searchQuery, type BookForLinks } from './links';

/** A book with a saved id for every link (real forms from the library, 2026-11-22). */
const ALL_IDS: Record<string, string> = {
  amazon_jp: 'B0CXYZ1234',
  bookwalker: 'e53c458b-e9e5-410d-afaa-9111b4d6102b',
  bookmeter: '3981671',
  ranobedb: '10475',
  natively: '7dd00398c6',
  rakuten: 'rb/13205773',
  honto: '29445282',
  ebookjapan: '311410/A001568951',
  unext: 'BSD0000238463/BID0000492918'
};

const book = (over: Partial<BookForLinks> = {}): BookForLinks => ({
  title: '魔女の旅々10',
  authors: [{ name: '白石定規' }, { name: 'あずーる' }],
  source: 'calibre',
  identifiers: {},
  ...over
});

const all = (b: BookForLinks, search = true) => [
  ...bookLinks(b, LINKS_DEFAULT, search).buttons,
  ...bookLinks(b, LINKS_DEFAULT, search).menu
];

describe('the links table', () => {
  it('has the design’s nine links in order with their default places', () => {
    expect(BOOK_LINKS.map((l) => [l.name, l.defaultPlace])).toEqual([
      ['Amazon', 'button'],
      ['BOOK☆WALKER', 'button'],
      ['読書メーター', 'button'],
      ['RanobeDB', 'button'],
      ['Natively', 'button'],
      ['楽天ブックス', 'menu'],
      ['honto', 'menu'],
      ['ebookjapan', 'menu'],
      ['U-NEXT', 'menu']
    ]);
  });

  it('makes every direct address from the saved id', () => {
    const links = all(book({ identifiers: ALL_IDS }));
    expect(links.every((l) => l.kind === 'direct')).toBe(true);
    expect(Object.fromEntries(links.map((l) => [l.id, l.href]))).toEqual({
      amazon: 'https://www.amazon.co.jp/dp/B0CXYZ1234',
      bookwalker: 'https://bookwalker.jp/dee53c458b-e9e5-410d-afaa-9111b4d6102b/',
      bookmeter: 'https://bookmeter.com/books/3981671',
      ranobedb: 'https://ranobedb.org/book/10475',
      natively: 'https://learnnatively.com/book/7dd00398c6/',
      rakuten: 'https://books.rakuten.co.jp/rb/13205773/',
      honto: 'https://honto.jp/ebook/pd_29445282.html',
      ebookjapan: 'https://ebookjapan.yahoo.co.jp/books/311410/A001568951/',
      unext: 'https://video.unext.jp/book/title/BSD0000238463/BID0000492918'
    });
    // The Kobo form and a title-only U-NEXT id are direct too.
    const kobo = all(
      book({
        identifiers: { rakuten: 'rk/9eb23aa29767327ab135ef44d11b306d', unext: 'BSD0000238463' }
      })
    );
    expect(kobo.find((l) => l.id === 'rakuten')?.href).toBe(
      'https://books.rakuten.co.jp/rk/9eb23aa29767327ab135ef44d11b306d/'
    );
    expect(kobo.find((l) => l.id === 'unext')?.href).toBe(
      'https://video.unext.jp/book/title/BSD0000238463'
    );
  });

  it('searches for the title and the first author when there is no saved id', () => {
    expect(searchQuery(book())).toBe('魔女の旅々10 白石定規');
    expect(searchQuery(book({ authors: [] }))).toBe('魔女の旅々10');
    const q = encodeURIComponent('魔女の旅々10 白石定規');
    const links = all(book());
    expect(links.every((l) => l.kind === 'search')).toBe(true);
    expect(Object.fromEntries(links.map((l) => [l.id, l.href]))).toEqual({
      amazon: `https://www.amazon.co.jp/s?k=${q}&i=digital-text`,
      bookwalker: `https://bookwalker.jp/search/?word=${q}`,
      bookmeter: `https://bookmeter.com/search?keyword=${q}`,
      ranobedb: `https://ranobedb.org/books?q=${q}`,
      natively: `https://learnnatively.com/search/jpn/books/?q=${q}`,
      rakuten: `https://books.rakuten.co.jp/search?sitem=${q}&g=101`,
      honto: `https://honto.jp/ebook/search_10${q}.html?srchf=1`,
      ebookjapan: `https://ebookjapan.yahoo.co.jp/search/?keyword=${q}`,
      unext: `https://video.unext.jp/freeword/book?query=${q}`
    });
    // Characters that mean something in an address are encoded.
    const odd = all(book({ title: 'A&B? #1/2', authors: [] }));
    expect(odd[0].href).toBe('https://www.amazon.co.jp/s?k=A%26B%3F%20%231%2F2&i=digital-text');
  });

  it('uses a saved id only in its own form; anything else gets the search link', () => {
    const links = all(
      book({
        identifiers: {
          amazon_jp: 'B0CX/../x',
          rakuten: '13205773',
          unext: 'BID1',
          isbn: '9784000000000'
        }
      })
    );
    for (const id of ['amazon', 'rakuten', 'unext']) {
      expect(links.find((l) => l.id === id)?.kind, id).toBe('search');
    }
  });

  it('with Search links off, shows only the links with a saved id', () => {
    const placed = bookLinks(
      book({ identifiers: { bookmeter: '1', honto: '2' } }),
      LINKS_DEFAULT,
      false
    );
    expect(placed.buttons.map((l) => l.id)).toEqual(['bookmeter']);
    expect(placed.menu.map((l) => l.id)).toEqual(['honto']);
    expect(bookLinks(book(), LINKS_DEFAULT, false)).toEqual({ buttons: [], menu: [] });
  });

  it('gives an uploaded book no links', () => {
    expect(
      bookLinks(book({ source: 'upload', identifiers: ALL_IDS }), LINKS_DEFAULT, true)
    ).toEqual({
      buttons: [],
      menu: []
    });
  });

  it('follows the device’s order and places; hidden links are left out', () => {
    const list = setLinkPlace(moveLink(LINKS_DEFAULT, 'unext', -1), 'amazon', 'hidden');
    const placed = bookLinks(
      book({ identifiers: ALL_IDS }),
      setLinkPlace(list, 'honto', 'button'),
      true
    );
    expect(placed.buttons.map((l) => l.id)).toEqual([
      'bookwalker',
      'bookmeter',
      'ranobedb',
      'natively',
      'honto'
    ]);
    expect(placed.menu.map((l) => l.id)).toEqual(['rakuten', 'unext', 'ebookjapan']);
  });
});

describe('the stored list', () => {
  it('reads nothing stored as the defaults', () => {
    expect(resolveLinks(undefined)).toEqual(LINKS_DEFAULT);
    expect(resolveLinks('junk')).toEqual(LINKS_DEFAULT);
  });

  it('keeps the stored order, drops unknown, repeated and invalid entries, adds missing ones at the end as Hidden', () => {
    const shown = resolveLinks([
      { id: 'honto', place: 'button' },
      { id: 'nope', place: 'button' },
      { id: 'honto', place: 'menu' },
      { id: 'amazon', place: 'sideways' },
      null,
      { id: 'unext', place: 'menu' }
    ]);
    expect(shown.slice(0, 2)).toEqual([
      { id: 'honto', place: 'button' },
      { id: 'unext', place: 'menu' }
    ]);
    expect(shown.map((e) => e.id).sort()).toEqual([...LINK_IDS].sort());
    expect(shown.slice(2).every((e) => e.place === 'hidden')).toBe(true);
  });

  it('moves, drops, places and resets, returning a clean full list', () => {
    expect(moveLink(undefined, 'amazon', -1)).toEqual(LINKS_DEFAULT);
    expect(moveLink(undefined, 'unext', 1)).toEqual(LINKS_DEFAULT);
    expect(
      moveLink(undefined, 'bookwalker', -1)
        .slice(0, 2)
        .map((e) => e.id)
    ).toEqual(['bookwalker', 'amazon']);
    expect(moveLinkTo(undefined, 8, 0)[0]).toEqual({ id: 'unext', place: 'menu' });
    expect(setLinkPlace([{ id: 'amazon', place: 'button' }], 'amazon', 'menu')).toHaveLength(9);
    expect(resetLinks()).toEqual(LINKS_DEFAULT);
    expect(resetLinks()).not.toBe(LINKS_DEFAULT);
  });
});
