/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  Stage5Counts,
  Stage5Gate,
  Stage5Progress,
  Stage5SetScore,
  Stage5Status,
  StageMode
} from './cleanup-api';
import { etaText, n, type ProgressBar } from './cleanup-text';

/** Plain wording for stage 5 on the /cleanup page (WP20f): genres and tags. */

export const STAGE5_MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Both AI models read every book; a genre or tag is kept only when both give it, RanobeDB and the store categories add theirs, and every book of a series gets what any of its volumes has. Lists what it would change; nothing in Calibre is changed.',
  on: 'Adds the genres, tags and format to each book’s own tags in Calibre, in batches, and takes off the Google Books categories and the old workflow tags. Your own tags stay.'
};

const PHASES: Record<string, string> = {
  marks: 'recording the old workflow tags',
  evidence: 'gathering what the models read',
  models: 'asking both models',
  decide: 'deciding every book',
  gate: 'checking the labeled books',
  propose: 'working out each book’s tags',
  done: 'done'
};

const BAR_LABELS: Record<string, string> = {
  marks: 'Recording the old workflow tags',
  evidence: 'Gathering what the models read',
  models: 'Asking both models',
  decide: 'Deciding every book',
  gate: 'Checking the labeled books',
  propose: 'Working out each book’s tags'
};

/** The running phase's bar with the time left. */
export function stage5Bar(p: Stage5Progress | null | undefined): ProgressBar | null {
  const b = p?.bar;
  if (!p || !b || p.phase === 'done') return null;
  const what = b.phase === 'models' ? 'answers in' : 'books';
  return {
    label: b.total
      ? `${BAR_LABELS[b.phase] ?? b.phase}: ${n(b.done)} of ${n(b.total)} ${what}`
      : (BAR_LABELS[b.phase] ?? b.phase),
    fraction: b.total ? Math.min(1, b.done / b.total) : 0,
    eta:
      b.secondsLeft !== null && b.secondsLeft > 0
        ? `${etaText(b.secondsLeft * 1000)} (estimate)`
        : null
  };
}

/** The run in one line: phase, answers, given up, cost. */
export function stage5Line(p: Stage5Progress): string {
  const a = p.answers;
  const asked = a ? a.answered + a.failed + a.blocked + a.invalid : 0;
  const all = a ? asked + a.queued + a.sent : 0;
  const parts = [`Genres and tags: ${PHASES[p.phase] ?? p.phase}`];
  if (a && all > 0) parts.push(`${n(a.answered)} of ${n(all)} answers in`);
  if (a && a.failed > 0) parts.push(`${n(a.failed)} given up`);
  if (p.phase === 'decide') parts.push(`${n(p.decided)} of ${n(p.items)} books decided`);
  if (p.costUsd !== null) parts.push(`$${p.costUsd.toFixed(2)} spent`);
  return parts.join(' · ');
}

const pct = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} %`);

/** One label set as the page shows it, beside the genre test's numbers. */
export function setLine(
  name: string,
  s: Stage5SetScore,
  test: { found: number; right: number; full: number; books: number }
): string {
  return `${name}: ${pct(s.foundPercent)} found (test ${test.found} %), ${pct(s.rightPercent)} right (test ${test.right} %), ${n(s.full)} of ${n(s.books)} books fully right (test ${test.full} of ${test.books})`;
}

/** The gate's lines: as written (the union per series), and both models alone per book. */
export function stage5GateLines(g: Stage5Gate): { title: string; lines: string[] }[] {
  const view = (v: Stage5Gate['final']) => [
    setLine('Genres', v.genres, g.test.genres),
    setLine('Tags', v.tags, g.test.tags)
  ];
  return [
    { title: 'As written (every source, the union per series)', lines: view(g.final) },
    { title: 'Both models alone, per book (as the genre test measured)', lines: view(g.models) },
    { title: 'Every source per book, no union', lines: view(g.own) },
    { title: 'The union without RanobeDB', lines: view(g.noRanobedb) }
  ];
}

/** The gate in one line for the card. */
export function stage5GateSummary(g: Stage5Gate | null | undefined): string | null {
  if (!g) return null;
  if (g.books.genres === 0 && g.books.tags === 0)
    return 'No labeled books for the gate: nothing is written';
  const f = g.final;
  const base = `On the labeled books: genres ${pct(f.genres.rightPercent)} right, ${pct(f.genres.foundPercent)} found; tags ${pct(f.tags.rightPercent)} right, ${pct(f.tags.foundPercent)} found`;
  if (g.below.length) return `${base} · held back: ${g.below.join('; ')}`;
  return `${base} · passes`;
}

/** What the run would change, in one line. */
export function stage5CountsLine(c: Stage5Counts): string {
  const parts = [
    `${n(c.books)} books get a change: ${n(c.added)} tags added, ${n(c.removed)} taken off`,
    `${n(c.noGenre)} books with no genre`
  ];
  if (c.outside > 0)
    parts.push(
      `${n(c.outside)} books stage 4 never read (old tags taken off only: ${n(c.outsideChanged)})`
    );
  if (c.inBatch > 0) parts.push(`${n(c.inBatch)} books in a batch now (left as they are)`);
  return parts.join(' · ');
}

/** How many books get each term of a kind, most first, with the Japanese label. */
export function termCounts(
  status: Pick<Stage5Status, 'terms'>,
  c: Stage5Counts,
  kind: string
): { id: string; label: string; n: number }[] {
  return status.terms
    .filter((t) => t.kind === kind)
    .map((t) => ({ id: t.id, label: `${t.ja} (${t.en})`, n: c.terms[t.id] ?? 0 }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

/** The format tags' counts (the format from stage 4). */
export function formatCounts(
  status: Pick<Stage5Status, 'terms'>,
  c: Stage5Counts
): { label: string; n: number }[] {
  const ids: Record<string, string> = {
    'light novel': 'fmt_light_novel',
    novel: 'fmt_novel',
    nonfiction: 'fmt_nonfiction',
    manga: 'fmt_manga',
    'image-only': 'fmt_image_only'
  };
  return Object.entries(c.formats)
    .map(([f, k]) => {
      const t = status.terms.find((x) => x.id === ids[f]);
      return { label: t ? `${t.ja} (${t.en})` : f, n: k };
    })
    .sort((a, b) => b.n - a.n);
}

/** The removals per tag, most first. */
export function removalCounts(c: Stage5Counts): { tag: string; n: number }[] {
  return Object.entries(c.removals)
    .map(([tag, k]) => ({ tag, n: k }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

const SOURCE_NAMES: Record<string, string> = {
  models: 'both models',
  ranobedb: 'RanobeDB',
  store: 'store category'
};

/** Where a book's term came from, in words. */
export function sourceText(s: { from: string[]; books: number }): string {
  const from = s.from.map((x) => SOURCE_NAMES[x] ?? x).join(', ');
  return s.books > 1 ? `${from} · ${n(s.books)} volumes` : from;
}
