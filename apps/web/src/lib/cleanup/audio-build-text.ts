/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Audiobook stage 6's words on /cleanup (WP21e-1): building japanese-new next to the live
 * library from stages 1-5 (hard links only), and the check. The hint, the progress with time
 * left, what the plan found, the check's lines and one line per sample book. Pure, tested.
 */
import type { AudioBuildBook, AudioStage6Status, Stage6Progress } from './cleanup-api';
import { count } from './audio-text';
import { bytesText, etaText, n, type ProgressBar } from './cleanup-text';

export const STAGE6_HINTS: Record<'off' | 'analyse' | 'on', string> = {
  off: 'Off: builds nothing. In Preview, the new library is planned from stages 1-5 (folders, hard links, metadata.json, the move list) and the linking sidecar checks every torrent file it would link (read only). On builds it.',
  analyse:
    'Preview: the plan and the sidecar’s check of the sources; nothing is written. The live library, the torrents, Audiobookshelf and the reader are not touched.',
  on: 'On: the linking sidecar builds media/audiobooks/japanese-new/ (and japanese-generated-new/ for the AI books) next to the live library: new folders, hard links to the torrents’ files, each book’s metadata.json. Nothing else is changed; the switch is a later step.'
};

export const MODE_LABEL_ON = 'On (build)';

const PHASE_LABELS: Record<string, string> = {
  plan: 'Planning',
  preflight: 'The sidecar checks the planned torrent files',
  planned: 'Planned',
  walk_before: 'Listing the torrents and the library (before)',
  build: 'Building',
  walk_after: 'Listing the torrents and the library (after)',
  check: 'Checking',
  done: 'Done'
};

/** The progress bar of the step running now (with time left when the server can tell). */
export function audioStage6Bar(s: AudioStage6Status | null | undefined): ProgressBar | null {
  const p = s?.progress;
  if (!p || p.phase === 'done' || p.phase === 'planned') return null;
  const eta =
    s.secondsLeft !== null && s.secondsLeft !== undefined && s.secondsLeft > 0
      ? `${etaText(s.secondsLeft * 1000)} (estimate)`
      : null;
  if (p.phase === 'preflight' && p.preflight.total)
    return {
      label: `${PHASE_LABELS.preflight}: ${n(p.preflight.done)} of ${n(p.preflight.total)}`,
      fraction: Math.min(1, p.preflight.done / p.preflight.total),
      eta
    };
  if (p.phase === 'build' && p.build.total)
    return {
      label: `Building: ${n(p.build.done)} of ${n(p.build.total)} folders, links and metadata files`,
      fraction: Math.min(1, p.build.done / p.build.total),
      eta
    };
  if ((p.phase === 'walk_before' || p.phase === 'walk_after') && p.walk.current)
    return {
      label: `${PHASE_LABELS[p.phase]}: ${n(p.walk.current.done)} of about ${n(p.walk.current.expected)} entries`,
      fraction: Math.min(1, p.walk.current.done / Math.max(1, p.walk.current.expected)),
      eta
    };
  return { label: PHASE_LABELS[p.phase] ?? p.phase, fraction: 0, eta: null };
}

/** One line for the card: what the plan makes, or the build and the check. */
export function stage6Summary(s: AudioStage6Status | null | undefined): string | null {
  const p = s?.progress;
  const k = p?.counts;
  if (!p || !k) return null;
  const books = `${count(k.books.main, 'book', 'books')} in japanese-new, ${n(k.books.ai)} AI books in japanese-generated-new, ${count(k.links + k.pdfLinks, 'hard link', 'hard links')}`;
  if (p.phase === 'done' && p.check)
    return `Built: ${books}. Check: ${p.check.passed ? '✓ passed' : `✗ ${count(p.check.items.filter((i) => i.ok === false).length, 'item failed', 'items failed')}`}.`;
  if (p.build.startedAt) return `Building: ${books}.`;
  return `Plan: ${books}; ${n(k.books.pending)} library-only files wait for the switch.`;
}

const secs = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/** The details' lines: the plan's counts, the preflight, the build, the walks. */
export function audioStage6Lines(s: AudioStage6Status | null | undefined): string[] {
  const p = s?.progress;
  if (!s || !p) return [];
  const out: string[] = [];
  const k = p.counts;
  if (k) {
    out.push(
      `From ${count(k.units, 'recording', 'recordings')}: ${n(k.books.main)} books in japanese-new, ${n(k.books.ai)} AI books in japanese-generated-new, ${n(k.books.pending)} library-only (moved into the torrents’ _from-library at the switch, then linked).`
    );
    out.push(
      `Folders: ${n(k.shapes.seriesVol)} Author/Series/Vol N - Title, ${n(k.shapes.seriesNoVol)} Author/Series/Title, ${n(k.shapes.standalone)} Author/Title; ${n(k.unknownAuthor)} under _Unknown.`
    );
    out.push(
      `${count(k.links, 'audio link', 'audio links')}, ${count(k.pdfLinks, 'PDF link', 'PDF links')} (${n(k.pdfs.placed)} of ${n(k.pdfs.total)} PDFs placed${k.pdfs.otherCopy !== undefined && k.pdfs.unplaced ? `; not placed: ${n(k.pdfs.otherCopy)} of a dropped copy whose kept copy brings its own booklet, ${n(k.pdfs.noBook ?? 0)} with no matching book` : ''}), ${n(k.metadata)} metadata.json, ${n(k.folders)} folders.`
    );
    out.push(
      `Duplicates: ${count(k.droppedCopies, 'proven copy', 'proven copies')} not linked; ${count(k.keptReview, 'unproven copy', 'unproven copies')} kept as books of their own.`
    );
    out.push(
      `Names: ${n(k.collisions.narrator)} with {narrator}, ${n(k.collisions.number)} with a copy number, ${n(k.namesReplaced)} with characters replaced by full-width forms, ${n(k.namesCut)} cut to 255 bytes.`
    );
    out.push(
      `Move list: ${n(k.moves.moved)} moved, ${n(k.moves.ai)} to the AI library, ${n(k.moves.dropped)} dropped as proven duplicates (pointing to the kept copy), ${n(k.moves.library_only_pending)} library-only, ${n(k.moves.reader_written)} written by the reader, ${n(k.moves.unaccounted)} unaccounted.`
    );
    if (k.noCover)
      out.push(
        `${count(k.noCover, 'book has', 'books have')} no embedded cover (Audiobookshelf will show none until the switch sets the store cover).`
      );
  }
  if (p.archives)
    out.push(
      `${count(p.archives.count, 'archive', 'archives')} in the torrents (${bytesText(p.archives.bytes)}): not part of this build (the daily run unpacks them later).`
    );
  if (p.preflight.total) {
    const probs = Object.entries(p.preflight.byProblem)
      .map(([why, c]) => `${why} ${n(c)}`)
      .join(', ');
    out.push(
      `Sources checked by the sidecar: ${n(p.preflight.done)} of ${n(p.preflight.total)}${p.preflight.problems ? `; ${n(p.preflight.problems)} can’t be linked (${probs})` : ', all linkable'}.`
    );
  }
  const sc = s.sidecar;
  if (sc)
    out.push(
      sc.online
        ? `Linking sidecar online${sc.version ? ` (${sc.version})` : ''}${sc.problem ? `: ${sc.problem}` : ''}.`
        : 'Linking sidecar offline (start ttsu-cleanup-link).'
    );
  const b = p.build;
  if (b.startedAt)
    out.push(
      `Build: ${n(b.done)} of ${n(b.total)} done in ${count(b.batches, 'batch', 'batches')}${b.failed ? `, ${n(b.failed)} failed` : ''}; waited for the disk ${count(b.lockWaits, 'time', 'times')} (${secs(b.lockWaitMs)}), gave it to Calibre ${count(b.yields, 'time', 'times')}.`
    );
  if (b.firstFailure) out.push(`First failure: ${b.firstFailure}`);
  for (const [which, w] of [
    ['before', p.walk.before],
    ['after', p.walk.after]
  ] as const)
    if (w)
      out.push(
        `Walk ${which}: ${n(w.entries)} entries in ${secs(w.ms)}${w.pausedMs ? ` (${secs(w.pausedMs)} waiting for Calibre)` : ''}${w.errors.length ? `, ${n(w.errors.length)} errors` : ''}.`
      );
  const times = Object.entries(p.phaseTimes)
    .filter(([, t]) => t.ms > 0)
    .map(([ph, t]) => `${PHASE_LABELS[ph] ?? ph} ${secs(t.ms)}`);
  if (times.length) out.push(`Time per step: ${times.join(', ')}.`);
  if (p.error) out.push(`Error: ${p.error}`);
  return out;
}

/** The check, one line per item. */
export function checkLines(p: Stage6Progress | null | undefined): string[] {
  if (!p?.check) return [];
  return p.check.items.map(
    (i) => `${i.ok === true ? '✓' : i.ok === false ? '✗' : '–'} ${i.name}: ${i.detail}`
  );
}

/** A labeled book whose folder or value differs from its label, and why. */
export function labelDiffLines(p: Stage6Progress | null | undefined): string[] {
  const l = p?.check?.labels;
  if (!l) return [];
  return [
    ...l.folderWrong.map((f) => `${f.id}: folder ${f.got} (label: ${f.expected}) — ${f.why}`),
    ...l.valuesWrong.map(
      (v) =>
        `${v.id}: ${v.field} ${JSON.stringify(v.got)} (label: ${JSON.stringify(v.expected)}) — ${v.why}`
    )
  ];
}

/** "Vol 1 - … (3 files, 1 PDF) ← torrents/…". */
export function bookLine(b: AudioBuildBook): string {
  const what = [
    count(b.fileCount, 'file', 'files'),
    b.pdfs ? count(b.pdfs, 'PDF', 'PDFs') : null,
    b.state === 'pending' ? 'library-only: linked at the switch' : null,
    b.notes.length ? b.notes.join(', ') : null
  ]
    .filter(Boolean)
    .join(', ');
  return `${b.folder} (${what})`;
}

/** The metadata.json values shown under a sample book. */
export function metadataLine(m: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join('、') : '—');
  return [
    `Title ${String(m.title ?? '—')}`,
    `authors ${list(m.authors)}`,
    `narrators ${list(m.narrators)}`,
    `series ${list(m.series)}`,
    m.tags && Array.isArray(m.tags) && m.tags.length ? `tags ${list(m.tags)}` : null,
    m.asin ? `ASIN ${String(m.asin)}` : null,
    m.publishedYear ? `${String(m.publishedYear)}` : null
  ]
    .filter(Boolean)
    .join(' · ');
}
