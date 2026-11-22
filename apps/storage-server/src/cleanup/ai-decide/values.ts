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
  /** WP21f-1: the design this row was decided with (else the call's). */
  design?: string;
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
        r.design ?? design,
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

/** How strong a design is: E < F < J (an upgrade never repeats itself or a weaker one). */
export const DESIGN_RANK: Record<string, number> = { E: 0, F: 1, J: 2 };

/** The designs at least as strong as `design` (their values an upgrade to it skips). */
export function designsAtLeast(design: UpgradeDesign): string[] {
  return Object.keys(DESIGN_RANK).filter((d) => DESIGN_RANK[d] >= DESIGN_RANK[design]);
}

/**
 * The fields an upgrade re-checks (requirement 3): F only what E flagged; J also every open
 * field both of E's models agreed on. Never a user value, never a rules value E kept.
 *
 * WP21f-1: a value already decided by the requested design or a stronger one is skipped (for F:
 * F and J; for J: J), so a later library-wide J upgrade doesn't ask again about the new arrivals
 * stage 7 decided with J. `includeDecided` (setting `ai.upgradeIncludeDecided`, off) takes them
 * too.
 */
export function upgradeTargets(
  db: Database.Database,
  stage: string,
  design: UpgradeDesign,
  opts: { includeDecided?: boolean } = {},
): { itemKey: string; field: string }[] {
  const what =
    design === 'F'
      ? `flagged = 1 AND source <> 'user'`
      : `(flagged = 1 OR source = 'both_models') AND source <> 'user'`;
  const skip = opts.includeDecided ? [] : designsAtLeast(design);
  const where = skip.length
    ? `${what} AND design NOT IN (${skip.map(() => '?').join(', ')})`
    : what;
  return (
    db
      .prepare(
        `SELECT item_key, field FROM ai_values WHERE stage = ? AND ${where} ORDER BY item_key, field`,
      )
      .all(stage, ...skip) as { item_key: string; field: string }[]
  ).map((r) => ({ itemKey: r.item_key, field: r.field }));
}

/**
 * Items by the design their values were decided with (user values aside), for the page: how many
 * recordings are at E, F and J. An item counts at the strongest design any of its fields has.
 */
export function designCounts(db: Database.Database, stage: string): Record<string, number> {
  const out: Record<string, number> = { E: 0, F: 0, J: 0 };
  for (const r of db
    .prepare(
      `SELECT strongest, COUNT(*) AS n FROM (
         SELECT item_key,
           MAX(CASE ai_values.design WHEN 'J' THEN 2 WHEN 'F' THEN 1 ELSE 0 END) AS strongest
         FROM ai_values WHERE stage = ? AND source <> 'user' GROUP BY item_key)
       GROUP BY strongest`,
    )
    .all(stage) as { strongest: number; n: number }[])
    out[['E', 'F', 'J'][r.strongest] ?? 'E'] += r.n;
  return out;
}

/** WP21f-1: the design each item is to be decided with (none = E). */
export function itemDesigns(db: Database.Database, stage: string): Map<string, string> {
  return new Map(
    (
      db.prepare('SELECT item_key, design FROM ai_item_designs WHERE stage = ?').all(stage) as {
        item_key: string;
        design: string;
      }[]
    ).map((r) => [r.item_key, r.design]),
  );
}

/** Replaces a stage's item designs (only E rows are left out: E is the default). */
export function setItemDesigns(
  db: Database.Database,
  stage: string,
  designs: Map<string, string>,
  now: number,
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM ai_item_designs WHERE stage = ?').run(stage);
    const put = db.prepare(
      'INSERT INTO ai_item_designs (stage, item_key, design, set_at) VALUES (?, ?, ?, ?)',
    );
    for (const [k, d] of designs) if (d !== 'E') put.run(stage, k, d, now);
  })();
}

/**
 * WP20g: sets the design of the given items (others kept; E rows removed: E is the default). The
 * Calibre library's new arrivals are decided with J and keep it when the library is decided again.
 */
export function addItemDesigns(
  db: Database.Database,
  stage: string,
  designs: Map<string, string>,
  now: number,
): void {
  db.transaction(() => {
    const del = db.prepare('DELETE FROM ai_item_designs WHERE stage = ? AND item_key = ?');
    const put = db.prepare(
      `INSERT INTO ai_item_designs (stage, item_key, design, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(stage, item_key) DO UPDATE SET design = excluded.design, set_at = excluded.set_at`,
    );
    for (const [k, d] of designs) {
      if (d === 'E') del.run(stage, k);
      else put.run(stage, k, d, now);
    }
  })();
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
