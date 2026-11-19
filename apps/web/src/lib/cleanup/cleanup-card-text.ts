/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Cleanup tab's short lines (user, 2026-11-19: "the page is starting to get too long and I
 * don't need to look at all that info 24/7"), as the Audiobooks tab's audio-card-text.ts: one
 * line per check shown on the card; the tables and the rest wait in the card's folded details.
 * Pure, tested.
 */
import type { CleanupCheck, Stage3Gate, Stage4Gate, Stage4Status } from './cleanup-api';
import type { GateRow } from './stage2-text';
import { n } from './cleanup-text';
import { gateRows as stage4GateRows } from './stage4-text';

const plural = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`;

/** Stage 2's check on the labeled books in one line (null before it ran). */
export function stage2GateSummary(rows: GateRow[]): string | null {
  const judged = rows.filter((r) => r.ok !== null);
  if (!judged.length) return null;
  const failed = judged.filter((r) => r.ok === false);
  return failed.length
    ? `Labeled books: ✗ ${plural(failed.length, 'check fails', 'checks fail')} (${failed
        .map((r) => r.label.replace(/ \(.*\)$/, ''))
        .join('; ')}).`
    : `Labeled books: ✓ every check passes.`;
}

/** Stage 3's check on the measured pairs and the labeled books in one line. */
export function stage3GateSummary(gate: Stage3Gate | null | undefined): string | null {
  if (!gate) return null;
  return gate.passed
    ? 'Measured pairs and labeled books: ✓ passes.'
    : `Measured pairs and labeled books: ✗ not passed${gate.problems.length ? ` (${gate.problems[0]})` : ''}.`;
}

/** Stage 4's check on the labeled books in one line: every field at its bar, or which aren't. */
export function stage4GateSummary(gate: Stage4Gate | null | undefined): string | null {
  if (!gate) return null;
  const below = stage4GateRows(gate).filter((r) => r.below);
  return below.length
    ? `Labeled books: ✗ ${below.map((r) => r.field).join(', ')} below the bar (${n(gate.books)} checked).`
    : `Labeled books: ✓ every field at or above its bar (${n(gate.books)} checked).`;
}

/** The safety checks in one line when every required one passes; null when one fails. */
export function checksSummary(checks: CleanupCheck[], sidecarOnline: boolean): string | null {
  if (!checks.filter((c) => c.required).every((c) => c.ok)) return null;
  return `✓ All ${n(checks.length)} checks pass · sidecar ${sidecarOnline ? 'running' : 'not running'}.`;
}

/** The sites that need you on stage 4's card (paused, or requests given up). */
export function stage4SitesNeedingYou(status: Stage4Status | null): Stage4Status['sites'] {
  return (status?.sites ?? []).filter((s) => s.enabled && (s.pausedReason || s.failed > 0));
}
