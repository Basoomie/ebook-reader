/**
 * Audiobook and subtitle matching (WP15a, decisions: "Audio" and "Phase 5
 * decisions"). Pure: no database, no files. Title-based, because the Japanese
 * audiobooks have no author folders: both sides are normalized (full/half width,
 * brackets, spacing; `_ (出版社)`, `[N巻]`, `Vol N - `, ASINs stripped) and
 * compared with the Calibre title plus the series number.
 *
 * The result is only a ranked list of suggestions for the confirmation picker.
 * Nothing here ever links a book (decided: never auto-link).
 */
import { looseTitleKey, titleKey } from '../migration/fingerprint';

export const AUDIO_EXTENSIONS = ['.m4b', '.m4a', '.mp3'];
export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass'];
export const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];

/** Folders the scanner never enters (decided: `_Archives/` holds zip files). */
export function isSkippedFolder(name: string): boolean {
  return name.startsWith('.') || name === '_Archives' || name === '@eaDir' || name === '#recycle';
}

/** U+A789, used in place of ":" in file and folder names (":" isn't allowed there). */
const MODIFIER_COLON = String.fromCharCode(0xa789);

/**
 * A folder or file name without the decorations the audiobook tools add:
 * `Vol 1 - `, `Bonus 2 - `, `_ (出版社)`, `[B0XXXXXXXX]` ASINs, a leading `[01]`
 * track number, `[3巻]` volume tags and a leading `05 - ` chapter number.
 * `Special N - ` (short-story extras) loses its prefix like `Bonus`. The colon
 * substitute some tools put in folder names (U+A789 `꞉`) becomes a colon.
 */
export function stripAudioName(name: string): string {
  let s = name.split(MODIFIER_COLON).join(':').normalize('NFKC');
  s = s.replace(
    /^\s*(?:vol(?:ume)?\.?\s*\d+(?:\.\d+)?|bonus(?:\s*\d+)?|special(?:\s*\d+)?)\s*-\s*/i,
    '',
  );
  s = s.replace(/_\s*\([^()]*\)\s*$/, '');
  s = s.replace(/_\s*$/, '');
  s = s.replace(/\[B0[A-Z0-9]{8}\]/gi, '');
  s = s.replace(/^\s*\[\d{1,3}\]\s*/, '');
  s = s.replace(/\[[^\]]*巻\]/g, '');
  s = s.replace(/^\s*\d{1,3}\s+-\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** A file name without its extension. */
export function baseName(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * The volume number in a name, or null. Tried in order: `Vol N`, `[N巻]`,
 * `第N巻`, `N巻`, `[上巻]`/`[中巻]`, then the last 1-3 digit number of the
 * stripped name (e.g. `スパイ教室01 《花園》…`, `…生きる12_ (KADOKAWA)`).
 * `下` is not a number: it is volume 2 of two or 3 of three.
 */
export function extractVolume(name: string): number | null {
  const s = name.normalize('NFKC');
  const patterns = [
    /^\s*vol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i,
    /\[(?:[^\]\d]*?)(\d+(?:\.\d+)?)巻\]/,
    /第\s*(\d+(?:\.\d+)?)\s*巻/,
    /(\d+(?:\.\d+)?)\s*巻/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return Number(m[1]);
  }
  if (/\[上巻\]|\s上巻?(?:\s|$)/.test(s)) return 1;
  if (/\[中巻\]|\s中巻?(?:\s|$)/.test(s)) return 2;
  const stripped = stripAudioName(s);
  const numbers = [...stripped.matchAll(/(?:^|[^\d.])(\d{1,3})(?=$|[^\d])/g)];
  if (numbers.length > 0) return Number(numbers[numbers.length - 1][1]);
  return null;
}

/** ABS metadata.json `series`: `["Name #2"]` or `[{ name, sequence }]`. */
export function parseAbsSeries(value: unknown): { name: string; sequence: string | null } | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') {
    const m = /^(.*?)\s*#\s*([\d.]+)\s*$/.exec(first.trim());
    return m ? { name: m[1].trim(), sequence: m[2] } : { name: first.trim(), sequence: null };
  }
  if (first && typeof first === 'object') {
    const o = first as { name?: unknown; sequence?: unknown };
    if (typeof o.name === 'string') {
      return {
        name: o.name.trim(),
        sequence: o.sequence === undefined || o.sequence === null ? null : String(o.sequence),
      };
    }
  }
  return null;
}

/** What the scanner stores for one audiobook folder or subtitle file. */
export interface NamedEntry {
  name: string;
  parentName: string | null;
  titleKey: string;
  looseKey: string;
  volume: number | null;
  metaTitle?: string | null;
  metaSeries?: string | null;
}

/** The keys of a folder or file name (the scanner and the tests use this). */
export function entryKeys(name: string): { titleKey: string; looseKey: string } {
  const stripped = stripAudioName(name);
  return { titleKey: titleKey(stripped), looseKey: looseTitleKey(stripped) };
}

export interface BookForMatch {
  title: string;
  seriesName: string | null;
  seriesIndex: number | null;
}

export type MatchTier = 'exact' | 'loose' | 'contains' | 'series' | 'other-volume';

export interface Scored<T> {
  entry: T;
  score: number;
  tier: MatchTier;
}

const contains = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));

/**
 * Ranks `entries` for one book. Tiers (score): exact key 100, loose key 90,
 * contains with an agreeing or unknown volume 80/75, same series and volume
 * 70 (unknown volume 50), contains with a different volume 40 (shown last).
 * Ties: single-file folders first (they can play), then by name.
 */
export function rankEntries<T extends NamedEntry & { fileCount?: number }>(
  book: BookForMatch,
  entries: T[],
  limit = 10,
): Scored<T>[] {
  const bookKey = titleKey(book.title);
  const bookLoose = looseTitleKey(book.title);
  const bookVolume = book.seriesIndex ?? extractVolume(book.title);
  const seriesKey = book.seriesName ? titleKey(book.seriesName) : null;
  const out: Scored<T>[] = [];

  for (const entry of entries) {
    const keys = [entry.titleKey];
    const looseKeys = [entry.looseKey];
    const metaSeriesKey = entry.metaSeries ? titleKey(entry.metaSeries) : null;
    if (entry.metaTitle) {
      const k = titleKey(entry.metaTitle);
      // ABS often stores the series name as the title: that says nothing about the volume.
      if (k && k !== metaSeriesKey) {
        keys.push(k);
        looseKeys.push(looseTitleKey(entry.metaTitle));
      }
    }
    const volumeAgrees =
      entry.volume === null || bookVolume === null
        ? null
        : Math.abs(entry.volume - bookVolume) < 1e-6;

    let scored: Scored<T> | null = null;
    if (bookKey && keys.includes(bookKey)) scored = { entry, score: 100, tier: 'exact' };
    else if (bookLoose.length >= 2 && looseKeys.includes(bookLoose)) {
      scored = { entry, score: 90, tier: 'loose' };
    } else if (
      keys.some((k) => contains(k, bookKey)) ||
      looseKeys.some((k) => contains(k, bookLoose))
    ) {
      scored =
        volumeAgrees === false
          ? { entry, score: 40, tier: 'other-volume' }
          : { entry, score: volumeAgrees ? 80 : 75, tier: 'contains' };
    } else if (seriesKey && seriesKey.length >= 2) {
      const parentKey = entry.parentName ? entryKeys(entry.parentName).titleKey : null;
      const sameSeries =
        metaSeriesKey === seriesKey ||
        parentKey === seriesKey ||
        (metaSeriesKey !== null && contains(metaSeriesKey, seriesKey)) ||
        (parentKey !== null && contains(parentKey, seriesKey));
      if (sameSeries && volumeAgrees !== false) {
        scored = { entry, score: volumeAgrees ? 70 : 50, tier: 'series' };
      }
    }
    if (scored) out.push(scored);
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      Number((a.entry.fileCount ?? 1) !== 1) - Number((b.entry.fileCount ?? 1) !== 1) ||
      a.entry.name.localeCompare(b.entry.name),
  );
  return out.slice(0, limit);
}

/** A search box query against names and paths (normalized like the titles). */
export function searchMatches(query: string, name: string, relPath: string): boolean {
  const q = titleKey(query);
  if (!q) return false;
  return titleKey(name).includes(q) || titleKey(relPath).includes(q);
}
