/**
 * WP20d: would BookWalker settle more than light novels? On a cleanup.db snapshot, for every book
 * that has both Amazon's product page and BookWalker's book page, stage 4's rules decide twice:
 * with Amazon (as the live run did) and with BookWalker standing in (bw-standin.ts). Per
 * BookWalker category: how often the stand-in would settle every field, and of those, how often
 * every value equals the Amazon-based one (Amazon's values were measured accurate on the labeled
 * books; agreement with them is the proxy here, not ground truth). Reads only.
 *
 *   npx tsx scripts/measure-stage4-bw-agree.ts <cleanup.db snapshot> <calibre metadata.db copy>
 */
import Database from 'better-sqlite3';
import { gunzipSync } from 'zlib';
import { bwAsAmazon, bwIdentified } from '../src/cleanup/stage4/bw-standin';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';

const [dbPath, calPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });
const cal = new Database(calPath, { readonly: true });
const calBook = cal.prepare(
  `SELECT b.title, (SELECT group_concat(a.name, '&') FROM books_authors_link l JOIN authors a ON a.id = l.author
     WHERE l.book = b.id) AS authors FROM books b WHERE b.uuid = ?`,
);
const refOf = db.prepare(
  `SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = 'reffile'`,
);
const F = ['t', 'au', 'il', 'se', 'ix', 'fmt'] as const;
type Row = {
  n: number;
  amazonAll: number;
  bwAll: number;
  bothAll: number;
  agreeAll: number;
  perField: Record<string, number>;
};
const by = new Map<string, Row>();
const rows = db
  .prepare(`SELECT library_id, calibre_uuid, data FROM evidence_records WHERE kind = 'online'`)
  .iterate() as Iterable<{ library_id: string; calibre_uuid: string; data: Buffer }>;
for (const r of rows) {
  let ev: any;
  try {
    ev = JSON.parse(gunzipSync(r.data).toString());
  } catch {
    continue;
  }
  if (!ev.amazon?.product || !ev.bookwalker?.detail?.title || ev.amazon?.standin) continue;
  const refRow = refOf.get(r.library_id, r.calibre_uuid) as { data: Buffer } | undefined;
  const ref = refRow ? JSON.parse(gunzipSync(refRow.data).toString()) : null;
  if (!ref?.file) continue;
  const c = calBook.get(r.calibre_uuid) as { title: string; authors: string } | undefined;
  const base = {
    calibre: {
      cal_title: c?.title ?? '',
      cal_authors: c?.authors ?? '',
      cal_tags: '',
      has_cover: 1,
    },
    file: ref.file,
    amazon: { ...ev.amazon },
    ranobedb: { ...ev.ranobedb },
    bookwalker: { ...ev.bookwalker },
  } as unknown as RefRecord;
  if (!bwIdentified(base)) continue;
  const kw = (ev.bookwalker.detail.keywords || '').split(',');
  const cat = kw.length >= 3 ? kw[kw.length - 2] : '?';
  const a = decideStage4(base);
  const b = decideStage4({ ...base, amazon: bwAsAmazon(base) ?? {} } as RefRecord);
  const row = by.get(cat) ?? {
    n: 0,
    amazonAll: 0,
    bwAll: 0,
    bothAll: 0,
    agreeAll: 0,
    perField: {},
  };
  row.n++;
  const aAll = F.every((f) => a.auto[f]);
  const bAll = F.every((f) => b.auto[f]);
  if (aAll) row.amazonAll++;
  if (bAll) row.bwAll++;
  if (aAll && bAll) {
    row.bothAll++;
    const same = (f: (typeof F)[number]) =>
      JSON.stringify((a.values as any)[f]) === JSON.stringify((b.values as any)[f]);
    if (F.every(same)) row.agreeAll++;
    for (const f of F) if (!same(f)) row.perField[f] = (row.perField[f] ?? 0) + 1;
  }
  by.set(cat, row);
}
console.log(
  'BookWalker category: books with both | settled with Amazon | settled with BookWalker | both settle | of those, every value equal',
);
for (const [cat, r] of [...by].sort((x, y) => y[1].n - x[1].n))
  console.log(
    `${cat.padEnd(10)} ${String(r.n).padStart(5)} | ${String(r.amazonAll).padStart(5)} | ${String(r.bwAll).padStart(5)} | ${String(r.bothAll).padStart(5)} | ${String(r.agreeAll).padStart(5)} (${r.bothAll ? ((100 * r.agreeAll) / r.bothAll).toFixed(1) : '-'} %) differ: ${JSON.stringify(r.perField)}`,
  );
