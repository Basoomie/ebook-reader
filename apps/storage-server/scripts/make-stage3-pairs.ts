/**
 * WP20c: the gate's file of measured duplicate pairs (stage3-pairs.json) from the dup_test of
 * 2026-11-12 (dup_pairs.json + dup/results.jsonl in source-probe on the NAS).
 *
 *   node -r ts-node/register/transpile-only scripts/make-stage3-pairs.ts <dup_pairs.json> <results.jsonl> <out.json>
 *
 * Each pair's expected class is the one the measured containment gives with stage 3's rules
 * (before the spread check), the kinds read from the two Calibre titles of that day. The four
 * editions inspected by hand are anchors for the spread measure. Pairs listed twice in the
 * test (the same two copies) are kept once.
 */
import fs from 'fs';
import { editionKind } from '../src/cleanup/stage3-kinds';
import { classifyPair, DEFAULT_DUPLICATE_SETTINGS } from '../src/cleanup/stage3-rules';

interface DupPair {
  kind: string;
  a: { id: number; title: string };
  b: { id: number; title: string };
}
interface Result {
  key: string;
  kind: string;
  a_id: number;
  b_id: number;
  a_in_b?: number;
  b_in_a?: number;
  error?: string;
}

/** The editions inspected by hand (plan section 5, "Special editions"). */
const ANCHORS: { match: RegExp; anchor: 'spread' | 'not_spread' }[] = [
  { match: /デート・ア・ライブ 十香デッドエンド BOOK☆WALKER special/, anchor: 'spread' },
  { match: /りゅうおうのおしごと！２１/, anchor: 'not_spread' },
  { match: /サイレント・ウィッチ VII 特装版/, anchor: 'not_spread' },
  { match: /この素晴らしい世界に祝福を！ 11/, anchor: 'not_spread' },
];

export function makePairs(pairs: DupPair[], results: Result[]) {
  const titles = new Map<string, [string, string]>();
  for (const p of pairs) titles.set(`${p.a.id}-${p.b.id}`, [p.a.title, p.b.title]);
  const seen = new Set<string>();
  const out = [];
  for (const r of results) {
    if (r.error || r.a_in_b === undefined || r.b_in_a === undefined) continue;
    const [ta, tb] = titles.get(r.key) ?? ['', ''];
    const key = [r.a_id, r.b_id].sort((x, y) => x - y).join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const ka = editionKind([ta]).kind;
    const kb = editionKind([tb]).kind;
    const v = classifyPair(
      { calibreId: r.a_id, kind: ka, chars: 0 },
      { calibreId: r.b_id, kind: kb, chars: 0 },
      { aInB: r.a_in_b, bInA: r.b_in_a, extraA: null, extraB: null },
      DEFAULT_DUPLICATE_SETTINGS,
    );
    const anchor = ANCHORS.find((x) => x.match.test(ta) || x.match.test(tb))?.anchor;
    out.push({
      key,
      group: r.kind,
      a: r.a_id,
      b: r.b_id,
      aTitle: ta,
      bTitle: tb,
      kinds: [ka, kb],
      measured: { aInB: r.a_in_b, bInA: r.b_in_a },
      expected: v.cls,
      rule: v.rule,
      ...(anchor && (v.cls === 'duplicate' || v.cls === 'superset') ? { anchor } : {}),
    });
  }
  return out;
}

if (require.main === module) {
  const [pairsFile, resultsFile, outFile] = process.argv.slice(2);
  const pairs = (JSON.parse(fs.readFileSync(pairsFile, 'utf8')) as { pairs: DupPair[] }).pairs;
  const results = fs
    .readFileSync(resultsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Result);
  const out = makePairs(pairs, results);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { made: new Date().toISOString(), source: 'dup_test 2026-11-12', pairs: out },
      null,
      2,
    ),
  );
  const count: Record<string, number> = {};
  for (const p of out)
    count[`${p.group} → ${p.expected}`] = (count[`${p.group} → ${p.expected}`] ?? 0) + 1;
  console.log(`${out.length} pairs`);
  for (const [k, n] of Object.entries(count).sort()) console.log(`  ${k}: ${n}`);
  console.log(
    `anchors: ${out
      .filter((p) => 'anchor' in p)
      .map((p) => `${p.anchor} ${p.aTitle.slice(0, 20)}`)
      .join(' | ')}`,
  );
}
