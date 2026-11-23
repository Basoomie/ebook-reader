/**
 * More Bookmeter coverage, step 1: reads the second search's answers (the probe's output) and
 * runs today's acceptance and the candidate rules on them, for the labeled books. Reads only.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-probe-read.ts --answers out.json
 *     --in books-full.jsonl --gold gold800.json
 */
import fs from 'fs';
import { parseBookmeterSearch } from '../src/cleanup/stage4/store-links';
import {
  acceptWith,
  judge,
  makeRules,
  parseFullTitles,
  type BookRow,
  type Gold,
} from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const answers = JSON.parse(fs.readFileSync(arg('answers')!, 'utf8')) as {
  cid: number;
  form: string;
  status?: number;
  ms?: number;
  body?: string;
  error?: string;
}[];
const books = new Map(
  fs
    .readFileSync(arg('in')!, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BookRow)
    .map((b) => [b.cid, b]),
);
const gold = JSON.parse(fs.readFileSync(arg('gold')!, 'utf8')) as Record<string, Gold>;
const best = makeRules({
  full: true,
  paren: true,
  authSplit: true,
  authDot: true,
  authKanji: true,
  volClean: true,
  volGuard: true,
  comicGuard: true,
});
const base = makeRules({});
for (const a of answers) {
  const b = books.get(a.cid)!;
  const hits0 = a.body ? parseBookmeterSearch(a.body) : [];
  const full = a.body ? parseFullTitles(a.body) : new Map<string, string>();
  const hits = hits0.map((h) => ({
    ...h,
    edOk: true,
    full: full.get(h.id) ?? null,
    edOkFull: true,
  }));
  const row = { ...b, hits };
  const t = acceptWith(base, row);
  const c = acceptWith(best, row);
  const g = b.gid ? gold[b.gid] : null;
  console.log(
    [
      a.cid,
      a.form,
      `HTTP ${a.status ?? a.error} ${a.ms ?? ''} ms`,
      `${hits.length} results`,
      `first: ${hits[0] ? `${hits[0].full ?? hits[0].title} / ${hits[0].authors.join(',')}` : '-'}`,
      `today: ${t ? t.id : '-'}`,
      `candidates: ${c ? `${c.id} ${c.full ?? c.title}` : '-'}${c && g ? ` [${judge(c, g).ok ? 'label ok' : 'label: ' + judge(c, g).why.join('+')}]` : ''}`,
    ].join(' | '),
  );
}
