/**
 * Titles too long for a Calibre folder, stop B: the report (Markdown) from the tools' outputs.
 *   npx ts-node --transpile-only scripts/title-length-report.ts <dir with clean.json, shorten.json,
 *     shorten-chain.json, empty11.json, export-live.json> <out.md>
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const [dir, out] = process.argv.slice(2);
const j = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const clean = j('clean.json');
const short = j('shorten.json');
const chain = j('shorten-chain.json') as any[];
const e11 = j('empty11.json');
const exp = j('export-live.json');
const cell = (s: string) => String(s ?? '').replace(/\|/gu, '\\|');
const L: string[] = [];
L.push('# Titles too long for a Calibre folder: stop B, the real examples');
L.push('');
L.push(
  `Read-only, from copies: the library and stage 2/4 evidence as of 2026-11-22 18:36 (snapshot live-v9), the held proposals and the new arrivals' catalog exported from the live server at ${exp.at} (the WP20g Preview had read ${exp.files.length} of about 102,000 files then).`,
);
L.push('');
L.push('## Cleaning rules (every title a stage writes)');
for (const [id, e] of Object.entries<any>(clean.rules)) {
  L.push('');
  L.push(`### ${id} (${e.kind})`);
  L.push(
    `${e.text}. Changes: Calibre titles ${e.cal}, file titles ${e.file}, arrivals so far ${e.arr}. Labeled books changed: ${e.labeled} (closer to the label ${e.closer}, farther ${e.farther}, neither ${e.same}).`,
  );
  const rows = clean.rows.filter((r: any) => r.rule === id);
  if (!rows.length) continue;
  L.push('');
  L.push('| where | book | before | after | label |');
  L.push('|---|---|---|---|---|');
  for (const r of rows.slice(0, 40))
    L.push(`| ${r.s} | ${r.id} | ${cell(r.before)} | ${cell(r.after)} | ${cell(r.label ?? '')} |`);
  if (rows.length > 40) L.push(`| … | ${rows.length - 40} more | | | |`);
}
L.push('');
L.push(
  "## Shortening: each candidate rule alone, on the titles still too long after today's cleaning",
);
L.push('');
L.push(
  '| rule | what it does | titles changed | fit alone | number lost | store pick changed | record no longer fits |',
);
L.push('|---|---|---|---|---|---|---|');
for (const [id, e] of Object.entries<any>(short.rules))
  L.push(
    `| ${id} | ${cell(e.text)} | ${e.changes} | ${e.fitsAlone} | ${e.numberChanged} | ${e.pickChanged} | ${e.fitLost} |`,
  );
L.push('');
L.push('## The proposed order, applied until the name fits, then the cut');
const cnt: Record<string, number> = {};
for (const c of chain) cnt[c.step] = (cnt[c.step] ?? 0) + 1;
L.push('');
L.push(
  Object.entries(cnt)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', '),
);
L.push('');
L.push('| book | held by | step | rules | bytes | number | before | after | impact |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const c of chain)
  L.push(
    `| ${c.id} | ${cell((c.src ?? []).join(', '))} | ${c.step} | ${c.rules.join(' + ')} | ${c.bytes} | ${cell(c.number)} | ${cell(c.before)} | ${cell(c.after)} | ${cell([...c.pick, ...c.fit].join('; '))} |`,
  );
L.push('');
L.push('## Item 7: the 11 records without files');
L.push('');
L.push(
  `Catalog files matched by the start of the title in the file's name or read title (${e11.files} files in the catalog at ${e11.at}).`,
);
L.push('');
L.push('| record | Calibre title | files | e.g. |');
L.push('|---|---|---|---|');
for (const b of e11.books)
  L.push(
    `| ${b.id} | ${cell(b.title.slice(0, 80))} | ${b.hits.length} (${[...new Set(b.hits.map((h: any) => h.outcome))].join(', ')}) | ${cell((b.hits[0]?.path ?? '').split('/').pop())} |`,
  );
writeFileSync(out, L.join('\n'));
console.log(`${out}: ${L.length} lines`);
