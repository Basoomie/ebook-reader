/**
 * Series and author figures (docs/design/series-figures.md): how long they take on a copy of
 * the live ttsu.db, what they find, and 40 random series for the spot check against 読書メーター.
 *   npx ts-node --transpile-only scripts/series-figures-timing.ts <copy of ttsu.db> [spot.json]
 * Opens the copy read-only; never point it at the live database.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { planGroups } from '../src/catalog/groups';
import { planCount } from '../src/catalog/queries';
import { registerRegexp } from '../src/catalog/regexp';
import { authorFigures, figureIndex, groupFigure } from '../src/catalog/series-figures';

const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
registerRegexp(db);
const user = db
  .prepare(
    `SELECT user_id AS id FROM sync_records WHERE kind = 'book-status'
      GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1`,
  )
  .get() as { id: string };

const ms = (f: () => unknown) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

// The figures themselves.
let index!: ReturnType<typeof figureIndex>;
const cold = ms(() => (index = figureIndex(db, user.id)));
const warm = ms(() => figureIndex(db, user.id));
const all = [...index.byKey.values()];
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
const kept = all.map((f) => f.kept).filter((k): k is number => k !== null);
console.log(
  `figureIndex: ${index.byKey.size} series (library × series); cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(1)} ms`,
);
console.log(
  `  volume 1 rated ${all.filter((f) => f.rating).length}, volume 1 readers ${all.filter((f) => f.readers !== null).length}, went on to vol 2 ${kept.length}` +
    ` (p10 ${pct(kept, 0.1)} %, median ${pct(kept, 0.5)} %, p90 ${pct(kept, 0.9)} %; 100 %: ${kept.filter((k) => k === 100).length}; under 20 %: ${kept.filter((k) => k < 20).length})`,
);
const t = ms(() => authorFigures(db, index, {}));
const t2 = ms(() => authorFigures(db, index, {}));
console.log(
  `authorFigures: ${authorFigures(db, index, {}).size} authors; ${t.toFixed(0)} ms, again ${t2.toFixed(1)} ms`,
);

// Group pages as the route runs them (first page, each sort; the second run is cached).
const page = (by: 'series' | 'author', key: string, q?: string) => {
  const plan = planGroups(db, user, {
    by,
    query: q,
    sort: { key: key as 'rating', dir: 'desc' },
    limit: 60,
  });
  const rows = db.prepare(plan.sql).all(...plan.params);
  return plan.finish(rows);
};
for (const [by, key, q] of [
  ['series', 'kept'],
  ['series', 'rating'],
  ['series', 'readers'],
  ['author', 'rating'],
  ['author', 'readers'],
  ['series', 'newest', 'rating:>=4.3'],
  ['series', 'kept', 'kept:>=80'],
] as const) {
  const first = ms(() => page(by, key, q));
  let result: ReturnType<typeof page> | null = null;
  const again = ms(() => (result = page(by, key, q)));
  const names = result!.groups
    .slice(0, 5)
    .map((g) => g.name)
    .join(' / ');
  console.log(
    `${by} ${key}${q ? ` q=${q}` : ''}: ${first.toFixed(0)} ms, again ${again.toFixed(0)} ms; ${result!.total} groups; ${names}`,
  );
}

// kept: on the Books tab (a count, as the Library's count line).
for (const q of ['kept:>=80', 'kept:>=80 status:unread', '-kept:>=50']) {
  let n = 0;
  const time = ms(() => {
    const plan = planCount(db, user, { query: q });
    n = (plan.finish(db.prepare(plan.sql).all(...plan.params)) as { count: number }).count;
  });
  console.log(`books ${q}: ${n} in ${time.toFixed(0)} ms`);
}

// 40 random series with a figure, for the spot check: volume 1 and 2's titles and 読書メーター ids.
const withKept = [...index.bySeries.entries()].filter(
  ([sid]) => groupFigure(index, sid)?.kept !== null,
);
const spot = [];
let seed = 20261126;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const picked = new Set<number>();
while (spot.length < 40 && picked.size < withKept.length) {
  const [sid, libs] = withKept[Math.floor(rand() * withKept.length)];
  if (picked.has(sid)) continue;
  picked.add(sid);
  const [lib] = [...libs.entries()].sort((a, b) => (b[1].readers ?? -1) - (a[1].readers ?? -1))[0];
  const vols = db
    .prepare(
      `SELECT b.series_index AS idx, b.title, b.readers, bi.value AS bookmeter
         FROM books b LEFT JOIN book_identifiers bi ON bi.book_id = b.id AND bi.type = 'bookmeter'
        WHERE b.series_id = ? AND b.library_id = ? AND b.series_index IN (1, 2, 3)
        ORDER BY b.series_index`,
    )
    .all(sid, lib);
  const name = (db.prepare('SELECT name FROM series WHERE id = ?').get(sid) as { name: string })
    .name;
  spot.push({ series: name, kept: groupFigure(index, sid)!.kept, volumes: vols });
}
if (process.argv[3]) {
  writeFileSync(process.argv[3], JSON.stringify(spot, null, 1));
  console.log(`spot check list: ${process.argv[3]}`);
}
