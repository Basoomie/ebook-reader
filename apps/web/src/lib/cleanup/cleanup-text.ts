/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CleanupBatch, CleanupStage, Proposal, StageMode } from './cleanup-api';

/** Plain wording for the /cleanup page (WP20a). Everyday words, no design-doc terms. */

export function n(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

export function bytesText(value: unknown): string {
  const b = typeof value === 'number' ? value : 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

export const MODE_LABELS: Record<StageMode, string> = {
  off: 'Off',
  analyse: 'Look only',
  on: 'On'
};

export const MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse: 'Finds the copies and lists them here; nothing in Calibre is changed.',
  on: 'Finds the copies and removes them in batches on its own, behind the safety checks.'
};

const PAUSE_TEXT: Record<string, string> = {
  not_identical: 'A copy is no longer identical to the copy it was matched with',
  batch_failed: 'Some items of the last batch failed',
  mass_missing: "The reader's library index refused to mark many books as gone",
  ingest_mismatch: "The reader's library index doesn't show the last batch"
};

export function pauseTitle(reason: string): string {
  return PAUSE_TEXT[reason] ?? reason;
}

/** The lines under stage 1's name: where the analysis is, and what it found. */
export function stage1Lines(stage: CleanupStage): string[] {
  const p = stage.progress as Record<string, unknown>;
  if (!p || typeof p.phase !== 'string') {
    return stage.mode === 'off' ? [] : ['Waiting to start.'];
  }
  const lines: string[] = [];
  if (p.phase === 'stat') {
    lines.push(`Reading file sizes: ${n(p.statDone)} of ${n(p.statTotal)} books.`);
  } else if (p.phase === 'hash') {
    lines.push(
      `Comparing files of the same size: ${n(p.hashDone)} of ${n(p.hashTotal)} files (${bytesText(
        p.bytesHashed
      )} read).`
    );
  } else if (p.phase === 'group') {
    lines.push('Grouping identical files…');
  } else if (p.phase === 'done') {
    if (p.error) {
      lines.push(`The analysis stopped: ${String(p.error)}`);
    } else {
      lines.push(
        `Found ${n(p.duplicateSets)} sets of identical files: ${n(p.toRemove)} copies to remove ` +
          `(the copy kept: by your tags ${n(p.keptByTags)}, the older record ${n(p.keptByDate)}).`
      );
      const extras: string[] = [];
      const has = (count: unknown) => (Number(count) === 1 ? 'has' : 'have');
      if (Number(p.extraFormat) > 0) {
        extras.push(`${n(p.extraFormat)} also ${has(p.extraFormat)} another format`);
      }
      if (Number(p.tagsCopied) > 0) {
        extras.push(
          `${n(p.tagsCopied)} ${has(p.tagsCopied)} your own tags, which are added to the copy that stays`
        );
      }
      if (Number(p.removedWithData) > 0) {
        extras.push(
          `${n(p.removedWithData)} ${has(p.removedWithData)} reading data, which goes to the kept copy`
        );
      }
      if (Number(p.bothWithData) > 0) {
        extras.push(
          `${n(p.bothWithData)} where both copies have reading data (each keeps its own)`
        );
      }
      if (extras.length) lines.push(`Of these, ${extras.join('; ')}.`);
    }
    if (Number(p.statErrors) > 0 || Number(p.hashErrors) > 0) {
      lines.push(
        `${n(Number(p.statErrors) + Number(p.hashErrors))} files couldn't be read and were left out.`
      );
    }
  }
  return lines;
}

/** "N of N checked pairs were still identical" (stage 1's measured precision). */
export function precisionLine(stage: CleanupStage): string | null {
  const p = stage.precision as { checked?: number; identical?: number };
  if (!p || !p.checked) return null;
  const pct = ((100 * (p.identical ?? 0)) / p.checked).toFixed(1);
  return `Checked again just before removing: ${n(p.identical)} of ${n(p.checked)} pairs still identical (${pct} %).`;
}

const BATCH_STATE: Record<CleanupBatch['state'], string> = {
  planned: 'Waiting for the sidecar',
  claimed: 'Being applied',
  applied: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  undone: 'Undone'
};

export function batchStateText(batch: CleanupBatch): string {
  return BATCH_STATE[batch.state] ?? batch.state;
}

export function batchKindText(batch: CleanupBatch): string {
  return batch.kind === 'undo' ? 'Undo' : 'Remove identical copies';
}

export function batchCountsText(batch: CleanupBatch): string {
  const c = batch.counts ?? {};
  const parts: string[] = [];
  const done = batch.kind === 'undo' ? c.restored : c.removed;
  if (done) parts.push(`${n(done)} ${batch.kind === 'undo' ? 'brought back' : 'removed'}`);
  if (c.skipped) parts.push(`${n(c.skipped)} skipped`);
  if (c.failed) parts.push(`${n(c.failed)} failed`);
  const waiting = (c.pending ?? 0) + (c.verified ?? 0) + (c.exported ?? 0);
  if (waiting) parts.push(`${n(waiting)} to go`);
  return parts.length ? parts.join(' · ') : `${n(batch.itemCount)} items`;
}

export function canUndo(batch: CleanupBatch, all: CleanupBatch[]): boolean {
  if (batch.kind !== 'apply') return false;
  if (!['applied', 'partial', 'failed'].includes(batch.state)) return false;
  if (!(batch.counts?.removed > 0)) return false;
  // One batch at a time.
  return !all.some((b) => b.state === 'planned' || b.state === 'claimed');
}

const ITEM_STATE: Record<string, string> = {
  pending: 'Waiting',
  verified: 'Checked',
  exported: 'Saved to the quarantine',
  removed: 'Removed (in Calibre’s trash)',
  restored: 'Brought back',
  failed: 'Failed',
  skipped: 'Skipped',
  proposed: 'To remove',
  queued: 'In a batch',
  applied: 'Removed',
  kept: 'Kept',
  undone: 'Brought back'
};

export function itemStateText(state: string): string {
  return ITEM_STATE[state] ?? state;
}

export function handoffText(p: Proposal): string | null {
  const kind = p.handoff?.kind;
  if (kind === 'swapped') return 'Its reading data now shows on the kept copy.';
  if (kind === 'both-have-data') return 'Both copies had reading data; each kept its own.';
  return null;
}

export function ruleText(p: Proposal): string {
  return p.evidence?.rule === 'tags' ? 'kept: more of your tags' : 'kept: the older record';
}

export function restoreText(method: string | null | undefined): string | null {
  if (!method) return null;
  if (method.startsWith('trash')) return 'Brought back from Calibre’s trash (same Calibre id).';
  if (method.startsWith('readd')) {
    return 'Added again from the quarantine (a new Calibre id; the reader kept its book).';
  }
  return null;
}

/**
 * The removed copy's own tags (PeepoHappyBooks, TMW-collection-*, …) that the kept copy
 * lacks: they are added to the kept copy (decided with the user 2026-11-13).
 */
export function tagsMoving(p: Proposal): string[] {
  const ev = p.evidence;
  if (!ev) return [];
  const kept = new Set(ev.kept.tags.map((t) => t.toLowerCase()));
  return (ev.removed.customTags ?? []).filter((t) => !kept.has(t.toLowerCase()));
}

/** Tags as one line: the user's own tags first. */
export function tagsText(tags: string[] | undefined): string {
  return tags && tags.length ? tags.join(', ') : 'no tags';
}
