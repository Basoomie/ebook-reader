/**
 * Book summaries: what went wrong, in plain words for the book page, the series page and the
 * alert (review of the states, user 2026-11-24): a wait without the provider's raw error; why a
 * setup failed, each failure once with every model it happened with.
 */
import { providerName, waitText, type AiWait } from '../ai/waits';
import { Refused, Unusable } from './engine';
import { modelDisplayName } from './settings';

/**
 * A wait in plain words for the book page (review of the states, user 2026-11-24): what is
 * happening, without the provider's raw error (that stays in the log and Settings > AI).
 */
export function plainWait(w: AiWait): string {
  switch (w.kind) {
    case 'provider_busy':
      return `${providerName(w.provider)} is busy, trying again soon`;
    case 'auth_failed':
      return `${providerName(w.provider)} refused the API key (Settings › AI)`;
    case 'model_check_failed':
      return `${providerName(w.provider)} can't be reached, trying again soon`;
    case 'batch_failing':
      return `${providerName(w.provider)} refused a batch, trying again later`;
    case 'limit_reached':
      return `the monthly AI spending limit is reached (Settings › AI); it goes on when there is room`;
    case 'no_limit':
      return 'set a monthly AI spending limit first (Settings › AI)';
    default:
      return waitText(w);
  }
}

/** The first line of the note when every setup failed (the book page recognizes it). */
export const EVERY_SETUP_FAILED = 'Every setup failed.';

/** What a question was for, in plain words: "read the book", "check the notes", "write the summary". */
function stepWords(stage: string): string {
  if (stage === 'sum.extract' || stage === 'sum.extract-chapter') return 'read the book';
  if (stage === 'sum.write') return 'write the summary';
  if (stage.startsWith('sum.match') || stage.startsWith('sum.support')) return 'check the notes';
  // The series recap (session 5).
  if (stage === 'sum.recap') return 'write the story so far';
  if (stage === 'sum.recap-check') return 'check the story so far';
  return 'answer';
}

function joinNames(names: string[]): string {
  return names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Why a setup failed: what happened, and the models it happened with (none for a wait). */
export interface PlainFailure {
  what: string;
  models: string[];
}

/** Why a setup failed, in plain words (review of the states, user 2026-11-24). */
export function plainFailure(
  err: unknown,
  h: { abandoned: boolean; wait: AiWait | null },
  fallbackAfterMinutes: number,
): PlainFailure {
  if (h.abandoned)
    return {
      what: `Nothing could be sent for ${fallbackAfterMinutes} min: ${h.wait ? plainWait(h.wait) : 'waiting'}.`,
      models: [],
    };
  if (err instanceof Refused)
    return {
      what: `refused to ${stepWords(err.stage)}`,
      models: err.model.split(/,\s*/).filter(Boolean),
    };
  if (err instanceof Unusable)
    return {
      what: `gave no usable answer when asked to ${stepWords(err.stage)}`,
      models: [err.model],
    };
  return { what: `An error: ${(err as Error)?.message ?? String(err)}.`, models: [] };
}

/**
 * The failures of every setup merged (user 2026-11-24: no setup-by-setup list, each model named
 * once): one line per kind of failure, with every model it happened with. Three setups that
 * all were refused reading the book make one line.
 */
export function failureLines(fails: PlainFailure[]): string[] {
  const groups = new Map<string, string[]>();
  for (const f of fails) {
    const g = groups.get(f.what) ?? [];
    for (const m of f.models) if (!g.includes(m)) g.push(m);
    groups.set(f.what, g);
  }
  return [...groups].map(([what, models]) =>
    models.length ? `${joinNames(models.map(modelDisplayName))} ${what}.` : what,
  );
}
