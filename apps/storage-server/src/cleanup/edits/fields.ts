/**
 * Calibre metadata editing from the reader (tier 3 item 2): the fields a user can edit, their
 * values as the server keeps them, and the checks a save must pass (pure).
 *
 * Field names are the cleanup's proposal fields (title, authors, illustrator, series, ...) plus
 * the ones only the user edits (sort = the title sort, pubdate, rating). A value is what the
 * write path (stage2-batches.ts fieldArgs / fieldEquals) takes:
 *   title, sort, author_sort: text;  authors, illustrator, languages, tags: lists;
 *   series: { name, index };  publisher, description: text or null;
 *   pubdate: ms (noon UTC of the day) or null;  rating: 1-10 (half stars) or null;
 *   identifiers: { type: value };  cover: { file, sha256 } (the picture in the server's cache).
 */
import { NAME_MAX_BYTES, calibreNameBytes } from '../calibre-names';

export const EDIT_FIELDS = [
  'title',
  'sort',
  'authors',
  'author_sort',
  'illustrator',
  'series',
  'publisher',
  'pubdate',
  'languages',
  'rating',
  'description',
  'tags',
  'identifiers',
  'cover',
] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

/** The keys of user_fields: the edit fields, with the series' name and number apart. */
export const USER_FIELD_KEYS = [
  'title',
  'sort',
  'authors',
  'author_sort',
  'illustrator',
  'series',
  'series_index',
  'publisher',
  'pubdate',
  'languages',
  'rating',
  'description',
  'tags',
  'identifiers',
  'cover',
] as const;
export type UserFieldKey = (typeof USER_FIELD_KEYS)[number];

export interface SeriesValue {
  name: string | null;
  index: number | null;
}

/** A book's editable values (as the catalog holds them, or as the user saved them). */
export interface EditValues {
  title: string;
  sort: string;
  authors: string[];
  author_sort: string;
  illustrator: string[];
  series: SeriesValue;
  publisher: string | null;
  pubdate: number | null;
  languages: string[];
  rating: number | null;
  description: string | null;
  tags: string[];
  identifiers: Record<string, string>;
}

export class EditError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const bad = (message: string, code = 'invalid_value', details: Record<string, unknown> = {}) =>
  new EditError(422, code, message, details);

const text = (field: string, v: unknown, max: number, empty: 'allow' | 'refuse'): string => {
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const t = v.replace(/[\r\n\t]+/g, ' ').trim();
  if ([...t].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    throw bad(`${field} contains a control character`);
  if (t === '' && empty === 'refuse') throw bad(`${field} can't be empty`);
  if ([...t].length > max) throw bad(`${field} is longer than ${max} characters`);
  return t;
};

/** Names Calibre splits: "&" makes two authors (WP20 lessons 2); a full-width ＆ is one name. */
function names(field: string, v: unknown, needOne: boolean): string[] {
  if (!Array.isArray(v) || v.length > 50) throw bad(`${field} must be a list of names`);
  const out: string[] = [];
  for (const raw of v) {
    const n = text(field, raw, 300, 'allow');
    if (n === '') continue;
    if (n.includes('&'))
      throw bad(
        `“${n}”: Calibre splits a name at “&” into two names. Use ＆ (full width) or add the names one by one.`,
        'split_name',
        { field, name: n },
      );
    if (!out.some((o) => o === n)) out.push(n);
  }
  if (needOne && out.length === 0) throw bad(`${field}: at least one name`, 'empty');
  return out;
}

/** "YYYY-MM-DD" → noon UTC of that day (every time zone shows the same day); null = none. */
export function dateValue(v: unknown): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw bad('Published date must be a date like 2024-05-01');
  const [y, m, d] = v.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12, 0, 0);
  const back = new Date(t);
  if (y < 102 || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    throw bad('Published date is not a real date');
  return t;
}

/** Normalizes and checks one field's value (throws EditError 422 with a message). */
export function normalizeValue(field: EditField, v: unknown): unknown {
  switch (field) {
    case 'title':
      return text('Title', v, 500, 'refuse');
    case 'sort':
      return text('Title sort', v, 500, 'allow');
    case 'author_sort':
      return text('Author sort', v, 500, 'allow');
    case 'authors':
      return names('Authors', v, true);
    case 'illustrator':
      return names('Illustrators', v, false);
    case 'publisher':
    case 'description': {
      if (v === null) return null;
      if (field === 'description') {
        if (typeof v !== 'string' || v.length > 100_000)
          throw bad('Description must be text of at most 100,000 characters');
        const t = v.replace(/\r\n?/g, '\n').trim();
        return t === '' ? null : t;
      }
      const t = text('Publisher', v, 300, 'allow');
      return t === '' ? null : t;
    }
    case 'pubdate':
      return dateValue(v);
    case 'rating': {
      if (v === null || v === 0) return null;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10)
        throw bad('Rating must be 1 to 10 half stars');
      return v;
    }
    case 'languages': {
      if (!Array.isArray(v) || v.length > 10) throw bad('Languages must be a list');
      const out: string[] = [];
      for (const raw of v) {
        const c = text('Language', raw, 10, 'allow').toLowerCase();
        if (c === '') continue;
        if (!/^[a-z]{2,3}$/.test(c)) throw bad(`“${c}” is not a language code like jpn or eng`);
        if (!out.includes(c)) out.push(c);
      }
      return out;
    }
    case 'tags': {
      if (!Array.isArray(v) || v.length > 200) throw bad('Tags must be a list');
      const out: string[] = [];
      for (const raw of v) {
        const t = text('Tag', raw, 200, 'allow');
        if (t === '') continue;
        if (t.includes(',')) throw bad(`“${t}”: a tag can't contain a comma`);
        if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
      }
      return out;
    }
    case 'identifiers': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Store ids must be a map');
      const out: Record<string, string> = {};
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        const type = k.trim().toLowerCase();
        if (!/^[a-z0-9_-]{1,40}$/.test(type)) throw bad(`“${k}” is not an id name`);
        const val = text(`Id ${type}`, raw, 300, 'allow');
        if (val === '') continue;
        if (/[,:]/.test(val)) throw bad(`Id ${type}: “,” and “:” can't be in an id`);
        out[type] = val;
      }
      return out;
    }
    case 'series': {
      const s = (v ?? {}) as { name?: unknown; index?: unknown };
      const name =
        s.name === null || s.name === undefined ? '' : text('Series', s.name, 300, 'allow');
      if (name === '') return { name: null, index: null };
      if (name.includes('&'))
        throw bad(`“${name}”: Calibre treats “&” specially in names. Use ＆ (full width).`);
      let index: number | null = null;
      if (s.index !== null && s.index !== undefined && s.index !== '') {
        const n = typeof s.index === 'number' ? s.index : Number(s.index);
        if (!Number.isFinite(n) || n < 0 || n > 99999)
          throw bad('The number in the series must be from 0 to 99999');
        index = Math.round(n * 100) / 100;
      }
      return { name, index: index ?? 1 };
    }
    case 'cover':
      throw bad('The cover is saved through its own upload');
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tagKey = (l: string[]) => [...new Set(l.map((x) => x.toLowerCase()))].sort().join('|');

/** Whether two values of a field are the same (tags as a set, ids as a map). */
export function sameValue(field: EditField, a: unknown, b: unknown): boolean {
  if (field === 'tags') return tagKey((a as string[]) ?? []) === tagKey((b as string[]) ?? []);
  if (field === 'identifiers') {
    const s = (m: unknown) =>
      Object.entries((m ?? {}) as Record<string, string>).sort(([x], [y]) =>
        x < y ? -1 : x > y ? 1 : 0,
      );
    return sameJson(s(a), s(b));
  }
  if (field === 'pubdate') {
    const s = (x: unknown) => (typeof x === 'number' ? Math.floor(x / 86_400_000) : null);
    return s(a) === s(b);
  }
  if (field === 'sort' || field === 'author_sort' || field === 'title')
    return ((a as string) ?? '') === ((b as string) ?? '');
  return sameJson(a ?? null, b ?? null);
}

/** The user_fields keys an edit of a field makes the user's (a series: its name and/or number). */
export function userKeysOf(field: EditField, before: unknown, after: unknown): UserFieldKey[] {
  if (field !== 'series') return [field];
  const a = (before ?? { name: null, index: null }) as SeriesValue;
  const b = (after ?? { name: null, index: null }) as SeriesValue;
  const keys: UserFieldKey[] = [];
  if ((a.name ?? null) !== (b.name ?? null)) keys.push('series');
  if ((a.index ?? null) !== (b.index ?? null) || b.name === null) keys.push('series_index');
  return keys.length ? keys : ['series'];
}

/** The stage-4 AI field a user field corresponds to (ai_values 'calibre4'), if any. */
export function aiFieldOf(
  key: UserFieldKey,
): { field: string; value: (v: unknown) => unknown } | null {
  switch (key) {
    case 'title':
      return { field: 't', value: (v) => v };
    case 'authors':
      return { field: 'au', value: (v) => v };
    case 'illustrator':
      return { field: 'il', value: (v) => v };
    case 'series':
      return { field: 'se', value: (v) => ({ name: (v as SeriesValue | null)?.name ?? null }) };
    case 'series_index':
      return { field: 'ix', value: (v) => ({ n: (v as SeriesValue | null)?.index ?? null }) };
    default:
      return null;
  }
}

export interface NameCheck {
  bytes: number;
  authorBytes: number;
  ok: boolean;
}

/**
 * Calibre's folder and file names for this title and first author must fit the disk (255 bytes,
 * lessons 2): never shortened silently, the save is refused (design, 2026-11-23).
 */
export function checkNames(calibreId: number, title: string, firstAuthor: string): NameCheck {
  const bytes = calibreNameBytes(calibreId, title, firstAuthor);
  const authorBytes = calibreNameBytes(calibreId, '', firstAuthor);
  return { bytes, authorBytes, ok: bytes <= NAME_MAX_BYTES && authorBytes <= NAME_MAX_BYTES };
}

export function refuseLongNames(calibreId: number, title: string, firstAuthor: string): void {
  const c = checkNames(calibreId, title, firstAuthor);
  if (c.authorBytes > NAME_MAX_BYTES)
    throw bad(
      `The first author makes a Calibre folder name of ${c.authorBytes} bytes; the disk takes at most ${NAME_MAX_BYTES}. Shorten the first author.`,
      'author_too_long',
      { bytes: c.authorBytes, max: NAME_MAX_BYTES },
    );
  if (c.bytes > NAME_MAX_BYTES)
    throw bad(
      `The title makes a Calibre file name of ${c.bytes} bytes; the disk takes at most ${NAME_MAX_BYTES}. Shorten the title.`,
      'title_too_long',
      { bytes: c.bytes, max: NAME_MAX_BYTES },
    );
}
