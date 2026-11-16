/**
 * WP20c: the Preview report of stage 3 from a copy of the live cleanup.db (read-only).
 *
 *   node -r ts-node/register/transpile-only scripts/stage3-report.ts <cleanup.db copy> [out.json]
 *
 * Prints, and writes as JSON: candidate pairs; counts per class and rule; copies to remove;
 * the special-edition measure (every duplicate/superset pair with extra text inside the
 * chapters, sorted, with the inspected anchors from the gate) and a proposed pair of limits;
 * 30 random pairs per class; the omnibus files; seconds per book per phase and the total.
 * Titles come from the stage's own evidence (no metadata.db needed).
 */
import Database from 'better-sqlite3';
import fs from 'fs';

interface Pair {
  id: number;
  a_id: number;
  b_id: number;
  source: string;
  a_in_b: number | null;
  b_in_a: number | null;
  est_a_in_b: number | null;
  est_b_in_a: number | null;
  class: string | null;
  rule: string | null;
  reason: string | null;
  keep_id: number | null;
  spread_json: string | null;
  best_json: string | null;
  error: string | null;
}

interface Extra {
  interleavedShare: number;
  interleavedRuns: number;
  chaptersTouched: number;
  extraChars: number;
}

export function stage3Report(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const stage = db
      .prepare('SELECT progress_json, mode, state FROM stages WHERE stage = 3')
      .get() as {
      progress_json: string;
      mode: string;
      state: string;
    };
    const p = JSON.parse(stage.progress_json) as Record<string, unknown> & {
      analysisId: string;
      libraryId: string;
      times: Record<string, { ms: number; items?: number }>;
      textRead: number;
      textDone: number;
      textReadMs: number;
      gate: Record<string, unknown> | null;
    };
    const pairs = db
      .prepare('SELECT * FROM content_pairs WHERE analysis_id = ?')
      .all(p.analysisId) as Pair[];
    const facts = new Map(
      (
        db
          .prepare(
            'SELECT calibre_id, file_title, chars, kind, kind_by, kind_marker, image_only, error FROM text_facts WHERE library_id = ?',
          )
          .all(p.libraryId) as {
          calibre_id: number;
          file_title: string | null;
          chars: number | null;
          kind: string | null;
          kind_by: string | null;
          kind_marker: string | null;
          image_only: number;
          error: string | null;
        }[]
      ).map((f) => [f.calibre_id, f]),
    );
    const title = (id: number) => facts.get(id)?.file_title ?? `#${id}`;
    const byClass: Record<string, number> = {};
    const byRule: Record<string, number> = {};
    for (const x of pairs) {
      const c = x.class ?? (x.error ? 'error' : 'pending');
      byClass[c] = (byClass[c] ?? 0) + 1;
      const r = `${c}/${x.rule ?? '-'}`;
      byRule[r] = (byRule[r] ?? 0) + 1;
    }
    const removals = db
      .prepare(
        `SELECT calibre_id, evidence_json FROM proposed_changes WHERE stage = 3 AND analysis_id = ? AND class = 'auto'`,
      )
      .all(p.analysisId) as { calibre_id: number; evidence_json: string }[];

    // The special-edition measure: every same-text / superset / spread pair with extra text
    // inside the chapters, largest share first.
    const spread = pairs
      .filter((x) => x.spread_json && x.a_in_b !== null)
      .map((x) => {
        const sp = JSON.parse(x.spread_json!) as { a: Extra | null; b: Extra | null };
        const side = (sp.a?.interleavedShare ?? 0) >= (sp.b?.interleavedShare ?? 0) ? 'a' : 'b';
        const e = sp[side];
        return {
          pair: x.id,
          class: x.class,
          rule: x.rule,
          richer: side === 'a' ? x.a_id : x.b_id,
          other: side === 'a' ? x.b_id : x.a_id,
          titles: [title(x.a_id), title(x.b_id)],
          kinds: [facts.get(x.a_id)?.kind, facts.get(x.b_id)?.kind],
          aInB: x.a_in_b,
          bInA: x.b_in_a,
          share: e?.interleavedShare ?? 0,
          runs: e?.interleavedRuns ?? 0,
          chapters: e?.chaptersTouched ?? 0,
        };
      })
      .filter(
        (s) =>
          s.runs > 0 && ['duplicate', 'superset', 'review', 'keep_both'].includes(s.class ?? ''),
      )
      .filter((s) => s.rule !== 'partial')
      .sort((a, b) => b.share - a.share);
    const special = spread.filter((s) => s.kinds.includes('special'));

    const sample = (cls: string) =>
      db
        .prepare(
          `SELECT id, a_id, b_id, a_in_b, b_in_a, rule, reason, keep_id FROM content_pairs
           WHERE analysis_id = ? AND class = ? ORDER BY RANDOM() LIMIT 30`,
        )
        .all(p.analysisId, cls)
        .map((r) => {
          const x = r as Pair;
          return {
            ...x,
            titles: [title(x.a_id), title(x.b_id)],
            kinds: [facts.get(x.a_id)?.kind, facts.get(x.b_id)?.kind],
          };
        });
    const examples = Object.fromEntries(
      ['duplicate', 'superset', 'review', 'never', 'different', 'keep_both'].map((c) => [
        c,
        sample(c),
      ]),
    );
    const omnibus = [...facts.values()]
      .filter((f) => f.kind === 'omnibus')
      .map((f) => ({
        id: f.calibre_id,
        title: f.file_title,
        by: f.kind_by,
        marker: f.kind_marker,
        chars: f.chars,
      }));
    const phaseMs = Object.fromEntries(Object.entries(p.times ?? {}).map(([k, v]) => [k, v.ms]));
    const totalMs = Object.values(phaseMs).reduce((a, b) => a + b, 0);
    return {
      analysisId: p.analysisId,
      mode: stage.mode,
      state: stage.state,
      books: {
        read: p.textDone,
        readNow: p.textRead,
        errors: p.textErrors,
        imageOnly: p.imageOnly,
      },
      candidates: p.candidates,
      indexStats: p.indexStats,
      byClass,
      byRule,
      toRemove: removals.length,
      review: p.review,
      sets: { all: p.sets, withoutKeeper: p.setsWithoutKeeper },
      omnibusByText: p.omnibusByText,
      omnibus,
      spread: { all: spread.length, special: special.length, pairs: spread },
      examples,
      timing: {
        phaseMs,
        phaseItems: Object.fromEntries(
          Object.entries(p.times ?? {}).map(([k, v]) => [k, v.items ?? 0]),
        ) as Record<string, number>,
        totalMs,
        secondsPerBookWall: p.textRead ? (phaseMs.text ?? 0) / 1000 / p.textRead : null,
        secondsPerBookRead: p.textRead ? p.textReadMs / 1000 / p.textRead : null,
      },
      gate: p.gate,
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [file, out] = process.argv.slice(2);
  if (!file) {
    console.error('usage: stage3-report.ts <cleanup.db copy> [out.json]');
    process.exit(2);
  }
  const r = stage3Report(file);
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(
    `Books read: ${r.books.read} (${r.books.errors} unreadable, ${r.books.imageOnly} picture books)`,
  );
  console.log(`Candidate pairs: ${r.candidates}`);
  console.log(`Per class: ${JSON.stringify(r.byClass)}`);
  console.log(`Copies to remove: ${r.toRemove}; pairs for review: ${r.review}`);
  console.log(`Omnibus files: ${r.omnibus.length} (${r.omnibusByText} by their text)`);
  console.log(
    `Extra text inside the chapters: ${r.spread.all} pairs (${r.spread.special} with a special edition); top 10 shares: ${r.spread.pairs
      .slice(0, 10)
      .map((s) => (100 * s.share).toFixed(1))
      .join(', ')}`,
  );
  console.log(
    `Time: ${(r.timing.totalMs / 3_600_000).toFixed(2)} h in all; ${r.timing.secondsPerBookWall?.toFixed(3)} s per book (wall), ${r.timing.secondsPerBookRead?.toFixed(3)} s per book in one reader process`,
  );
  for (const [k, ms] of Object.entries(r.timing.phaseMs)) {
    const n = r.timing.phaseItems[k] ?? 0;
    console.log(
      `  ${k}: ${(ms / 1000).toFixed(1)} s, ${n} items${n ? `, ${(ms / 1000 / n).toFixed(3)} s each` : ''}`,
    );
  }
}
