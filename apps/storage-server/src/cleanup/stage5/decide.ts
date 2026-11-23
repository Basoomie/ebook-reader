/**
 * Stage 5's decisions (WP20f), pure:
 *
 *   own(book)     Haiku AND Luna per id (a term only when both give it), RanobeDB's series tags
 *                 (accepted matches only, mapped by vocab.ts), the store rules (BL, TL, adult
 *                 imprints), and the adaptation tags (RanobeDB's tie-ins, or both models AND the
 *                 statement in the text: never guessed)
 *   per book      each book keeps its own terms (decided with the user 2026-11-21 at stop 1:
 *                 the union per series of 2026-11-13 put genres at 86.4 % and tags at 77.4 %
 *                 right on the blind labels; per book 96.2 % / 96.5 %). `seriesUnion` with no
 *                 series gives exactly that; a series name groups volumes where a union is
 *                 wanted again
 *   change        the labels to add (and the format tag) and the tags to remove (the approved
 *                 list; never a custom tag), against the book's tags in Calibre now
 */
import { isCustomTag } from '../settings';
import type { Stage5Answer } from './prompt';
import {
  BY_ID,
  FORMAT_TAGS,
  GENRE_IDS,
  SUBJECT_IDS,
  TAG_IDS,
  fromRanobedb,
  fromStoreCategories,
  isRemovedTag,
  label,
} from './vocab';
import type { Format } from '../stage4/rules-v3';

/** Raised when a decision rule or the mapping changes (decided again, nobody asked). */
export const STAGE5_RULES_VERSION = 2;

export type Source = 'models' | 'ranobedb' | 'store';

/** One book's own terms, with where each came from. */
export interface OwnTerms {
  /** id → its sources on this book. */
  terms: Record<string, Source[]>;
  /** Both models answered (else no term from the models). */
  asked: boolean;
  /** Terms one model gave and the other didn't (kept for the report and a later upgrade). */
  oneModel: number;
}

const ANIME_WORDS = /アニメ/;
const MANGA_WORDS = /コミカライズ|漫画化|マンガ化/;

export interface OwnInputs {
  primary: Stage5Answer | null;
  secondary: Stage5Answer | null;
  /** The accepted RanobeDB match's series tags (null = no accepted match). */
  ranobedbTags: { name?: unknown; type?: unknown }[] | null;
  /** The identified Amazon record's categories. */
  storeCategories: string[];
  /** The description, the store notes and the categories: where a statement must be. */
  adaptationText: string;
}

export function ownTerms(i: OwnInputs): OwnTerms {
  const terms: Record<string, Source[]> = {};
  const add = (id: string, s: Source) => {
    const l = (terms[id] ??= []);
    if (!l.includes(s)) l.push(s);
  };
  const a = i.primary;
  const b = i.secondary;
  let oneModel = 0;
  if (a && b) {
    for (const k of ['genres', 'subjects', 'tags'] as const) {
      const bs = new Set(b[k]);
      for (const id of a[k]) if (bs.has(id)) add(id, 'models');
      const as = new Set(a[k]);
      oneModel += a[k].filter((x) => !bs.has(x)).length + b[k].filter((x) => !as.has(x)).length;
    }
    if (a.anime && b.anime && ANIME_WORDS.test(i.adaptationText)) add('anime', 'models');
    if (a.manga && b.manga && MANGA_WORDS.test(i.adaptationText)) add('manga', 'models');
  }
  if (i.ranobedbTags) for (const id of fromRanobedb(i.ranobedbTags)) add(id, 'ranobedb');
  for (const id of fromStoreCategories(i.storeCategories)) add(id, 'store');
  return { terms, asked: !!(a && b), oneModel };
}

/** Where a series' term came from: which books, by which source. */
export interface UnionTerm {
  sources: Source[];
  /** Calibre ids of the volumes that had it (a few kept for the evidence). */
  books: number[];
  count: number;
}

/**
 * The union per series. `series` maps a book to its Calibre series name (null = standalone).
 * Returns per book: every term it gets and from where. Linear in the books (lessons 3: no
 * pair structures; a Map per series name, at most the library's 9,000 series).
 */
export function seriesUnion(
  books: { calibreId: number; series: string | null; own: OwnTerms }[],
): Map<number, Record<string, UnionTerm>> {
  const bySeries = new Map<string, Record<string, UnionTerm>>();
  const add = (into: Record<string, UnionTerm>, id: string, s: Source[], book: number) => {
    const t = (into[id] ??= { sources: [], books: [], count: 0 });
    for (const x of s) if (!t.sources.includes(x)) t.sources.push(x);
    t.count += 1;
    if (t.books.length < 5) t.books.push(book);
  };
  for (const b of books) {
    if (b.series === null) continue;
    const u = bySeries.get(b.series) ?? {};
    for (const [id, s] of Object.entries(b.own.terms)) add(u, id, s, b.calibreId);
    bySeries.set(b.series, u);
  }
  const out = new Map<number, Record<string, UnionTerm>>();
  for (const b of books) {
    if (b.series !== null) {
      out.set(b.calibreId, bySeries.get(b.series) ?? {});
      continue;
    }
    const own: Record<string, UnionTerm> = {};
    for (const [id, s] of Object.entries(b.own.terms)) add(own, id, s, b.calibreId);
    out.set(b.calibreId, own);
  }
  return out;
}

/** The ids by kind (for the page, the gate and the evidence). */
export function byKind(ids: Iterable<string>): {
  genres: string[];
  subjects: string[];
  tags: string[];
  adaptations: string[];
} {
  const all = [...ids].sort();
  return {
    genres: all.filter((x) => GENRE_IDS.has(x)),
    subjects: all.filter((x) => SUBJECT_IDS.has(x)),
    tags: all.filter((x) => TAG_IDS.has(x)),
    adaptations: all.filter((x) => BY_ID.get(x)?.kind === 'adaptation'),
  };
}

export interface TagChange {
  add: string[];
  remove: string[];
}

/**
 * The change to a book's Calibre tags. `ids` are the terms it gets (null for a book stage 4
 * never read: removals only), `format` stage 4's decided format, `current` its tags now,
 * `addedBefore` the labels the cleanup added to it earlier (one now missing was removed by the
 * user and is never added again).
 */
export function tagChange(
  ids: Iterable<string> | null,
  format: Format | null,
  current: readonly string[],
  customTags: readonly string[],
  addedBefore: readonly string[] = [],
  /**
   * New books: "Tags you can pick" (tag-list.ts): a term's label, or null when it isn't on the
   * list (left out); a format's label likewise. Without it, stage 5's own vocabulary.
   */
  list?: { label: (id: string) => string | null; format: (f: Format) => string | null },
): TagChange {
  const have = new Set(current.map((t) => t.toLowerCase()));
  const removedByUser = new Set(
    addedBefore.map((t) => t.toLowerCase()).filter((t) => !have.has(t)),
  );
  const labels = new Set<string>();
  if (ids)
    for (const id of ids) {
      const l = list ? list.label(id) : label(id);
      if (l) labels.add(l);
    }
  if (ids && format) {
    const fl = list ? list.format(format) : (FORMAT_TAGS[format]?.ja ?? null);
    if (fl) labels.add(fl);
  }
  const add = [...labels]
    .filter((l) => !have.has(l.toLowerCase()) && !removedByUser.has(l.toLowerCase()))
    .sort();
  const remove = current.filter((t) => isRemovedTag(t) && !isCustomTag(t, [...customTags]));
  return { add, remove };
}

/**
 * The tags Calibre should hold after the change, from what it holds now (read at the write,
 * so a tag added in Calibre since the proposal stays). Compared ignoring case, as Calibre
 * does. A custom tag is never removed, whatever the change says.
 */
export function applyTagChange(
  current: readonly string[],
  change: TagChange,
  customTags: readonly string[],
): string[] {
  const drop = new Set(
    change.remove.filter((t) => !isCustomTag(t, [...customTags])).map((t) => t.toLowerCase()),
  );
  const out = current.filter((t) => !drop.has(t.toLowerCase()));
  const have = new Set(out.map((t) => t.toLowerCase()));
  for (const t of change.add) {
    if (t.includes(',')) continue; // Calibre separates tags with commas
    if (!have.has(t.toLowerCase())) {
      out.push(t);
      have.add(t.toLowerCase());
    }
  }
  return out;
}

/** Undo: the cleanup's additions taken off, its removals put back (the user's later tags stay). */
export function undoTagChange(
  current: readonly string[],
  record: { added: string[]; removed: string[] },
): string[] {
  const added = new Set(record.added.map((t) => t.toLowerCase()));
  const out = current.filter((t) => !added.has(t.toLowerCase()));
  const have = new Set(out.map((t) => t.toLowerCase()));
  for (const t of record.removed) if (!have.has(t.toLowerCase())) out.push(t);
  return out;
}

/** Two tag lists hold the same tags (ignoring case and order). */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a.map((t) => t.toLowerCase()));
  const y = new Set(b.map((t) => t.toLowerCase()));
  return x.size === y.size && [...x].every((t) => y.has(t));
}
