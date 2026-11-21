/**
 * WP21f-2: books in the library kept as they were built, whatever stage 5 decides later: the
 * user's own decisions (like meta-corrections.ts), keyed by a torrent file the book links.
 * Stage 7's library changes never change such a book (listed as "kept as built").
 */
export const KEPT_AS_BUILT: readonly { torrent: string; reason: string; decided: string }[] = [
  {
    // WP21c follow-up (3): stage 3's fingerprints found it a different recording from the
    // Discord copy that keeps Audible B0GP5PY2CH, so stage 4 looked it up again and found no
    // record; it is most likely the same product (328.8 min both, the same tags and
    // description). User, 2026-11-21: keep its built values unless proven otherwise.
    torrent: 'MAM/[13巻] 安達としまむら13 (KADOKAWA).m4b',
    reason: 'Kept as built (your decision, 2026-11-21): most likely Audible B0GP5PY2CH too',
    decided: '2026-11-21',
  },
];

/** The reason a book whose linked torrent files are `rels` is kept as built, else null. */
export function keptAsBuilt(rels: string[]): string | null {
  for (const k of KEPT_AS_BUILT) if (rels.includes(k.torrent)) return k.reason;
  return null;
}
