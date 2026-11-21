/**
 * One recording's decisions (WP21d), pure: the rules, the two models' answers and setup E
 * (framework `combineE`) for every field, in this order:
 *
 * 1. The record. Stage 4's automatic match stays (a model saying "none" is no answer: the
 *    match passed title, author, volume and length; the models can still flag its fields).
 *    For a recording stage 4 left in review, the record is an open field: when both models
 *    pick the same candidate it is applied (decided with the user, 2026-11-19); otherwise the
 *    best guess (Luna's pick, else stage 4's best guess), unconfirmed.
 * 2. The rules' values from that record (all open when the record is unconfirmed).
 * 3. Title, authors, narrators, series and drama by setup E.
 *    The follow-up rules (2026-11-20): a store, publisher or company is never a narrator or an
 *    author, in the models' answers too; an imprint is never a series, in the models' answers
 *    too; the rules' title stands against a model that only drops an edition mark or adds a
 *    volume number; a printed volume number with no store series is "unknown" when the
 *    models give none (their guess stays unconfirmed; the ebook pass, WP21g, fills the rest).
 * 4. 複数ナレーター from the narrators decided (their source and flag).
 * 5. Publisher, year, language, store id, description and cover from the record, by rules
 *    alone: unconfirmed with the record, unknown without one.
 */
import { answerOf, combineE, combineUpgrade, type UpgradeDesign } from '../ai/combine';
import type { FieldDecision, RulesValue } from '../ai/types';
import type { MetaEvidence, RecordBrief } from './meta-evidence';
import { META_FIELDS, seriesKey, titleKey } from './meta-prompt';
import {
  isImprintSeries,
  isNotPerson,
  metaRules,
  onlyEditionOrNumberChange,
  storeFields,
  VOLUME_NO_SERIES,
  type MetaRules,
  type SeriesEntry,
} from './meta-rules';

export const META_VALUE_FIELDS = [
  'record',
  'title',
  'authors',
  'narrators',
  'series',
  'drama',
  'multi_narr',
  'publisher',
  'year',
  'language',
  'store_id',
  'description',
  'cover',
] as const;
export type MetaValueField = (typeof META_VALUE_FIELDS)[number];

/** One recording as the same-book series rule sees it, after its own decision. */
export interface SameBookUnit {
  key: string;
  name: string;
  /** Its series came from Audible's own series data (and is confirmed). */
  audibleSeries: boolean;
  /** Its store record is Audible's with series data (its series is never replaced). */
  audibleRecord: boolean;
  title: string | null;
  authors: string[];
  series: { name: string; position: number | null; label?: string | null }[] | null;
  /** Its series value is the user's (never changed by a rule). */
  user?: boolean;
  /** Its series is a models' guess kept for a printed volume number (the twin's still replaces it). */
  volumeGuess?: boolean;
}

/**
 * A position two different recordings of one Audible series share is contradicted by Audible
 * itself (灼眼のシャナ X and XI both at 11; D県警's four stories at 1): every recording at it
 * keeps the series without a number (user, 2026-11-20). Recordings with equal titles are copies
 * of one book and don't count; a series with one recording is never touched. Evaluated over the
 * whole library on every pass, so new arrivals are covered. Returns the new series values.
 */
export function sharedPositions(
  units: SameBookUnit[],
): Map<string, NonNullable<SameBookUnit['series']>> {
  const key = (name: string, pos: number) => `${titleKey(name)}#${pos}`;
  const groups = new Map<string, { keys: Set<string>; titles: Set<string> }>();
  const usable = (u: SameBookUnit) => u.audibleRecord && !u.user && !!u.title && !!u.series;
  for (const u of units) {
    if (!usable(u)) continue;
    const tk = titleKey(u.title!);
    for (const s of u.series!) {
      if (s.position === null || s.label === 'drama') continue;
      const k = key(s.name, s.position);
      const g = groups.get(k) ?? { keys: new Set<string>(), titles: new Set<string>() };
      g.keys.add(u.key);
      g.titles.add(tk);
      groups.set(k, g);
    }
  }
  const out = new Map<string, NonNullable<SameBookUnit['series']>>();
  for (const u of units) {
    if (!usable(u)) continue;
    let changed = false;
    const next = u.series!.map((s) => {
      if (s.position === null || s.label === 'drama') return s;
      const g = groups.get(key(s.name, s.position));
      if (g && g.keys.size >= 2 && g.titles.size >= 2) {
        changed = true;
        return { ...s, position: null };
      }
      return s;
    });
    if (changed) out.set(u.key, next);
  }
  return out;
}

/**
 * The same book's series in Audible's name (user, 2026-11-20): a recording whose store has no
 * series data takes the series of an Audible edition of the same book in the library (same
 * title, an author in common), when that edition's series is confirmed. Measured on the live
 * library first: 19 recordings, each matching Audible's data for the other edition (屍人荘,
 * 成瀬, 伊良部, 十二国記, …); matching series names alone was wrong and is not done.
 */
export function sameBookSeries(
  units: SameBookUnit[],
): Map<string, { series: NonNullable<SameBookUnit['series']>; from: string }> {
  const nameKey = (s: string) =>
    s
      .normalize('NFKC')
      .replace(/[\s・･=＝]/gu, '')
      .toLowerCase();
  const byTitle = new Map<string, SameBookUnit[]>();
  for (const u of units)
    if (u.audibleSeries && u.title && u.series?.length) {
      const k = titleKey(u.title);
      byTitle.set(k, [...(byTitle.get(k) ?? []), u]);
    }
  const out = new Map<string, { series: NonNullable<SameBookUnit['series']>; from: string }>();
  for (const u of units) {
    if (u.audibleRecord || !u.title) continue;
    const mine = u.authors.map(nameKey);
    const twin = (byTitle.get(titleKey(u.title)) ?? []).find((a) =>
      a.authors.map(nameKey).some((x) => mine.includes(x)),
    );
    if (!twin) continue;
    const series = twin.series!.map((s) => ({
      name: s.name,
      position: s.position,
      label: s.label ?? null,
    }));
    if (
      u.series &&
      !u.volumeGuess &&
      seriesKey(u.series.map((s) => ({ ...s, label: s.label ?? null }))) === seriesKey(series)
    )
      continue;
    out.set(u.key, { series, from: twin.name });
  }
  return out;
}

export interface FieldOutcome {
  decision: FieldDecision;
  rules: { value: unknown; auto: boolean } | null;
  primary: unknown;
  secondary: unknown;
}

export interface UnitOutcome {
  fields: Partial<Record<MetaValueField, FieldOutcome>>;
  record: RecordBrief | null;
  recordConfirmed: boolean;
  /** Model strings dropped because the evidence doesn't hold them (never invent). */
  invented: number;
}

type Answer = Record<string, unknown> | null;

/**
 * WP21f-1: whether an item decided with F or J has anything for the stronger pair (the same
 * fields `upgradeTargets` returns): F a flagged field; J also an open field E's pair agreed on.
 * A user's value and a rules value E kept never are.
 */
export function needsUpgrade(out: UnitOutcome, design: 'F' | 'J'): boolean {
  // Only the fields the models answer (the record's other fields follow the record).
  return (['record', 'title', 'authors', 'narrators', 'series', 'drama'] as const).some((f) => {
    const d = out.fields[f]?.decision;
    if (!d || d.source === 'user') return false;
    return d.flagged || (design === 'J' && d.source === 'both_models');
  });
}

const rulesOut = <V>(r: RulesValue<V> | null) => (r ? { value: r.value, auto: r.auto } : null);

export function decideUnit(
  ev: MetaEvidence,
  answers: { primary: Answer; secondary: Answer },
  evidenceText: string,
  opts: { multiNarratorMin: number },
  /**
   * WP21f-1: an upgrade (F or J) with the stronger pair's answers. Without any answer of the
   * stronger pair the item is decided as E (an item with nothing to re-check is never asked).
   */
  upgrade?: { design: UpgradeDesign; primary: Answer; secondary: Answer },
): UnitOutcome {
  const fields: UnitOutcome['fields'] = {};
  let invented = 0;
  const ans = <V>(f: (typeof META_FIELDS)[keyof typeof META_FIELDS], a: Answer): V | undefined => {
    const r = answerOf(f as never, a, evidenceText);
    if (r.invented) invented++;
    return r.value as V | undefined;
  };
  const strong = upgrade && (upgrade.primary || upgrade.secondary) ? upgrade : null;
  /** Setup E, or the upgrade when the stronger pair answered. */
  const combine = <V>(
    f: Parameters<typeof combineE<V>>[0],
    r: RulesValue<V>,
    p: V | undefined,
    s: V | undefined,
    sp: V | undefined,
    ss: V | undefined,
  ): FieldDecision<V> =>
    strong
      ? combineUpgrade(
          strong.design,
          f,
          r,
          { primary: p, secondary: s },
          { primary: sp, secondary: ss },
        )
      : combineE(f, r, p, s);

  // 1. the record
  let record: RecordBrief | null = ev.kind === 'record' ? ev.record : null;
  let confirmed = ev.kind === 'record' && ev.stage4.class === 'auto' && !!ev.record;
  const first = metaRules(ev, record, confirmed);
  if (first.record && ev.record) {
    const choices = new Map<string, RecordBrief>([[ev.record.id, ev.record]]);
    for (const c of ev.candidates) choices.set(c.record.id, c.record);
    const pick = (a: Answer) => {
      const v = ans<string>(META_FIELDS.record, a);
      return v !== undefined && choices.has(v) ? v : undefined;
    };
    const p = pick(answers.primary);
    const s = pick(answers.secondary);
    const d = combine(
      META_FIELDS.record as never,
      first.record,
      p,
      s,
      strong ? pick(strong.primary) : undefined,
      strong ? pick(strong.secondary) : undefined,
    ) as FieldDecision;
    fields.record = {
      decision: d,
      rules: rulesOut(first.record),
      primary: p ?? null,
      secondary: s ?? null,
    };
    record = d.value ? (choices.get(d.value as string) ?? null) : null;
    confirmed = !d.flagged && record !== null;
  }

  // 2. the rules from that record
  const rules: MetaRules =
    record === ev.record && confirmed === (ev.stage4.class === 'auto')
      ? first
      : metaRules(ev, record, confirmed);

  // 3. setup E per field
  const one = <V>(
    name: 'title' | 'authors' | 'narrators' | 'series' | 'drama',
    clean: (v: V | undefined) => V | undefined = (v) => v,
  ) => {
    const f = META_FIELDS[name] as unknown as Parameters<typeof combineE<V>>[0];
    const r = rules[name] as unknown as RulesValue<V>;
    const p = clean(ans<V>(META_FIELDS[name], answers.primary));
    const s = clean(ans<V>(META_FIELDS[name], answers.secondary));
    const sp = strong ? clean(ans<V>(META_FIELDS[name], strong.primary)) : undefined;
    const ss = strong ? clean(ans<V>(META_FIELDS[name], strong.secondary)) : undefined;
    fields[name] = {
      decision: combine(f, r, p, s, sp, ss) as FieldDecision,
      rules: rulesOut(r),
      primary: p ?? null,
      secondary: s ?? null,
    };
  };
  const publisher = record?.publisher ?? null;
  const people = (v: string[] | undefined) => v?.filter((x) => !isNotPerson(x, publisher));
  one<string>('title');
  one<string[]>('authors', people);
  // A model's narrators that were only a company leave no answer.
  one<string[]>('narrators', (v) => {
    const l = people(v);
    return l?.length ? l : undefined;
  });
  one<SeriesEntry[]>('series', (v) => v?.filter((x) => !isImprintSeries(x.name)));
  one<boolean>('drama');

  // The rules' title stands against a model that only drops an edition mark or adds a number.
  {
    const t = fields.title!;
    const rt = rules.title;
    if (
      rt.auto &&
      rt.value !== null &&
      t.decision.source !== 'rules' &&
      typeof t.decision.value === 'string' &&
      onlyEditionOrNumberChange(rt.value, t.decision.value)
    )
      t.decision = { value: rt.value, source: 'rules', flagged: false, reason: null };
  }
  // A printed volume number and no store series: the models' guess stays as an unconfirmed value
  // (as every open field); only when they give none is it unknown, for the ebook pass
  // (user, 2026-11-20).
  const sd = fields.series!.decision;
  const noGuess = sd.value === null || (Array.isArray(sd.value) && sd.value.length === 0);
  if (rules.series.reason === VOLUME_NO_SERIES && rules.series.value === null)
    fields.series!.decision = noGuess
      ? { value: null, source: 'unknown', flagged: true, reason: VOLUME_NO_SERIES }
      : { ...sd, flagged: true, reason: VOLUME_NO_SERIES };

  // 4. 複数ナレーター follows the narrators
  const n = fields.narrators!.decision;
  const narr = n.value as string[] | null;
  fields.multi_narr = {
    decision: {
      value: narr ? narr.length >= opts.multiNarratorMin : null,
      source: n.source,
      flagged: n.flagged,
      reason: n.reason,
    },
    rules: null,
    primary: null,
    secondary: null,
  };

  // 5. the record's other fields, by rules alone
  const sf = storeFields(record);
  const put = (name: MetaValueField, value: unknown) => {
    fields[name] = {
      decision:
        value === null || value === undefined
          ? {
              value: null,
              source: 'unknown',
              flagged: false,
              reason: record ? null : 'No store record',
            }
          : confirmed
            ? { value, source: 'rules', flagged: false, reason: null }
            : {
                value,
                source: 'rules_guess',
                flagged: true,
                reason: 'From a store record that is not confirmed',
              },
      rules: { value: value ?? null, auto: confirmed },
      primary: null,
      secondary: null,
    };
  };
  put('publisher', sf.publisher);
  put('year', sf.year);
  if (record) put('language', sf.language);
  else
    // Without a record: the Japanese library's language, as sure as the folder it is in.
    fields.language = {
      decision: { value: 'ja', source: 'rules', flagged: false, reason: null },
      rules: { value: 'ja', auto: true },
      primary: null,
      secondary: null,
    };
  put('store_id', sf.storeId);
  put('description', sf.description);
  put('cover', sf.cover);
  return { fields, record, recordConfirmed: confirmed, invented };
}
