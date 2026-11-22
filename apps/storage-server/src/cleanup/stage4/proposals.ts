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
  looksLikeMojibake,
  normalizeName,
  nfkc,
  pyStrip,
} from '../title-rules';
import {
  AMAZON_JP,
  hammingHex,
  NAME_MAX_BYTES,
  calibreNameBytes,
  isProcessed,
  type SpellingLookup,
} from '../stage2-rules';
import type { Stage2Book } from '../stage2-snapshot';
import { sameTime } from '../stage2-batches';
import { chooseDescription, cleanDescription, type RemovedLine } from './desc';
import type { RefRecord } from './rules-v3';
import type { Stage4Decision } from './stage4-rules';
import { isConfirmed, type AiFieldKey, type Stage4AiValues } from './ai-decide';

const AI_SOURCE_TEXT: Record<string, string> = {
  secondary_guess: "the second model's answer",
  rules_guess: "the rules' value",
  unknown: 'nobody knows',
  both_models: 'both models',
  rules: 'the rules',
  user: 'your value',
  upgrade_models: 'the stronger models',
};
const aiSourceText = (src: string) => AI_SOURCE_TEXT[src] ?? src;

const GARBLE_FIELDS = new Set(['title', 'authors', 'illustrator', 'series']);
const garbled = (v: unknown): boolean =>
  typeof v === 'string'
    ? looksLikeMojibake(v)
    : Array.isArray(v)
      ? v.some((x) => typeof x === 'string' && looksLikeMojibake(x))
      : !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
        ? looksLikeMojibake((v as { name: string }).name)
        : false;
import type { StoreIds } from './store-links';
import { seriesKey, spellingOf } from './series-spelling';
import type { SeriesChoice } from './series-order';
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
  /** The AI's decided values (ai_values, so a user value wins); none = the rules alone. */
  ai?: (Stage4AiValues & { asked: boolean }) | null;
  /** Calibre's last_modified right after the cleanup's write, by field. */
  appliedLastModified?: Map<string, string | null>;
  /**
   * Calibre's cover as it is now, read from its cover.jpg; only needed when the cleanup wrote
   * this book's cover (applied 'cover'). Undefined = not read: the cover counts as changed.
   */
  calibreCover?: CalibreCoverNow | null;
  spelling?: SpellingLookup;
  /** The chosen spelling per series key (series-spelling.ts); none = names as decided. */
  seriesSpelling?: ReadonlyMap<string, string> | null;
  /**
   * The series step's choice for this book (series-order.ts, stage4_series_order): its number,
   * a title with its number, a best guess with its reason, or a problem for review.
   */
  seriesOrder?: SeriesChoice | null;
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

/** Calibre's cover.jpg now: its sha256 and difference hash (null when it can't be read). */
export interface CalibreCoverNow {
  sha256: string;
  dhash: string | null;
}

const lowerNames = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()) : null;
const sameIds = (a: unknown, b: unknown): boolean => {
  const norm = (x: unknown) => {
    const o: Record<string, string> = {};
    if (x && typeof x === 'object' && !Array.isArray(x))
      for (const [k, v] of Object.entries(x as Record<string, unknown>))
        if (typeof v === 'string') o[k.toLowerCase()] = v;
    return o;
  };
  const x = norm(a);
  const y = norm(b);
  const kx = Object.keys(x).sort();
  const ky = Object.keys(y).sort();
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && x[k] === y[k]);
};

/**
 * Whether Calibre still holds the value the cleanup wrote, compared the way the write path
 * compares it (stage 2's fieldEquals): identifiers whatever the key order, names ignoring case
 * (Calibre may keep a spelling it knows), the cover by its bytes. WP20e: the plain JSON
 * comparison sent 1,081 covers (a hash against Calibre's has_cover flag) and 3,578 store-link
 * changes (the same ids in another order) to review although nothing had changed.
 */
export function stillAsWritten(
  field: string,
  written: unknown,
  current: unknown,
  cover?: {
    hasCover: boolean;
    now: CalibreCoverNow | null | undefined;
    fileDhash: string | null;
    sameDistance: number;
    /** Calibre's last_modified now, and right after the cleanup's write. */
    lastModified?: string | null;
    writtenLastModified?: string | null;
  },
): boolean {
  switch (field) {
    case 'identifiers':
      return sameIds(written, current);
    case 'authors':
    case 'illustrator': {
      const a = lowerNames(written);
      const b = lowerNames(current);
      return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
    }
    case 'cover': {
      if (!cover || !cover.hasCover || !cover.now) return false;
      const w = (written ?? {}) as { sha256?: string; mediaType?: string };
      if (w.sha256 && w.sha256 === cover.now.sha256) return true;
      // Calibre stores a JPEG as given (1,651 of 1,651 identical, measured); other types it
      // converts to JPEG: the same picture, or nothing written to the book since the write.
      if (w.mediaType === 'image/jpeg') return false;
      const d = hammingHex(cover.fileDhash, cover.now.dhash);
      if (d !== null && d <= cover.sameDistance) return true;
      return !!cover.writtenLastModified && sameTime(cover.lastModified, cover.writtenLastModified);
    }
    case 'series': {
      const a = (written ?? {}) as { name?: string | null; index?: number | null };
      const b = (current ?? {}) as { name?: string | null; index?: number | null };
      if ((a.name ?? null) !== (b.name ?? null)) return false;
      // Calibre stores a series written with no number as number 1 (series-order stop 2:
      // (仮)花嫁 vol 8, written with none, went to review as "changed in Calibre").
      const ai = a.index ?? null;
      const bi = b.index ?? null;
      return ai === bi || (ai === null && a.name != null && bi === 1);
    }
    default:
      return JSON.stringify(written ?? null) === JSON.stringify(current ?? null);
  }
}

export function proposeStage4(input: ProposalInput): Stage4Proposal[] {
  const { book, extras, record, decision: d } = input;
  const out: Stage4Proposal[] = [];
  const spell = input.spelling ?? ((_k: unknown, n: string) => n);
  const v = d.values;
  const src = sourceOf(d, record);

  const coverNow = {
    hasCover: book.hasCover,
    now: input.calibreCover,
    fileDhash: input.cover?.fileDhash ?? null,
    sameDistance: input.sameDistance,
    lastModified: book.lastModified,
  };
  const push = (p: Stage4Proposal, current: unknown, appliedField = p.field) => {
    if (JSON.stringify(p.old) === JSON.stringify(p.new)) return;
    // Written already and still as written: not proposed again. A cover's "before" is only "has
    // a cover", never the value written (series-order stop 1: deciding again proposed all 1,290
    // written covers once more).
    if (
      input.applied.has(appliedField) &&
      stillAsWritten(appliedField, input.applied.get(appliedField), current, {
        ...coverNow,
        writtenLastModified: input.appliedLastModified?.get(appliedField) ?? null,
      })
    ) {
      if (JSON.stringify(input.applied.get(appliedField)) === JSON.stringify(p.new)) return;
      // A cover is stored as the file written: the same store picture as Calibre's cover now.
      const d =
        p.field === 'cover' && input.calibreCover
          ? hammingHex(input.cover?.storeDhash ?? null, input.calibreCover.dhash)
          : null;
      if (d !== null && d <= input.sameDistance) return;
    }
    // Garbled text (a file read in the wrong encoding) never goes into Calibre (lessons 2),
    // whichever source gave it: the AI's fallback to the rules' guess found one (WP20e stop 1).
    if (p.class === 'auto' && GARBLE_FIELDS.has(p.field) && garbled(p.new)) {
      p.class = 'review';
      p.reason = 'The value is garbled (wrong text encoding)';
    }
    if (
      p.class === 'auto' &&
      input.applied.has(appliedField) &&
      !stillAsWritten(appliedField, input.applied.get(appliedField), current, {
        hasCover: book.hasCover,
        now: input.calibreCover,
        fileDhash: input.cover?.fileDhash ?? null,
        sameDistance: input.sameDistance,
        lastModified: book.lastModified,
        writtenLastModified: input.appliedLastModified?.get(appliedField) ?? null,
      })
    ) {
      p.class = 'review';
      p.reason = 'Changed in Calibre after the cleanup wrote it';
    }
    out.push(p);
  };

  // The value and class of each scored field: the AI's decision (setup E) when the models
  // were asked about this book, else the rules' (WP20d). A flagged AI field is written as its
  // best guess, marked unconfirmed (plan section 6: "flagged fields are never left as they
  // are"); the guards below (name length, "&", changed in Calibre) still send it to review.
  const ai = input.ai && input.ai.asked ? input.ai : null;
  const field = <V>(k: AiFieldKey, rulesValue: V, rulesAuto: boolean, rulesReason: string) => {
    const a = ai?.[k];
    if (!a)
      return {
        value: rulesValue as V | null,
        auto: rulesAuto,
        unconfirmed: false,
        reason: rulesAuto ? null : rulesReason,
        ai: null as { source: string; flagged: boolean; reason: string | null } | null,
      };
    const confirmed = isConfirmed(a);
    return {
      value: (a.value ?? null) as V | null,
      auto: true,
      unconfirmed: !confirmed,
      reason: confirmed
        ? null
        : `Unconfirmed (${aiSourceText(a.source)}): ${a.reason ?? 'the models do not settle it'}`,
      ai: { source: a.source, flagged: a.flagged, reason: a.reason } as {
        source: string;
        flagged: boolean;
        reason: string | null;
      } | null,
    };
  };
  const withAi = (p: Stage4Proposal, x: { unconfirmed: boolean; ai: unknown }): Stage4Proposal =>
    x.ai
      ? {
          ...p,
          evidence: {
            ...(p.evidence ?? {}),
            ai: x.ai,
            ...(x.unconfirmed ? { unconfirmed: true } : {}),
          },
        }
      : p;
  const srcOf = (x: { ai: { source: string } | null }, rulesSrc: string) =>
    x.ai && x.ai.source !== 'rules' ? `ai:${x.ai.source}` : rulesSrc;

  // Title
  const ft = field<string>('t', v.t, d.auto.t, 'The online sources do not confirm the title');
  const amazonTitle = record.amazon?.product?.title ?? null;
  // The series step's title (the store's form with the volume number, or the file's own when
  // the models added a number no source prints).
  const soTitle = input.seriesOrder?.title ?? null;
  const title = soTitle
    ? soTitle
    : ft.ai && ft.ai.source !== 'rules'
      ? ft.value
        ? pyStrip(lightNormalize(ft.value))
        : null
      : displayTitle(
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
  const fau = field<string[]>(
    'au',
    v.au,
    d.auto.au,
    'The online sources do not confirm the authors',
  );
  const authors = (fau.value ?? [])
    .map((a) => spell('author', normalizeName(a)))
    .filter((a) => a !== '');
  const firstAuthor = authors[0] ?? book.authors[0] ?? 'Unknown';
  const tooLong =
    calibreNameBytes(book.calibreId, title ?? book.title, firstAuthor) > NAME_MAX_BYTES;

  if (title && (N(title) !== N(book.title) || title !== book.title)) {
    let cls: 'auto' | 'review' = ft.auto ? 'auto' : 'review';
    let reason = ft.reason;
    if (tooLong) {
      cls = 'review';
      reason = "Too long for a folder name in Calibre's library";
    }
    if (soTitle && !tooLong) {
      cls = 'auto';
      reason = null;
    }
    const titleProposal: Stage4Proposal = {
      field: 'title',
      old: book.title,
      new: title,
      class: cls,
      source: soTitle ? 'series-order' : srcOf(ft, ft.auto && !ft.unconfirmed ? src : 'file'),
      reason,
    };
    push(
      soTitle
        ? {
            ...titleProposal,
            evidence: { seriesOrder: { title: input.seriesOrder?.titleFrom ?? null } },
          }
        : withAi(titleProposal, ft),
      book.title,
    );
  }

  // The authors Calibre holds after the write: the decided ones only when written automatically.
  let authorsAfter = book.authors;
  if (authors.length && !sameNames(authors, book.authors)) {
    let cls: 'auto' | 'review' = fau.auto ? 'auto' : 'review';
    let reason = fau.reason;
    if (authors.some((a) => a.includes('&'))) {
      cls = 'review';
      reason = 'A name holds "&", which Calibre splits into two names';
    } else if (tooLong) {
      cls = 'review';
      reason = "Too long for a folder name in Calibre's library";
    }
    if (cls === 'auto') authorsAfter = authors;
    push(
      withAi(
        {
          field: 'authors',
          old: book.authors,
          new: authors,
          class: cls,
          source: srcOf(fau, fau.auto && !fau.unconfirmed ? src : 'file'),
          reason,
        },
        fau,
      ),
      book.authors,
    );
  }

  // Illustrators (#illustrator)
  if (book.illustrators !== null) {
    const fil = field<string[]>(
      'il',
      v.il,
      d.auto.il,
      'The online sources do not confirm the illustrators',
    );
    const ill = (fil.value ?? [])
      .map((a) => spell('illustrator', normalizeName(a)))
      .filter((a) => a !== '');
    if (fil.value !== null && !sameNames(ill, book.illustrators)) {
      let cls: 'auto' | 'review' = fil.auto ? 'auto' : 'review';
      let reason = fil.reason;
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
        withAi(
          {
            field: 'illustrator',
            old: book.illustrators,
            new: ill,
            class: cls,
            source: srcOf(fil, isrc),
            reason,
          },
          fil,
        ),
        book.illustrators,
      );
    }
  }

  // Series and number together (Calibre's series and series_index).
  const fse = field<{ name: string | null }>(
    'se',
    { name: v.se },
    d.auto.se,
    'The online sources do not confirm the series',
  );
  const fix = field<{ n: number | null }>(
    'ix',
    { n: v.ix ?? d.numberGuess?.value ?? null },
    d.auto.ix,
    d.numberGuess
      ? `The number is a best guess (${d.numberGuess.rule})`
      : 'The online sources do not confirm the number',
  );
  const seName = fse.value?.name ?? null;
  const decidedSeries = seName ? pyStrip(lightNormalize(seName)) : null;
  // One spelling per series across the library (series-spelling.ts); a value the user set is
  // never changed.
  const respell = (n: string | null) =>
    n && input.seriesSpelling && fse.ai?.source !== 'user'
      ? spellingOf(input.seriesSpelling, n)
      : n;
  const oldName = extras?.series ?? null;
  // A series name stage 4 wrote and Calibre still holds keeps its spelling when the decision
  // names the same series: only its number may change (series-order stop 2: index-only changes
  // counted with the decided spelling flipped the one-spelling choice of 21 series and respelled
  // 346 books, 〈Infinite Dendrogram〉 to <Infinite Dendrogram>, ！ to !).
  const writtenName =
    oldName &&
    fse.ai?.source !== 'user' &&
    input.applied.has('series') &&
    stillAsWritten('series', input.applied.get('series'), {
      name: oldName,
      index: extras?.seriesIndex ?? null,
    }) &&
    ((input.applied.get('series') ?? {}) as { name?: string | null }).name === oldName
      ? oldName
      : null;
  const keepWritten =
    !!writtenName && !!decidedSeries && seriesKey(decidedSeries) === seriesKey(writtenName);
  const series = keepWritten ? writtenName : respell(decidedSeries);
  const spelling = keepWritten
    ? { spelling: { asDecided: writtenName } }
    : series !== decidedSeries
      ? { spelling: { asDecided: decidedSeries } }
      : undefined;
  // The series step's choice (series-order.ts): the number from what the series' sources print,
  // a best guess marked with its reason, or a problem for review.
  const so = series ? (input.seriesOrder ?? null) : null;
  const index = so ? so.index : (fix.value?.n ?? null);
  const oldSeries = { name: extras?.series ?? null, index: extras?.seriesIndex ?? null };
  const newSeries = { name: series, index: series ? index : null };
  let seriesProposed = false;
  if (
    fse.value !== null &&
    (N(newSeries.name ?? '') !== N(oldSeries.name ?? '') ||
      newSeries.index !== oldSeries.index ||
      (newSeries.name !== null && newSeries.name !== oldSeries.name && spelling !== undefined))
  ) {
    seriesProposed = true;
    // A series stage 4 wrote is never removed automatically: removing it means the evidence it
    // was written from changed (series-order stop 2: 31 books whose pick changed would have lost
    // ハリー・ポッター #6, 源氏物語 #42, 十津川警部シリーズ #56…). It goes to review.
    const removesWritten = newSeries.name === null && !!writtenName;
    const auto =
      !removesWritten &&
      (so ? fse.auto && !so.review : fse.auto && (newSeries.name === null || fix.auto));
    const unconfirmed = so
      ? fse.unconfirmed || so.guess
      : fse.unconfirmed || (newSeries.name !== null && fix.unconfirmed);
    const both = {
      unconfirmed,
      ai: fse.ai || fix.ai ? { series: fse.ai, number: fix.ai } : null,
    };
    push(
      withAi(
        {
          field: 'series',
          old: oldSeries,
          new: newSeries,
          class: auto ? 'auto' : 'review',
          source: srcOf(
            fse.ai && fse.ai.source !== 'rules' ? fse : fix,
            d.trace.amazonIdentified && d.trace.amazon?.se
              ? src
              : d.trace.ranobedbIdentified
                ? 'ranobedb'
                : 'rules',
          ),
          reason: removesWritten
            ? 'Would remove a series the cleanup wrote'
            : so
              ? (so.review ??
                (fse.unconfirmed || !fse.auto ? fse.reason : so.guess ? so.reason : null))
              : auto && !unconfirmed
                ? null
                : fse.unconfirmed || !fse.auto
                  ? fse.reason
                  : fix.reason,
          evidence:
            so || spelling
              ? {
                  ...(spelling ?? {}),
                  ...(so
                    ? {
                        seriesOrder: { from: so.from, ...(so.reason ? { reason: so.reason } : {}) },
                      }
                    : {}),
                }
              : undefined,
        },
        both,
      ),
      oldSeries,
    );
  }
  // Calibre's own name kept (no change proposed) but spelled another way than the series' chosen
  // spelling: only the spelling changes, the number stays.
  const chosenNow = respell(oldSeries.name);
  if (
    !seriesProposed &&
    !writtenName &&
    oldSeries.name &&
    chosenNow &&
    chosenNow !== oldSeries.name
  ) {
    push(
      {
        field: 'series',
        old: oldSeries,
        new: { name: chosenNow, index: oldSeries.index },
        class: 'auto',
        source: 'spelling',
        reason: null,
        evidence: { spelling: { asDecided: oldSeries.name } },
      },
      oldSeries,
    );
  }

  // Format and edition kind (no Calibre field yet; stage 5 makes the format a tag).
  const ffmt = field<string>(
    'fmt',
    v.fmt,
    d.auto.fmt,
    d.amazonRejected ?? 'Amazon does not confirm the format',
  );
  if (ffmt.value !== null)
    push(
      withAi(
        {
          field: 'format',
          old: null,
          new: ffmt.value,
          class: ffmt.auto ? 'auto' : 'review',
          source: srcOf(ffmt, ffmt.auto && !ffmt.unconfirmed ? src : 'rules'),
          reason: ffmt.reason,
        },
        ffmt,
      ),
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
  // The description case of setup E: both models say Amazon's result is this book (not when the
  // rules set Amazon aside: it lists the book as manga while the file has text).
  const { source: dsrc, text } = chooseDescription(
    record,
    !!input.ai?.asked && !!input.ai.amazonIsBook && !d.amazonRejected,
  );
  if (text) {
    const cleaned = cleanDescription(text);
    if (cleaned.text !== (extras?.comments ?? '') && !onlySpacing(extras?.comments, cleaned.text)) {
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
  } else if (isProcessed(book.tags, book.marks) && extras?.comments) {
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
          evidence: { ...c, hadCover: book.hasCover, lastModified: book.lastModified },
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
          evidence: { ...c, hadCover: book.hasCover, lastModified: book.lastModified },
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
  // Of the authors Calibre holds after the write (a reading for authors left to review would not
  // match the names Calibre shows).
  const names = authorsAfter;
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

/**
 * A description that differs from Calibre's only by its spacing, without more paragraph breaks:
 * no change (the live run of 2026-11-22 proposed 180 such, most taking the breaks away: the same
 * store text formatted another way by another source).
 */
export function onlySpacing(now: string | null | undefined, next: string): boolean {
  if (!now) return false;
  const bare = (s: string) => s.replace(/\s+/gu, '');
  if (bare(now) !== bare(next)) return false;
  const breaks = (s: string) => (s.match(/\n/gu) ?? []).length;
  return breaks(next) <= breaks(now);
}
