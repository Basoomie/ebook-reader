/**
 * Each book's Audiobookshelf `metadata.json` (WP21e-1, plan section 8 step 2), written into its
 * new folder during the build so ABS's first scan of the fresh library reads everything (its own
 * metadata file has the highest priority). The format is ABS 2.37.1's, as on the live library's
 * files: series as "Name #position" strings, tags, the year as text. Pure.
 *
 * - Values are stage 5's (`ai_values`, stage audio5): an unconfirmed value is its stored best
 *   guess; an unknown one is null / [].
 * - No `chapters` key: ABS reads the chapters from the files (checked on a scratch ABS).
 * - Only Audible ids go into `asin`; kikubon and audiobook.jp ids stay in cleanup.db.
 * - Tags: ドラマCD and 複数ナレーター (design section 5); with stage 8 (WP21g) the paired ebook's
 *   story tags, adaptations and format come first. Genres: the paired ebook's genres and subjects
 *   (stage 8), else none.
 * - The subtitle stays empty (decided 2026-11-17); covers are left to ABS (embedded art).
 */
import type { SeriesEntry } from './meta-rules';
import { formatPosition } from './build-names';

export const TAG_DRAMA = 'ドラマCD';
export const TAG_MULTI_NARRATOR = '複数ナレーター';

/** A recording's values as the build uses them. */
export interface BookValues {
  title: string;
  authors: string[];
  narrators: string[];
  /** null = unknown, [] = no series. */
  series: SeriesEntry[] | null;
  drama: boolean;
  multiNarrator: boolean;
  publisher: string | null;
  year: number | null;
  language: string | null;
  /** The prefixed store id (audible:…, kikubon:…, audiobookjp:…). */
  storeId: string | null;
  description: string | null;
  /** Stage 8 (WP21g): the paired ebook's genres and subjects (Japanese labels), else []. */
  genres: string[];
  /** Stage 8: the paired ebook's story tags, adaptations and format, else []. */
  ebookTags: string[];
  /** Stage 8: the series is the paired ebook's (a move it causes waits while anyone listens). */
  seriesFromEbook: boolean;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

/** Stage 5's stored values (field -> value) as BookValues; `fallbackTitle` when none is stored. */
export function bookValues(values: Record<string, unknown>, fallbackTitle: string): BookValues {
  const series = values.series;
  const year = values.year;
  return {
    title: str(values.title) ?? fallbackTitle,
    authors: strs(values.authors),
    narrators: strs(values.narrators),
    series: Array.isArray(series)
      ? (series as unknown[])
          .filter(
            (s): s is SeriesEntry =>
              typeof s === 'object' &&
              s !== null &&
              typeof (s as SeriesEntry).name === 'string' &&
              (s as SeriesEntry).name.trim() !== '',
          )
          .map((s) => ({
            name: s.name.trim(),
            position:
              typeof s.position === 'number' && Number.isFinite(s.position) ? s.position : null,
            label: typeof s.label === 'string' ? s.label : null,
          }))
      : null,
    drama: values.drama === true,
    multiNarrator: values.multi_narr === true,
    publisher: str(values.publisher),
    year: typeof year === 'number' && Number.isFinite(year) ? Math.trunc(year) : null,
    language: str(values.language),
    storeId: str(values.store_id) ?? str(values.record),
    description: str(values.description),
    genres: strs(values.genres),
    ebookTags: strs(values.ebook_tags),
    seriesFromEbook: values.series_from === 'ebook',
  };
}

/** "Name #5.5", or "Name" without a position (ABS's form). */
export function absSeries(s: SeriesEntry): string {
  return s.position === null ? s.name : `${s.name} #${formatPosition(s.position)}`;
}

/** The Audible ASIN of a store id, else null. */
export function asinOf(storeId: string | null): string | null {
  if (!storeId) return null;
  const m = /^audible:([A-Z0-9]{10})$/.exec(storeId);
  return m ? m[1] : null;
}

/** The metadata.json object, keys in ABS's own order. */
export function absMetadata(v: BookValues): Record<string, unknown> {
  const tags: string[] = [...(v.ebookTags ?? [])];
  if (v.drama && !tags.includes(TAG_DRAMA)) tags.push(TAG_DRAMA);
  if (v.multiNarrator && !tags.includes(TAG_MULTI_NARRATOR)) tags.push(TAG_MULTI_NARRATOR);
  return {
    tags,
    title: v.title,
    subtitle: null,
    authors: v.authors,
    narrators: v.narrators,
    series: (v.series ?? []).map(absSeries),
    genres: [...(v.genres ?? [])],
    publishedYear: v.year === null ? null : String(v.year),
    publishedDate: null,
    publisher: v.publisher,
    description: v.description,
    isbn: null,
    asin: asinOf(v.storeId),
    language: v.language,
    explicit: false,
    abridged: false,
  };
}

/** The file's bytes (UTF-8, two-space indent as ABS writes it, a final newline). */
export function metadataBytes(v: BookValues): Buffer {
  return Buffer.from(JSON.stringify(absMetadata(v), null, 2) + '\n', 'utf8');
}
