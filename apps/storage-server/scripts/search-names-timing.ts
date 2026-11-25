/**
 * Search suggestions (search palette step 1, 2026-11-24): how long GET /names takes on a copy
 * of the live ttsu.db, the first time (counting every name) and after (cached).
 *   npx ts-node --transpile-only scripts/search-names-timing.ts <copy of ttsu.db>
 * Opens the copy read-only; never point it at the live database.
 */
import Database from 'better-sqlite3';
import { NAME_FIELDS, suggestNames } from '../src/catalog/names';

const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const books = (db.prepare('SELECT COUNT(*) n FROM books').get() as { n: number }).n;
console.log(`books ${books}`);
for (const field of NAME_FIELDS) {
  const t0 = performance.now();
  const first = suggestNames(db, { field, text: '' });
  const ms = performance.now() - t0;
  const times: number[] = [];
  for (const text of ['a', '魔', 'の', 'sf', 'ひ']) {
    const t = performance.now();
    suggestNames(db, { field, text });
    times.push(performance.now() - t);
  }
  console.log(
    `${field.padEnd(12)} first ${ms.toFixed(0).padStart(5)} ms, typed ${Math.max(...times)
      .toFixed(1)
      .padStart(5)} ms at most; top: ${first
      .slice(0, 3)
      .map((n) => `${n.name} (${n.count})`)
      .join(', ')}`,
  );
}
