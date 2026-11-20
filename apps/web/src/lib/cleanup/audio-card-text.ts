/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Audiobooks tab's short lines (user, 2026-11-19: "I don't need to look at all that info
 * 24/7"): one summary per stage and one gate line shown on the card; everything else waits in
 * the card's folded details. Pure, tested.
 */
import type {
  AudioGateResult,
  AudioMetaGate,
  AudioOnlineGate,
  AudioStatus,
  DiskLockState
} from './cleanup-api';
import { count } from './audio-text';
import { n } from './cleanup-text';

const c = (counts: Record<string, number> | null | undefined, key: string) => counts?.[key] ?? 0;

/** The disk line only while a cleanup job uses the disk (nothing to say when it is free). */
export function diskBusy(lock: DiskLockState | null | undefined): boolean {
  return !!lock && (lock.holder !== null || lock.waiting.length > 0 || !!lock.calibreApplying);
}

/** One line of what a finished stage found; null while there is nothing to say. */
export function stageSummary(stage: number, status: AudioStatus): string | null {
  if (stage === 1) {
    const k = status.stage1.counts;
    if (!k || status.stage1.progress?.phase !== 'done') return null;
    return `${count(c(k, 'library.copy'), 'library file is a copy', 'library files are copies')} of torrent files; ${count(c(k, 'torrents.torrent_only'), 'torrent file is', 'torrent files are')} not in the library.`;
  }
  if (stage === 2) {
    const k = status.stage2.counts;
    if (!k || status.stage2.progress?.phase !== 'done') return null;
    const books =
      c(k, 'torrents.single') +
      c(k, 'torrents.parts') +
      c(k, 'torrents.likely_copies') +
      c(k, 'torrents.unclear');
    const bad = c(k, 'torrents.health.unreadable') + c(k, 'torrents.health.damaged');
    return `${count(books, 'book', 'books')}; ${count(bad, 'torrent file', 'torrent files')} can’t be read or fail to play at an end.`;
  }
  if (stage === 3) {
    const k = status.stage3?.counts;
    if (!k || status.stage3?.progress?.phase !== 'done') return null;
    const proven = Object.keys(k)
      .filter((x) => x.startsWith('decisions.auto.rule.'))
      .reduce((a, x) => a + k[x], 0);
    return `${count(proven, 'recording', 'recordings')} proven to have a copy not needed (${count(c(k, 'dropped'), 'copy', 'copies')}); ${n(c(k, 'review'))} to review.`;
  }
  if (stage === 4) {
    const k = status.stage4?.counts;
    if (!k || status.stage4?.progress?.phase !== 'done') return null;
    return `${n(c(k, 'auto'))} matched, ${n(c(k, 'review'))} to review, ${n(c(k, 'unknown'))} not found, ${n(c(k, 'none_expected'))} not looked up.`;
  }
  if (stage === 5) {
    const p = status.stage5?.progress;
    if (!p || p.phase !== 'done' || !p.counts) return null;
    const flagged = p.counts.title?.flagged ?? 0;
    const cost = p.inUse?.costUsd ?? p.cost?.costUsd;
    const spent = cost !== undefined ? ` AI cost $${cost.toFixed(2)}.` : '';
    return `${count(p.units, 'recording', 'recordings')} decided; ${count(flagged, 'title', 'titles')} unconfirmed.${spent}`;
  }
  return null;
}

/** Stage 5's gate in one line (WP21d): every field on the labeled books. */
export function metaGateSummary(gate: AudioMetaGate | null | undefined): string | null {
  if (!gate) return null;
  if (gate.error) return 'Labeled check: the labels can’t be read.';
  const fields = Object.values(gate.fields);
  const failed = Object.entries(gate.fields).filter(([, f]) => !f.passed);
  return gate.passed
    ? `Labeled books: ✓ every field passes (${n(fields.reduce((a, f) => a + f.auto, 0))} automatic values checked).`
    : `Labeled books: ✗ ${failed.map(([k]) => k).join(', ')} below the bar; ${count(gate.misses.length, 'value differs', 'values differ')} from the labels.`;
}

/** The gate in one line: passes, or how many labeled items came out wrong. */
export function gateSummary(
  stage: number,
  gate: AudioGateResult | AudioOnlineGate | null | undefined
): string | null {
  if (!gate) return null;
  if (gate.error) return 'Labeled check: the labels can’t be read.';
  if (stage === 3) {
    const g = gate as AudioGateResult;
    return `Labeled pairs: ${g.passed ? '✓' : '✗'} ${n(g.correct)} of ${n(g.checked)} as labeled.`;
  }
  const g = gate as AudioOnlineGate;
  return g.passed
    ? `Labeled books: ✓ passes (${n(g.checked)} checked).`
    : `Labeled books: ✗ ${count(g.misses.length, 'book matched differently from its label', 'books matched differently from their labels')}.`;
}
