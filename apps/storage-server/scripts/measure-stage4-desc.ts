/**
 * WP20d: the description rules on the 800 labeled books' stored records.
 *
 *   node -r ts-node/register/transpile-only scripts/measure-stage4-desc.ts <cleanup-reference dir> [desc_py.json]
 *
 * With desc_py.json (desc.py's choose + clean_desc for every book), the port with the original
 * patterns (v1) must give the same source, text and removed lines for every book. Then it lists
 * every line the check-D fixes (v2) remove in addition, or no longer remove. Reads only.
 */
import fs from 'fs';
import path from 'path';
import { chooseDescription, cleanDescription } from '../src/cleanup/stage4/desc';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';

const [refDir, pyFile] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  { sample: string }
>;
const py = pyFile
  ? (JSON.parse(fs.readFileSync(pyFile, 'utf8')) as Record<
      string,
      {
        source: string | null;
        text: string | null;
        cleaned: string | null;
        removed: [string, string][];
      }
    >)
  : null;

let diffs = 0;
const counts = { ABC: { books: 0, withDesc: 0 }, D: { books: 0, withDesc: 0 } };
const changes: string[] = [];
for (const id of Object.keys(gold)) {
  const r = JSON.parse(
    fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8'),
  ) as RefRecord;
  const grp = gold[id].sample === 'D' ? 'D' : 'ABC';
  const { source, text } = chooseDescription(r);
  counts[grp].books += 1;
  if (source) counts[grp].withDesc += 1;
  const v1 = text ? cleanDescription(text, 1) : { text: null, removed: [] };
  const v2 = text ? cleanDescription(text, 2) : { text: null, removed: [] };
  if (py) {
    const o = py[id];
    const same =
      o.source === source &&
      o.text === text &&
      o.cleaned === v1.text &&
      JSON.stringify(o.removed) === JSON.stringify(v1.removed.map((x) => [x.kind, x.line]));
    if (!same) {
      diffs += 1;
      if (diffs <= 10) {
        console.log(`DIFF ${id}: ts ${source} | py ${o.source}`);
        console.log(
          `   ts removed ${JSON.stringify(v1.removed)}\n   py removed ${JSON.stringify(o.removed)}`,
        );
      }
    }
  }
  const a = new Set(v1.removed.map((x) => x.line));
  const b = new Set(v2.removed.map((x) => x.line));
  for (const x of v2.removed)
    if (!a.has(x.line)) changes.push(`${grp} ${id} + [${x.kind}] ${x.line}`);
  for (const x of v1.removed)
    if (!b.has(x.line)) changes.push(`${grp} ${id} - [${x.kind}] ${x.line}`);
}
if (py)
  console.log(
    `Port (v1 patterns) vs desc.py: ${diffs} books differ of ${Object.keys(gold).length}`,
  );
console.log(
  `Books with a description: the 600 ${counts.ABC.withDesc}/${counts.ABC.books}, check D ${counts.D.withDesc}/${counts.D.books}`,
);
console.log(
  `\nLines the check-D fixes change (${changes.length}; + removed now, - no longer removed):`,
);
for (const c of changes) console.log('  ' + c);
