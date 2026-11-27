/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { OfflineCatalog, type OfflineData } from './offline/offline-catalog';
import { describeQuery } from './query/describe';
import { parseQuery } from './query/parse';
import {
  DEFAULT_KEPT_RULES,
  figureMatches,
  pickFigure,
  seriesFigures,
  worksFigure,
  type FigureVolume
} from './series-figures';
import { groupFigureText } from './store-ratings';
import { parseSort, sortChoices } from './sort';
import type { CatalogBookDetail } from './types';

const NOW = Date.UTC(2026, 10, 26);
const OLD = Date.UTC(2020, 0, 1);

function vol(
  series: string,
  index: number,
  readers: number | null,
  over: Partial<FigureVolume> = {}
): FigureVolume {
  return {
    id: `${series}${index}`,
    library: 'lib1',
    series,
    index,
    ratingX10: null,
    ratingCount: null,
    ratingScore: null,
    readers,
    publishedAt: OLD,
    ...over
  };
}

const kept = (volumes: FigureVolume[], rules = DEFAULT_KEPT_RULES) =>
  seriesFigures(volumes, rules, NOW).get(`lib1:${volumes[0].series}`)?.kept ?? null;

describe('Went on to vol 2 (kept)', () => {
  it('is vol 2 readers as a whole percent of vol 1', () => {
    expect(kept([vol('a', 1, 1000), vol('a', 2, 693)])).toBe(69);
  });

  it('is empty when vol 1 has too few readers, vol 2 none, or vol 2 is new', () => {
    expect(kept([vol('a', 1, 49), vol('a', 2, 40)])).toBeNull();
    expect(kept([vol('a', 1, 100), vol('a', 2, null)])).toBeNull();
    expect(kept([vol('a', 1, 100)])).toBeNull();
    expect(
      kept([vol('a', 1, 100), vol('a', 2, 80, { publishedAt: NOW - 30 * 86400000 })])
    ).toBeNull();
    // An undated vol 2 counts as old.
    expect(kept([vol('a', 1, 100), vol('a', 2, 80, { publishedAt: null })])).toBe(80);
  });

  it('is empty when vol 2 is far under vol 3 or far over vol 1 (wrong links)', () => {
    expect(kept([vol('a', 1, 200), vol('a', 2, 20), vol('a', 3, 150)])).toBeNull();
    expect(kept([vol('a', 1, 200), vol('a', 2, 120), vol('a', 3, 150)])).toBe(60);
    expect(kept([vol('a', 1, 100), vol('a', 2, 300)])).toBeNull();
    expect(kept([vol('a', 1, 100), vol('a', 2, 110)])).toBe(100);
  });

  it('follows the thresholds', () => {
    const rules = { minReaders: 10, neighbourPercent: 0, maxPercent: 400, minMonths: 0 };
    expect(kept([vol('a', 1, 20), vol('a', 2, 10)], rules)).toBe(50);
    expect(kept([vol('a', 1, 100), vol('a', 2, 300)], rules)).toBe(100);
  });

  it('never reads bonus, side or omnibus books as volumes 1-3', () => {
    expect(kept([vol('a', 1, 100), vol('a', 1.1, 5), vol('a', 2.5, 5), vol('a', 2, 70)])).toBe(70);
  });
});

describe("a series' volume 1", () => {
  it('takes the stars of the volume 1 with most ratings and the most readers of any', () => {
    const f = seriesFigures(
      [
        vol('a', 1, 10, { ratingX10: 42, ratingCount: 300, ratingScore: 4180 }),
        vol('a', 1, 900, { ratingX10: 45, ratingCount: 5, ratingScore: 4150 }),
        vol('a', 2, 50, { ratingX10: 49, ratingCount: 999, ratingScore: 4890 })
      ],
      DEFAULT_KEPT_RULES,
      NOW
    ).get('lib1:a')!;
    expect(f.rating).toEqual({ avg: 4.2, count: 300, score: 4180 });
    expect(f.readers).toBe(900);
  });

  it('across libraries takes the one whose volume 1 has the most readers', () => {
    const a = { rating: null, readers: 10, kept: null };
    const b = { rating: null, readers: 99, kept: 50 };
    expect(pickFigure([a, undefined, b])).toBe(b);
    expect(pickFigure([undefined])).toBeNull();
  });
});

describe("an author's works", () => {
  it('weights the stars by their counts and pulls them toward the median', () => {
    const f = worksFigure(
      [
        { rating: { avg: 4, count: 100, score: 0 }, readers: 1000 },
        { rating: { avg: 4.8, count: 50, score: 0 }, readers: null },
        { rating: null, readers: 5 }
      ],
      { m: 4.1, c: 20 }
    );
    expect(f).toEqual({ rating: { avg: 4.3, count: 150, score: 4247 }, readers: 1005, kept: null });
    expect(worksFigure([], { m: 4.1, c: 20 })).toEqual({ rating: null, readers: null, kept: null });
  });
});

describe('figure terms', () => {
  it('never match a missing figure, negated or not', () => {
    expect(figureMatches(null, 70, null, false)).toBe(false);
    expect(figureMatches(null, 70, null, true)).toBe(false);
    expect(figureMatches(69, 70, null, true)).toBe(true);
  });

  it('parse kept: as whole percents and read it in plain words', () => {
    const terms = (q: string) => {
      const r = parseQuery(q);
      if (!r.ok) throw new Error(r.error.message);
      return r.query.terms.map((t) => ('min' in t ? [t.type, t.min, t.max] : t.type));
    };
    expect(terms('kept:>=70')).toEqual([['kept', 70, null]]);
    expect(terms('kept:50-80')).toEqual([['kept', 50, 80]]);
    expect(terms('kept:70%')).toEqual([['kept', 70, 70]]);
    expect(terms('kept:<50')).toEqual([['kept', null, 49]]);
    for (const bad of ['kept:', 'kept:120', 'kept:abc', 'kept:80-50']) {
      expect(parseQuery(bad).ok, bad).toBe(false);
    }
    expect(describeQuery('kept:>=70')).toEqual({
      kind: 'reads',
      text: 'went on to vol 2: at least 70 %'
    });
    expect(describeQuery('-kept:50-80%')).toEqual({
      kind: 'reads',
      text: 'not: went on to vol 2: 50 to 80 %'
    });
  });
});

describe('the sort menu and the cards', () => {
  it('offers the figure sorts on Series (with Went on to vol 2) and Authors, not on Tags', () => {
    const keys = (c: Parameters<typeof sortChoices>[0]) => sortChoices(c).map((s) => s.key);
    expect(keys('series-groups')).toEqual([
      'newest',
      'name',
      'count',
      'rating',
      'ratings',
      'readers',
      'kept'
    ]);
    expect(keys('author-groups')).toEqual([
      'newest',
      'name',
      'count',
      'rating',
      'ratings',
      'readers'
    ]);
    expect(keys('groups')).toEqual(['newest', 'name', 'count']);
    // A remembered figure sort isn't one of Tags' sorts.
    expect(parseSort('kept-desc', 'groups')).toBeNull();
    expect(parseSort('kept-desc', 'series-groups')).toEqual({ key: 'kept', dir: 'desc' });
  });

  it('shows the figure of the sort only', () => {
    const figures = { rating: { avg: 4.2, count: 1310, score: 4180 }, readers: 5120, kept: 69 };
    expect(groupFigureText({ by: 'series', figures }, 'rating')).toBe('Vol 1: 4.2 · 1,310');
    expect(groupFigureText({ by: 'series', figures }, 'readers')).toBe('Vol 1: 5,120 read it');
    expect(groupFigureText({ by: 'series', figures }, 'kept')).toBe('Went on to vol 2: 69 %');
    expect(groupFigureText({ by: 'author', figures }, 'ratings')).toBe('1,310 ratings');
    expect(groupFigureText({ by: 'author', figures }, 'kept')).toBeNull();
    expect(groupFigureText({ by: 'series', figures }, 'newest')).toBeNull();
    expect(groupFigureText({ by: 'tag', figures }, 'rating')).toBeNull();
  });
});

describe('the offline Library', () => {
  let added = 0;
  function book(
    id: string,
    series: [string, number] | null,
    authors: string[],
    over: Partial<CatalogBookDetail> = {}
  ): CatalogBookDetail {
    added += 1;
    return {
      id,
      libraryId: 'lib1',
      title: id,
      titleSort: null,
      authorSort: null,
      authors: authors.map((name) => ({ name, sort: null })),
      series: series ? { name: series[0], index: series[1] } : null,
      tags: [],
      addedAt: added,
      charCount: 1000,
      charCountStatus: 'counted',
      missing: false,
      thumbnail: null,
      source: 'calibre',
      publisher: null,
      publishedAt: OLD,
      description: null,
      sources: [],
      ...over
    };
  }
  const rated = (avg: number, count: number, score: number) => ({
    storeRating: { avg, count, score }
  });
  const books = [
    book('A1', ['Alpha', 1], ['Amy'], { ...rated(4, 100, 4000), readers: 1000 }),
    book('A2', ['Alpha', 2], ['Amy'], { readers: 600 }),
    book('B1', ['Beta', 1], ['Bob'], { ...rated(4.5, 10, 4233), readers: 100 }),
    book('B2', ['Beta', 2], ['Bob'], { readers: 90 }),
    book('G1', ['Gamma', 1], ['Cat'], { ...rated(3, 500, 3100), readers: 40 }),
    book('G2', ['Gamma', 2], ['Cat'], { ...rated(4.8, 300, 4700), readers: 30 }),
    book('L', null, ['Amy'], { ...rated(4.8, 50, 4500), readers: 300 })
  ];
  const data: OfflineData = {
    books,
    libraries: [],
    states: new Map(),
    positions: [],
    collections: [],
    items: new Map()
  };
  const catalog = new OfflineCatalog(async () => data);

  it('sorts the Series tab by a figure and carries it on the cards', async () => {
    const page = await catalog.groups({ by: 'series', sort: { key: 'kept', dir: 'desc' } });
    expect(page.groups.map((g) => [g.name, g.figures?.kept ?? null])).toEqual([
      ['Beta', 90],
      ['Alpha', 60],
      ['Gamma', null],
      [null, null]
    ]);
    const byRating = await catalog.groups({ by: 'series', sort: { key: 'rating', dir: 'desc' } });
    expect(byRating.groups.map((g) => g.name)).toEqual(['Beta', 'Alpha', 'Gamma', null]);
  });

  it("tests volume 1 on the Series tab, the series' figure everywhere with kept:", async () => {
    const names = async (q: string) =>
      (await catalog.groups({ by: 'series', q, sort: { key: 'name', dir: 'asc' } })).groups.map(
        (g) => g.name
      );
    expect(await names('rating:>=4')).toEqual(['Alpha', 'Beta']);
    expect(await names('kept:>=90')).toEqual(['Beta']);
    const ids = async (q: string) =>
      (await catalog.books({ q, limit: 50 })).books.map((b) => b.id).sort();
    // On the Books tab rating: is each book's own (Gamma's volume 2 has 4.8).
    expect(await ids('rating:>=4.7')).toEqual(['G2', 'L']);
    expect(await ids('kept:>=90')).toEqual(['B1', 'B2']);
    expect(await ids('-kept:>=90')).toEqual(['A1', 'A2']);
  });

  it('sorts the Authors tab by their works (each series once)', async () => {
    const page = await catalog.groups({ by: 'author', sort: { key: 'rating', dir: 'desc' } });
    expect(page.groups.map((g) => [g.name, g.figures?.rating?.score])).toEqual([
      ['Amy', 4247],
      ['Bob', 4233],
      ['Cat', 3042]
    ]);
  });
});
