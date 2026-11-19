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
 * 4. 複数ナレーター from the narrators decided (their source and flag).
 * 5. Publisher, year, language, store id, description and cover from the record, by rules
 *    alone: unconfirmed with the record, unknown without one.
 */
import { answerOf, combineE } from '../ai/combine';
import type { FieldDecision, RulesValue } from '../ai/types';
import type { MetaEvidence, RecordBrief } from './meta-evidence';
import { META_FIELDS } from './meta-prompt';
import { metaRules, storeFields, type MetaRules } from './meta-rules';

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

const rulesOut = <V>(r: RulesValue<V> | null) => (r ? { value: r.value, auto: r.auto } : null);

export function decideUnit(
  ev: MetaEvidence,
  answers: { primary: Answer; secondary: Answer },
  evidenceText: string,
  opts: { multiNarratorMin: number },
): UnitOutcome {
  const fields: UnitOutcome['fields'] = {};
  let invented = 0;
  const ans = <V>(f: (typeof META_FIELDS)[keyof typeof META_FIELDS], a: Answer): V | undefined => {
    const r = answerOf(f as never, a, evidenceText);
    if (r.invented) invented++;
    return r.value as V | undefined;
  };

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
    const d = combineE(META_FIELDS.record, first.record, p, s);
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
  const one = <V>(name: 'title' | 'authors' | 'narrators' | 'series' | 'drama') => {
    const f = META_FIELDS[name] as unknown as Parameters<typeof combineE<V>>[0];
    const r = rules[name] as unknown as RulesValue<V>;
    const p = ans<V>(META_FIELDS[name], answers.primary);
    const s = ans<V>(META_FIELDS[name], answers.secondary);
    fields[name] = {
      decision: combineE(f, r, p, s) as FieldDecision,
      rules: rulesOut(r),
      primary: p ?? null,
      secondary: s ?? null,
    };
  };
  one<string>('title');
  one<string[]>('authors');
  one<string[]>('narrators');
  one('series');
  one<boolean>('drama');

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
