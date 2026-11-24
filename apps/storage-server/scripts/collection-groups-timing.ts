/**
 * Series, authors and tags in a collection (2026-11-24): how long GET /groups takes on a
 * copy of the live ttsu.db, unscoped (whole library) and scoped to the largest collections.
 *   npx ts-node --transpile-only scripts/collection-groups-timing.ts <copy of ttsu.db>
 * Opens the copy read-only; never point it at the live database.
 */
import Database from 'better-sqlite3';
import { clearGroupCaches, planGroups } from '../src/catalog/groups';
import { registerRegexp } from '../src/catalog/regexp';

const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
registerRegexp(db);
const user = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as { id: string };
const tag = db
  .prepare(
    'SELECT t.name, COUNT(*) n FROM book_tags bt JOIN tags t ON t.id = bt.tag_id GROUP BY t.id ORDER BY n DESC LIMIT 1',
  )
  .get() as { name: string; n: number };
const books = (db.prepare('SELECT COUNT(*) n FROM books').get() as { n: number }).n;
console.log(`books ${books}; biggest tag ${tag.name} (${tag.n})`);
const run = (label: string, opts: Parameters<typeof planGroups>[2]) => {
  const t0 = performance.now();
  const plan = planGroups(db, { id: user.id, deviceId: null }, opts);
  const page = plan.finish(db.prepare(plan.sql).all(...plan.params));
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const again = planGroups(db, { id: user.id, deviceId: null }, opts);
  again.finish(db.prepare(again.sql).all(...again.params));
  console.log(
    `${label.padEnd(44)} first ${ms.toFixed(0).padStart(5)} ms, again ${(performance.now() - t1).toFixed(0).padStart(4)} ms, ${page.total} groups`,
  );
};
for (const by of ['series', 'author', 'tag'] as const) {
  clearGroupCaches(db);
  run(`${by}: whole library`, { by, limit: 50 });
  run(`${by}: Unread (status:unread)`, { by, limit: 50, scope: 'status:unread' });
  run(`${by}: tag:"${tag.name}"`, { by, limit: 50, scope: `tag:="${tag.name}"` });
  run(`${by}: Unread + typed search 魔`, { by, limit: 50, scope: 'status:unread', query: '魔' });
}
