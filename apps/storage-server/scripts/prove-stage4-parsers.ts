/**
 * WP20d proof: the stage-4 parsers and pickers reproduce the reference run (ref4.py).
 *
 *   node -r ts-node/register/transpile-only scripts/prove-stage4-parsers.ts <records dir> <raw dir> [log.jsonl]
 *
 * records: the 800 labeled books' evidence (docs/design/cleanup-reference/records); raw: the
 * reference run's cached pages (source-probe/out3/raw, <id>_<site>_<name>.txt). For every page a
 * record was built from, the TS parser's output must equal the stored record field for field,
 * and every pick must equal the stored pick. Reads only.
 */
import fs from 'fs';
import path from 'path';
import {
  jload,
  parseAmazonDp,
  parseAmazonSearch,
  parseBwDetail,
  parseBwList,
  rdbAuthorMatch,
  rdbBook,
  rdbCandidates,
  rdbSeries,
} from '../src/cleanup/stage4/parse';
import { pickByVolume, queryTitle, sim } from '../src/cleanup/stage4/pick';
import { classifyResponse } from '../src/cleanup/stage4/challenge';

const [recordsDir, rawDir, logFile] = process.argv.slice(2);
if (!recordsDir || !rawDir) {
  console.error('usage: prove-stage4-parsers.ts <records dir> <raw dir> [log.jsonl]');
  process.exit(2);
}

type Obj = Record<string, any>;
const tally = new Map<string, { ok: number; bad: number; examples: string[] }>();
function check(name: string, id: string, got: unknown, want: unknown): void {
  const t = tally.get(name) ?? { ok: 0, bad: 0, examples: [] };
  const a = String(JSON.stringify(got));
  const b = String(JSON.stringify(want));
  if (a === b) t.ok += 1;
  else {
    t.bad += 1;
    if (t.examples.length < 4)
      t.examples.push(`${id}: got ${a.slice(0, 300)}\n      want ${b.slice(0, 300)}`);
  }
  tally.set(name, t);
}
const raw = (id: string, site: string, name: string): Buffer | null => {
  const f = path.join(rawDir, `${id}_${site}_${name}.txt`);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
};

for (const file of fs.readdirSync(recordsDir).filter((f) => f.endsWith('.json'))) {
  const r = JSON.parse(fs.readFileSync(path.join(recordsDir, file), 'utf8')) as Obj;
  const id = String(r.id);
  const f = (r.file ?? {}) as Obj;
  const q = (r.query ?? {}) as Obj;
  if (!f.error) {
    check('query title', id, queryTitle(f.opf_title || r.calibre.cal_title), q.title);
  }
  const textBook = q.text_book !== false;
  // Amazon
  const amz = (r.amazon ?? {}) as Obj;
  const search = raw(id, 'amazon', 'search');
  if (amz.search_candidates && search) {
    const cands = parseAmazonSearch(search);
    check('amazon search candidates', id, cands, amz.search_candidates);
  }
  if (amz.picked_from_search && amz.search_candidates && amz.product) {
    const pick = pickByVolume(
      q.title,
      (amz.search_candidates as [string, string][]).slice(0, 6),
      textBook,
    );
    check('amazon search pick', id, pick?.[0] ?? null, amz.product.asin);
  }
  const dp = raw(id, 'amazon', 'dp');
  if (amz.product && dp) check('amazon product', id, parseAmazonDp(dp), amz.product);
  // RanobeDB
  const rdb = (r.ranobedb ?? {}) as Obj;
  const rs = raw(id, 'ranobedb', 'search');
  if (rdb.search_candidates && rs) {
    check('ranobedb candidates', id, rdbCandidates(jload(rs)), rdb.search_candidates);
  }
  if (rdb.search_candidates) {
    const pick = pickByVolume(q.title, rdb.search_candidates as [unknown, string][], textBook);
    const accepted = pick && sim(q.title, pick[1]) >= 0.7 ? pick[0] : null;
    check('ranobedb pick', id, accepted, rdb.book ? rdb.book.id : null);
  }
  const rb = raw(id, 'ranobedb', 'book');
  if (rdb.book && rb) {
    const book = rdbBook(jload(rb));
    check('ranobedb book', id, book, rdb.book);
    check('ranobedb author match', id, rdbAuthorMatch(book, q.author ?? ''), rdb.author_match);
  }
  const rser = raw(id, 'ranobedb', 'series');
  if (rdb.series && rser) check('ranobedb series', id, rdbSeries(jload(rser)), rdb.series);
  // BookWalker
  const bw = (r.bookwalker ?? {}) as Obj;
  const bs = raw(id, 'bookwalker', 'search');
  if (bw.search_candidates && bs) {
    check('bookwalker candidates', id, parseBwList(bs).slice(0, 8), bw.search_candidates);
  }
  const bser = raw(id, 'bookwalker', 'series');
  if (bw.series_candidates && bser) {
    const vols = parseBwList(bser).filter((v) => v[0].includes('/de'));
    check('bookwalker series list', id, vols.slice(0, 40), bw.series_candidates);
  }
  if (bw.search_candidates && (bw.detail || bw.series_candidates)) {
    let pick = pickByVolume(
      q.title,
      (bw.search_candidates as [string, string][]).slice(0, 8),
      textBook,
    );
    if (pick && pick[0].includes('/series/') && bw.series_candidates) {
      pick = pickByVolume(q.title, bw.series_candidates as [string, string][], textBook);
    }
    check(
      'bookwalker pick',
      id,
      pick && pick[0].includes('/de') ? pick[0] : null,
      bw.detail?.url ?? null,
    );
  }
  const bd = raw(id, 'bookwalker', 'detail');
  if (bw.detail && bd)
    check('bookwalker detail', id, { ...parseBwDetail(bd), url: bw.detail.url }, bw.detail);
}

for (const [name, t] of tally) {
  console.log(`${t.bad === 0 ? 'OK  ' : 'DIFF'} ${name}: ${t.ok} equal, ${t.bad} differ`);
  for (const e of t.examples) console.log(`    ${e}`);
}

// Challenge pages: every cached Amazon page with its logged status.
if (logFile) {
  const last = new Map<string, Obj>();
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Obj;
    if (e.status !== undefined) last.set(`${e.id}_${e.src}_${e.name}`, e);
  }
  const counts = new Map<string, number>();
  let total = 0;
  for (const fn of fs.readdirSync(rawDir)) {
    const m = /^(.+)_(amazon|bookwalker|ranobedb)_(\w+)\.txt$/.exec(fn);
    if (!m) continue;
    const e = last.get(`${m[1]}_${m[2]}_${m[3]}`);
    const status = typeof e?.status === 'number' ? e.status : 200;
    const kind = classifyResponse(
      m[2] === 'amazon' ? 'amazon' : m[2],
      status,
      fs.readFileSync(path.join(rawDir, fn)),
    );
    const key = `${m[2]} ${m[3]} status ${status} -> ${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  console.log(`\nResponse classes of ${total} cached pages:`);
  for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
}
