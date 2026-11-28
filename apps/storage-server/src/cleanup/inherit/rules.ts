/**
 * Replaced books (cleanup.db v42): a new arrival kept over a library book of the same text (stage
 * 1 or 3 of a new-arrivals run) gets the old record's values it lacks. The kept copy is the same
 * book; the old record held what Calibre and the cleanup had decided for it (series, store ids,
 * …), and the removal dropped all of it but the user's own fields (run 7, 2026-11-25: 330 books
 * lost their series, 701 their store ids).
 *
 * Only what the kept copy lacks is given: a value the kept copy has (its file's, a later stage's
 * decision, the user's) is never replaced, and a store id is only added, never changed. The
 * field each value goes through is the stage that writes it (series, ids and illustrators stage
 * 4, publisher and languages stage 2, a custom tag stage 5).
 */
import { isCustomTag } from '../settings';

/** The values of a book the pass reads (the reader's index of Calibre). */
export interface InheritValues {
  series: { name: string | null; index: number | null };
  identifiers: Record<string, string>;
  publisher: string | null;
  languages: string[];
  illustrator: string[];
  tags: string[];
}

export type InheritField =
  | 'series'
  | 'identifiers'
  | 'publisher'
  | 'languages'
  | 'illustrator'
  | 'tags';

/** The stage whose field batches write each field. */
export const INHERIT_STAGE: Record<InheritField, 2 | 4 | 5> = {
  series: 4,
  identifiers: 4,
  illustrator: 4,
  publisher: 2,
  languages: 2,
  tags: 5,
};

export interface InheritChange {
  field: InheritField;
  stage: 2 | 4 | 5;
  /** The kept copy's value now (the proposal's old value). */
  before: unknown;
  /** The value written (tags: the change, `{ add, remove }`). */
  value: unknown;
}

const blank = (s: string | null | undefined) => (s ?? '').trim() === '';

/**
 * What the kept copy takes over from the old record: each field the kept copy has no value of
 * and the old record has, the store ids the kept copy lacks (added to its own), and the old
 * record's custom tags the kept copy lacks. `yours`: the kept copy's fields that are the user's
 * (never given).
 */
export function inheritChanges(
  old: InheritValues,
  kept: InheritValues,
  customTags: string[],
  yours: ReadonlySet<string> = new Set(),
): InheritChange[] {
  const out: InheritChange[] = [];
  const add = (field: InheritField, before: unknown, value: unknown) => {
    if (!yours.has(field)) out.push({ field, stage: INHERIT_STAGE[field], before, value });
  };
  if (blank(kept.series.name) && !blank(old.series.name))
    add('series', { name: null, index: null }, { name: old.series.name, index: old.series.index });
  const missing = Object.entries(old.identifiers).filter(
    ([type, v]) => !blank(v) && !(type in kept.identifiers),
  );
  if (missing.length > 0)
    add('identifiers', kept.identifiers, { ...kept.identifiers, ...Object.fromEntries(missing) });
  if (blank(kept.publisher) && !blank(old.publisher))
    add('publisher', kept.publisher, old.publisher);
  if (kept.languages.length === 0 && old.languages.length > 0)
    add('languages', kept.languages, old.languages);
  if (kept.illustrator.length === 0 && old.illustrator.length > 0)
    add('illustrator', kept.illustrator, old.illustrator);
  const has = new Set(kept.tags.map((t) => t.toLowerCase()));
  const tags = old.tags.filter((t) => isCustomTag(t, customTags) && !has.has(t.toLowerCase()));
  if (tags.length > 0) add('tags', kept.tags, { add: tags, remove: [] });
  return out;
}

/** A field's change from every old record a copy replaced, merged. */
export interface MergedChange extends InheritChange {
  /** The old record (index in `olds`) whose value it is, for what the cleanup knew of it. */
  from: number | null;
  /** The old records disagree: listed for review, never written. */
  conflict: string | null;
}

/**
 * One kept copy may have replaced several library books (two copies of one book): one change
 * per field from all of them (the write refuses two changes of one field). Store ids and custom
 * tags are pooled (an id type the old records give different values of is left out); any other
 * field the old records agree on is given, else it goes to review.
 */
export function mergeInherit(
  olds: InheritValues[],
  kept: InheritValues,
  customTags: string[],
  yours: ReadonlySet<string> = new Set(),
): MergedChange[] {
  const per = olds.map((o) => inheritChanges(o, kept, customTags, yours));
  const fields = [...new Set(per.flat().map((c) => c.field))];
  const out: MergedChange[] = [];
  for (const field of fields) {
    const found = per
      .map((l, i) => ({ c: l.find((x) => x.field === field), i }))
      .filter((x): x is { c: InheritChange; i: number } => !!x.c);
    const first = found[0].c;
    if (field === 'identifiers') {
      const pooled = new Map<string, string>();
      const clash = new Set<string>();
      for (const { c } of found)
        for (const [type, v] of Object.entries(c.value as Record<string, string>)) {
          if (type in kept.identifiers) continue;
          if (pooled.has(type) && pooled.get(type) !== v) clash.add(type);
          else pooled.set(type, v);
        }
      for (const t of clash) pooled.delete(t);
      if (pooled.size === 0) continue;
      out.push({
        ...first,
        value: { ...kept.identifiers, ...Object.fromEntries(pooled) },
        from: null,
        conflict: null,
      });
      continue;
    }
    if (field === 'tags') {
      const add: string[] = [];
      const seen = new Set<string>();
      for (const { c } of found)
        for (const t of (c.value as { add: string[] }).add)
          if (!seen.has(t.toLowerCase())) {
            seen.add(t.toLowerCase());
            add.push(t);
          }
      out.push({ ...first, value: { add, remove: [] }, from: null, conflict: null });
      continue;
    }
    const distinct = [...new Set(found.map(({ c }) => JSON.stringify(c.value)))];
    out.push({
      ...first,
      from: found[0].i,
      conflict:
        distinct.length > 1
          ? `The library books this copy replaced had different values: ${distinct.join(' / ')}`
          : null,
    });
  }
  return out;
}
