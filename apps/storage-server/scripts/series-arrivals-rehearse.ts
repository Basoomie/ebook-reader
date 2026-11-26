/**
 * The series-arrival alert, the rehearsal (docs/design/series-arrivals.md): the real server
 * code on a copy of the reader's ttsu.db. Migrates the copy, then inside one transaction that
 * is rolled back at the end:
 *   1. switches the alert on (the baseline: nothing is told);
 *   2. replays the latest arrivals (books created after --replay-from) as if the alert had
 *      been on, with today's series counting from before them: counts per decision, the
 *      message, the time a round takes and the query plans;
 *   3. applies the 読書メーター Review's completions (--bookmeter <rehearsal.json>, optional):
 *      the new series count from now, so nothing is told;
 *   4. made-up arrivals in one series you're reading: a new volume, a copy, a bonus, an
 *      omnibus, the same series in another library, a book without a series; first while a
 *      new-arrivals run is open, then after it ends.
 * Prints every message it would send. Writes only the copy (refused on a live path).
 *
 *   npx vite-node scripts/series-arrivals-rehearse.ts -- --ttsu <ttsu.db copy>
 *     [--replay-from 2026-11-24] [--bookmeter <bookmeter rehearsal.json>]
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { migrate } from '../src/db/migrations';
import { SERIES_ARRIVAL_EVENT } from '../src/series-arrivals/events';
import { SeriesArrivals } from '../src/series-arrivals/service';
import { readingSeries } from '../src/series-arrivals/rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ttsu = arg('ttsu');
if (!ttsu) throw new Error('--ttsu is needed');
if (/^[a-z]:\\ttsu|^\\\\|^y:/i.test(path.resolve(ttsu))) throw new Error('refusing a live path');
const replayFrom = Date.parse(`${arg('replay-from') ?? '2026-11-24'}T00:00:00Z`);
const bookmeterFile = arg('bookmeter');

const db = new Database(ttsu);
db.pragma('journal_mode = WAL');
console.log(`schema ${db.pragma('user_version', { simple: true })} → ${migrate(db)}`);

const userId = (db.prepare('SELECT id FROM users ORDER BY created_at').get() as { id: string }).id;
let now = (db.prepare('SELECT MAX(created_at) AS t FROM books').get() as { t: number }).t + 60_000;
let doneBefore = Infinity;
const sent: { lines: string[]; link: string | null }[] = [];
const digest: string[] = [];
const settings = {
  sections: { data: true } as Record<string, boolean>,
  events: { [SERIES_ARRIVAL_EVENT]: { discord: true, email: true } },
  waits: { seriesArrivalWaitHours: 24 },
};
const service = new SeriesArrivals({
  db,
  notifications: {
    settings: () => settings,
    notify: (m) => sent.push(m),
    addDigestLine: (_e, text, link) => digest.push(`${text}  (${link})`),
  },
  arrivalsDoneBefore: () => doneBefore,
  now: () => now,
  log: () => {},
});

const seriesName = (id: number) =>
  (db.prepare('SELECT name FROM series WHERE id = ?').get(id) as { name: string }).name;
const libName = (id: string) =>
  (db.prepare('SELECT name FROM libraries WHERE id = ?').get(id) as { name: string }).name;

function showMessages(label: string) {
  console.log(`\n  ${label}: ${sent.length} message(s), ${digest.length} digest line(s)`);
  for (const m of sent) console.log(`    > ${m.lines.join('\n      ')}\n      link ${m.link}`);
  for (const d of digest.slice(0, 30)) console.log(`    • ${d}`);
  if (digest.length > 30) console.log(`    • … ${digest.length - 30} more`);
  sent.length = 0;
  digest.length = 0;
}

function reasons(since: number) {
  return db
    .prepare(
      `SELECT reason, COUNT(*) AS n FROM series_arrival_books WHERE decided_at >= ? GROUP BY reason ORDER BY n DESC`,
    )
    .all(since);
}

function timed<T>(f: () => T): [T, number] {
  const t = process.hrtime.bigint();
  const r = f();
  return [r, Number(process.hrtime.bigint() - t) / 1e6];
}

function explain(sql: string, ...params: unknown[]) {
  for (const r of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    console.log(`      ${r.detail}`);
}

db.exec('BEGIN');
try {
  // 1. The baseline.
  const [r1, ms1] = timed(() => service.round());
  const reading = readingSeries(db, userId);
  console.log(`\n1. switched on: ${JSON.stringify(r1)} in ${ms1.toFixed(1)} ms`);
  console.log(`   series you're reading: ${reading.length}`);
  for (const s of reading) console.log(`     ${libName(s.libraryId)} / ${seriesName(s.seriesId)}`);
  showMessages('baseline');

  // 2. The latest arrivals as if the alert had been on, the series counting from before.
  db.prepare('UPDATE series_arrival_state SET on_since = ?').run(replayFrom);
  db.prepare('UPDATE series_arrival_series SET since = ?').run(replayFrom - 86_400_000);
  const pending = (
    db.prepare('SELECT COUNT(*) AS n FROM books WHERE created_at > ?').get(replayFrom) as {
      n: number;
    }
  ).n;
  doneBefore = -Infinity;
  const [waitRound, msWait] = timed(() => service.round());
  console.log(
    `\n2. replay of ${pending} books created since ${new Date(replayFrom).toISOString()}` +
      `\n   while a run is open: ${JSON.stringify(waitRound)} in ${msWait.toFixed(1)} ms`,
  );
  doneBefore = Infinity;
  const mark2 = now;
  const [r2, ms2] = timed(() => service.round());
  console.log(`   after the run: ${JSON.stringify(r2)} in ${ms2.toFixed(1)} ms`);
  console.log(`   decisions: ${JSON.stringify(reasons(mark2))}`);
  for (const t of db
    .prepare(
      `SELECT b.title, se.name AS series, b.series_index AS idx, d.reason FROM series_arrival_books d
         JOIN books b ON b.id = d.book_id LEFT JOIN series se ON se.id = b.series_id
        WHERE d.decided_at >= ? AND b.series_id IS NOT NULL ORDER BY d.reason, se.name, b.series_index`,
    )
    .all(mark2) as { title: string; series: string; idx: number; reason: string }[])
    console.log(`     ${t.reason.padEnd(13)} ${t.series} ${t.idx} · ${t.title}`);
  showMessages('replay');
  console.log('   plans: pending books (the round, every minute)');
  explain(
    `SELECT b.id FROM books b WHERE b.created_at > ? AND b.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM series_arrival_books d WHERE d.user_id = ? AND d.book_id = b.id)`,
    replayFrom,
    now,
    userId,
  );
  console.log('   copy check');
  explain(
    `SELECT 1 FROM books c WHERE c.series_id = 1 AND c.series_index = 1 AND c.library_id = 'x' AND c.id <> 'y'`,
  );

  // 3. The 読書メーター Review's completions.
  if (bookmeterFile) {
    const plan = JSON.parse(fs.readFileSync(bookmeterFile, 'utf8')) as {
      changes: { list: { title: string; kind: string }[] };
    };
    let rev = 1e9;
    let n = 0;
    for (const c of plan.changes.list.filter((x) => x.kind === 'complete')) {
      const b = db
        .prepare(
          `SELECT b.id FROM books b JOIN libraries l ON l.id = b.library_id
            WHERE b.title = ? ORDER BY (l.name = 'japanese-library') DESC, b.created_at, b.id LIMIT 1`,
        )
        .get(c.title) as { id: string } | undefined;
      if (!b) continue;
      db.prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, 'book-status', ?, ?, 'rehearsal', ?, NULL, ?, ?, ?)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data`,
      ).run(
        userId,
        b.id,
        b.id,
        now,
        rev++,
        JSON.stringify({ status: 'completed', auto: true }),
        now,
      );
      n++;
    }
    now += 60_000;
    const mark3 = now;
    const [r3, ms3] = timed(() => service.round());
    console.log(
      `\n3. 読書メーター Review: ${n} completions → ${readingSeries(db, userId).length} series you're reading` +
        `\n   round: ${JSON.stringify(r3)} in ${ms3.toFixed(1)} ms, decisions ${JSON.stringify(reasons(mark3))}`,
    );
    showMessages('after the Review');
  }

  // 4. Made-up arrivals in a series you're reading.
  const pick = db
    .prepare(
      `SELECT s.library_id AS lib, s.series_id AS sid, MAX(b.series_index) AS top
         FROM series_arrival_series s JOIN books b ON b.series_id = s.series_id AND b.library_id = s.library_id
        WHERE s.user_id = ? GROUP BY s.library_id, s.series_id ORDER BY s.series_id LIMIT 1`,
    )
    .get(userId) as { lib: string; sid: number; top: number };
  const other = db.prepare('SELECT id FROM libraries WHERE id <> ? LIMIT 1').get(pick.lib) as {
    id: string;
  };
  now += 60_000;
  const add = (title: string, lib: string, sid: number | null, idx: number | null) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO books (id, library_id, title, series_id, series_index, added_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, lib, title, sid, idx, now, now, now);
    db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, created_at, updated_at)
       VALUES (?, ?, 'calibre', ?, ?, ?, ?)`,
    ).run(randomUUID(), id, lib, randomUUID(), now, now);
    return id;
  };
  const name = seriesName(pick.sid);
  const next = Math.floor(pick.top) + 1;
  add(`${name} ${next} (made up)`, pick.lib, pick.sid, next);
  add(`${name} 1 (a copy, made up)`, pick.lib, pick.sid, 1);
  add(`${name} ${next}.1 (bonus, made up)`, pick.lib, pick.sid, next + 0.1);
  add(`${name} 1-3 (omnibus, made up)`, pick.lib, pick.sid, 3.9);
  add(`${name} ${next + 1} (other library, made up)`, other.id, pick.sid, next + 1);
  add(`no series (made up)`, pick.lib, null, null);
  now += 60_000;
  doneBefore = -Infinity;
  const r4a = service.round();
  doneBefore = now;
  const mark4 = now;
  const r4b = service.round();
  console.log(
    `\n4. made-up arrivals in ${libName(pick.lib)} / ${name}: run open ${JSON.stringify(r4a)}, ` +
      `after it ${JSON.stringify(r4b)}`,
  );
  for (const t of db
    .prepare(
      `SELECT b.title, d.reason FROM series_arrival_books d JOIN books b ON b.id = d.book_id
        WHERE d.decided_at >= ? ORDER BY b.title`,
    )
    .all(mark4) as { title: string; reason: string }[])
    console.log(`     ${t.reason.padEnd(13)} ${t.title}`);
  showMessages('made-up arrivals');
} finally {
  db.exec('ROLLBACK');
  db.close();
}
console.log('\nrolled back: the copy keeps only the migration');
