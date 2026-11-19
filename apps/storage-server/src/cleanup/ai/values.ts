/**
 * Every field's value and where it came from (cleanup.db `ai_values`, WP21d). The upgrade path
 * of library-cleanup-plan.md section 6 (requirements 1-4):
 *   1. each item's evidence record is kept (`ai_items`, runner.ts);
 *   2. the source of every value is stored (rules / both_models / secondary_guess / rules_guess
 *      / unknown / user / upgrade_models);
 *   3. an upgrade (F or J) re-checks only what the models decided or guessed
 *      (`upgradeTargets`);
 *   4. a later pass never overwrites a value the user edited (`writeDecisions` skips `user`).
 */
import type Database from 'better-sqlite3';
import type { UpgradeDesign } from './combine';
import type { FieldDecision, ValueSource } from './types';

export interface StoredValue {
  itemKey: string;
  field: string;
  value: unknown;
  source: ValueSource;
  flagged: boolean;
  reason: string | null;
  rules: unknown;
  rulesAuto: boolean | null;
  primary: unknown;
  secondary: unknown;
  design: string;
  decidedAt: number;
  userAt: number | null;
}

export interface DecisionRow {
  itemKey: string;
  field: string;
  decision: FieldDecision;
  rules: { value: unknown; auto: boolean } | null;
  primary: unknown;
  secondary: unknown;
  evidenceHash: string | null;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/**
 * Writes decisions. A value the user set is never replaced (requirement 4): the row keeps its
 * value and source; only the models' and rules' answers next to it are refreshed.
 */
export function writeDecisions(
  db: Database.Database,
  stage: string,
  rows: DecisionRow[],
  design: string,
  now: number,
): void {
  const put = db.prepare(
    `INSERT INTO ai_values (stage, item_key, field, value_json, source, flagged, reason, rules_json,
       rules_auto, primary_json, secondary_json, design, evidence_hash, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stage, item_key, field) DO UPDATE SET
       value_json = CASE WHEN ai_values.source = 'user' THEN ai_values.value_json ELSE excluded.value_json END,
       source = CASE WHEN ai_values.source = 'user' THEN 'user' ELSE excluded.source END,
       flagged = CASE WHEN ai_values.source = 'user' THEN 0 ELSE excluded.flagged END,
       reason = CASE WHEN ai_values.source = 'user' THEN ai_values.reason ELSE excluded.reason END,
       rules_json = excluded.rules_json, rules_auto = excluded.rules_auto,
       primary_json = excluded.primary_json, secondary_json = excluded.secondary_json,
       design = CASE WHEN ai_values.source = 'user' THEN ai_values.design ELSE excluded.design END,
       evidence_hash = excluded.evidence_hash, decided_at = excluded.decided_at`,
  );
  db.transaction(() => {
    for (const r of rows) {
      put.run(
        stage,
        r.itemKey,
        r.field,
        JSON.stringify(r.decision.value),
        r.decision.source,
        r.decision.flagged ? 1 : 0,
        r.decision.reason,
        r.rules ? JSON.stringify(r.rules.value) : null,
        r.rules ? (r.rules.auto ? 1 : 0) : null,
        json(r.primary),
        json(r.secondary),
        design,
        r.evidenceHash,
        now,
      );
    }
  })();
}

/** The user's own value (kept by every later pass). */
export function setUserValue(
  db: Database.Database,
  stage: string,
  itemKey: string,
  field: string,
  value: unknown,
  now: number,
): void {
  db.prepare(
    `INSERT INTO ai_values (stage, item_key, field, value_json, source, flagged, design, decided_at, user_at)
     VALUES (?, ?, ?, ?, 'user', 0, 'user', ?, ?)
     ON CONFLICT(stage, item_key, field) DO UPDATE SET value_json = excluded.value_json,
       source = 'user', flagged = 0, reason = NULL, user_at = excluded.user_at`,
  ).run(stage, itemKey, field, JSON.stringify(value), now, now);
}

interface Row {
  item_key: string;
  field: string;
  value_json: string;
  source: ValueSource;
  flagged: number;
  reason: string | null;
  rules_json: string | null;
  rules_auto: number | null;
  primary_json: string | null;
  secondary_json: string | null;
  design: string;
  decided_at: number;
  user_at: number | null;
}

const parse = (s: string | null): unknown => (s === null ? null : (JSON.parse(s) as unknown));

function toValue(r: Row): StoredValue {
  return {
    itemKey: r.item_key,
    field: r.field,
    value: parse(r.value_json),
    source: r.source,
    flagged: r.flagged === 1,
    reason: r.reason,
    rules: parse(r.rules_json),
    rulesAuto: r.rules_auto === null ? null : r.rules_auto === 1,
    primary: parse(r.primary_json),
    secondary: parse(r.secondary_json),
    design: r.design,
    decidedAt: r.decided_at,
    userAt: r.user_at,
  };
}

export function valuesOf(db: Database.Database, stage: string, itemKey: string): StoredValue[] {
  return (
    db
      .prepare('SELECT * FROM ai_values WHERE stage = ? AND item_key = ? ORDER BY field')
      .all(stage, itemKey) as Row[]
  ).map(toValue);
}

/**
 * The fields an upgrade re-checks (requirement 3): F only what E flagged; J also every open
 * field both of E's models agreed on. Never a user value, never a rules value E kept.
 */
export function upgradeTargets(
  db: Database.Database,
  stage: string,
  design: UpgradeDesign,
): { itemKey: string; field: string }[] {
  const where =
    design === 'F'
      ? `flagged = 1 AND source <> 'user'`
      : `(flagged = 1 OR source = 'both_models') AND source <> 'user'`;
  return (
    db
      .prepare(
        `SELECT item_key, field FROM ai_values WHERE stage = ? AND ${where} ORDER BY item_key, field`,
      )
      .all(stage) as { item_key: string; field: string }[]
  ).map((r) => ({ itemKey: r.item_key, field: r.field }));
}

/** Counts per field and source (and flagged), for the page and the reports. */
export function valueCounts(
  db: Database.Database,
  stage: string,
  itemKeys?: string[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const rows = db
    .prepare(`SELECT item_key, field, source, flagged FROM ai_values WHERE stage = ?`)
    .all(stage) as { item_key: string; field: string; source: string; flagged: number }[];
  const only = itemKeys ? new Set(itemKeys) : null;
  for (const r of rows) {
    if (only && !only.has(r.item_key)) continue;
    const f = (out[r.field] ??= {});
    f[r.source] = (f[r.source] ?? 0) + 1;
    if (r.flagged) f.flagged = (f.flagged ?? 0) + 1;
  }
  return out;
}

/** Removes the values of items no longer analysed (a user value is kept). */
export function dropOtherItems(db: Database.Database, stage: string, keep: Set<string>): number {
  const keys = db
    .prepare(`SELECT DISTINCT item_key FROM ai_values WHERE stage = ? AND source <> 'user'`)
    .all(stage) as { item_key: string }[];
  const del = db.prepare(
    `DELETE FROM ai_values WHERE stage = ? AND item_key = ? AND source <> 'user'`,
  );
  let n = 0;
  db.transaction(() => {
    for (const k of keys) if (!keep.has(k.item_key)) n += del.run(stage, k.item_key).changes;
  })();
  return n;
}
