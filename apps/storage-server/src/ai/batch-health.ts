/**
 * Batches a provider refused as a whole, per model (2026-11-22: OpenAI failed 926 gpt-6-luna
 * batches in 31 minutes, and a new one was sent within seconds of each; the reason was not
 * kept). Kept in ttsu.db `ai_state` (key `batchHealth`), so a restart doesn't start over:
 *
 * - After a failed batch the model sends no batch for `batchFailWaitMinutes`, doubled with each
 *   failure in a row up to `batchFailMaxWaitMinutes`.
 * - A failure for the provider's capacity (its queue or limit) while batches of the model are at
 *   the provider also waits for one of them to end (room in its queue), at most the longest wait.
 * - After `batchFailPauseAfter` failures in a row the model's batches are paused: one batch is
 *   tried every `batchFailMaxWaitMinutes`, the stage shows why, and the notifications send one
 *   alert (`ai_batches_failing`) until a batch is accepted again. With `batchFailFallback`
 *   'direct' the paused model's questions are asked one call each for the rest of that run.
 * - A batch sent after the last failure that the provider accepts (in progress or later) ends it.
 */
import type { AiSettings } from './settings';
import type { Provider } from './types';

export const BATCH_HEALTH_KEY = 'batchHealth';

export interface ModelBatchHealth {
  provider: Provider;
  model: string;
  /** Failed batches in a row. */
  failures: number;
  /** The provider's reason for the last one. */
  reason: string;
  /** The last one failed for the provider's capacity (its questions kept their tries). */
  capacity: boolean;
  failedAt: number;
  /** No batch before this. */
  nextAt: number;
  /** A capacity failure with batches at the provider: the next waits for one of them to end. */
  waitForEnd: boolean;
  /** Since when the model's batches are paused (failures reached batchFailPauseAfter). */
  pausedSince: number | null;
  /** The run whose questions are asked one call each while paused (batchFailFallback). */
  fallbackRun: string | null;
}

/** The wait before the next batch after `failures` in a row (ms). */
export function failWaitMs(s: AiSettings, failures: number, paused: boolean): number {
  const max = s.batchFailMaxWaitMinutes * 60_000;
  if (paused) return max;
  return Math.min(max, s.batchFailWaitMinutes * 60_000 * 2 ** Math.max(0, failures - 1));
}

/** The model's state after one more failed batch. */
export function afterFailure(
  cur: ModelBatchHealth | null,
  f: {
    provider: Provider;
    model: string;
    reason: string;
    capacity: boolean;
    /** Batches of the model still at the provider. */
    open: number;
    at: number;
  },
  s: AiSettings,
): ModelBatchHealth {
  const failures = (cur?.failures ?? 0) + 1;
  const paused = failures >= s.batchFailPauseAfter;
  return {
    provider: f.provider,
    model: f.model,
    failures,
    reason: f.reason,
    capacity: f.capacity,
    failedAt: f.at,
    nextAt: f.at + failWaitMs(s, failures, paused),
    waitForEnd: f.capacity && f.open > 0,
    pausedSince: paused ? (cur?.pausedSince ?? f.at) : null,
    fallbackRun: cur?.fallbackRun ?? null,
  };
}

/** True while no batch of the model may be sent. */
export function held(h: ModelBatchHealth, now: number, s: AiSettings): boolean {
  if (now < h.nextAt) return true;
  return h.waitForEnd && now < h.failedAt + s.batchFailMaxWaitMinutes * 60_000;
}
