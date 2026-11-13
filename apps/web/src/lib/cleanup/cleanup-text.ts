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
  analyse: 'Preview',
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
  library_changed: 'Calibre changed since the analysis',
  mass_missing: "The reader's library index refused to mark many books as gone",
  ingest_mismatch: "The reader's library index doesn't show the last batch"
};

export function pauseTitle(reason: string): string {
  return PAUSE_TEXT[reason] ?? reason;
}

/** Pauses that only a new analysis clears (resuming alone would pause again). */
export function pauseNeedsAnalysis(reason: string | null): boolean {
  return reason === 'library_changed' || reason === 'not_identical';
}

/** A progress bar: what is being done, how far, and roughly how long is left. */
export interface ProgressBar {
  label: string;
  /** 0-1. */
  fraction: number;
  /** "about 25 min left", or null while there is too little to go on. */
  eta: string | null;
}

/** "less than a minute left", "about 25 min left", "about 2 h 10 min left". */
export function etaText(ms: number): string {
  if (ms < 60_000) return 'less than a minute left';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}

/**
 * Time left from the speed since `startedAt` (when the step began, at `startDone`). Shown only
 * after 30 seconds and some progress, so the first guess isn't wild.
 */
export function eta(
  done: number,
  total: number,
  startedAt: number | null,
  startDone: number,
  now: number
): string | null {
  if (startedAt === null || total <= 0 || done >= total) return null;
  const elapsed = now - startedAt;
  const progressed = done - startDone;
  if (elapsed < 30_000 || progressed <= 0 || done / total < 0.005) return null;
  return etaText(((total - done) * elapsed) / progressed);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The analysis' progress bar (reading file sizes, then comparing same-size files). */
export function stage1Progress(stage: CleanupStage, now = Date.now()): ProgressBar | null {
  const p = stage.progress as Record<string, unknown>;
  if (!p || stage.mode === 'off') return null;
  const phaseStart = typeof p.phaseStartedAt === 'number' ? p.phaseStartedAt : null;
  if (p.phase === 'stat') {
    const done = num(p.statDone);
    const total = num(p.statTotal);
    if (total <= 0) return null;
    // Analyses started before the bar existed have no phaseStartedAt: they began with this step.
    const started = phaseStart ?? (typeof p.startedAt === 'number' ? p.startedAt : null);
    return {
      label: `Step 1 of 2 · Reading file sizes: ${n(done)} of ${n(total)} books`,
      fraction: Math.min(1, done / total),
      eta: eta(done, total, started, num(p.phaseStartDone), now)
    };
  }
  if (p.phase === 'hash') {
    const totalBytes = num(p.hashBytesTotal);
    if (totalBytes > 0) {
      const done = num(p.bytesHashed);
      return {
        label: `Step 2 of 2 · Comparing files of the same size: ${bytesText(done)} of ${bytesText(totalBytes)}`,
        fraction: Math.min(1, done / totalBytes),
        eta: eta(done, totalBytes, phaseStart, num(p.phaseStartDone), now)
      };
    }
    const total = num(p.hashTotal);
    if (total <= 0) return null;
    return {
      label: `Step 2 of 2 · Comparing files of the same size: ${n(p.hashDone)} of ${n(total)} files`,
      fraction: Math.min(1, num(p.hashDone) / total),
      eta: null
    };
  }
  return null;
}

/** Removing the copies once stage 1 is on: removed of all to remove, time left from the pace. */
export function applyProgress(
  counts: Record<string, number>,
  batches: CleanupBatch[],
  now = Date.now()
): ProgressBar | null {
  const done = counts.applied ?? 0;
  const total = done + (counts.proposed ?? 0) + (counts.queued ?? 0);
  if (total <= 0 || done >= total || (done === 0 && (counts.queued ?? 0) === 0)) return null;
  const applies = batches.filter((b) => b.kind === 'apply');
  const first = applies.length ? Math.min(...applies.map((b) => b.claimedAt ?? b.createdAt)) : null;
  return {
    label: `Removing copies: ${n(done)} of ${n(total)}`,
    fraction: done / total,
    eta: eta(done, total, first, 0, now)
  };
}

/** The lines under stage 1's name: where the analysis is, and what it found. */
export function stage1Lines(stage: CleanupStage): string[] {
  const p = stage.progress as Record<string, unknown>;
  if (!p || typeof p.phase !== 'string') {
    return stage.mode === 'off' ? [] : ['Waiting to start.'];
  }
  const lines: string[] = [];
  if (p.phase === 'stat' || p.phase === 'hash') {
    // Shown as a progress bar (stage1Progress).
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
  const waiting = (c.pending ?? 0) + (c.verified ?? 0) + (c.exported ?? 0) + (c.tagged ?? 0);
  // A batch that has ended won't get to them any more.
  if (waiting) parts.push(`${n(waiting)} ${batch.finishedAt ? 'not finished' : 'to go'}`);
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
  tagged: 'Saved to the quarantine, your tags copied',
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
