/**
 * Calibre stage 4's AI decision per book (WP20e, pure): setup E per field (the framework's
 * combineE) against the stage-4 rules' values and classes, as the bake-off's design E did
 * (designs2.py check_all): an automatic rules value stays unless both models agree against it
 * (flagged); an open field is applied when both models agree; a flagged field gets Luna's
 * answer, else the rules' value, marked unconfirmed.
 *
 * The rules' value of the number is v3's, else stage 4's best guess (numberGuess: side volume,
 * store bonus N.1, omnibus), which v3 leaves open. Edition kind stays with the rules.
 */
import type Database from 'better-sqlite3';
import { answerOf, combineE } from '../ai/combine';
import type { FieldDecision, RulesValue } from '../ai/types';
import type { DecisionRow } from '../ai/values';
import { STAGE4_AI_FIELDS, type NumberValue, type SeriesValue } from './ai-prompt';
import type { Stage4Decision } from './stage4-rules';

/** Raised when the decision rules here change (decided again from the stored answers). */
export const STAGE4_AI_DECIDE_VERSION = 1;

export const AI_FIELD_KEYS = ['t', 'au', 'il', 'se', 'ix', 'fmt'] as const;
export type AiFieldKey = (typeof AI_FIELD_KEYS)[number];

export interface FieldOutcome<V> {
  decision: FieldDecision<V>;
  rules: RulesValue<V>;
  primary: V | undefined;
  secondary: V | undefined;
}

export interface Stage4AiOutcome {
  t: FieldOutcome<string>;
  au: FieldOutcome<string[]>;
  il: FieldOutcome<string[]>;
  se: FieldOutcome<SeriesValue>;
  ix: FieldOutcome<NumberValue>;
  fmt: FieldOutcome<string>;
  /** Both models answered "Amazon is this book" (the description case). */
  amazonIsBook: boolean;
  /** Model values dropped by the never-invent check. */
  invented: number;
}

type Answer = Record<string, unknown> | null;

/** The rules' values in the fields' shapes. */
export function stage4RulesValues(d: Stage4Decision): {
  t: RulesValue<string>;
  au: RulesValue<string[]>;
  il: RulesValue<string[]>;
  se: RulesValue<SeriesValue>;
  ix: RulesValue<NumberValue>;
  fmt: RulesValue<string>;
} {
  const v = d.values;
  const a = d.auto;
  const number = v.ix ?? (v.se ? (d.numberGuess?.value ?? null) : null);
  return {
    t: {
      value: v.t || null,
      auto: a.t,
      reason: a.t ? null : 'The online sources do not confirm the title',
    },
    au: {
      value: v.au,
      auto: a.au,
      reason: a.au ? null : 'The online sources do not confirm the authors',
    },
    il: {
      value: v.il,
      auto: a.il,
      reason: a.il ? null : 'The online sources do not confirm the illustrators',
    },
    se: {
      value: { name: v.se },
      auto: a.se,
      reason: a.se ? null : 'The online sources do not confirm the series',
    },
    ix: {
      value: { n: number },
      auto: a.ix,
      reason: a.ix
        ? null
        : d.numberGuess
          ? `The number is a best guess (${d.numberGuess.rule})`
          : 'The online sources do not confirm the number',
    },
    fmt: {
      value: v.fmt,
      auto: a.fmt,
      reason: a.fmt ? null : (d.amazonRejected ?? 'Amazon does not confirm the format'),
    },
  };
}

export function decideStage4Ai(
  d: Stage4Decision,
  answers: { primary: Answer; secondary: Answer },
  evidenceText: string,
): Stage4AiOutcome {
  const rules = stage4RulesValues(d);
  let invented = 0;
  const one = <V>(key: keyof typeof STAGE4_AI_FIELDS, r: RulesValue<V>): FieldOutcome<V> => {
    const field = STAGE4_AI_FIELDS[key] as unknown as Parameters<typeof answerOf<V>>[0];
    const p = answerOf<V>(field, answers.primary, evidenceText);
    const s = answerOf<V>(field, answers.secondary, evidenceText);
    if (p.invented) invented++;
    if (s.invented) invented++;
    return {
      decision: combineE(field, r, p.value, s.value),
      rules: r,
      primary: p.value,
      secondary: s.value,
    };
  };
  const out = {
    t: one('t', rules.t),
    au: one('au', rules.au),
    il: one('il', rules.il),
    se: one('se', rules.se),
    ix: one('ix', rules.ix),
    fmt: one('fmt', rules.fmt),
  };
  const pa = answers.primary?.amazon_is_this_book;
  const sa = answers.secondary?.amazon_is_this_book;
  return { ...out, amazonIsBook: pa === true && sa === true, invented };
}

/** The rows writeDecisions stores (one per field). */
export function decisionRows(
  itemKey: string,
  o: Stage4AiOutcome,
  evidenceHash: string | null,
  /** Both models answered this book (else the rules' classes stand: nothing is guessed). */
  asked: boolean,
): DecisionRow[] {
  const extra = (field: string, value: boolean): DecisionRow => ({
    itemKey,
    field,
    decision: { value, source: value ? 'both_models' : 'rules', flagged: false, reason: null },
    rules: null,
    primary: null,
    secondary: null,
    evidenceHash,
  });
  return [extra(ASKED_FIELD, asked), extra(AMAZON_FIELD, o.amazonIsBook)].concat(
    AI_FIELD_KEYS.map((f) => {
      const x = o[f] as FieldOutcome<unknown>;
      return {
        itemKey,
        field: f,
        decision: x.decision,
        rules: { value: x.rules.value, auto: x.rules.auto },
        primary: x.primary ?? null,
        secondary: x.secondary ?? null,
        evidenceHash,
      };
    }),
  );
}

/** A decided value as the proposals read it (from ai_values, so a user value wins). */
export interface AiValue {
  value: unknown;
  source: string;
  flagged: boolean;
  reason: string | null;
}
export type Stage4AiValues = Partial<Record<AiFieldKey, AiValue>> & {
  /** Both models say the Amazon result is this book (the description case). */
  amazonIsBook?: boolean;
};

/** The decided values of a book as stored (ai_values 'calibre4'); null when none. */
export function storedAiValues(
  db: Database.Database,
  itemKey: string,
): (Stage4AiValues & { asked: boolean }) | null {
  const rows = db
    .prepare(
      'SELECT field, value_json, source, flagged, reason FROM ai_values WHERE stage = ? AND item_key = ?',
    )
    .all('calibre4', itemKey) as {
    field: string;
    value_json: string | null;
    source: string;
    flagged: number;
    reason: string | null;
  }[];
  if (!rows.length) return null;
  const out: Stage4AiValues & { asked: boolean } = { asked: false };
  for (const r of rows) {
    const value = r.value_json === null ? null : JSON.parse(r.value_json);
    if (r.field === ASKED_FIELD) out.asked = value === true;
    else if (r.field === AMAZON_FIELD) out.amazonIsBook = value === true;
    else if ((AI_FIELD_KEYS as readonly string[]).includes(r.field))
      out[r.field as AiFieldKey] = {
        value,
        source: r.source,
        flagged: !!r.flagged,
        reason: r.reason,
      };
  }
  return out;
}

/** Extra rows per book: whether both models were asked and answered, and the description case. */
export const ASKED_FIELD = 'asked';
export const AMAZON_FIELD = 'amazon_is_book';

/** Automatic after the AI: the rules' value or both models' (or the user's). */
export const isConfirmed = (v: AiValue | undefined) =>
  !!v && !v.flagged && (v.source === 'rules' || v.source === 'both_models' || v.source === 'user');
