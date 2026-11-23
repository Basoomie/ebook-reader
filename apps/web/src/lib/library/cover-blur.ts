/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { builtinCollection } from '$lib/collections/builtins';
import type { Collection, CollectionItem } from '$lib/collections/collections';
import { matchesQuery } from '$lib/library/offline/match';
import { parseQuery, type ParsedQuery } from '$lib/library/query/parse';
import type { CatalogBook, GroupTile } from '$lib/library/types';
import type { BookBlur, BookState } from '$lib/sync/book-state';

/**
 * Cover blur (WP7a, decisions "Library UI"; rules for authors, series and collections and
 * the per-device default 2026-11-21):
 *
 * 1. A book's own setting wins: "Always blur" or "Never blur".
 * 2. Otherwise ("Follow rules", also no record) this device's default decides:
 *    - 'all': every cover is blurred;
 *    - 'none': every cover is shown (the rules are ignored on this device);
 *    - 'rules' (the default): blurred when any rule matches the book: one of its tags, one of
 *      its authors, its series, or a collection it is in.
 *
 * A collection's members: a manual collection's list (this device's records); a smart or
 * built-in collection's search, evaluated on the device with the offline Library's matcher
 * (lib/library/offline/match.ts), so a cover blurs the same wherever it appears.
 */

export type CoverBlurDefault = 'rules' | 'all' | 'none';
export const COVER_BLUR_DEFAULTS: readonly CoverBlurDefault[] = ['rules', 'all', 'none'];

export function coverBlurDefault(value: unknown): CoverBlurDefault {
  return COVER_BLUR_DEFAULTS.includes(value as CoverBlurDefault)
    ? (value as CoverBlurDefault)
    : 'rules';
}

export type BlurRuleTarget = 'tag' | 'author' | 'series' | 'collection';

export interface CoverRules {
  tags: ReadonlySet<string>;
  authors: ReadonlySet<string>;
  series: ReadonlySet<string>;
  /** Collection ids (yours or a built-in's). */
  collections: ReadonlySet<string>;
}

export const NO_COVER_RULES: CoverRules = {
  tags: new Set(),
  authors: new Set(),
  series: new Set(),
  collections: new Set()
};

export function hasCoverRule(rules: CoverRules, target: BlurRuleTarget, name: string): boolean {
  return ruleSet(rules, target).has(name);
}

function ruleSet(rules: CoverRules, target: BlurRuleTarget): ReadonlySet<string> {
  switch (target) {
    case 'tag':
      return rules.tags;
    case 'author':
      return rules.authors;
    case 'series':
      return rules.series;
    case 'collection':
      return rules.collections;
  }
}

/**
 * What the rules look at. Lists and Home have whole books; collage tiles carry the same
 * fields (their title, authors, series and length for a smart collection's search).
 */
export interface BlurBook {
  id: string;
  tags: readonly string[];
  title?: string;
  authors?: readonly { name: string }[];
  illustrators?: readonly string[];
  series?: { name: string } | null;
  charCount?: number | null;
}

/** A collage tile as the rules see it. */
export function tileBlurBook(tile: GroupTile): BlurBook {
  return {
    id: tile.bookId,
    tags: tile.tags,
    title: tile.title,
    authors: tile.authors?.map((name) => ({ name })),
    illustrators: tile.illustrators,
    series: tile.series ? { name: tile.series } : null,
    charCount: tile.charCount
  };
}

/** Whether a book is in a collection (see collectionMembership). */
export type InCollection = (book: BlurBook, collectionId: string) => boolean;

export interface CoverBlurContext {
  rules: CoverRules;
  fallback: CoverBlurDefault;
  inCollection?: InCollection;
}

export function isCoverBlurred(
  bookBlur: BookBlur | undefined,
  book: BlurBook,
  ctx: CoverBlurContext
): boolean {
  if (bookBlur === 'always') return true;
  if (bookBlur === 'never') return false;
  if (ctx.fallback === 'all') return true;
  if (ctx.fallback === 'none') return false;
  return ruleMatches(book, ctx);
}

function ruleMatches(book: BlurBook, ctx: CoverBlurContext): boolean {
  const { rules } = ctx;
  if (book.tags.some((tag) => rules.tags.has(tag))) return true;
  if (book.authors?.some((a) => rules.authors.has(a.name))) return true;
  if (book.series && rules.series.has(book.series.name)) return true;
  if (rules.collections.size && ctx.inCollection) {
    for (const id of rules.collections) {
      if (ctx.inCollection(book, id)) return true;
    }
  }
  return false;
}

/**
 * Membership for collection rules, from this device's records. Only collections that have
 * a rule are looked at; a search that doesn't parse holds no books.
 */
export function collectionMembership(input: {
  rules: CoverRules;
  collections: readonly Collection[];
  items: ReadonlyMap<string, readonly CollectionItem[]>;
  states: ReadonlyMap<string, BookState>;
  onDevice?: (bookId: string) => boolean;
  audioOnDevice?: (bookId: string) => boolean;
}): InCollection {
  const lists = new Map<string, Set<string>>();
  const searches = new Map<string, ParsedQuery | null>();
  for (const id of input.rules.collections) {
    const builtin = builtinCollection(id);
    const mine = input.collections.find((c) => c.id === id);
    const query = builtin?.query ?? (mine?.type === 'smart' ? (mine.query ?? '') : null);
    if (query !== null) {
      const parsed = parseQuery(query);
      searches.set(id, parsed.ok ? parsed.query : null);
    } else if (mine) {
      lists.set(id, new Set((input.items.get(id) ?? []).map((i) => i.bookId)));
    }
  }
  const ctx = {
    states: input.states,
    onDevice: input.onDevice ?? (() => false),
    audioOnDevice: input.audioOnDevice ?? (() => false)
  };
  return (book, id) => {
    const list = lists.get(id);
    if (list) return list.has(book.id);
    const search = searches.get(id);
    if (!search) return false;
    return matchesQuery(asCatalogBook(book), search, ctx);
  };
}

/** The fields the matcher reads (title, authors, illustrators, series, tags, length, id). */
function asCatalogBook(book: BlurBook): CatalogBook {
  return {
    id: book.id,
    libraryId: '',
    title: book.title ?? '',
    authors: (book.authors ?? []).map((a) => ({ name: a.name, sort: null })),
    illustrators: [...(book.illustrators ?? [])],
    series: book.series ? { name: book.series.name, index: null } : null,
    tags: [...book.tags],
    addedAt: 0,
    charCount: book.charCount ?? null,
    missing: false,
    thumbnail: null
  };
}
