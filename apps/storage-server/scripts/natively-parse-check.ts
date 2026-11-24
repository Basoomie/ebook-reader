/**
 * The Natively level (2026-11-24): checks the page parser against saved Natively book pages. Each
 * page's own <title> ends with "| L19" (or "| L24??" for a temporary level); the parser must give
 * the same. Usage: npx ts-node -T scripts/natively-parse-check.ts <folder of saved pages>
 */
import fs from 'fs';
import path from 'path';
import { parseNativelyLevel } from '../src/natively/parse';

const dir = process.argv[2];
let bad = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  const title = /\| L(\d+)(\?\?)?<\/title>/.exec(html);
  const parsed = parseNativelyLevel(html);
  const expected = title
    ? { kind: 'level', level: Number(title[1]), temporary: !!title[2] }
    : { kind: 'none' };
  const same = JSON.stringify(parsed) === JSON.stringify(expected);
  if (!same) bad += 1;
  console.log(
    `${same ? 'OK      ' : 'MISMATCH'} ${f} parsed ${JSON.stringify(parsed)} title ${title?.[0] ?? '(none)'}`,
  );
}
console.log(bad ? `${bad} mismatches` : 'all pages match their titles');
process.exitCode = bad ? 1 : 0;
