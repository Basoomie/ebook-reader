/**
 * Series under a short and a full name (tier 4, Part 3): the sample for the check against the
 * store pages. A seeded, stratified draw from series-pairs-extract.ts's pairs.jsonl: each group
 * in proportion to its pairs, at least --min per group (all of a smaller group), about --size in
 * all. Writes sample.json (every pair with its signals, the candidate rules' answer, both sides'
 * books with their store links, and `truth: null` to fill in: 'same' or 'different', with
 * `evidence`) and sample.md (the same, to read).
 *
 *   npx ts-node --transpile-only scripts/series-pairs-sample.ts --pairs <folder/pairs.jsonl>
 *     --out <folder> [--size 80] [--min 10] [--seed 20261123]
 *
 * An existing sample.json keeps its filled-in answers for pairs drawn again.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PAIR_GROUPS, type PairGroup } from '../src/cleanup/series-pairs/pairs';
import { readPairs, sampleRows, shares, type PairRow } from './lib/series-pairs-io';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const size = Number(arg('size') ?? 80);
const min = Number(arg('min') ?? 10);
const seed = arg('seed') ?? '20261123';
const outDir = arg('out')!;
const rows = readPairs(arg('pairs')!);

const key = (r: PairRow) =>
  createHash('sha1').update(`${seed}\u0000${r.short}\u0000${r.long}`).digest('hex');
const totals = Object.fromEntries(
  PAIR_GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length]),
) as Record<PairGroup, number>;
const want = shares(totals, size, min);
const drawn = PAIR_GROUPS.flatMap((g) =>
  rows
    .filter((r) => r.group === g)
    .sort((a, b) => (key(a) < key(b) ? -1 : 1))
    .slice(0, want[g]),
);

const file = path.join(outDir, 'sample.json');
const before = new Map(
  fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof sampleRows>).map((s) => [
        `${s.short}\u0000${s.long}`,
        s,
      ])
    : [],
);
const sample = sampleRows(drawn).map((s) => {
  const old = before.get(`${s.short}\u0000${s.long}`);
  return old ? { ...s, truth: old.truth, evidence: old.evidence } : s;
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(sample, null, 2));

const pct = (x: number) => `${Math.round(x * 100)} %`;
const md: string[] = [
  `# Series pairs: the sample (${sample.length} of ${rows.length} pairs, seed ${seed})`,
  '',
  `Per group: ${PAIR_GROUPS.map((g) => `${g} ${want[g]} of ${totals[g]}`).join(', ')}.`,
  '',
];
for (const s of sample) {
  const g = s.signals;
  md.push(
    `## ${s.short}  /  ${s.long}`,
    '',
    `- Group: ${s.group}; added: 「${s.added}」; merged name: 「${s.common.name}」${s.common.cut ? ' (the long name: the short one is cut)' : ''}`,
    `- Books: ${s.shortBooks} / ${s.longBooks}${s.decided ? `; decided in the series editor: ${s.decided}` : ''}`,
    `- Signals: numbers a merge would share ${g.collisions}${g.collisionExamples.length ? ` (${g.collisionExamples.join('; ')})` : ''}; already shared inside a name ${g.collisionsWithin}; both have #1: ${g.bothHaveOne ? 'yes' : 'no'}; authors in common: ${g.sharedAuthors.join(', ') || 'none'} (long side ${pct(g.longWithShortAuthor)}); long titles start with the short name: ${pct(g.longTitlesStartShort)}; RanobeDB ${g.ranobedb}; Amazon ${g.amazon}; a store names the other: ${g.storeNamesOther ? 'yes' : 'no'}; spin-off word: ${g.spinoff ?? 'none'}`,
    `- The rules: **${s.answer}**${s.rule ? ` (${s.rule}${s.held ? ', held: a merge would share a number' : ''})` : ''}`,
    `- Truth: ${s.truth ?? '(to check)'}${s.evidence ? ` — ${s.evidence}` : ''}`,
    '',
  );
  for (const [label, side] of [
    ['Short', s.shortSide],
    ['Long', s.longSide],
  ] as const) {
    md.push(`  ${label}:`);
    for (const b of side) {
      const links = b.links.map((l) => `[${l.site}](${l.url})`).join(' ');
      md.push(
        `  - #${b.index ?? '–'} ${b.title} — ${b.authors.join(', ')} (Calibre ${b.calibreId}${b.kind !== 'full' ? `, ${b.kind}` : ''})${b.amazonSeries ? ` · Amazon: ${b.amazonSeries}` : ''}${b.ranobedbSeries ? ` · RanobeDB ${b.ranobedbSeries.id}: ${b.ranobedbSeries.name ?? ''}` : ''} ${links}`,
      );
    }
    if (side.length < (label === 'Short' ? s.shortBooks : s.longBooks))
      md.push(`  - … ${(label === 'Short' ? s.shortBooks : s.longBooks) - side.length} more`);
  }
  md.push('');
}
fs.writeFileSync(path.join(outDir, 'sample.md'), md.join('\n'));
console.log(
  `${sample.length} pairs drawn (${PAIR_GROUPS.map((g) => `${g} ${want[g]}`).join(', ')}); ${sample.filter((s) => s.truth).length} already checked`,
);
