/** WP20d: labeled light novels BookWalker identifies but doesn't settle: why (diagnosis, reads only). */
import fs from 'fs';
import path from 'path';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import * as sw from '../src/cleanup/stage4/bw-standin';
import type { Stage4Gold } from '../src/cleanup/stage4/score';

const refDir = process.argv[2];
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
const out: Record<string, string[]> = {};
for (const [id, g] of Object.entries(gold)) {
  if (g.fmt !== 'light novel') continue;
  const r = JSON.parse(
    fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8'),
  ) as RefRecord & {
    bookwalker?: {
      detail?: { title?: string; keywords?: string };
      series_candidates?: [string, string][];
    };
  };
  if (!sw.bwIdentified(r) || sw.bwSettles(r)) continue;
  const x = { ...r, amazon: sw.bwAsAmazon(r) ?? {} } as RefRecord;
  const d = decideStage4(x);
  const un = (['t', 'au', 'il', 'se', 'ix', 'fmt'] as const).filter((f) => !d.auto[f]);
  const k = (sw.bwLightNovel(r) ? '' : 'not LN/numbered no list: ') + un.join(',');
  const kw = (r.bookwalker?.detail?.keywords || '').split(',');
  const vols = (r.bookwalker?.series_candidates || []).map((c) => c[1]);
  (out[k] ??= []).push(
    `${id} "${String(r.file.opf_title).slice(0, 40)}" | gold se ${JSON.stringify(g.se)} ix ${g.ix} il ${JSON.stringify(g.il)} | stand-in series ${JSON.stringify((x.amazon as { product?: { series?: string } }).product?.series)} | kana ${kw[1]} | people ${kw.slice(2, -3).join('/')} | vols ${vols.length} e.g. ${vols.slice(0, 2).join(' / ').slice(0, 60)} | values se ${JSON.stringify(d.values.se)} ix ${d.values.ix} il ${JSON.stringify(d.values.il)}`,
  );
}
for (const [k, v] of Object.entries(out).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${v.length} unsettled: ${k}`);
  for (const l of v.slice(0, 6)) console.log('  ' + l);
}
