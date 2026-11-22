/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError } from '$lib/library/api';
import { formatWhen } from '$lib/notes/notes-format';
import type { AiKeyInfo, AiPrice, AiProvider, AiStatus } from './ai-api';

/** Settings > AI: the words. */

export const PROVIDER_NAMES: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI'
};

/** US$ with cents, or four places below 10 cents ($0.0030). */
export function usd(v: number): string {
  return v > 0 && v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/** "November 2026" from "2026-11". */
export function monthName(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/** "$0.10 in · $0.50 out per million tokens" (+ the long-prompt tier). */
export function priceText(p: AiPrice): string {
  const n = (v: number) => `$${Number.isInteger(v) ? String(v) : v.toFixed(2)}`;
  const base = `${n(p.inputPerMTok)} in · ${n(p.outputPerMTok)} out per million tokens`;
  if (!p.long || p.longAboveTokens === undefined) return base;
  const k = `${Math.round(p.longAboveTokens / 1000)}K`;
  return `${base} (prompts over ${k} tokens: ${n(p.long.inputPerMTok)} in · ${n(p.long.outputPerMTok)} out)`;
}

const money = (v: number) => `$${Number.isInteger(v) ? String(v) : v.toFixed(2)}`;

/** "$0.10 / $0.50" (in / out per million tokens). */
export function priceShort(p: AiPrice): string {
  return `${money(p.inputPerMTok)} / ${money(p.outputPerMTok)}`;
}

/** The long-prompt tier, for the price's tooltip ("" when the model has none). */
export function longTierText(p: AiPrice): string {
  if (!p.long || p.longAboveTokens === undefined) return '';
  return `Prompts over ${Math.round(p.longAboveTokens / 1000)}K tokens: ${priceShort(p.long)}`;
}

/** "Anthropic ✓" / "OpenAI: no key" / "Anthropic: <error>" (the models toolbar). */
export function providerShort(status: AiStatus, id: AiProvider): string {
  const name = PROVIDER_NAMES[id];
  const key = status.keys[id === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey'];
  if (!key?.set) return `${name}: no key`;
  const c = status.checks[id];
  if (!c) return `${name}: not checked`;
  if (c.error) return `${name}: ${c.error}`;
  return `${name} ✓`;
}

/** A model's last batch test in a few words ("" when never tested). */
export function batchTestShort(status: AiStatus, model: string): string {
  const t = status.batchTests[model];
  if (!t) return '';
  if (t.state === 'open') return 'Batch test running';
  if (t.state === 'answered')
    return `Batches work (${(t.detail ?? 'answered').replace(/^answered in /, '')})`;
  if (t.state === 'nothing') return 'Batches: no answer in the time allowed';
  return 'Batch test failed';
}

export function keyStateText(info: AiKeyInfo | undefined): string {
  if (info?.unreadable) return 'Saved, but it can’t be read on the server any more: enter it again';
  if (!info?.set) return 'Not saved yet';
  const when = info.updatedAt ? ` ${formatWhen(info.updatedAt)}` : '';
  return info.hint ? `Saved${when} · ends in ${info.hint}` : `Saved${when}`;
}

/** "$12.40 spent this month of the $100.00 limit ($0.50 held for batches)". */
export function spendText(s: AiStatus['spend']): string {
  const held = s.reservedUsd > 0 ? ` (${usd(s.reservedUsd)} held for batches)` : '';
  if (s.limitUsd === null)
    return `${usd(s.spentUsd)} spent this month${held}. No limit set yet: nothing is sent to a model.`;
  const left = Math.max(0, s.limitUsd - s.spentUsd - s.reservedUsd);
  return `${usd(s.spentUsd)} spent this month of the ${usd(s.limitUsd)} limit${held}; ${usd(left)} left until ${s.resumesOn}.`;
}

/** A month's split per feature, largest first ("Calibre cleanup $8.20 · ..."). */
export function featureSplit(
  byFeature: Record<string, number>,
  names: Record<string, string>
): { name: string; usd: string }[] {
  return Object.entries(byFeature)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ name: names[id] ?? id, usd: usd(v) }));
}

export function providerLine(status: AiStatus, id: AiProvider): string {
  const name = PROVIDER_NAMES[id];
  const key = status.keys[id === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey'];
  if (!key?.set) return `${name}: no API key saved`;
  const c = status.checks[id];
  if (!c) return `${name}: key saved, not checked yet`;
  if (c.error) return `${name}: ${c.error}`;
  return `${name}: key works, ${c.models ?? 0} models offered (checked ${formatWhen(c.checkedAt)})`;
}

/** Whether the model's provider offers it, after Check models. */
export function offeredText(offered: boolean | null, provider: AiProvider): string {
  const name = PROVIDER_NAMES[provider];
  if (offered === null) return `${name}: not checked yet`;
  return offered ? `offered by ${name} ✓` : `NOT offered by ${name}: check the model id`;
}

export function batchTestText(status: AiStatus, model: string): string {
  const t = status.batchTests[model];
  if (!t) return 'Batch not tested yet';
  const when = formatWhen(t.submittedAt);
  if (t.state === 'open') return `Batch test running since ${when}`;
  if (t.state === 'answered') return `Batch test ${when}: ${t.detail ?? 'answered'} ✓`;
  if (t.state === 'nothing') return `Batch test ${when}: ${t.detail ?? 'nothing answered'}`;
  return `Batch test ${when}: failed (${t.detail ?? ''})`;
}

export function describeAiError(err: unknown): string {
  if (err instanceof LibraryApiError) {
    if (err.kind === 'unreachable' || err.kind === 'timeout')
      return 'The library server cannot be reached (offline, or the server is down).';
    if (err.status === 404) return 'The library server is too old for Settings > AI: update it.';
    if (err.code === 'ai_off') return 'The AI settings are unavailable on the server.';
  }
  return (err as Error).message;
}
