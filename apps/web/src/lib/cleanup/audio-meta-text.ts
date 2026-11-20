/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Audiobook stage 5's words on /cleanup (WP21d): the stage's hint, its progress with time left,
 * the spending line, the lists, and each field with its value and where it came from. Pure,
 * tested.
 */
import type {
  AudioMetaField,
  AudioMetaGate,
  AudioMetaGateMiss,
  AudioStage5Status
} from './cleanup-api';
import { count } from './audio-text';
import { etaText, n, type ProgressBar } from './cleanup-text';

export const STAGE5_HINTS: Record<'off' | 'analyse', string> = {
  off: 'Off: decides nothing. In Preview, each recording’s title, authors, narrators, series and tags are decided from what stages 2-4 found (nothing is fetched or read again), with Claude Haiku and GPT Luna reading every recording; nothing is written anywhere.',
  analyse:
    'Preview: decides the metadata and shows it here; nothing is written to the audiobook folders or Audiobookshelf. The models are asked only within the spending limit (Settings > AI).'
};

export const FIELD_LABELS: Record<string, string> = {
  record: 'Store record',
  title: 'Title',
  authors: 'Authors',
  narrators: 'Narrators',
  series: 'Series',
  drama: 'ドラマCD',
  multi_narr: '複数ナレーター',
  publisher: 'Publisher',
  year: 'Year',
  language: 'Language',
  store_id: 'Store id',
  description: 'Description',
  cover: 'Cover'
};

export const SOURCE_LABELS: Record<string, string> = {
  rules: 'rules',
  both_models: 'both models agreed',
  secondary_guess: 'Luna’s guess',
  rules_guess: 'the rules’ guess',
  unknown: 'unknown',
  user: 'you',
  upgrade_models: 'the stronger models'
};

export const META_LISTS: { id: string; label: string }[] = [
  { id: 'flagged', label: 'Unconfirmed fields' },
  { id: 'gate', label: 'Labeled books: differ from the label' },
  { id: 'labeled', label: 'Labeled books' },
  { id: 'no_record', label: 'No store record' },
  { id: 'ai', label: 'AI audiobooks and radio clips' },
  { id: 'field:authors:both_models', label: 'Authors decided by both models' },
  { id: 'field:series:both_models', label: 'Series decided by both models' },
  { id: 'field:record:both_models', label: 'Store record chosen by both models' },
  { id: 'all', label: 'Every recording' }
];

const PHASES: Record<string, string> = {
  evidence: 'Building the evidence records',
  models: 'Asking the models',
  decide: 'Deciding',
  gate: 'Checking the labeled books'
};

/** The progress bar of the step running now (with time left when the server can tell). */
export function audioStage5Bar(s: AudioStage5Status | null | undefined): ProgressBar | null {
  const p = s?.progress;
  if (!p || p.phase === 'done' || p.units === 0) return null;
  const eta =
    s.secondsLeft !== null && s.secondsLeft > 0
      ? `${etaText(s.secondsLeft * 1000)} (estimate)`
      : null;
  if (p.phase === 'models' && p.ai) {
    const a = p.ai;
    const done = a.answered + a.blocked + a.invalid + a.failed;
    const all = done + a.queued + a.sent;
    if (!all) return null;
    return {
      label: `Asking the models: ${n(done)} of ${n(all)} answers in${a.sent ? ` (${n(a.sent)} at the providers)` : ''}`,
      fraction: Math.min(1, done / all),
      eta
    };
  }
  if (p.phase === 'decide')
    return {
      label: `Deciding: ${n(p.decided)} of ${n(p.units)} recordings`,
      fraction: Math.min(1, p.decided / p.units),
      eta
    };
  return { label: PHASES[p.phase] ?? p.phase, fraction: 0, eta };
}

const usd = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** "AI: $0.14 spent of the $1.00 limit ($0.02 held for batches)". */
export function spendLine(s: AudioStage5Status | null | undefined): string | null {
  if (!s) return null;
  const { spentUsd, reservedUsd, limitUsd } = s.spend;
  if (limitUsd === null)
    return 'AI: no spending limit set yet (Settings > AI): the models are not asked.';
  return `AI: ${usd(spentUsd)} spent of the ${usd(limitUsd)} limit${reservedUsd > 0 ? ` (${usd(reservedUsd)} held for batches)` : ''}.`;
}

/** The details' lines: answers, cost, batches. */
export function audioStage5Lines(s: AudioStage5Status | null | undefined): string[] {
  const p = s?.progress;
  if (!s || !p) return [];
  const out: string[] = [];
  out.push(
    `${count(p.units, 'recording', 'recordings')} (${n(p.labeledUnits)} labeled); ${s.models.primary} ${s.modes.primary === 'batch' ? 'by batch' : 'one call each'}, ${s.models.secondary} ${s.modes.secondary === 'batch' ? 'by batch' : 'one call each'}${s.labeledOnly ? ', labeled books only' : ''}.`
  );
  if (p.ai) {
    const a = p.ai;
    out.push(
      `Answers: ${n(a.answered)} in${a.queued ? `, ${n(a.queued)} to ask` : ''}${a.sent ? `, ${n(a.sent)} at the providers` : ''}${a.blocked ? `, ${n(a.blocked)} blocked by a provider (final)` : ''}${a.invalid ? `, ${n(a.invalid)} unusable` : ''}${a.failed ? `, ${n(a.failed)} failed` : ''}.`
    );
  }
  if (p.invented)
    out.push(`${count(p.invented, 'answer', 'answers')} not in the evidence (dropped).`);
  if (p.cost && p.cost.items)
    out.push(
      `This run: ${usd(p.cost.costUsd)} for ${count(p.cost.items, 'recording', 'recordings')} (${usd(p.cost.perItemUsd ?? 0)} each).`
    );
  if (s.batches.stalled)
    out.push(
      `${count(s.batches.stalled, 'batch', 'batches')} answered nothing in ${n(s.batchStallMinutes)} min: cancelled, ${s.batches.stalled === 1 ? 'its' : 'their'} questions asked directly.`
    );
  if (s.batches.collected) {
    const med = s.batches.turnaroundMs.median;
    out.push(
      `Batches: ${n(s.batches.collected)} answered${med !== null ? `, typically within ${Math.max(1, Math.round(med / 60_000))} min` : ''}${s.batches.open ? `; ${n(s.batches.open)} at the providers` : ''}.`
    );
  }
  return out;
}

/** "Title: 183 rules, 4 both models, 11 unconfirmed". */
export function metaCountLines(
  counts: Record<string, Record<string, number>> | null | undefined
): string[] {
  if (!counts) return [];
  const order = ['title', 'authors', 'narrators', 'series', 'drama', 'multi_narr', 'record'];
  return order
    .filter((f) => counts[f])
    .map((f) => {
      const c = counts[f];
      const parts = [
        c.rules ? `${n(c.rules)} rules` : null,
        c.both_models ? `${n(c.both_models)} both models` : null,
        c.user ? `${n(c.user)} yours` : null,
        c.flagged ? `${n(c.flagged)} unconfirmed` : null
      ].filter(Boolean);
      return `${FIELD_LABELS[f]}: ${parts.join(', ') || 'none'}.`;
    });
}

export function metaGateLines(g: AudioMetaGate | null | undefined): string[] {
  if (!g) return [];
  if (g.error) return [`The labels can’t be read: ${g.error}`];
  return Object.entries(g.fields).map(([f, s]) => {
    const pct = s.percent === null ? '–' : `${s.percent.toFixed(1)} %`;
    return `${FIELD_LABELS[f] ?? f}: ${s.passed ? '✓' : '✗'} ${pct} of ${n(s.auto)} automatic right${s.flagged ? `; ${n(s.flaggedRight)} of ${n(s.flagged)} unconfirmed right` : ''}.`;
  });
}

/** A value as text ("unknown" for null, never "none"). */
export function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (field === 'series' && Array.isArray(v)) {
    if (!v.length) return 'no series';
    return (v as { name: string; position: number | null }[])
      .map((s) => (s.position === null ? s.name : `${s.name} #${s.position}`))
      .join(' · ');
  }
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none credited';
  return String(v);
}

export function fieldLine(f: AudioMetaField): string {
  return `${FIELD_LABELS[f.field] ?? f.field}: ${valueText(f.field, f.value)} (${SOURCE_LABELS[f.source] ?? f.source}${f.flagged ? ', unconfirmed' : ''})`;
}

export function metaMissLine(m: AudioMetaGateMiss): string {
  return `${m.id} ${m.name ?? ''}: ${FIELD_LABELS[m.field] ?? m.field} is ${valueText(m.field, m.got)} (${SOURCE_LABELS[m.source] ?? m.source}); the label says ${valueText(m.field, m.expected)}.`;
}
