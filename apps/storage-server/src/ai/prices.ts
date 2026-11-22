/**
 * The chat models the app knows the list prices of (US$ per million tokens), built in: neither
 * provider's API returns prices (Anthropic's model list gives ids, context sizes and
 * capabilities; OpenAI's no price either), so they are taken from the providers' price pages
 * and changed here, in code, when a provider changes them or releases a model. Settings > AI
 * shows them read-only. They are used only to count what is spent against the monthly limit and
 * to estimate the next questions; the providers bill their own prices.
 *
 * A model a provider offers that is not here can't be added in Settings > AI ("price not known
 * yet"): its cost couldn't be counted.
 *
 * Sources (checked 2026-11-21): Anthropic's model and price list (Claude API docs, cached
 * 2026-11-03); OpenAI's pricing page (developers.openai.com/api/docs/pricing), the Standard
 * text-token table. Cache reads: the listed cached-input price where one is listed, else a tenth
 * of the input price (spend.ts). Batches cost half on both (ai.batchPriceFactor).
 */
import type { AiPrice } from './settings';

export const PRICES_CHECKED = '2026-11-21';

const p = (
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadPerMTok?: number,
  long?: [above: number, input: number, output: number, cacheRead?: number],
): AiPrice => ({
  inputPerMTok,
  outputPerMTok,
  ...(cacheReadPerMTok !== undefined ? { cacheReadPerMTok } : {}),
  ...(long
    ? {
        longAboveTokens: long[0],
        long: {
          inputPerMTok: long[1],
          outputPerMTok: long[2],
          ...(long[3] !== undefined ? { cacheReadPerMTok: long[3] } : {}),
        },
      }
    : {}),
});

/** OpenAI's long-context tier starts above 272K input tokens. */
const OA = 272_000;

export const BUILT_IN_PRICES: Readonly<Record<string, AiPrice>> = {
  // Anthropic
  'claude-fable-5-2': p(8, 40, 0.2),
  'claude-mythos-5-2': p(8, 40, 0.2),
  'claude-fable-5-1': p(10, 50),
  'claude-mythos-5-1': p(10, 50),
  'claude-fable-5': p(10, 50),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-opus-4-8': p(5, 25),
  'claude-opus-4-7': p(5, 25),
  'claude-opus-4-6': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.1),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4-6': p(3, 15),
  'claude-haiku-5-5': p(0.1, 0.5, undefined, [100_000, 0.5, 2.5]),
  'claude-haiku-4-5': p(1, 5),
  // OpenAI
  'gpt-6.2-astra': p(8, 40, 0.4, [OA, 16, 60, 0.8]),
  'gpt-6.2-sol': p(2, 10, 0.1, [OA, 4, 15, 0.2]),
  'gpt-6-astra': p(10, 50, 1, [OA, 20, 75, 2]),
  'gpt-6.1-sol': p(2, 10, 0.1, [OA, 4, 15, 0.2]),
  'gpt-6.1-terra': p(1, 5, 0.05, [OA, 2, 7.5, 0.1]),
  'gpt-6-luna': p(0.1, 0.5, 0.01, [OA, 0.2, 0.75, 0.02]),
  'gpt-6-sol': p(2, 10, 0.2, [OA, 4, 15, 0.4]),
  'gpt-5.6-sol': p(4, 20, 0.4, [OA, 8, 30, 0.8]),
  'gpt-5.6-terra': p(2, 12, 0.2, [OA, 4, 18, 0.4]),
  'gpt-5.6-luna': p(0.2, 1.2, 0.02, [OA, 0.4, 1.8, 0.04]),
  'gpt-5.5': p(5, 30, 0.5, [OA, 10, 45, 1]),
  'gpt-5.5-pro': p(30, 180, undefined, [OA, 60, 270]),
  'gpt-5.4': p(2.5, 15, 0.25, [OA, 5, 22.5, 0.5]),
  'gpt-5.4-pro': p(30, 180, undefined, [OA, 60, 270]),
  'gpt-5.4-mini': p(0.75, 4.5, 0.075),
  'gpt-5.4-nano': p(0.2, 1.25, 0.02),
  'gpt-5.2': p(1.75, 14, 0.175),
  'gpt-5.2-pro': p(21, 168),
  'gpt-5.1': p(1.25, 10, 0.125),
  'gpt-5': p(1.25, 10, 0.125),
  'gpt-5-mini': p(0.25, 2, 0.025),
  'gpt-5-nano': p(0.05, 0.4, 0.005),
  'gpt-5-pro': p(15, 120),
  'gpt-4.1': p(2, 8, 0.5),
  'gpt-4.1-mini': p(0.4, 1.6, 0.1),
  'gpt-4o': p(2.5, 10, 1.25),
  'gpt-4o-mini': p(0.15, 0.6, 0.075),
  'o3-pro': p(20, 80),
  o3: p(2, 8, 0.5),
};

/** The models a new installation lists in Settings > AI (the ones the cleanup uses). */
export const DEFAULT_MODELS: readonly string[] = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'gpt-6-luna',
  'gpt-6.1-sol',
];

export function isBuiltIn(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_PRICES, model);
}

/**
 * Whether a provider's model id is a chat model the Add dialog lists (with its price, or as
 * "price not known yet"): Claude's `claude-*`, OpenAI's `gpt-*` and `o<n>` text models; not
 * embeddings, audio, speech, realtime, image, transcription or moderation models.
 */
export function isChatModel(model: string): boolean {
  if (isBuiltIn(model)) return true;
  // Dated snapshots of a model (claude-3-5-sonnet-20241022, gpt-4o-2024-08-06): the list shows
  // the model's own id only.
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(model)) return false;
  if (/^claude-/.test(model)) return true;
  if (!/^(gpt-|o\d|chatgpt-)/.test(model)) return false;
  return !/(embedding|tts|whisper|audio|realtime|live|image|transcribe|moderation|search|dall-e|codex|cyber|rosalind|law)/.test(
    model,
  );
}
