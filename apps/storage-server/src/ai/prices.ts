/**
 * The models the app knows, with their list prices (US$ per million tokens), built in: neither
 * provider's API returns prices (Anthropic's model list gives ids, context sizes and
 * capabilities; OpenAI's no price either), so they are taken from the providers' price pages
 * and changed here, in code, when a provider changes them. Settings > AI shows them read-only.
 * They are used only to count what is spent against the monthly limit and to estimate the next
 * questions; the providers bill their own prices whatever is written here.
 *
 * Sources (checked 2026-11-21): Anthropic's model and price list (Claude API docs, cached
 * 2026-11-03: Haiku 5.5 $0.10/$0.50 for prompts up to 100K tokens, $0.50/$2.50 beyond; Sonnet 5.5
 * $2/$10, cache reads $0.10; Opus 5.5 $4/$20, cache reads $0.20); OpenAI's pricing page
 * (developers.openai.com/api/docs/pricing: gpt-6-luna $0.10/$0.50, cached $0.01, above 272K
 * input tokens $0.20/$0.75, cached $0.02; gpt-6.1-sol $2/$10, cached $0.10, above 272K $4/$15,
 * cached $0.20). Batches cost half on both (ai.batchPriceFactor).
 */
import type { AiPrice } from './settings';

export const PRICES_CHECKED = '2026-11-21';

export const BUILT_IN_PRICES: Readonly<Record<string, AiPrice>> = {
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longAboveTokens: 100_000,
    long: { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'gpt-6-luna': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    longAboveTokens: 272_000,
    long: { inputPerMTok: 0.2, outputPerMTok: 0.75, cacheReadPerMTok: 0.02 },
  },
  'gpt-6.1-sol': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.1,
    longAboveTokens: 272_000,
    long: { inputPerMTok: 4, outputPerMTok: 15, cacheReadPerMTok: 0.2 },
  },
};

export function isBuiltIn(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_PRICES, model);
}

/**
 * Every model with a price: the built-in ones, then models added in Settings before prices were
 * built in (kept until deleted there). A built-in price always wins over a stored one.
 */
export function allPrices(stored: Record<string, AiPrice>): Record<string, AiPrice> {
  const out: Record<string, AiPrice> = { ...BUILT_IN_PRICES };
  for (const [model, p] of Object.entries(stored)) if (!isBuiltIn(model)) out[model] = p;
  return out;
}
