/**
 * Book summaries session 3: builds the one-time import file of the accuracy test's 13 summaries
 * (book-summaries.md "Summaries on the server"), from a copy of the test's summaries.db and the
 * test's EPUB copies. The newest mixed-setup summary of each book (the 10 v4 ones as they are,
 * no rerun of their writing step), with the items the test flagged corrected
 * (summaries-import-corrections.json). Every quote, the corrected ones included, is checked
 * against the test's copy of the book; the server checks them again against the library's.
 * デュラララ!! is not imported. Reads only; writes the output file.
 *
 *   npx ts-node --transpile-only scripts/summaries-import-build.ts <summaries.db copy> <epub dir> <out.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { readBookScript } from '../src/audio/book-script';
import { DEFAULT_COUNTS_CONFIG } from '../src/config';
import { countImportOptions } from '../src/counts/counter-bundle';
import { refindQuotes, type ImportEntry, type ImportFile } from '../src/summaries/import';
import type { Summary, SummaryItem } from '../src/summaries/types';

export const IMPORT_RUNS = [
  'hanayome1|mixed|bg0|v4',
  'watanare1|mixed|bg0|v4',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `sw0${n}|mixed|bg0|v4`),
  'hanayome2|mixed|bg1|v5',
  'watanare2|mixed|bg1|v5',
  'sw09|mixed|bg1|v5',
];

export interface Correction {
  run: string;
  ref: string;
  action: 'replace' | 'replace-text' | 'delete';
  text?: string;
  from?: string;
  to?: string;
  flag: string;
  book: string;
}

/** The summary with its corrections applied (each must hit exactly one item). */
export function corrected(run: string, s: Summary, all: Correction[]): Summary {
  const mine = all.filter((c) => c.run === run);
  const hit = new Set<string>();
  const fix = (it: SummaryItem): SummaryItem | null => {
    const c = mine.find((x) => x.ref === it.ref);
    if (!c) return it;
    hit.add(c.ref);
    if (c.action === 'delete') return null;
    if (c.action === 'replace') return { ...it, text: c.text! };
    if (!it.text.includes(c.from!))
      throw new Error(`${run} ${it.ref}: "${c.from}" not in the text`);
    return { ...it, text: it.text.replace(c.from!, () => c.to!) };
  };
  const sections = s.sections
    .map((sec) => ({
      ...sec,
      groups: sec.groups
        .map((g) => ({ ...g, items: g.items.map(fix).filter((x): x is SummaryItem => !!x) }))
        .filter((g) => g.items.length),
    }))
    .filter((sec) => sec.groups.length);
  const missed = mine.filter((c) => !hit.has(c.ref));
  if (missed.length) throw new Error(`${run}: no item ${missed.map((c) => c.ref).join(', ')}`);
  return { ...s, sections };
}

async function main() {
  const [dbFile, epubDir, out] = process.argv.slice(2);
  if (!dbFile || !epubDir || !out)
    throw new Error('usage: <summaries.db copy> <epub dir> <out.json>');
  const db = new Database(dbFile, { readonly: true });
  const { corrections } = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'summaries-import-corrections.json'), 'utf8'),
  ) as { corrections: Correction[] };
  const entries: ImportEntry[] = [];
  for (const run of IMPORT_RUNS) {
    const r = db
      .prepare(
        `SELECT r.book_key, r.background, r.round, b.title, b.series, b.volume, b.characters, s.summary_json
         FROM test_runs r JOIN test_books b ON b.key = r.book_key
         JOIN test_summaries s ON s.run_id = r.id AND s.lang = 'ja'
         WHERE r.id = ? AND r.state = 'done'`,
      )
      .get(run) as
      | {
          book_key: string;
          background: number;
          round: string;
          title: string;
          series: string | null;
          volume: number | null;
          characters: number;
          summary_json: string;
        }
      | undefined;
    if (!r) throw new Error(`${run}: no finished summary`);
    const s = corrected(run, JSON.parse(r.summary_json) as Summary, corrections);
    const script = await readBookScript(path.join(epubDir, `${r.book_key}.epub`), {
      importOptions: countImportOptions(DEFAULT_COUNTS_CONFIG),
      maxSentence: 120,
      timeoutMs: 300_000,
    });
    if (script.characters !== r.characters)
      throw new Error(
        `${run}: the EPUB has ${script.characters} characters, the test ${r.characters}`,
      );
    const q = refindQuotes(s, script);
    if (q.missing.length) throw new Error(`${run}: quotes not found: ${q.missing.join(', ')}`);
    const mine = corrections.filter((c) => c.run === run);
    entries.push({
      key: r.book_key,
      run,
      title: r.title,
      series: r.series,
      volume: r.volume,
      characters: r.characters,
      background: r.background === 1,
      round: r.round,
      madeAt: s.madeAt,
      summary: q.summary,
      corrections: mine.map((c) => ({
        ref: c.ref,
        what: c.action === 'delete' ? 'deleted' : 'corrected',
      })),
    });
    const items = s.sections.reduce(
      (a, x) => a + x.groups.reduce((b, g) => b + g.items.length, 0),
      0,
    );
    console.log(
      `${run}: ${r.title} · ${items} items, ${q.quotes} quotes (${q.moved} moved) · ${mine.length} corrections`,
    );
  }
  const file: ImportFile = { version: 1, summaries: entries };
  fs.writeFileSync(out, JSON.stringify(file));
  console.log(`Wrote ${out}: ${entries.length} summaries, ${fs.statSync(out).size} bytes`);
}

if (require.main === module)
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
