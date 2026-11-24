/**
 * Series under a short and a full name (tier 4, Part 3): the candidate rules on the checked
 * sample, then a chosen list of rules on the whole pair list. A rule counts as wrong where it
 * says merge for a pair checked 'different', or separate for one checked 'same'. Only rules with
 * 0 wrong on the sample may decide automatically (cleanup-finish.md Part 3).
 *
 *   npx ts-node --transpile-only scripts/series-pairs-measure.ts --sample <folder/sample.json>
 *     [--pairs <folder/pairs.jsonl>] [--rules collision,store-same,…] [--out <report.json>]
 *
 * Without --rules, every candidate in its order. Writes nothing but --out.
 */
import fs from 'fs';
import {
  CANDIDATE_RULES,
  PAIR_GROUPS,
  answerPair,
  type PairRule,
} from '../src/cleanup/series-pairs/pairs';
import { measureRules, readPairs, type SampleRow } from './lib/series-pairs-io';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const sample = JSON.parse(fs.readFileSync(arg('sample')!, 'utf8')) as SampleRow[];
const ids = arg('rules')?.split(',').filter(Boolean);
const rules: PairRule[] = ids
  ? ids.map((id) => {
      const r = CANDIDATE_RULES.find((x) => x.id === id);
      if (!r) throw new Error(`No rule ${id}`);
      return r;
    })
  : CANDIDATE_RULES;

const result = measureRules(sample, rules);
const report: Record<string, unknown> = { sample: result };
console.log(
  `Checked: ${result.checked} of ${sample.length} (same ${result.same}, different ${result.different})`,
);
console.log('Each rule alone (pairs it decides / wrong):');
for (const r of result.alone)
  console.log(
    `  ${r.rule.padEnd(22)} merge ${r.merge}/${r.mergeWrong}  separate ${r.separate}/${r.separateWrong}`,
  );
console.log(
  `The list in order: merge ${result.list.merge} (wrong ${result.list.mergeWrong}), separate ${result.list.separate} (wrong ${result.list.separateWrong}), review ${result.list.review}`,
);
for (const w of result.list.wrong) console.log(`  wrong: ${w}`);

if (arg('pairs')) {
  const rows = readPairs(arg('pairs')!);
  const whole = Object.fromEntries(
    PAIR_GROUPS.map((g) => [g, { merge: 0, separate: 0, review: 0, books: 0 }]),
  ) as Record<string, Record<'merge' | 'separate' | 'review' | 'books', number>>;
  for (const r of rows) {
    // A pair the user already decided in the series editor is not decided by the rules.
    const a = r.decided ? 'decided' : answerPair(r, r.signals, rules).answer;
    if (a === 'decided') continue;
    whole[r.group][a]++;
    whole[r.group].books += r.shortBooks + r.longBooks;
  }
  report.whole = whole;
  console.log('The whole list:');
  for (const g of PAIR_GROUPS)
    console.log(
      `  ${g.padEnd(12)} merge ${whole[g].merge}  separate ${whole[g].separate}  review ${whole[g].review}`,
    );
}
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 2));
