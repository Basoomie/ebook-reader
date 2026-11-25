/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Suggestions while typing a library search (search palette step 1, 2026-11-24). Pure code:
 * what the word under the caret is (a field name being typed, or a field's value), what to
 * offer for it, and the box's text after one is picked. Names (authors, series, tags,
 * illustrators) come from the caller (`rankNames` orders them); everything else is here.
 */

import { QUERY_FIELDS, QUERY_STATUSES } from './parse';

export type NameField = 'author' | 'illustrator' | 'series' | 'tag';
export const NAME_FIELDS: readonly NameField[] = ['author', 'illustrator', 'series', 'tag'];

export type SuggestContext =
  | { kind: 'none' }
  /** A field name being typed ("ta" → tag:). Replaces text[from, to). */
  | { kind: 'field'; partial: string; from: number; to: number }
  /**
   * A field's value: the item under the caret (after the colon, an "=" and any earlier
   * items of a comma list). `taken` = the term's other items, folded; `afterComma` = not
   * the first item (the hint "comma = either").
   */
  | {
      kind: 'value';
      field: string;
      partial: string;
      from: number;
      to: number;
      taken: string[];
      afterComma: boolean;
    };

export interface Suggestion {
  /** Shown in the row. */
  label: string;
  /** Put in the box in place of the context's span. */
  insert: string;
  /** A short line beside it (an example's meaning). */
  detail?: string;
  /** Books with this name. */
  count?: number;
}

export interface NameCount {
  name: string;
  count: number;
}

/** At most this many suggestions are shown. */
export const MAX_SUGGESTIONS = 8;

const FIELD_HELP: Record<(typeof QUERY_FIELDS)[number], string> = {
  author: 'Author name contains the text',
  illustrator: 'Illustrator name contains the text',
  series: 'Series name contains the text',
  tag: 'Tag contains the text',
  chars: 'Number of characters: <150000, 50k-150k',
  level: 'Natively level: <25, 20-29',
  rating: "Readers' stars on the stores: >=4, 3.5-4.5",
  ratings: 'How many people rated it: >=100',
  readers: 'People who logged it on 読書メーター: >=1000',
  myrating: 'Your own rating: >=4, 5',
  status: 'Unread, reading, completed or dropped',
  favorite: 'Your favorites: yes or no',
  on: 'On this device: device or audio'
};

const FIELD_AT =
  /^(author|illustrator|series|tag|chars|level|ratings|rating|readers|myrating|status|favorite|on)[:：]/i;

/** The same folding as the search itself (full/half width, case). */
export function foldName(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Unquoted whitespace and commas, honoring "quotes" from the start of the box. */
function quotedAt(text: string): boolean[] {
  const inQuote: boolean[] = [];
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') q = !q;
    inQuote.push(q && text[i] !== '"');
  }
  return inQuote;
}

/** What the caret is in. */
export function contextAt(text: string, cursor: number): SuggestContext {
  if (cursor < 0 || cursor > text.length) return { kind: 'none' };
  const quoted = quotedAt(text);
  const breakAt = (i: number) => !quoted[i] && /\s/.test(text[i]);
  let start = cursor;
  while (start > 0 && !breakAt(start - 1)) start -= 1;
  let end = cursor;
  while (end < text.length && !breakAt(end)) end += 1;
  const bodyStart = text[start] === '-' ? start + 1 : start;
  if (bodyStart > cursor) return { kind: 'none' };
  const token = text.slice(bodyStart, end);
  const field = FIELD_AT.exec(token);
  if (!field) {
    // A field name being typed: letters only, the caret at its end, the start of a field.
    const typed = text.slice(bodyStart, cursor);
    if (cursor !== end || !/^[a-z]+$/i.test(typed)) return { kind: 'none' };
    const lower = typed.toLowerCase();
    if (!QUERY_FIELDS.some((f) => f.startsWith(lower))) return { kind: 'none' };
    return { kind: 'field', partial: typed, from: bodyStart, to: end };
  }
  const name = field[1].toLowerCase();
  let valueStart = bodyStart + field[0].length;
  if (cursor < valueStart) return { kind: 'none' };
  const isName = (NAME_FIELDS as readonly string[]).includes(name);
  if (isName && text[valueStart] === '=') valueStart += 1;
  if (cursor < valueStart) return { kind: 'none' };
  // The comma-separated item under the caret.
  let from = valueStart;
  for (let i = valueStart; i < cursor; i += 1) if (text[i] === ',' && !quoted[i]) from = i + 1;
  let to = cursor;
  while (to < end && !(text[to] === ',' && !quoted[to])) to += 1;
  let partial = text.slice(from, cursor);
  if (partial.startsWith('"')) partial = partial.slice(1);
  if (partial.startsWith('/')) return { kind: 'none' };
  const taken: string[] = [];
  let item = '';
  const flush = (at: number) => {
    if (at !== from && item.trim() !== '') taken.push(foldName(item.replace(/"/g, '').trim()));
    item = '';
  };
  let itemStart = valueStart;
  for (let i = valueStart; i <= end; i += 1) {
    if (i === end || (text[i] === ',' && !quoted[i])) {
      flush(itemStart);
      itemStart = i + 1;
    } else item += text[i];
  }
  return {
    kind: 'value',
    field: name,
    partial,
    from,
    to,
    taken,
    afterComma: from > valueStart
  };
}

/** Field names starting with what was typed. */
export function fieldSuggestions(partial: string): Suggestion[] {
  const lower = partial.toLowerCase();
  return QUERY_FIELDS.filter((f) => f.startsWith(lower)).map((f) => ({
    label: `${f}:`,
    insert: `${f}:`,
    detail: FIELD_HELP[f]
  }));
}

const STATIC_VALUES: Record<string, { value: string; detail?: string }[]> = {
  status: QUERY_STATUSES.map((value) => ({ value })),
  favorite: [
    { value: 'yes', detail: 'Your favorites' },
    { value: 'no', detail: 'Books not marked favorite' }
  ],
  on: [
    { value: 'device', detail: 'Books stored on this device' },
    { value: 'audio', detail: 'Their audio is on this device' }
  ]
};

const EXAMPLES: Record<string, { value: string; detail: string }[]> = {
  chars: [
    { value: '<100000', detail: 'Fewer than 100,000 characters' },
    { value: '>=50k', detail: '50,000 or more (k = 1,000)' },
    { value: '50k-150k', detail: '50,000 to 150,000' }
  ],
  level: [
    { value: '<25', detail: 'Natively level under 25' },
    { value: '>=30', detail: '30 or higher' },
    { value: '20-29', detail: '20 to 29' }
  ],
  rating: [
    { value: '>=4', detail: 'Readers rated it 4 stars or higher' },
    { value: '<3.5', detail: 'Under 3.5 stars' },
    { value: '4-4.5', detail: '4 to 4.5 stars' }
  ],
  ratings: [
    { value: '>=100', detail: 'At least 100 ratings' },
    { value: '<20', detail: 'Fewer than 20 ratings' }
  ],
  readers: [
    { value: '>=1000', detail: 'At least 1,000 readers on 読書メーター' },
    { value: '<100', detail: 'Fewer than 100 readers' }
  ],
  myrating: [
    { value: '>=4', detail: 'You rated it 4 stars or higher' },
    { value: '5', detail: 'You rated it 5 stars' }
  ]
};

/**
 * Values that don't come from the library: statuses, yes/no, device/audio, and example
 * forms for chars: and level: (only before anything is typed). Null for name fields.
 */
export function fixedValueSuggestions(
  context: Extract<SuggestContext, { kind: 'value' }>
): Suggestion[] | null {
  const { field, partial, taken } = context;
  const lower = partial.toLowerCase();
  const examples = EXAMPLES[field];
  if (examples) {
    if (partial !== '') return [];
    return examples.map((e) => ({
      label: `${field}:${e.value}`,
      insert: e.value,
      detail: e.detail
    }));
  }
  const values = STATIC_VALUES[field];
  if (!values) return null;
  // favorite: and on: take one value; status: is a comma list.
  if (field !== 'status' && context.afterComma) return [];
  return values
    .filter((v) => v.value.startsWith(lower) && !taken.includes(v.value))
    .map((v) => ({ label: v.value, insert: v.value, detail: v.detail }));
}

/** A name as it goes in the box: quoted when it has a space, comma or a leading / or =. */
export function nameForQuery(name: string): string | null {
  if (name.includes('"')) return null;
  return /[\s,]|^[/=-]/.test(name) ? `"${name}"` : name;
}

/**
 * Orders names for what was typed: those starting with it first, then the rest containing
 * it, each by book count (most first) and then name. Names already in the term are left out.
 */
export function rankNames(
  names: readonly NameCount[],
  partial: string,
  taken: readonly string[] = [],
  limit = MAX_SUGGESTIONS
): NameCount[] {
  const want = foldName(partial.trim());
  const scored: { n: NameCount; prefix: boolean }[] = [];
  for (const n of names) {
    const f = foldName(n.name);
    if (taken.includes(f)) continue;
    const at = want === '' ? 0 : f.indexOf(want);
    if (at < 0) continue;
    scored.push({ n, prefix: at === 0 });
  }
  scored.sort(
    (a, b) =>
      Number(b.prefix) - Number(a.prefix) ||
      b.n.count - a.n.count ||
      a.n.name.localeCompare(b.n.name)
  );
  return scored.slice(0, limit).map((s) => s.n);
}

/** Library names as suggestions. */
export function nameSuggestions(names: readonly NameCount[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const n of names) {
    const insert = nameForQuery(n.name);
    if (insert !== null) out.push({ label: n.name, insert, count: n.count });
  }
  return out;
}

/** The box after a pick, and where the caret goes. */
export function applySuggestion(
  text: string,
  context: Exclude<SuggestContext, { kind: 'none' }>,
  suggestion: Suggestion
): { text: string; cursor: number } {
  const next = text.slice(0, context.from) + suggestion.insert + text.slice(context.to);
  return { text: next, cursor: context.from + suggestion.insert.length };
}
