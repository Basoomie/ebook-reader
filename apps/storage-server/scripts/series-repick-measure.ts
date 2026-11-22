/**
 * Series-order follow-up, stop 1 tool: which picks the new picker (pick.ts pickByVolume) changes,
 * old against new on the same stored search results, in the analysis' own flow (nothing is
 * fetched or written). Needs main's pick.ts copied beside it as pick-main-copy.ts.
 *
 *   npx ts-node --transpile-only scripts/series-repick-measure.ts --db <copy/cleanup.db> [--out changes.json]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import * as now from '../src/cleanup/stage4/pick';
import * as before from '../src/cleanup/stage4/pick-main-copy';
import type { OnlineEvidence } from '../src/cleanup/stage4/analysis';

type P = typeof now.pickByVolume;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const labeled = new Set(
  (
    db.prepare('SELECT calibre_uuid FROM stage4_books WHERE labeled = 1').all() as {
      calibre_uuid: string;
    }[]
  ).map((r) => r.calibre_uuid),
);

/** The analysis' picks for one book with a given picker. */
function picks(ev: OnlineEvidence, pick: P) {
  const q = ev.query.title;
  const tb = ev.query.text_book;
  const amazon =
    ev.amazon.picked_from_search && ev.amazon.search_candidates
      ? (pick(q, ev.amazon.search_candidates.slice(0, 6), tb) ?? null)
      : null;
  const hits = ev.ranobedb.search_candidates ?? [];
  const r = hits.length ? pick(q, hits, tb) : null;
  const ranobedb = r && now.sim(q, r[1]) >= 0.7 ? r : null;
  let bookwalker: [string, string] | null = null;
  const s = ev.bookwalker.search_candidates?.length
    ? pick(q, ev.bookwalker.search_candidates.slice(0, 8), tb)
    : null;
  if (s && s[0].includes('/series/')) {
    // The series list the analysis fetched for its pick (only when the old pick was this series).
    const vols = ev.bookwalker.series_candidates ?? [];
    bookwalker = vols.length ? (pick(q, vols, tb) ?? null) : ['(series list not fetched)', s[0]];
  } else if (s && s[0].includes('/de')) bookwalker = s;
  return { amazon, ranobedb, bookwalker };
}

const changes: Record<string, unknown>[] = [];
const count = { amazon: 0, ranobedb: 0, bookwalker: 0, books: 0, labeled: 0 };
const it = db
  .prepare(`SELECT calibre_uuid, data FROM evidence_records WHERE kind = 'online'`)
  .iterate() as Iterable<{ calibre_uuid: string; data: Buffer }>;
for (const r of it) {
  const ev = JSON.parse(gunzipSync(r.data).toString('utf8')) as OnlineEvidence;
  const a = picks(ev, before.pickByVolume as P);
  const b = picks(ev, now.pickByVolume);
  const ch: Record<string, unknown> = {};
  for (const k of ['amazon', 'ranobedb', 'bookwalker'] as const) {
    const x = a[k];
    const y = b[k];
    if (String(x?.[0] ?? '') !== String(y?.[0] ?? '')) {
      count[k]++;
      ch[k] = { from: x, to: y };
    }
  }
  if (Object.keys(ch).length) {
    count.books++;
    if (labeled.has(r.calibre_uuid)) count.labeled++;
    changes.push({
      uuid: r.calibre_uuid,
      query: ev.query.title,
      labeled: labeled.has(r.calibre_uuid),
      ...ch,
    });
  }
}
console.log(JSON.stringify(count));
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(changes, null, 1));
