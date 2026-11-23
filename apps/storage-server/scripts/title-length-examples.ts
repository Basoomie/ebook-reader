/**
 * Titles too long for a Calibre folder, stop B (read-only): the real examples, from the dump made
 * by title-length-dump.ts.
 *
 *   npx ts-node --transpile-only scripts/title-length-examples.ts <titles.json> <mode> [n]
 *     mode: repeats | long | all
 */
import { readFileSync, writeFileSync } from 'fs';
import { cleanTitle, repeatsItself } from '../src/cleanup/title-rules';
import { calibreNameBytes, NAME_MAX_BYTES } from '../src/cleanup/stage2-rules';

const [file, mode = 'all', nArg] = process.argv.slice(2);
const N = Number(nArg ?? 40);
const d = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map<number, any>(d.books.map((b: any) => [b.id, b]));

if (mode === 'repeats' || mode === 'all') {
  const rows: any[] = [];
  for (const b of d.books) {
    for (const [s, t, au] of [
      ['file', b.fileTitle, b.fileAuthors],
      ['cal', b.title, b.authors],
    ] as const) {
      if (!t) continue;
      const c = cleanTitle(t, [...(au ?? []), ...b.authors]);
      if (repeatsItself(c)) rows.push({ s, id: b.id, t: c, label: b.label?.t ?? null });
    }
  }
  for (const f of d.arrivals) {
    const c = cleanTitle(f.facts.title, f.facts.authors ?? []);
    if (repeatsItself(c)) rows.push({ s: 'arr', id: `f${f.id}`, t: c, label: null });
  }
  const by: Record<string, number> = {};
  for (const r of rows) by[r.s] = (by[r.s] ?? 0) + 1;
  console.log(`== repeats: ${rows.length}`, by, 'labeled', rows.filter((r) => r.label).length);
  for (const r of rows
    .filter((x) => x.label)
    .concat(rows.filter((x) => !x.label))
    .slice(0, N))
    console.log(`${r.s} ${r.id} | ${r.t}${r.label ? `\n      label: ${r.label}` : ''}`);
}

if (mode === 'long' || mode === 'all') {
  // Every title some stage would write or that blocks writes, measured after today's cleaning.
  // One row per book and title text; `src` lists what holds it.
  const rows: any[] = [];
  const seen = new Map<string, any>();
  const push = (
    src: string,
    id: number | string,
    raw: string,
    first: string,
    authors: string[],
  ) => {
    const key = `${id}:${raw}`;
    const had = seen.get(key);
    if (had) {
      if (!had.src.includes(src)) had.src.push(src);
      return;
    }
    const c = cleanTitle(raw, authors);
    const cid = typeof id === 'number' ? id : 9_999_999;
    const row = {
      src: [src],
      id,
      raw,
      clean: c,
      first,
      rawBytes: calibreNameBytes(cid, raw, first),
      bytes: calibreNameBytes(cid, c, first),
    };
    seen.set(key, row);
    rows.push(row);
  };
  for (const h of d.held) {
    const b = byId.get(h.calibre_id);
    const first = b?.authors?.[0] ?? 'Unknown';
    if (h.field === 'title')
      push(`held s${h.stage}`, h.calibre_id, JSON.parse(h.new_json), first, b?.authors ?? []);
    else if (b) push(`held s${h.stage} ${h.field}`, h.calibre_id, b.title, first, b.authors);
  }
  for (const f of d.arrivals) {
    const au = f.facts.authors ?? [];
    if (f.facts.nameBytes > NAME_MAX_BYTES || f.outcome === 'too_long')
      push('arrival', `f${f.id}`, f.facts.title, au[0] ?? 'Unknown', au);
  }
  for (const b of d.books) {
    if (calibreNameBytes(b.id, b.title, b.authors[0] ?? 'Unknown') > NAME_MAX_BYTES)
      push(
        `library${b.formats ? '' : ' (no files)'}`,
        b.id,
        b.title,
        b.authors[0] ?? 'Unknown',
        b.authors,
      );
  }
  const books = new Set(rows.map((r) => r.id));
  const still = rows.filter((r) => r.bytes > NAME_MAX_BYTES);
  console.log(
    `\n== long names: ${rows.length} titles of ${books.size} books; still too long after today's cleaning: ${still.length} titles of ${new Set(still.map((r) => r.id)).size} books`,
  );
  for (const r of rows.slice(0, N))
    console.log(
      `${r.id} ${r.rawBytes}->${r.bytes} [${r.first}] ${r.src.join(', ')}\n   raw:   ${r.raw}\n   clean: ${r.clean}`,
    );
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(rows, null, 1));
}
