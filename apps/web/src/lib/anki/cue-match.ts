/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP14: which subtitle cues speak a sentence, so the server can cut its audio.
 *
 * 1. A book matched by whispersync wraps each line in a span carrying its cue id: those
 *    ids give the cues exactly (`cuesById`).
 * 2. Otherwise the sentence is looked for in the cue text, both sides normalized (NFKC,
 *    no whitespace, punctuation or symbols). Several hits: the one nearest the expected
 *    time (the sentence's place in the book ≈ its place in the audio). No exact hit: the
 *    best window of 1-3 cues by character-bigram overlap, if it reaches `threshold`.
 */

export interface Cue {
  id: string;
  /** Seconds, padding already applied (as whispersync plays the line). */
  start: number;
  end: number;
  text: string;
}

export interface CueMatch {
  cues: Cue[];
  start: number;
  end: number;
  how: 'matched-book' | 'exact' | 'similar';
}

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\u3000]/gu, '');
}

function span(cues: Cue[], how: CueMatch['how']): CueMatch {
  return {
    cues,
    start: Math.min(...cues.map((c) => c.start)),
    end: Math.max(...cues.map((c) => c.end)),
    how
  };
}

/** The cues with these ids (from a whispersync-matched book), or null when none is known. */
export function cuesById(cues: Map<string, Cue> | Cue[], ids: Iterable<string>): CueMatch | null {
  const byId = cues instanceof Map ? cues : new Map(cues.map((c) => [c.id, c]));
  const found: Cue[] = [];

  for (const id of new Set(ids)) {
    const cue = byId.get(id);

    if (cue) found.push(cue);
  }

  return found.length ? span(found, 'matched-book') : null;
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();

  for (let i = 0; i + 1 < text.length; i += 1) {
    const g = text.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }

  return out;
}

/** Sørensen–Dice coefficient over character bigrams (0-1). */
export function similarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    return a === b && a !== '' ? 1 : 0;
  }

  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;

  for (const [g, n] of A) {
    shared += Math.min(n, B.get(g) ?? 0);
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

export interface FindOptions {
  /** Where the sentence is expected in the audio (seconds), to choose among repeats. */
  expectedSeconds?: number | null;
  /** Least bigram similarity for a window of cues when there is no exact hit. */
  threshold: number;
}

/** The cues (ordered by start) that speak `sentence`, or null. */
export function findCues(cues: Cue[], sentence: string, options: FindOptions): CueMatch | null {
  const needle = normalizeForMatch(sentence);

  if (needle.length < 2 || !cues.length) {
    return null;
  }

  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const norms = sorted.map((c) => normalizeForMatch(c.text));
  let hay = '';
  const cueAt: number[] = [];

  norms.forEach((n, i) => {
    hay += n;
    for (let k = 0; k < n.length; k += 1) cueAt.push(i);
  });

  const distance = (cue: Cue) =>
    options.expectedSeconds == null ? 0 : Math.abs(cue.start - options.expectedSeconds);

  // Exact hits.
  let best: { first: number; last: number } | null = null;

  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const hit = { first: cueAt[at], last: cueAt[at + needle.length - 1] };

    if (!best || distance(sorted[hit.first]) < distance(sorted[best.first])) {
      best = hit;
    }

    if (options.expectedSeconds == null) break;
  }

  if (best) {
    return span(sorted.slice(best.first, best.last + 1), 'exact');
  }

  // Similar windows of 1-3 cues.
  let top: { first: number; last: number; score: number } | null = null;

  for (let i = 0; i < sorted.length; i += 1) {
    let joined = '';

    for (let w = 0; w < 3 && i + w < sorted.length; w += 1) {
      joined += norms[i + w];

      // A window much longer than the sentence can't be it.
      if (joined.length > needle.length * 2 + 4) break;

      const score = similarity(needle, joined);

      if (
        score >= options.threshold &&
        (!top ||
          score > top.score + 1e-9 ||
          (Math.abs(score - top.score) <= 1e-9 &&
            distance(sorted[i]) < distance(sorted[top.first])))
      ) {
        top = { first: i, last: i + w, score };
      }
    }
  }

  return top ? span(sorted.slice(top.first, top.last + 1), 'similar') : null;
}
