/**
 * The spending ledger (ttsu.db ai_spend): one row per paid request of every feature, so the one
 * monthly limit covers them all and Settings > AI can show where the money went. A feature's
 * own answers stay in its own database; the row points back to its request (`source`, `ref`).
 * Holds (ai_holds): the estimates of batches still at a provider, counted against the limit
 * until their answers are in.
 */
import type Database from 'better-sqlite3';

export interface SpendRow {
  source: string;
  ref: number;
  feature: string;
  stage: string;
  provider: string;
  model: string;
  mode: string | null;
  costUsd: number;
  at: number;
}

/** Records a paid request (once per source and ref). True when it was new. */
export function recordSpend(db: Database.Database, r: SpendRow): boolean {
  return (
    db
      .prepare(
        `INSERT INTO ai_spend (source, ref, feature, stage, provider, model, mode, cost_usd, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, ref) DO NOTHING`,
      )
      .run(r.source, r.ref, r.feature, r.stage, r.provider, r.model, r.mode, r.costUsd, r.at)
      .changes > 0
  );
}

/** Records many rows in one transaction; returns how many were new. */
export function recordSpendMany(db: Database.Database, rows: SpendRow[]): number {
  const ins = db.prepare(
    `INSERT INTO ai_spend (source, ref, feature, stage, provider, model, mode, cost_usd, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, ref) DO NOTHING`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows)
      n += ins.run(
        r.source,
        r.ref,
        r.feature,
        r.stage,
        r.provider,
        r.model,
        r.mode,
        r.costUsd,
        r.at,
      ).changes;
  })();
  return n;
}

/** Spent between two instants (start inclusive, end exclusive). */
export function spentBetween(db: Database.Database, start: number, end: number): number {
  return (
    db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_spend WHERE at >= ? AND at < ?`)
      .get(start, end) as { c: number }
  ).c;
}

/** Spent per feature between two instants. */
export function spentByFeature(
  db: Database.Database,
  start: number,
  end: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      `SELECT feature, COALESCE(SUM(cost_usd), 0) AS c FROM ai_spend WHERE at >= ? AND at < ?
       GROUP BY feature`,
    )
    .all(start, end) as { feature: string; c: number }[])
    out[r.feature] = r.c;
  return out;
}

/** Every row's total (the move's check). */
export function spentTotal(db: Database.Database, source?: string): { usd: number; rows: number } {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM ai_spend
       ${source ? 'WHERE source = ?' : ''}`,
    )
    .get(...(source ? [source] : [])) as { c: number; n: number };
  return { usd: r.c, rows: r.n };
}

/** The refs already recorded for a source (the ledger repair at start). */
export function recordedRefs(db: Database.Database, source: string): Set<number> {
  return new Set(
    (db.prepare('SELECT ref FROM ai_spend WHERE source = ?').all(source) as { ref: number }[]).map(
      (r) => r.ref,
    ),
  );
}

/** The oldest row's time (earlier months are listed from it). */
export function firstSpendAt(db: Database.Database): number | null {
  return (db.prepare('SELECT MIN(at) AS t FROM ai_spend').get() as { t: number | null }).t;
}

// ---------------------------------------------------------------------------------------------
// holds

export function putHold(
  db: Database.Database,
  source: string,
  batchId: string,
  feature: string,
  estimateUsd: number,
  since: number,
): void {
  db.prepare(
    `INSERT INTO ai_holds (source, batch_id, feature, estimate_usd, since) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, batch_id) DO UPDATE SET estimate_usd = excluded.estimate_usd`,
  ).run(source, batchId, feature, estimateUsd, since);
}

export function dropHold(db: Database.Database, source: string, batchId: string): void {
  db.prepare('DELETE FROM ai_holds WHERE source = ? AND batch_id = ?').run(source, batchId);
}

/** Replaces a source's holds with its open batches (a runner's start). */
export function resetHolds(
  db: Database.Database,
  source: string,
  holds: { batchId: string; feature: string; estimateUsd: number; since: number }[],
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM ai_holds WHERE source = ?').run(source);
    for (const h of holds) putHold(db, source, h.batchId, h.feature, h.estimateUsd, h.since);
  })();
}

export function heldUsd(db: Database.Database): number {
  return (
    db.prepare('SELECT COALESCE(SUM(estimate_usd), 0) AS c FROM ai_holds').get() as { c: number }
  ).c;
}
