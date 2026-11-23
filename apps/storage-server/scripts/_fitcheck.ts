import { readFileSync } from 'fs';
import { fitTitle, UNKNOWN_ID } from '../src/cleanup/title-fit';
const long = JSON.parse(
  readFileSync('C:/Data/Projects/local-ttsu/.tmp-e2e/title-length/long.json', 'utf8'),
);
const chain = JSON.parse(
  readFileSync('C:/Data/Projects/local-ttsu/.tmp-e2e/title-length/shorten-chain.json', 'utf8'),
);
const seen = new Set<string>();
const cnt: Record<string, number> = {};
let diff = 0;
for (const r of long) {
  if (seen.has(`${r.id}:${r.raw}`)) continue;
  seen.add(`${r.id}:${r.raw}`);
  const f = fitTitle(r.raw, {
    calibreId: typeof r.id === 'number' ? r.id : UNKNOWN_ID,
    firstAuthor: r.first,
    authors: [r.first],
  });
  cnt[f.step] = (cnt[f.step] ?? 0) + 1;
  const p = chain.find((c: any) => c.id === r.id && c.before === r.clean);
  if (p && p.after !== f.title && !(p.step.startsWith('review') && f.step === 'author_too_long')) {
    diff++;
    console.log(r.id, f.step, f.rules.join('+'), '\n  proto: ' + p.after + '\n  fit:   ' + f.title);
  }
  if (f.bytesAfter > 255 && f.step !== 'author_too_long') console.log('OVER', r.id, f.bytesAfter);
}
console.log(cnt, 'differ from prototype', diff);
