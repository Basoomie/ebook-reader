/**
 * WP20d: how much stage 4's accuracy depends on Amazon, on the 800 labeled books' stored
 * records. Amazon caps a VPN address at about 200-300 requests an hour, so the library's
 * ~79,000 Amazon requests take ~3 weeks; this measures which Amazon requests the rules need.
 *
 *   node -r ts-node/register/transpile-only scripts/measure-stage4-amazon.ts <cleanup-reference dir>
 *
 * Each variant removes Amazon from some books' records (as if never asked) and runs stage 4's
 * rules: per field, the share applied automatically and the share right when applied, for the
 * 600 (samples A-C) and check D, and the Amazon requests per book the variant needs.
 * Reads only.
 */
import fs from 'fs';
import path from 'path';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import {
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  type ScoredField,
  type Stage4Gold,
} from '../src/cleanup/stage4/score';

const refDir = process.argv[2];
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
const records = Object.fromEntries(
  Object.keys(gold).map((id) => [
    id,
    JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as RefRecord,
  ]),
);

type Rec = RefRecord & {
  amazon?: { product?: unknown; picked_from_search?: unknown; search_candidates?: unknown[] };
  ranobedb?: Record<string, unknown>;
  bookwalker?: Record<string, unknown>;
};
const hasAsin = (r: Rec) => Boolean(r.file?.asin);
const rdbFound = (r: Rec) => Boolean(r.ranobedb && (r.ranobedb.book || r.ranobedb.pick));
const bwFound = (r: Rec) => Boolean(r.bookwalker && (r.bookwalker.detail || r.bookwalker.pick));

/** Which books keep their Amazon data in each variant. */
const VARIANTS: Record<string, (r: Rec) => boolean> = {
  'all Amazon (as measured)': () => true,
  'no Amazon at all': () => false,
  'Amazon only with the file ASIN (no Kindle search)': (r) => hasAsin(r),
  'Amazon only when RanobeDB and BookWalker found nothing': (r) => !rdbFound(r) && !bwFound(r),
  'file ASIN, or nothing else found': (r) => hasAsin(r) || (!rdbFound(r) && !bwFound(r)),
  'file ASIN, or BookWalker found nothing': (r) => hasAsin(r) || !bwFound(r),
};

for (const [name, keep] of Object.entries(VARIANTS)) {
  const groups = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  let dp = 0;
  let search = 0;
  for (const [id, g] of Object.entries(gold)) {
    const r = structuredClone(records[id]) as Rec;
    const used = keep(r);
    if (used) {
      if (!hasAsin(r)) search += 1;
      if (r.amazon?.product) dp += 1;
    } else r.amazon = {};
    const d = decideStage4(r as RefRecord);
    addScore(
      groups[g.sample === 'D' ? 'D' : 'ABC'],
      id,
      d.values as unknown as Record<ScoredField, unknown>,
      d.auto,
      g,
    );
  }
  const n = Object.keys(gold).length;
  console.log(
    `\n${name}: Amazon requests per book ${((dp + search) / n).toFixed(2)} (product ${(dp / n).toFixed(2)}, search ${(search / n).toFixed(2)})`,
  );
  for (const grp of ['ABC', 'D'] as const) {
    const s = groups[grp];
    console.log(
      `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
        SCORED_FIELDS.map((f) => {
          const p = percent(s[f].right, s[f].auto);
          const a = percent(s[f].auto, s[f].scored);
          return `${f} ${p === null ? '-' : p.toFixed(1)}% right, ${a === null ? '-' : a.toFixed(0)}% auto`;
        }).join(' | '),
    );
  }
}
