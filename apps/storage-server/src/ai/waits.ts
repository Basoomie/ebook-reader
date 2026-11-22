/** Why nothing can be asked now, and its words on the pages and in the alerts. */
import type { Provider } from './types';

export type AiWait =
  | { kind: 'no_limit' }
  | {
      kind: 'limit_reached';
      /** Spent this month by every feature together. */
      spentUsd: number;
      /** Held for batches at a provider and calls in flight (every feature). */
      reservedUsd: number;
      limitUsd: number;
      nextUsd: number;
      /** When the next month starts (room again), and its date in words ("Dec 1"). */
      resumesAt: number;
      resumesOn: string;
    }
  | { kind: 'no_key'; provider: Provider }
  | { kind: 'auth_failed'; provider: Provider; error: string }
  | { kind: 'model_missing'; provider: Provider; model: string }
  | { kind: 'no_price'; model: string }
  | { kind: 'model_check_failed'; provider: Provider; error: string }
  | { kind: 'provider_busy'; provider: Provider; until: number; error: string }
  | {
      /** The provider refused the model's batches (batch-health.ts). */
      kind: 'batch_failing';
      provider: Provider;
      model: string;
      /** In a row. */
      failures: number;
      paused: boolean;
      reason: string;
      nextAt: number;
      /** nextAt as a clock time in the Notifications time zone. */
      nextAtText: string;
      /** The next batch also waits for one of the model's batches at the provider to end. */
      waitForEnd: boolean;
      /** Its questions are asked one call each for the rest of the run instead. */
      fallback: boolean;
    }
  | {
      /** The model's batches at the provider hold as many tokens as its cap allows. */
      kind: 'batch_queue_full';
      provider: Provider;
      model: string;
      tokens: number;
      limit: number;
    };

/** Tokens in millions ("2.0 M"). */
const mTok = (n: number) => `${(n / 1e6).toFixed(1)} M`;

/**
 * Waits that only say why one model's batches are not sent now: the stage goes on with what it
 * can (other models, calls one at a time) and does not pause.
 */
export function waitIsNote(w: AiWait | null | undefined): boolean {
  return w?.kind === 'batch_failing' || w?.kind === 'batch_queue_full';
}

/** US$ with cents, or four places below a cent ($0.0030). */
export const usd = (v: number) => (v > 0 && v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export const providerName = (p: Provider) => (p === 'anthropic' ? 'Anthropic' : 'OpenAI');

/** The page's words for a wait. */
export function waitText(w: AiWait): string {
  switch (w.kind) {
    case 'no_limit':
      return 'Set a monthly spending limit first (Settings > AI)';
    case 'limit_reached':
      return `Monthly spending limit reached (${usd(w.spentUsd)} spent this month, ${usd(w.reservedUsd)} held for batches, limit ${usd(w.limitUsd)}; room again on ${w.resumesOn} or with a higher limit)`;
    case 'no_key':
      return `The ${providerName(w.provider)} API key is missing (Settings > AI)`;
    case 'auth_failed':
      return `${providerName(w.provider)} refused the API key: ${w.error}`;
    case 'model_missing':
      return `${providerName(w.provider)} does not offer the model "${w.model}" (Settings > AI; Check models)`;
    case 'no_price':
      return `No price for the model "${w.model}" (Settings > AI): its cost can't be counted`;
    case 'model_check_failed':
      return `Can't read ${providerName(w.provider)}'s model list: ${w.error}`;
    case 'provider_busy':
      return `${providerName(w.provider)} is busy; trying again soon (${w.error})`;
    case 'batch_failing': {
      const p = providerName(w.provider);
      const refused =
        w.failures === 1
          ? `${p} refused a ${w.model} batch`
          : `${p} refused ${w.failures} ${w.model} batches in a row`;
      if (w.fallback)
        return `${refused} (${w.reason}); its questions are asked one call each for the rest of this run (full price)`;
      const next = w.paused ? 'batches paused, next try' : 'next batch';
      const end = w.waitForEnd ? ' once one of its batches has ended' : '';
      return `${refused} (${w.reason}); ${next} at ${w.nextAtText}${end}`;
    }
    case 'batch_queue_full':
      return `${w.model}: batch queue full (${mTok(w.tokens)} of ${mTok(w.limit)} tokens at ${providerName(w.provider)}); more is sent as its batches end`;
  }
}

/**
 * Stops that need the user (a cleanup stage pauses and a notification goes out). A stage whose
 * spec says `onLimit: 'queue'` waits for room by itself: the limit needs nobody then.
 */
export function waitNeedsUser(w: AiWait, onLimit: 'pause' | 'queue' = 'pause'): boolean {
  if (w.kind === 'provider_busy' || waitIsNote(w)) return false;
  if (w.kind === 'limit_reached' && onLimit === 'queue') return false;
  return true;
}
