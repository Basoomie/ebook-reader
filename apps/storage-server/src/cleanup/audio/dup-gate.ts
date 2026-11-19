/**
 * Stage 3's gate (WP21b): the duplicate decisions scored against the labeled pairs of the
 * reference sample (`labels.json` "pairs", labels final 2026-11-18). Pairs labeled null are
 * left out. Decided with the user (2026-11-18): the gate passes only when every labeled pair
 * comes out as labeled; each miss is listed on /cleanup.
 *
 * A pair names two library files (`fa`, `fb`, paths under media/audiobooks/japanese). Each is
 * followed to the torrent files it is a byte copy of (stage 1), and from there to the copies
 * stage 3 compared. Pure: the caller supplies those lookups.
 */

export interface LabeledPair {
  n: number;
  kind: string;
  fa: string;
  fb: string;
  same: boolean | null;
  best?: string;
  note?: string;
}

export interface LabelsFile {
  pairs: LabeledPair[];
}

export type ExpectedBest = 'a' | 'b' | 'any' | 'review';

/** What a label asks for: same recording or not, and which copy is best. */
export function expected(p: LabeledPair): { same: boolean; best: ExpectedBest | null } | null {
  if (p.same === null || p.same === undefined) return null;
  if (!p.same) return { same: false, best: null };
  const b = (p.best ?? '').trim();
  if (/^review\b/i.test(b)) return { same: true, best: 'review' };
  if (/^a\b/.test(b)) return { same: true, best: 'a' };
  if (/^b\b/.test(b)) return { same: true, best: 'b' };
  return { same: true, best: 'any' };
}

export interface GateLookups {
  /** The copies a library file's content is in (empty when it can't be followed). */
  copiesOf(libraryRel: string): string[];
  /** The group a copy is in: its key, outcome and each member's rank (0 = best). */
  groupOf(copyKey: string): { key: string; outcome: 'auto' | 'review'; rank: number } | null;
  /** True when the two copies form an unsure pair (both stay, review). */
  unsurePair(a: string, b: string): boolean;
}

export interface GatePairResult {
  n: number;
  kind: string;
  expected: string;
  got: string;
  ok: boolean;
  note?: string;
}

export interface GateResult {
  passed: boolean;
  checked: number;
  correct: number;
  sameChecked: number;
  sameCorrect: number;
  bestChecked: number;
  bestCorrect: number;
  skipped: number;
  misses: GatePairResult[];
  results: GatePairResult[];
  error: string | null;
}

export function scoreGate(labels: LabelsFile, look: GateLookups): GateResult {
  const results: GatePairResult[] = [];
  let skipped = 0;
  let sameChecked = 0;
  let sameCorrect = 0;
  let bestChecked = 0;
  let bestCorrect = 0;
  for (const p of labels.pairs) {
    const want = expected(p);
    if (!want) {
      skipped++;
      continue;
    }
    const ca = look.copiesOf(p.fa);
    const cb = look.copiesOf(p.fb);
    const wantText = want.same ? `same, best ${want.best}` : 'different';
    if (ca.length === 0 || cb.length === 0) {
      results.push({
        n: p.n,
        kind: p.kind,
        expected: wantText,
        got: `not found (${ca.length === 0 ? p.fa : p.fb})`,
        ok: false,
      });
      sameChecked++;
      if (want.best) bestChecked++;
      continue;
    }
    const shared = ca.some((k) => cb.includes(k));
    const ga = ca.map((k) => ({ k, g: look.groupOf(k) }));
    const gb = cb.map((k) => ({ k, g: look.groupOf(k) }));
    let together: { ra: number; rb: number; outcome: 'auto' | 'review' } | null = null;
    for (const x of ga)
      for (const y of gb)
        if (x.g && y.g && x.g.key === y.g.key) {
          const t = { ra: x.g.rank, rb: y.g.rank, outcome: x.g.outcome };
          if (!together || Math.min(t.ra, t.rb) < Math.min(together.ra, together.rb)) together = t;
        }
    const unsure = ca.some((x) => cb.some((y) => look.unsurePair(x, y)));
    const isSame = shared || together !== null;
    let got: string;
    let ok: boolean;
    sameChecked++;
    if (!want.same) {
      got = isSame ? 'same' : unsure ? 'unsure (both stay, review)' : 'different';
      ok = !isSame && !unsure;
      if (ok) sameCorrect++;
    } else if (!isSame) {
      got = unsure ? 'unsure (both stay, review)' : 'different';
      ok = false;
      bestChecked++;
    } else {
      sameCorrect++;
      bestChecked++;
      // Under the user's rule (2026-11-18: a copy goes only when proven the same; otherwise both
      // stay), keeping both is never wrong; a decided drop is wrong when it drops the copy the
      // label says is better.
      if (shared && !together) {
        got = 'same file';
        ok = true;
      } else {
        const t = together!;
        const best = t.ra === t.rb ? 'any' : t.ra < t.rb ? 'a' : 'b';
        if (t.outcome === 'review') {
          got = `both stay (best guess ${best})`;
          ok = true;
        } else {
          got = `${best} stays (proven)`;
          ok = want.best === 'any' || want.best === 'review' || want.best === best;
        }
      }
      if (ok) bestCorrect++;
    }
    results.push({ n: p.n, kind: p.kind, expected: wantText, got, ok, note: p.note });
  }
  const misses = results.filter((r) => !r.ok);
  return {
    passed: results.length > 0 && misses.length === 0,
    checked: results.length,
    correct: results.length - misses.length,
    sameChecked,
    sameCorrect,
    bestChecked,
    bestCorrect,
    skipped,
    misses,
    results,
    error: null,
  };
}

/** Reads the labels' JSON text; an error message instead when it isn't usable. */
export function parseLabels(text: string): { labels: LabelsFile | null; error: string | null } {
  try {
    const j = JSON.parse(text) as { pairs?: unknown };
    if (!Array.isArray(j.pairs)) return { labels: null, error: 'The file has no "pairs" list' };
    const pairs = (j.pairs as Record<string, unknown>[]).filter(
      (p) => typeof p.fa === 'string' && typeof p.fb === 'string',
    ) as unknown as LabeledPair[];
    return { labels: { pairs }, error: null };
  } catch (err) {
    return { labels: null, error: `The file can’t be read: ${(err as Error).message}` };
  }
}
