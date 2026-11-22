/**
 * What the models cost (WP21d): every request's cost from its usage and the price table (a
 * provider setting), and estimates before anything is sent. The month's spending and the limit
 * are in ledger.ts and core.ts.
 */
import type Database from 'better-sqlite3';
import { BUILT_IN_PRICES } from './prices';
import type { AiPrice, AiPriceTier, AiSettings } from './settings';
import type { Usage } from './providers';

/**
 * Claude's prompt-cache writes cost 1.25x the input price; a cache read costs the model's own
 * cached-input price, else a tenth of the input price.
 */
const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;

/** A model's price: built in (prices.ts), else a model added before prices were built in. */
export function priceOf(s: AiSettings, model: string): AiPrice | null {
  return BUILT_IN_PRICES[model] ?? s.prices[model] ?? null;
}

/**
 * US$ of one request. A prompt over the model's long-context threshold (input, cache reads and
 * cache writes together) is priced at its long tier, as the providers bill it.
 */
export function costOf(price: AiPrice, usage: Usage, batch: boolean, batchFactor: number): number {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const tier: AiPriceTier =
    price.long && price.longAboveTokens !== undefined && prompt > price.longAboveTokens
      ? price.long
      : price;
  const cacheRead = tier.cacheReadPerMTok ?? tier.inputPerMTok * CACHE_READ_FACTOR;
  const inUsd =
    (usage.input + usage.cacheWrite * CACHE_WRITE_FACTOR) * tier.inputPerMTok +
    usage.cacheRead * cacheRead;
  const outUsd = usage.output * tier.outputPerMTok;
  return ((inUsd + outUsd) / 1e6) * (batch ? batchFactor : 1);
}

/** Output tokens assumed per answer before any is measured (thinking included). */
export const ASSUMED_OUTPUT_TOKENS = 1500;

/**
 * The list-price cost one more request to a model is expected to have: the average of its
 * last answers (at list price), else an estimate from the prompt's length (Japanese text: about
 * one token per character, rounded up).
 */
export interface RecentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
}

/** A model's last 50 answers' usage (the estimates below; read once per send). */
export function recentUsage(db: Database.Database, model: string): RecentUsage[] {
  return db
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens FROM ai_requests
       WHERE model = ? AND state IN ('answered', 'invalid', 'blocked') AND input_tokens IS NOT NULL
       ORDER BY id DESC LIMIT 50`,
    )
    .all(model) as RecentUsage[];
}

/**
 * The prompt tokens one more question to a model is expected to have (a batch queue's cap):
 * the average of its last answers' prompts, else from the prompt's length, with a margin.
 * Null when it has too few answers and no length is given.
 */
export function expectedPromptTokens(
  rows: RecentUsage[],
  promptChars: number | null,
): number | null {
  if (rows.length >= 5)
    return (
      (rows.reduce((a, r) => a + r.input_tokens + (r.cache_read_tokens ?? 0), 0) / rows.length) *
      1.2
    );
  return promptChars === null ? null : Math.ceil(promptChars * 1.2) * 1.2;
}

export function expectedListCost(
  db: Database.Database,
  s: AiSettings,
  model: string,
  promptChars: number,
  recent?: RecentUsage[],
): number {
  const price = priceOf(s, model);
  if (!price) return Infinity;
  const rows = recent ?? recentUsage(db, model);
  if (rows.length >= 5) {
    const avg =
      rows.reduce(
        (a, r) =>
          a +
          costOf(
            price,
            {
              input: r.input_tokens,
              output: r.output_tokens,
              cacheRead: r.cache_read_tokens ?? 0,
              cacheWrite: 0,
            },
            false,
            1,
          ),
        0,
      ) / rows.length;
    // Leave a margin: a long description costs more than the average.
    return avg * 1.5;
  }
  return costOf(
    price,
    {
      input: Math.ceil(promptChars * 1.2),
      output: ASSUMED_OUTPUT_TOKENS,
      cacheRead: 0,
      cacheWrite: 0,
    },
    false,
    1,
  );
}

/** Spending per run (an analysis), per model and per item answered. */
export function runSpend(
  db: Database.Database,
  stage: string,
  runId: string,
): { costUsd: number; items: number; perItemUsd: number | null; byModel: Record<string, number> } {
  const rows = db
    .prepare(
      `SELECT model, COALESCE(SUM(cost_usd), 0) AS c, COUNT(DISTINCT item_key) AS n FROM ai_requests
       WHERE stage = ? AND run_id = ? AND cost_usd IS NOT NULL GROUP BY model`,
    )
    .all(stage, runId) as { model: string; c: number; n: number }[];
  const items = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT item_key) AS n FROM ai_requests
         WHERE stage = ? AND run_id = ? AND cost_usd IS NOT NULL`,
      )
      .get(stage, runId) as { n: number }
  ).n;
  const byModel: Record<string, number> = {};
  let cost = 0;
  for (const r of rows) {
    byModel[r.model] = r.c;
    cost += r.c;
  }
  return { costUsd: cost, items, perItemUsd: items ? cost / items : null, byModel };
}
