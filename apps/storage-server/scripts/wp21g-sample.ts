/**
 * WP21g stop 1: the gate's labeled sample. A seeded draw (mulberry32) over every kind of
 * recording, and for each one an evidence pack to label from by hand: the recording's own facts
 * (stage 5's title, authors and series, its store record, its torrent file) and every plausible
 * Calibre book (one of its authors, or a title that shares most of its words), WITHOUT the pairing's
 * verdict (the labels are made blind; the gate scores them afterwards).
 *
 *   npx vite-node scripts/wp21g-sample.ts -- --cleanup <cleanup.db copy> --calibre <snapshot copy>
 *     --out <dir> [--seed 20261123]
 * Writes <out>/sample.json (the drawn recordings) and <out>/packs.txt (the evidence to read).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { readEbookSnapshot } from '../src/cleanup/audio/ebook-snapshot';
import { audioFactsAll, seriesOpen } from '../src/cleanup/audio/stage8-ebooks';
import { bareTitle, partOf, titleForm } from '../src/cleanup/audio/ebook-pair';
import { personKey } from '../src/cleanup/audio/online-names';
import { sim } from '../src/cleanup/stage4/pick';
import { SIDE } from '../src/cleanup/stage4/series-order';
import { nfkc } from '../src/cleanup/title-rules';
import type { UnitInputs } from '../src/cleanup/audio/stage4-online';

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`--${name} is required`);
}
let seed = Number(arg('seed', '20261123'));
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const cl = new Database(arg('cleanup'), { readonly: true, fileMustExist: true });
const snap = readEbookSnapshot(arg('calibre'));
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const facts = audioFactsAll(cl);
const s5 = JSON.parse(
  (
    cl.prepare('SELECT progress_json FROM audio_stages WHERE stage = 5').get() as {
      progress_json: string;
    }
  ).progress_json,
) as { stage4Id: string };
const torrentOf = new Map<string, string>();
for (const r of cl
  .prepare('SELECT unit_key, inputs_json FROM audio_online_units WHERE analysis_id = ?')
  .all(s5.stage4Id) as {
  unit_key: string;
  inputs_json: string;
}[]) {
  const inp = JSON.parse(r.inputs_json) as UnitInputs;
  const f = inp.opening.find((o) => o.root === 'torrents') ?? null;
  const p = inp.paths.find((x) => x.startsWith('torrents:'));
  torrentOf.set(r.unit_key, f?.rel ?? (p ? p.slice('torrents:'.length) : ''));
}
const seriesRow = new Map<string, { value: unknown; source: string; rules: unknown }>();
for (const r of cl
  .prepare(
    `SELECT item_key, value_json, source, rules_json FROM ai_values WHERE stage = 'audio5' AND field = 'series'`,
  )
  .all() as { item_key: string; value_json: string; source: string; rules_json: string | null }[])
  seriesRow.set(r.item_key, {
    value: JSON.parse(r.value_json),
    source: r.source,
    rules: r.rules_json ? JSON.parse(r.rules_json) : null,
  });

const QUOTA: Record<string, number> = {
  drama: 20,
  split: 20,
  side: 20,
  fill: 25,
  no_record: 25,
  kikubon: 25,
  audiobookjp: 35,
  audible_series: 50,
  audible_standalone: 30,
};
function stratum(f: (typeof facts)[number]): string | null {
  if (f.kind === 'ai' || f.kind === 'radio') return null;
  const t = nfkc(f.title);
  if (f.drama || /ドラマ\s*CD/i.test(t)) return 'drama';
  const labels = (f.series ?? []).map((s) => s.label ?? '').join(' ');
  if (partOf(f.title) || /前編|後編|[・\s]上|[・\s]下/.test(labels)) return 'split';
  if (
    SIDE.test(t) ||
    (f.series ?? []).some((s) => s.position !== null && !Number.isInteger(s.position))
  )
    return 'side';
  // The fill case: a series stage 5 doesn't know, or the models' guess (not an empty one).
  const sr = seriesRow.get(f.unitKey);
  if (
    sr &&
    seriesOpen(sr as never) &&
    (sr.value === null || (Array.isArray(sr.value) && sr.value.length > 0))
  )
    return 'fill';
  if (f.source === 'no_record') return 'no_record';
  if (f.source === 'kikubon') return 'kikubon';
  if (f.source === 'audiobookjp') return 'audiobookjp';
  if (f.source === 'audible')
    return (f.series ?? []).length ? 'audible_series' : 'audible_standalone';
  return null;
}
const pools = new Map<string, typeof facts>();
for (const f of facts) {
  const s = stratum(f);
  if (!s || !torrentOf.get(f.unitKey)) continue;
  const l = pools.get(s) ?? [];
  l.push(f);
  pools.set(s, l);
}
const drawn: { id: string; kind: string; stratum: string; unit: string; torrent: string }[] = [];
let n = 0;
for (const [s, q] of Object.entries(QUOTA)) {
  const pool = (pools.get(s) ?? []).map((f) => ({ f, k: rnd() })).sort((a, b) => a.k - b.k);
  for (const { f } of pool.slice(0, q))
    drawn.push({
      id: `B${String(++n).padStart(3, '0')}`,
      kind: f.source,
      stratum: s,
      unit: f.unitKey,
      torrent: torrentOf.get(f.unitKey)!,
    });
}
console.log(Object.fromEntries([...pools].map(([k, v]) => [k, v.length])));
console.log(`drawn ${drawn.length}`);

// The evidence packs: every Calibre book by one of the authors, plus books whose title shares
// most of the recording's (any author), most similar first.
const books = [...snap.books.values()];
const byAuthor = new Map<string, typeof books>();
for (const b of books)
  for (const a of new Set(b.authors.map(personKey))) {
    if (!a) continue;
    const l = byAuthor.get(a) ?? [];
    l.push(b);
    byAuthor.set(a, l);
  }
const factOf = new Map(facts.map((f) => [f.unitKey, f]));
const lines: string[] = [];
for (const d of drawn) {
  const f = factOf.get(d.unit)!;
  const sr = seriesRow.get(d.unit);
  lines.push(
    `\n## ${d.id} [${d.stratum} / ${d.kind}] ${f.title}`,
    `   authors: ${f.authors.join(', ') || '(none)'} · series: ${JSON.stringify(f.series)} (${sr?.source ?? '-'})`,
    `   store title: ${f.otherTitles.join(' | ') || '-'} · torrent: ${d.torrent}`,
  );
  const ab = bareTitle(f.title);
  const cand = new Map<number, number>();
  for (const a of f.authors) for (const b of byAuthor.get(personKey(a)) ?? []) cand.set(b.id, 0);
  for (const b of books) {
    const bb = bareTitle(b.title);
    if (!bb || !ab) continue;
    const sc = Math.max(sim(ab, bb), sim(bb, ab));
    if (sc >= 0.6 || (ab.length >= 3 && (bb.includes(ab) || (ab.includes(bb) && bb.length >= 3))))
      cand.set(b.id, sc);
  }
  const ranked = [...cand.keys()]
    .map((id) => snap.books.get(id)!)
    .map((b) => ({ b, sc: Math.max(sim(ab, bareTitle(b.title)), sim(bareTitle(b.title), ab)) }))
    .sort((x, y) => y.sc - x.sc)
    .slice(0, 40);
  for (const { b, sc } of ranked)
    lines.push(
      `   [${b.id}] ${b.title} | ${b.authors.join(', ')} | ${b.series ? `${b.series} #${b.index}` : '-'} | ${b.tags.filter((t) => /小説|ライトノベル|ノンフィクション|マンガ|画像のみ/.test(t)).join(',')} (${sc.toFixed(2)})`,
    );
  if (!ranked.length) lines.push('   (no Calibre book by these authors or with a similar title)');
}
fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(drawn, null, 1));
fs.writeFileSync(path.join(out, 'packs.txt'), lines.join('\n') + '\n');
console.log(`wrote ${path.join(out, 'packs.txt')}`);
void titleForm;
