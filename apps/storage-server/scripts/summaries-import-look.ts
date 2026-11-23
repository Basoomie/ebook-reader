/**
 * Book summaries session 3: a look at one test summary's item and the book around it (for
 * correcting the items the accuracy test flagged before the import). Reads a copy of the test's
 * summaries.db and the test's EPUB copies; writes nothing.
 *   npx ts-node --transpile-only scripts/summaries-import-look.ts <summaries.db> <epub dir> <run> <ref> [word...]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { readBookScript } from '../src/audio/book-script';
import { countImportOptions } from '../src/counts/counter-bundle';
import { DEFAULT_COUNTS_CONFIG } from '../src/config';
import { bookTextFromScript, QuoteIndex } from '../src/summaries/book-text';
import type { Summary } from '../src/summaries/types';

async function main() {
  const [dbFile, epubDir, run, ref, ...words] = process.argv.slice(2);
  const db = new Database(dbFile, { readonly: true });
  const row = db
    .prepare(`SELECT summary_json FROM test_summaries WHERE run_id = ? AND lang = 'ja'`)
    .get(run) as { summary_json: string };
  const s = JSON.parse(row.summary_json) as Summary;
  const book = run.split('|')[0];
  const script = await readBookScript(path.join(epubDir, `${book}.epub`), {
    importOptions: countImportOptions(DEFAULT_COUNTS_CONFIG),
    maxSentence: 120,
    timeoutMs: 300_000,
  });
  const text = bookTextFromScript(script);
  const idx = new QuoteIndex(script);
  for (const sec of s.sections)
    for (const g of sec.groups)
      for (const it of g.items)
        if (it.ref === ref) {
          console.log(
            JSON.stringify(
              { section: sec.key, chapter: g.chapter, title: g.title, ...it },
              null,
              1,
            ),
          );
          if (it.quote) console.log('quote found at', idx.find(it.quote, g.chapter));
        }
  const all = text.chapters.map((c) => c.text).join('\n');
  for (const w of words) {
    let at = all.indexOf(w);
    let n = 0;
    while (at >= 0 && n < 6) {
      console.log(`\n--- "${w}" #${++n}:\n${all.slice(Math.max(0, at - 350), at + 350)}`);
      at = all.indexOf(w, at + 1);
    }
  }
}
void main();
