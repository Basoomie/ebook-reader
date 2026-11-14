/**
 * Stage 2 decisions for one book (WP20b, plan section 4, decided 2026-11-14): what the EPUB's
 * own metadata proposes for each field, with its class (auto / review) and source.
 *
 * Pure functions only: the analysis (stage2.ts), the gate (stage2-gate.ts) and the
 * reproduction of the measurement (scripts/measure-stage2.ts) all run this same code.
 */
import {
  N,
  NA,
  cleanTitle,
  isUnknownName,
  lightNormalize,
  looksLikeImprint,
  looksLikeMojibake,
  normalizeName,
  nfkc,
  pyStrip,
  titleSort,
} from './title-rules';

export const STAGE2_FIELDS = [
  'title',
  'authors',
  'cover',
  'identifiers',
  'publisher',
  'languages',
  'illustrator',
] as const;
export type Stage2Field = (typeof STAGE2_FIELDS)[number];

/** How a value was decided (applied_values.source). */
export type Stage2Source = 'file-unconfirmed' | 'file' | 'normalize';
/** Which of the decided apply groups a book's title or authors fall in. */
export type ApplyGroup = 'unknown' | 'processed' | 'agree' | 'conflict';

export interface CoverFacts {
  width: number;
  height: number;
  /** 64-bit difference hash as 16 hex digits, or null when it couldn't be computed. */
  dhash: string | null;
}

export interface FileCover extends CoverFacts {
  entry: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface FileCreator {
  name: string;
  /** MARC relator code (aut, ill, trl, edt …) or null when the file gives none. */
  role: string | null;
}

/** What stage 2 reads from an EPUB (stored as evidence for later stages too). */
export interface FileFacts {
  title: string | null;
  creators: FileCreator[];
  publishers: string[];
  languages: string[];
  identifiers: string[];
  asin: string | null;
  cover: FileCover | null;
  frontText?: string;
  colophonText?: string;
}

/** The book's current Calibre record, as far as stage 2 reads or writes it. */
export interface CalibreFacts {
  title: string;
  titleSort: string | null;
  authors: string[];
  authorSort: string | null;
  tags: string[];
  hasCover: boolean;
  /** Calibre's cover.jpg, when it has one and it could be read. */
  cover: CoverFacts | null;
  identifiers: Record<string, string>;
  publisher: string | null;
  languages: string[];
  /** #illustrator values, or null when the library has no such column. */
  illustrators: string[] | null;
}

export interface FieldProposal {
  field: Stage2Field;
  old: unknown;
  new: unknown;
  class: 'auto' | 'review';
  source: Stage2Source;
  group: ApplyGroup | null;
  /** Plain words for the review list / the page. */
  reason: string | null;
  /** Extra values written with this field (title: sort; authors: author_sort). */
  extra?: Record<string, { old: unknown; new: unknown }>;
}

/** Existing spelling of a shared name (author, publisher, #illustrator), matched ignoring case. */
export type SpellingLookup = (kind: 'author' | 'publisher' | 'illustrator', name: string) => string;
const keepSpelling: SpellingLookup = (_k, n) => n;

export interface Stage2Options {
  /** Calibre matches shared names ignoring case and would rename the shared row (D4). */
  spelling?: SpellingLookup;
  /** dHash distance above which two covers are different pictures (measured: re-encodes 1-5). */
  coverSameDistance?: number;
  /** The file cover is "larger" when its longest side is at least this factor bigger. */
  coverLargerFactor?: number;
}

export const PROCESSED_TAG = 'metadata-processed';
/** Amazon JP identifier key in Calibre. */
export const AMAZON_JP = 'amazon_jp';

export function isProcessed(tags: readonly string[]): boolean {
  return tags.some((t) => t.trim().toLowerCase() === PROCESSED_TAG);
}

export function calibreAuthorsUnknown(authors: readonly string[]): boolean {
  return authors.length === 0 || authors.every((a) => isUnknownName(a));
}

/** The file's author-role creators (`aut` or no role), in file order (measured: role none = aut). */
export function fileAuthors(file: Pick<FileFacts, 'creators'>): string[] {
  return file.creators
    .filter((c) => c.role === null || c.role === 'aut')
    .map((c) => pyStrip(c.name))
    .filter((n) => n !== '');
}

export function fileIllustrators(file: Pick<FileFacts, 'creators'>): string[] {
  return file.creators
    .filter((c) => c.role === 'ill')
    .map((c) => pyStrip(c.name))
    .filter((n) => n !== '');
}

export function hammingHex(a: string | null, b: string | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The title group of the measurement (also used for authors when Calibre is Unknown/processed). */
export function titleGroup(cal: CalibreFacts, file: FileFacts): ApplyGroup {
  if (calibreAuthorsUnknown(cal.authors)) return 'unknown';
  if (isProcessed(cal.tags)) return 'processed';
  const names = [...fileAuthors(file), ...cal.authors];
  return N(cleanTitle(file.title, names)) === N(cleanTitle(cal.title, names))
    ? 'agree'
    : 'conflict';
}

export function authorGroup(cal: CalibreFacts, file: FileFacts): ApplyGroup {
  if (calibreAuthorsUnknown(cal.authors)) return 'unknown';
  if (isProcessed(cal.tags)) return 'processed';
  const first = fileAuthors(file)[0];
  if (first === undefined) return 'agree';
  // "Already the same after normalization": Calibre's names are exactly the file's first author.
  const own = new Set(cal.authors.map((a) => NA(normalizeName(a))));
  return own.size === 1 && own.has(NA(normalizeName(first))) ? 'agree' : 'conflict';
}

function normalizedNames(names: readonly string[], spelling: SpellingLookup): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = spelling('author', normalizeName(n));
    if (v !== '' && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

function titleProposals(cal: CalibreFacts, file: FileFacts): FieldProposal[] {
  const out: FieldProposal[] = [];
  const names = [...fileAuthors(file), ...cal.authors];
  const group = titleGroup(cal, file);
  const proposal = (
    value: string,
    cls: 'auto' | 'review',
    source: Stage2Source,
    reason: string | null,
  ): FieldProposal => ({
    field: 'title',
    old: cal.title,
    new: value,
    class: cls,
    source,
    group,
    reason,
    extra: { sort: { old: cal.titleSort, new: titleSort(value) } },
  });
  const calClean = looksLikeMojibake(cal.title) ? null : cleanTitle(cal.title, names);
  const normalizeOwn = () => {
    if (calClean && calClean !== cal.title) out.push(proposal(calClean, 'auto', 'normalize', null));
  };
  const raw = file.title ?? '';
  const fileClean = cleanTitle(raw, names);
  let fileProblem: string | null = null;
  if (looksLikeMojibake(raw)) fileProblem = "The file's title is garbled (wrong text encoding)";
  else if (fileClean === '') fileProblem = 'The file has no title';

  if (group === 'unknown' || group === 'processed') {
    if (fileProblem) {
      normalizeOwn();
      if (fileClean !== '' && fileClean !== cal.title) {
        out.push(proposal(fileClean, 'review', 'file-unconfirmed', fileProblem));
      }
    } else if (fileClean !== cal.title) {
      out.push(proposal(fileClean, 'auto', 'file-unconfirmed', null));
    }
  } else if (group === 'agree') {
    normalizeOwn();
  } else {
    normalizeOwn();
    if (!fileProblem && N(fileClean) !== N(calClean ?? cal.title)) {
      out.push(
        proposal(
          fileClean,
          'review',
          'file-unconfirmed',
          "Calibre has its own title, different from the file's",
        ),
      );
    }
  }
  return out;
}

function authorProposals(
  cal: CalibreFacts,
  file: FileFacts,
  spelling: SpellingLookup,
): FieldProposal[] {
  const out: FieldProposal[] = [];
  const group = authorGroup(cal, file);
  const first = fileAuthors(file)[0];
  const proposal = (
    value: string[],
    cls: 'auto' | 'review',
    source: Stage2Source,
    reason: string | null,
  ): FieldProposal => ({
    field: 'authors',
    old: cal.authors,
    new: value,
    class: cls,
    source,
    group,
    reason,
    // Calibre keeps a stale author_sort unless it is sent empty (then it computes its own).
    extra: { author_sort: { old: cal.authorSort, new: '' } },
  });
  const normalizeOwn = () => {
    if (calibreAuthorsUnknown(cal.authors)) return;
    if (cal.authors.some((a) => looksLikeMojibake(a))) return;
    const own = normalizedNames(cal.authors, spelling);
    if (own.length > 0 && !sameList(own, cal.authors)) {
      out.push(proposal(own, 'auto', 'normalize', null));
    }
  };
  let fileProblem: string | null = null;
  if (first === undefined) fileProblem = null;
  else if (isUnknownName(first)) fileProblem = 'The file names its author "Unknown"';
  else if (looksLikeMojibake(first))
    fileProblem = "The file's author is garbled (wrong text encoding)";
  else if (looksLikeImprint(first))
    fileProblem = "The file's author looks like a publisher or label";
  else if (first.includes('&')) fileProblem = "The file's author contains &, which Calibre splits";
  // Seen in the dry run (326 books, 1 of 5 labeled right): author and illustrator in one
  // creator, "あずみ圭/マツモトミツアキ", "原作:志倉千代丸/MAGES./Nitroplus".
  else if (/[/／、，,]/u.test(first)) fileProblem = "The file's author holds more than one name";

  if (first === undefined) {
    normalizeOwn();
    return out;
  }
  const fileValue = normalizedNames([first], spelling);
  if (group === 'unknown' || group === 'processed') {
    if (fileProblem) {
      normalizeOwn();
      if (!isUnknownName(first) && !sameList(fileValue, cal.authors)) {
        out.push(proposal(fileValue, 'review', 'file-unconfirmed', fileProblem));
      }
    } else if (!sameList(fileValue, cal.authors)) {
      out.push(proposal(fileValue, 'auto', 'file-unconfirmed', null));
    }
  } else if (group === 'agree') {
    normalizeOwn();
  } else {
    normalizeOwn();
    if (!fileProblem) {
      out.push(
        proposal(
          fileValue,
          'review',
          'file-unconfirmed',
          "Calibre has its own author, different from the file's",
        ),
      );
    }
  }
  return out;
}

function coverProposal(
  cal: CalibreFacts,
  file: FileFacts,
  o: Required<Stage2Options>,
): FieldProposal | null {
  const fc = file.cover;
  if (!fc) return null;
  const make = (reason: string): FieldProposal => ({
    field: 'cover',
    old: cal.hasCover
      ? {
          width: cal.cover?.width ?? null,
          height: cal.cover?.height ?? null,
          dhash: cal.cover?.dhash ?? null,
        }
      : null,
    new: {
      sha256: fc.sha256,
      width: fc.width,
      height: fc.height,
      mediaType: fc.mediaType,
      bytes: fc.bytes,
    },
    class: 'auto',
    source: 'file',
    group: null,
    reason,
  });
  if (!cal.hasCover) return make('Calibre has no cover');
  const cc = cal.cover;
  if (!cc) return null; // Calibre lists a cover we couldn't read: leave it.
  const longest = (c: CoverFacts) => Math.max(c.width, c.height);
  if (longest(fc) >= longest(cc) * o.coverLargerFactor) return make("The file's cover is larger");
  if (isProcessed(cal.tags)) {
    const d = hammingHex(fc.dhash, cc.dhash);
    if (d !== null && d > o.coverSameDistance)
      return make("Calibre's cover is a different picture");
  }
  return null;
}

/** ASIN forms seen in files: a bare B0…, urn:asin:…, ASIN:…, mobi-asin:…, amazon:… */
export function asinFromIdentifiers(ids: readonly string[]): string | null {
  for (const raw of ids) {
    const s = nfkc(raw).trim();
    const m =
      /^(?:urn:)?(?:asin|mobi-asin|amazon|amazon_jp)[:\s]+([A-Z0-9]{10})$/i.exec(s) ??
      /^(B0[A-Z0-9]{8})$/i.exec(s);
    if (m && /^B0[A-Z0-9]{8}$/i.test(m[1])) return m[1].toUpperCase();
  }
  return null;
}

function identifierProposal(cal: CalibreFacts, file: FileFacts): FieldProposal | null {
  const asin = file.asin;
  if (!asin) return null;
  const current = cal.identifiers[AMAZON_JP];
  if (current && current.toUpperCase() === asin) return null;
  return {
    field: 'identifiers',
    old: cal.identifiers,
    new: { ...cal.identifiers, [AMAZON_JP]: asin },
    class: current ? 'review' : 'auto',
    source: 'file',
    group: null,
    reason: current ? `Calibre already has another Amazon JP id (${current})` : null,
  };
}

/** ISO 639-1 → the 639-2 codes calibre stores. */
const LANGS: Record<string, string> = {
  ja: 'jpn',
  en: 'eng',
  zh: 'zho',
  ko: 'kor',
  fr: 'fra',
  de: 'deu',
};
export function calibreLanguage(code: string): string | null {
  const c = code.trim().toLowerCase().split(/[-_]/)[0];
  if (!c) return null;
  if (c.length === 3) return c;
  return LANGS[c] ?? null;
}

function publisherProposal(
  cal: CalibreFacts,
  file: FileFacts,
  spelling: SpellingLookup,
): FieldProposal | null {
  if (cal.publisher && cal.publisher.trim() !== '') return null;
  const raw = file.publishers.map((p) => pyStrip(p)).find((p) => p !== '' && !looksLikeMojibake(p));
  if (!raw) return null;
  const value = spelling('publisher', lightNormalize(raw));
  return {
    field: 'publisher',
    old: cal.publisher,
    new: value,
    class: 'auto',
    source: 'file',
    group: null,
    reason: null,
  };
}

function languageProposal(cal: CalibreFacts, file: FileFacts): FieldProposal | null {
  if (cal.languages.length > 0) return null;
  const langs = [...new Set(file.languages.map(calibreLanguage).filter((l): l is string => !!l))];
  if (langs.length === 0) return null;
  return {
    field: 'languages',
    old: cal.languages,
    new: langs,
    class: 'auto',
    source: 'file',
    group: null,
    reason: null,
  };
}

function illustratorProposal(
  cal: CalibreFacts,
  file: FileFacts,
  spelling: SpellingLookup,
): FieldProposal | null {
  if (cal.illustrators === null || cal.illustrators.length > 0) return null;
  const names: string[] = [];
  for (const n of fileIllustrators(file)) {
    const v = spelling('illustrator', normalizeName(n));
    if (v && !names.some((x) => x.toLowerCase() === v.toLowerCase()) && !v.includes(','))
      names.push(v);
  }
  if (names.length === 0) return null;
  return {
    field: 'illustrator',
    old: [],
    new: names,
    class: 'auto',
    source: 'file',
    group: null,
    reason: null,
  };
}

/** Every change stage 2 proposes for one book. */
export function proposeStage2(
  cal: CalibreFacts,
  file: FileFacts,
  options: Stage2Options = {},
): FieldProposal[] {
  const o: Required<Stage2Options> = {
    spelling: options.spelling ?? keepSpelling,
    coverSameDistance: options.coverSameDistance ?? 5,
    coverLargerFactor: options.coverLargerFactor ?? 1.1,
  };
  const out: FieldProposal[] = [
    ...titleProposals(cal, file),
    ...authorProposals(cal, file, o.spelling),
  ];
  for (const p of [
    coverProposal(cal, file, o),
    identifierProposal(cal, file),
    publisherProposal(cal, file, o.spelling),
    languageProposal(cal, file),
    illustratorProposal(cal, file, o.spelling),
  ]) {
    if (p) out.push(p);
  }
  return out;
}

/**
 * The value a field will have in Calibre once every auto proposal is applied (the gate scores
 * this), or Calibre's current value when nothing auto touches it.
 */
export function valueAfterAuto(
  field: 'title' | 'authors',
  cal: CalibreFacts,
  proposals: FieldProposal[],
): unknown {
  const auto = proposals.filter((p) => p.field === field && p.class === 'auto');
  const last = auto[auto.length - 1];
  if (last) return last.new;
  return field === 'title' ? cal.title : cal.authors;
}
