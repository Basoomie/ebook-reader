/** WP20d: why BookWalker standing in loses illustrators, and why it misses books (diagnosis). */
import fs from 'fs';
import path from 'path';
import { clean, type RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { fieldRight, type Stage4Gold } from '../src/cleanup/stage4/score';
import { N } from '../src/cleanup/title-rules';

const refDir = process.argv[2];
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
// Re-use the measuring script's helpers by requiring it as a module would run it; copy the two needed.
const src = fs.readFileSync(path.join(__dirname, 'measure-stage4-bw.ts'), 'utf8');
void src;
type Rec = RefRecord & {
  amazon?: Record<string, unknown>;
  bookwalker?: { detail?: { title?: string; keywords?: string } };
};
let shownIl = 0;
let shownId = 0;
for (const [id, g] of Object.entries(gold)) {
  const r = JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as Rec;
  const d = r.bookwalker?.detail;
  if (!d?.title) continue;
  const kw = (d.keywords || '').split(',');
  const label = kw.length >= 5 ? kw[kw.length - 3] : '';
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  const a = clean(ft, label ? [label] : [], [ft, d.title], [null]);
  const b = clean(d.title, label ? [label] : [], [ft, d.title], [null]);
  if (N(a) !== N(b) && shownId < 25) {
    console.log(`MISS ${id}: file "${a}" | bw "${b}" | people ${kw.slice(2, -3).join('/')}`);
    shownId++;
  }
  const today = decideStage4(structuredClone(r) as RefRecord);
  if (today.auto.il && fieldRight('il', today.values.il, g) === true && shownIl < 25) {
    const ap = (r.amazon as { product?: { authors?: { name: string; role: string }[] } })?.product;
    console.log(
      `IL ${id}: gold ${JSON.stringify(g.il)} | amazon ${JSON.stringify(ap?.authors?.map((x) => x.name + ':' + x.role))} | bw people ${kw.slice(2, -3).join('/')} | file ${JSON.stringify(r.file.creators)}`,
    );
    shownIl++;
  }
}
