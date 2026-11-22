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
  | { kind: 'provider_busy'; provider: Provider; until: number; error: string };

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
  }
}

/**
 * Stops that need the user (a cleanup stage pauses and a notification goes out). A stage whose
 * spec says `onLimit: 'queue'` waits for room by itself: the limit needs nobody then.
 */
export function waitNeedsUser(w: AiWait, onLimit: 'pause' | 'queue' = 'pause'): boolean {
  if (w.kind === 'provider_busy') return false;
  if (w.kind === 'limit_reached' && onLimit === 'queue') return false;
  return true;
}
