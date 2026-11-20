/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The switch's words on /cleanup (WP21e-2): the switch to the new audiobook library, Undo,
 * deleting japanese-old, and the covers. The state line, the bar with time left, the pause, the
 * report's lines. Pure, tested.
 */
import type { AudioSwitchStatus, SwitchAction, SwitchProgress } from './cleanup-api';
import { bytesText, eta, n, type ProgressBar } from './cleanup-text';

export const SWITCH_HINT =
  'The switch makes japanese-new the library: japanese is renamed japanese-old and japanese-new japanese (and japanese-generated-new japanese-generated), the five library-only files get their name under the torrents’ _from-library, and the reader’s links follow their files. While it runs the reader holds its audiobooks (no scans, merges, PC jobs or link changes). Until japanese-old is deleted, Undo renames everything back.';

const ACTION_LABEL: Record<SwitchAction, string> = {
  switch: 'The switch',
  undo: 'Undo',
  delete: 'Deleting japanese-old'
};

const PHASE_LABEL: Record<string, string> = {
  'switch:hold': 'Holding the reader’s audiobooks (scans, merges, the PC and link changes wait)',
  'switch:late': 'Looking for audio files that arrived after stage 1',
  'switch:from_library':
    'The library-only files: read again, then linked under _from-library and into the new library',
  'switch:check': 'Stage 6’s check again',
  'switch:links': 'Mapping the reader’s links to the new folders',
  'switch:snapshot': 'A copy of ttsu.db',
  'switch:rename': 'Renaming the folders',
  'switch:remap': 'Rewriting the reader’s links',
  'switch:rescan': 'The reader’s scan of the new folders',
  'switch:verify': 'Checking every reader link',
  'switch:release': 'Letting go of the hold',
  'undo:hold': 'Holding the reader’s audiobooks',
  'undo:rename': 'Renaming the folders back',
  'undo:restore': 'Putting the reader’s links back',
  'undo:rescan': 'The reader’s scan of the old folders',
  'undo:verify': 'Checking every reader link',
  'undo:release': 'Letting go of the hold',
  'delete:check': 'Stage 6’s check of the switched folders',
  'delete:files': 'The PDFs and archives read again on both sides',
  'delete:inventory': 'Keeping the old copy script’s files',
  'delete:list': 'Listing japanese-old',
  'delete:delete': 'Deleting japanese-old',
  'delete:report': 'The space freed'
};

export function phaseLabel(action: SwitchAction, phase: string): string {
  return PHASE_LABEL[`${action}:${phase}`] ?? phase;
}

/** What the switch's state is, in one line. */
export function switchStateLine(s: AudioSwitchStatus | null | undefined): string | null {
  if (!s?.available) return null;
  const p = s.progress;
  switch (s.state) {
    case 'none':
      return p?.history.some((h) => h.action === 'undo' && h.result === 'done')
        ? 'Not switched (undone): japanese is the old library again; japanese-new is built.'
        : 'Not switched: japanese is still the old library; japanese-new is built next to it.';
    case 'running': {
      if (!p) return 'Working';
      const phases = s.phases ?? [];
      const i = phases.indexOf(p.phase);
      return `${ACTION_LABEL[p.action]}: ${phaseLabel(p.action, p.phase)}${i >= 0 ? ` (step ${i + 1} of ${phases.length})` : ''}`;
    }
    case 'switched':
      return 'Switched: japanese is the new library; the old one is japanese-old (Undo renames everything back).';
    case 'deleted':
      return 'Switched; japanese-old is deleted (the switch can no longer be undone).';
  }
  return null;
}

/** The bar of the step running now, with time left. */
export function switchBar(
  s: AudioSwitchStatus | null | undefined,
  now = Date.now()
): ProgressBar | null {
  const p = s?.progress;
  if (!p || s?.state !== 'running') return null;
  const c = p.current;
  const label = phaseLabel(p.action, p.phase);
  if (!c) return { label, fraction: 0, eta: null };
  const step = c.step && c.step !== label ? `${label}: ${c.step}` : label;
  if (!c.total) return { label: step, fraction: 0, eta: null };
  return {
    label: `${step}: ${n(c.done)} of ${n(c.total)}`,
    fraction: Math.min(1, c.done / c.total),
    eta: eta(c.done, c.total, c.startedAt, 0, now)
  };
}

/** Why it stopped, or null. */
export function switchPauseLine(s: AudioSwitchStatus | null | undefined): string | null {
  if (!s?.pause) return null;
  return `Paused: ${s.pause.detail ?? s.pause.reason}`;
}

const sec = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;

/** The run's report (the last run's, or the one going on). */
export function switchLines(p: SwitchProgress | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.lateArrivals.length)
    out.push(
      `Arrived after stage 1: ${n(p.lateArrivals.length)} audio files (e.g. ${p.lateArrivals[0]}).`
    );
  if (p.fromLibrary.length)
    out.push(
      `Library-only files linked under the torrents’ _from-library and into the new library: ${n(p.fromLibrary.length)}.`
    );
  if (p.check)
    out.push(
      `Stage 6’s check: ${
        p.check.passed
          ? '✓ passed'
          : `✗ not passed (${p.check.items
              .filter((i) => i.ok === false)
              .map((i) => i.name)
              .join('; ')})`
      }.`
    );
  if (p.links) {
    const k = p.links;
    out.push(
      `Reader links: ${n(p.linksBefore ?? 0)} in all, ${n(k.changed ?? 0)} change (${n(k.moved ?? 0)} moved, ${n(k.dropped ?? 0)} duplicates now the kept copy, ${n(k.ai ?? 0)} AI books, ${n(k.library_only ?? 0)} library-only, ${n(k.folder ?? 0)} folder links), ${n(k.outside ?? 0)} outside the library, ${n(k.listed ?? 0)} can’t be mapped.`
    );
    if (k.changed)
      out.push(
        'Downloaded copies of these audiobooks on your devices no longer match their new place: download them again.'
      );
  }
  if (p.snapshot) out.push(`ttsu.db copied first: snapshots/${p.snapshot}.`);
  if (p.renamed.length && p.phaseTimes.rename !== undefined)
    out.push(`Renamed: ${p.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}.`);
  if (p.rescan)
    out.push(`The reader’s scan: ${n(p.rescan.folders)} audiobook folders in ${sec(p.rescan.ms)}.`);
  if (p.verify)
    out.push(
      `Every link: ${p.verify.passed ? '✓' : '✗'} ${n(p.verify.resolved)} of ${n(p.verify.links)} resolve, ${n(p.verify.playableLost)} no longer play; links ${n(p.verify.countBefore)} → ${n(p.verify.countAfter)}.`
    );
  if (p.restored)
    out.push(
      `Links put back: ${n(p.restored.restored)} (${n(p.restored.listed)} had changed since).`
    );
  if (p.files)
    out.push(
      `PDFs and archives read again: ${n(p.files.same)} of ${n(p.files.total)} the same bytes as their torrent twins (${bytesText(p.files.bytes)})${p.files.different + p.files.noTwin + p.files.unreadable ? `; ${n(p.files.different)} differ, ${n(p.files.noTwin)} without a twin, ${n(p.files.unreadable)} unreadable` : ''}.`
    );
  if (p.inventory?.copied.length)
    out.push(
      `Kept in media/audiobooks/_inventory/old-copy-script/: ${p.inventory.copied.join(', ')}.`
    );
  if (p.deletion) {
    const d = p.deletion;
    out.push(`japanese-old: ${n(d.files)} files and ${n(d.dirs)} folders, ${bytesText(d.bytes)}.`);
    if (d.unknown.length)
      out.push(`Not as the build listed them: ${n(d.unknown.length)} (e.g. ${d.unknown[0]}).`);
    if (p.finishedAt && p.action === 'delete')
      out.push(
        `Freed: ${bytesText(d.freed)}${d.freeBefore !== null && d.freeAfter !== null ? ` (disk1 free ${bytesText(d.freeBefore)} → ${bytesText(d.freeAfter)})` : ''}.`
      );
  }
  const times = Object.entries(p.phaseTimes)
    .filter(([, ms]) => ms >= 1000)
    .map(([ph, ms]) => `${ph} ${sec(ms)}`);
  if (times.length) out.push(`Time per step: ${times.join(', ')}.`);
  if (p.error) out.push(`Error: ${p.error}`);
  return out;
}

/** The covers' state and report. */
export function coversLines(
  s: AudioSwitchStatus | null | undefined,
  now = Date.now()
): {
  bar: ProgressBar | null;
  lines: string[];
} {
  const c = s?.covers;
  const p = c?.progress;
  if (!c || !p) return { bar: null, lines: [] };
  const lines: string[] = [];
  const k = p.counts;
  const get = (x: string) =>
    Object.entries(k)
      .filter(([key]) => key.startsWith(`${x}:`))
      .reduce((a, [, v]) => a + v, 0);
  if (p.libraries.main)
    lines.push(
      `Audiobookshelf library: ${p.libraries.main}${p.libraries.ai ? ` and ${p.libraries.ai}` : ''}.`
    );
  if (Object.keys(k).length)
    lines.push(
      `Books without embedded art: ${n(get('set'))} covers set (${n(k['set:url'] ?? 0)} store covers, ${n(k['set:file'] ?? 0)} from the old library), ${n(get('planned'))} waiting, ${n(get('failed'))} failed, ${n(get('has_cover'))} already had one, ${n(get('no_source'))} without a cover anywhere, ${n(get('no_item'))} not in Audiobookshelf.`
    );
  if (p.coverPng)
    lines.push(
      `The old library’s cover.png files: ${n(p.coverPng.total)}; ${n(p.coverPng.ofTheseBooks)} belong to these books, ${n(p.coverPng.used)} used.`
    );
  if (c.pause) lines.push(`Paused: ${c.pause.detail ?? c.pause.reason}`);
  if (p.error && !c.pause) lines.push(`Error: ${p.error}`);
  const cur = p.current;
  const bar =
    c.state === 'running' && cur
      ? {
          label: `Covers: ${cur.step}: ${n(cur.done)} of ${n(cur.total)}`,
          fraction: cur.total ? Math.min(1, cur.done / cur.total) : 0,
          eta: eta(cur.done, cur.total, cur.startedAt, 0, now)
        }
      : null;
  return { bar, lines };
}
