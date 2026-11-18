/**
 * Stage 4's proposals (WP20d): one per book and field whose value would change, each with the
 * source its value came from, the rule, and auto or review. Nothing here writes to Calibre; in
 * WP20d stage 4 is Preview only, and WP20e adds the AI check before any field is written.
 *
 * - Titles take the decided form (light normalization, Japanese punctuation and edition markers
 *   as printed): the printed source title the rules chose, cut where the rules cut it.
 * - Names get stage 2's name form (normalizeName: ＆ kept) and Calibre's existing spelling.
 * - Stage 2's guards apply: a title or author whose Calibre folder or file name would exceed
 *   255 bytes, and "&" inside a name, go to review.
 * - A value the cleanup wrote and the user changed since (Calibre's value differs from
 *   applied_values) is never proposed automatically.
 */
import {
  N,
  NA,
  cleanTitle,
  cleanTitleV3,
  lightNormalize,
  normalizeName,
  nfkc,
  pyStrip,
} from '../title-rules';
import {
  AMAZON_JP,
  NAME_MAX_BYTES,
  calibreNameBytes,
  isProcessed,
  type SpellingLookup,
} from '../stage2-rules';
import type { Stage2Book } from '../stage2-snapshot';
import { chooseDescription, cleanDescription, type RemovedLine } from './desc';
import type { RefRecord } from './rules-v3';
import type { Stage4Decision } from './stage4-rules';
import type { StoreIds } from './store-links';
import type { Stage4Extras } from './snapshot4';

export const STAGE4_FIELDS = [
  'title',
  'authors',
  'illustrator',
  'series',
  'format',
  'kind',
  'description',
  'cover',
  'identifiers',
  'author_sort',
] as const;
export type Stage4Field = (typeof STAGE4_FIELDS)[number];

export interface Stage4Proposal {
  field: Stage4Field;
  old: unknown;
  new: unknown;
  class: 'auto' | 'review';
  /** Where the value came from (amazon-asin, amazon-search, ranobedb, bookwalker, bookmeter, colophon, file, ndl, generated, rules). */
  source: string;
  reason: string | null;
  evidence?: Record<string, unknown>;
}

export interface CoverCheck {
  fileSide: number | null;
  fileDhash: string | null;
  storeSide: number | null;
  storeDhash: string | null;
  distance: number | null;
  url: string | null;
}

export interface ProposalInput {
  book: Stage2Book;
  extras: Stage4Extras | null;
  record: RefRecord;
  decision: Stage4Decision;
  /** The Bookmeter match that passed acceptance, and its store ids. */
  bookmeter: { id: string; stores: StoreIds } | null;
  natively: string | null;
  /** Reading per author name: NDL's, or a generated one. */
  readings: Map<string, { reading: string; source: 'ndl' | 'generated' }>;
  cover: CoverCheck | null;
  /** The values the cleanup wrote earlier (applied_values), by field. */
  applied: Map<string, unknown>;
  spelling?: SpellingLookup;
  sameDistance: number;
  smallCoverPx: number;
}

const sameNames = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a.map((n) => NA(n)));
  const y = new Set(b.map((n) => NA(n)));
  return x.size === y.size && [...x].every((n) => y.has(n));
};

/** The printed title the rules' value came from, in the decided form. */
export function displayTitle(
  ruleTitle: string,
  sources: (string | null | undefined)[],
  authors: string[],
): string {
  const want = N(ruleTitle);
  for (const raw of sources) {
    if (!raw) continue;
    const d = cleanTitle(raw, authors);
    if (N(cleanTitleV3(d)) === want) return d;
    // The rules cut an appended series name or label: cut the printed title at the same place.
    const words = d.split(' ');
    for (let k = words.length - 1; k >= 1; k--) {
      const prefix = words.slice(0, k).join(' ');
      if (N(cleanTitleV3(prefix)) === want) return prefix;
    }
  }
  return lightNormalize(ruleTitle);
}

const sourceOf = (d: Stage4Decision, record: RefRecord) =>
  (record.amazon as { standin?: string } | undefined)?.standin === 'bookwalker' &&
  d.trace.amazonIdentified
    ? 'bookwalker'
    : d.trace.amazonIdentified
      ? d.trace.amazonByAsin
        ? 'amazon-asin'
        : 'amazon-search'
      : d.trace.ranobedbIdentified
        ? 'ranobedb'
        : 'file';

function userChanged(applied: Map<string, unknown>, field: string, current: unknown): boolean {
  if (!applied.has(field)) return false;
  return JSON.stringify(applied.get(field)) !== JSON.stringify(current);
}

export function proposeStage4(input: ProposalInput): Stage4Proposal[] {
  const { book, extras, record, decision: d } = input;
  const out: Stage4Proposal[] = [];
  const spell = input.spelling ?? ((_k: unknown, n: string) => n);
  const v = d.values;
  const src = sourceOf(d, record);

  const push = (p: Stage4Proposal, current: unknown, appliedField = p.field) => {
    if (JSON.stringify(p.old) === JSON.stringify(p.new)) return;
    if (p.class === 'auto' && userChanged(input.applied, appliedField, current)) {
      p.class = 'review';
      p.reason = 'Changed in Calibre after the cleanup wrote it';
    }
    out.push(p);
  };

  // Title
  const amazonTitle = record.amazon?.product?.title ?? null;
  const title = displayTitle(
    v.t,
    [
      record.file.opf_title,
      amazonTitle,
      record.ranobedb?.book?.title_orig,
      record.bookwalker?.detail?.title,
      book.title,
    ],
    book.authors,
  );
  // Authors in stage 2's name form, Calibre's own spelling for case-only differences.
  const authors = v.au.map((a) => spell('author', normalizeName(a))).filter((a) => a !== '');
  const firstAuthor = authors[0] ?? book.authors[0] ?? 'Unknown';
  const tooLong = calibreNameBytes(book.calibreId, title, firstAuthor) > NAME_MAX_BYTES;

  if (N(title) !== N(book.title) || title !== book.title) {
    let cls: 'auto' | 'review' = d.auto.t ? 'auto' : 'review';
    let reason = d.auto.t ? null : 'The online sources do not confirm the title';
    if (tooLong) {
      cls = 'review';
      reason = "Too long for a folder name in Calibre's library";
    }
    push(
      {
        field: 'title',
        old: book.title,
        new: title,
        class: cls,
        source: d.auto.t ? src : 'file',
        reason,
      },
      book.title,
    );
  }

  if (authors.length && !sameNames(authors, book.authors)) {
    let cls: 'auto' | 'review' = d.auto.au ? 'auto' : 'review';
    let reason = d.auto.au ? null : 'The online sources do not confirm the authors';
    if (authors.some((a) => a.includes('&'))) {
      cls = 'review';
      reason = 'A name holds "&", which Calibre splits into two names';
    } else if (tooLong) {
      cls = 'review';
      reason = "Too long for a folder name in Calibre's library";
    }
    push(
      {
        field: 'authors',
        old: book.authors,
        new: authors,
        class: cls,
        source: d.auto.au ? src : 'file',
        reason,
      },
      book.authors,
    );
  }

  // Illustrators (#illustrator)
  if (book.illustrators !== null) {
    const ill = v.il.map((a) => spell('illustrator', normalizeName(a))).filter((a) => a !== '');
    if (!sameNames(ill, book.illustrators)) {
      let cls: 'auto' | 'review' = d.auto.il ? 'auto' : 'review';
      let reason = d.auto.il ? null : 'The online sources do not confirm the illustrators';
      if (ill.some((a) => a.includes('&'))) {
        cls = 'review';
        reason = 'A name holds "&", which Calibre splits into two names';
      }
      const isrc =
        d.trace.ranobedbIdentified && v.il.length
          ? 'ranobedb'
          : d.trace.amazonIdentified
            ? src
            : 'colophon';
      push(
        {
          field: 'illustrator',
          old: book.illustrators,
          new: ill,
          class: cls,
          source: isrc,
          reason,
        },
        book.illustrators,
      );
    }
  }

  // Series and number together (Calibre's series and series_index).
  const index = v.ix ?? d.numberGuess?.value ?? null;
  const series = v.se ? pyStrip(lightNormalize(v.se)) : null;
  const oldSeries = { name: extras?.series ?? null, index: extras?.seriesIndex ?? null };
  const newSeries = { name: series, index: series ? index : null };
  if (N(newSeries.name ?? '') !== N(oldSeries.name ?? '') || newSeries.index !== oldSeries.index) {
    const auto = d.auto.se && (newSeries.name === null || d.auto.ix);
    push(
      {
        field: 'series',
        old: oldSeries,
        new: newSeries,
        class: auto ? 'auto' : 'review',
        source:
          d.trace.amazonIdentified && d.trace.amazon?.se
            ? src
            : d.trace.ranobedbIdentified
              ? 'ranobedb'
              : 'rules',
        reason: auto
          ? null
          : !d.auto.se
            ? 'The online sources do not confirm the series'
            : d.numberGuess
              ? `The number is a best guess (${d.numberGuess.rule})`
              : 'The online sources do not confirm the number',
      },
      oldSeries,
    );
  }

  // Format and edition kind (no Calibre field yet; stage 5 makes the format a tag).
  push(
    {
      field: 'format',
      old: null,
      new: v.fmt,
      class: d.auto.fmt ? 'auto' : 'review',
      source: d.auto.fmt ? src : 'rules',
      reason: d.auto.fmt ? null : (d.amazonRejected ?? 'Amazon does not confirm the format'),
    },
    null,
  );
  push(
    {
      field: 'kind',
      old: null,
      new: v.kind,
      class: 'auto',
      source: 'file',
      reason: null,
      evidence: d.kindMarker ? { marker: d.kindMarker } : undefined,
    },
    null,
  );

  // Description
  const { source: dsrc, text } = chooseDescription(record);
  if (text) {
    const cleaned = cleanDescription(text);
    if (cleaned.text !== (extras?.comments ?? '')) {
      push(
        {
          field: 'description',
          old: extras?.comments ?? null,
          new: cleaned.text,
          class: 'auto',
          source: dsrc ?? 'none',
          reason: null,
          evidence: cleaned.removed.length
            ? { removed: cleaned.removed as RemovedLine[] }
            : undefined,
        },
        extras?.comments ?? null,
        'description',
      );
    }
  } else if (isProcessed(book.tags) && extras?.comments) {
    push(
      {
        field: 'description',
        old: extras.comments,
        new: '',
        class: 'auto',
        source: 'rules',
        reason: null,
        evidence: { rule: 'No confirmed description; the Google Books run wrote this one' },
      },
      extras.comments,
    );
  }

  // Cover: only a small file cover replaced by the same picture; a 帯 cover only without any cover.
  const c = input.cover;
  if (c && c.url && c.storeSide !== null) {
    const noCover = !book.hasCover && c.fileSide === null;
    const small = c.fileSide !== null && c.fileSide < input.smallCoverPx;
    const same = c.distance !== null && c.distance <= input.sameDistance;
    if ((small && same && c.storeSide > (c.fileSide ?? 0)) || noCover) {
      push(
        {
          field: 'cover',
          old: book.hasCover,
          new: { url: c.url, side: c.storeSide },
          class: 'auto',
          source: src,
          reason: null,
          evidence: { ...c },
        },
        book.hasCover,
      );
    } else if (small || noCover) {
      push(
        {
          field: 'cover',
          old: book.hasCover,
          new: { url: c.url, side: c.storeSide },
          class: 'review',
          source: src,
          reason: same
            ? 'The store cover is not larger'
            : 'The store cover is another picture (a 帯 version or another edition)',
          evidence: { ...c },
        },
        book.hasCover,
      );
    }
  }

  // Identifiers: the fixed keys, ids only from accepted matches (decided 2026-11-15).
  const accepted = d.auto.t && d.auto.au && d.auto.fmt && (d.auto.ix || v.se === null);
  const ids: Record<string, string> = { ...book.identifiers };
  const added: Record<string, string> = {};
  const add = (k: string, val: string | null | undefined) => {
    if (!val || ids[k] === val) return;
    if (ids[k] && ids[k] !== val) return; // never replace an id Calibre already has
    ids[k] = val;
    added[k] = val;
  };
  const prod = record.amazon?.product as { asin?: string | null } | null | undefined;
  if (d.trace.amazonIdentified && accepted) add(AMAZON_JP, prod?.asin ?? null);
  if (d.trace.ranobedbIdentified && accepted)
    add('ranobedb', record.ranobedb?.book?.id != null ? String(record.ranobedb.book.id) : null);
  const bwUrl = (record.bookwalker?.detail as { url?: string } | null | undefined)?.url;
  const bwId = bwUrl ? /bookwalker\.jp\/de([0-9a-f-]{36})/.exec(bwUrl)?.[1] : null;
  if (accepted && bwId && d.trace.cleaned.bookwalker && N(d.trace.cleaned.bookwalker) === N(v.t))
    add('bookwalker', bwId);
  if (input.bookmeter) {
    add('bookmeter', input.bookmeter.id);
    const st = input.bookmeter.stores;
    add('isbn', st.isbn);
    add('rakuten', st.rakuten);
    add('honto', st.honto);
    add('ebookjapan', st.ebookjapan);
    add('unext', st.unext);
    if (!ids.bookwalker) add('bookwalker', st.bookwalker);
  }
  add('natively', input.natively);
  if (Object.keys(added).length) {
    push(
      {
        field: 'identifiers',
        old: book.identifiers,
        new: ids,
        class: 'auto',
        source: Object.keys(added).join(','),
        reason: null,
        evidence: { added },
      },
      book.identifiers,
    );
  }

  // Author readings (author_sort), credited to Web NDL Authorities; generated ones marked.
  const names = authors.length ? authors : book.authors;
  const parts = names.map((n) => input.readings.get(n) ?? input.readings.get(nfkc(n)));
  if (names.length && parts.every((p) => p)) {
    const sort = parts.map((p) => p!.reading).join(' & ');
    const generated = parts.some((p) => p!.source === 'generated');
    if (sort !== book.authorSort) {
      push(
        {
          field: 'author_sort',
          old: book.authorSort,
          new: sort,
          class: 'auto',
          source: generated ? 'generated' : 'ndl',
          reason: generated ? 'Generated reading: listed for spot checks' : null,
          evidence: { credit: 'Web NDL Authorities', names },
        },
        book.authorSort,
      );
    }
  }
  return out;
}
