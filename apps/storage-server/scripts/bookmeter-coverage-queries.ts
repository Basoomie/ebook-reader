/**
 * More Bookmeter coverage, step 1: the second search's query forms for the books whose search
 * had no results (prints them; fetches nothing). Q0 is today's query (queryTitle), Q1 the title
 * without its subtitle, Q2 Q1 with the first author.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-queries.ts --in books-full.jsonl
 *     [--labeled] [--out queries.json]
 */
import fs from 'fs';
import { queryTitle } from '../src/cleanup/stage4/pick';
import { mainTitle, type BookRow } from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const rows = fs
  .readFileSync(arg('in')!, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BookRow)
  .filter((b) => b.searched && !b.hits.length && (!process.argv.includes('--labeled') || b.gid));
let same = 0;
const out = rows.map((b) => {
  const q0 = queryTitle(b.opfTitle || b.calTitle);
  const q1 = mainTitle(q0);
  const au = (b.au[0] ?? '').replace(/\s/gu, '');
  if (q1 === q0) same++;
  return { cid: b.cid, gid: b.gid, kind: b.kind, q0, q1, q2: au ? `${q1} ${au}` : null };
});
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(out, null, 1));
else console.log(JSON.stringify(out, null, 1));
console.error(`${rows.length} books; Q1 equals today's query for ${same}`);
