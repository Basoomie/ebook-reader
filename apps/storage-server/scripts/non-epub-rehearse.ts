/**
 * Books without an EPUB: the rehearsal of what the deploy runs, on working copies of the live
 * state (non-epub-books.md; WP20 lessons 3-4). Writes only the working copies and the report.
 *
 *   npx ts-node --transpile-only scripts/non-epub-rehearse.ts --db <copy of cleanup.db>
 *     --metadata <copy of the reader's snapshot of japanese-library> --library <reader id>
 *     --out <report.json>
 *
 * 1. The migrations on the copy, each timed (38 alone: the pass's tables, batch_items' new column,
 *    calibre_known_books rebuilt with the 'format' origin: every row kept).
 * 2. The pass's select on the live snapshot (the real code): how many books, listed by reason, to
 *    convert by format, with twins; against stop 1's numbers.
 * 3. Every query the card polls, the job claim, the planner and the arrivals' changed query:
 *    EXPLAIN QUERY PLAN (no SCAN of a table that grows with the library) and timed, at the size
 *    the run ends with (every selected book proposed).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { CLEANUP_MIGRATIONS, cleanupSchemaVersion } from '../src/cleanup/cleanup-db';
import { FORMATS_STAGE } from '../src/cleanup/field-stages';
import { EpubStore } from '../src/cleanup/formats/epub-store';
import { FormatsPass } from '../src/cleanup/formats/pass';
import { nonEpubUuids } from '../src/cleanup/formats/select';
import { formatsAnalysisId } from '../src/cleanup/formats/state';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const r = fn();
  return [r, Math.round((performance.now() - t0) * 10) / 10];
};

async function main() {
  const report: Record<string, unknown> = {};
  const db = new Database(arg('db')!);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const lib = arg('library')!;
  const snapshot = arg('metadata')!;

  // ---- 1. migrations
  const from = cleanupSchemaVersion(db);
  const knownBefore = (
    db.prepare('SELECT COUNT(*) AS n FROM calibre_known_books').get() as { n: number }
  ).n;
  const byOriginBefore = db
    .prepare('SELECT origin, COUNT(*) AS n FROM calibre_known_books GROUP BY origin')
    .all();
  const times: Record<number, number> = {};
  for (const m of CLEANUP_MIGRATIONS) {
    if (m.version <= from) continue;
    const [, ms] = time(() =>
      db.transaction(() => {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      })(),
    );
    times[m.version] = ms;
    log(`migration ${m.version}: ${ms} ms (${m.name})`);
  }
  const knownAfter = (
    db.prepare('SELECT COUNT(*) AS n FROM calibre_known_books').get() as { n: number }
  ).n;
  report.migrations = {
    from,
    to: cleanupSchemaVersion(db),
    ms: times,
    knownBooks: { before: knownBefore, after: knownAfter, byOriginBefore },
    knownBooksSame:
      JSON.stringify(byOriginBefore) ===
      JSON.stringify(
        db.prepare('SELECT origin, COUNT(*) AS n FROM calibre_known_books GROUP BY origin').all(),
      ),
    integrity: db.pragma('quick_check', { simple: true }),
  };
  log(`calibre_known_books ${knownBefore} -> ${knownAfter}`);

  // ---- 2. the select on the live snapshot (the working copy's own rows of an earlier try go)
  db.exec(
    `DELETE FROM proposed_changes WHERE stage = ${FORMATS_STAGE}; DELETE FROM calibre_format_books;`,
  );
  const cacheDir = fs.mkdtempSync('nep-cache-');
  const pass = new FormatsPass({
    db,
    main: new Database(':memory:'),
    cacheDir,
    calibreDir: null,
    batches: null as never,
    writes: null as never,
    store: new EpubStore(cacheDir),
    reader: () => {
      throw new Error('no reader in the rehearsal');
    },
    libraryId: lib,
    writeWait: () => null,
    calibreLibraryOf: () => null,
  });
  const [added, selectMs] = time(() => pass.select(lib, 1, snapshot));
  const n = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
  report.select = {
    ms: selectMs,
    books: added,
    byState: n('SELECT state, COUNT(*) AS n FROM calibre_format_books GROUP BY state'),
    listed: n(
      `SELECT listed_reason, COUNT(*) AS n FROM calibre_format_books WHERE state = 'listed' GROUP BY listed_reason ORDER BY n DESC`,
    ),
    toConvertByFormat: n(
      `SELECT source_format, COUNT(*) AS n FROM calibre_format_books WHERE state = 'waiting' GROUP BY source_format ORDER BY n DESC`,
    ),
    withTwins: n(
      `SELECT COUNT(*) AS n FROM calibre_format_books WHERE state = 'waiting' AND json_array_length(twins_json) > 0`,
    ),
    seriesTitles: n(
      `SELECT calibre_id, title FROM calibre_format_books WHERE listed_reason = 'series' ORDER BY calibre_id`,
    ),
  };
  log(`select: ${added} books in ${selectMs} ms`);
  const [uuids, checkMs] = time(() => nonEpubUuids(snapshot));
  (report.select as Record<string, unknown>).doneCheck = { books: uuids.length, ms: checkMs };
  log(`the done phase's check: ${uuids.length} books without an EPUB in ${checkMs} ms`);

  // ---- 3. the queries at the run's end size: every waiting book converted, checked, proposed
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT id, calibre_id, calibre_uuid, source_format, twins_json FROM calibre_format_books WHERE state = 'waiting'`,
    )
    .all() as {
    id: number;
    calibre_id: number;
    calibre_uuid: string;
    source_format: string;
    twins_json: string;
  }[];
  const ins = db.prepare(
    `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
       evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
     VALUES (${FORMATS_STAGE}, ?, ?, ?, ?, '[]', '{}', 'formats', ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
  );
  const [, fillMs] = time(() =>
    db.transaction(() => {
      for (const r of rows) {
        const fold = JSON.parse(r.twins_json).length > 0;
        const id = ins.run(
          lib,
          r.calibre_id,
          r.calibre_uuid,
          fold ? 'fold' : 'epub',
          JSON.stringify({ kind: fold ? 'fold' : 'convert', facts: { group: 'text' } }),
          formatsAnalysisId(1),
          now,
          now,
        ).lastInsertRowid;
        db.prepare(
          `UPDATE calibre_format_books SET state = 'proposed', change_id = ?, result_json = ?, check_json = ?,
             compare_json = ? WHERE id = ?`,
        ).run(
          id,
          JSON.stringify({ ms: 14000 }),
          JSON.stringify({ ms: 700 }),
          JSON.stringify({ ms: 900 }),
          r.id,
        );
      }
    })(),
  );
  log(`filled ${rows.length} proposals in ${fillMs} ms`);
  const plans: Record<string, { plan: string[]; ms: number }> = {};
  const explain = (name: string, sql: string, ...p: unknown[]) => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map(
      (r) => r.detail,
    );
    const [, ms] = time(() => db.prepare(sql).all(...p));
    plans[name] = { plan, ms };
  };
  explain(
    'claim: running',
    `SELECT 1 FROM calibre_format_books INDEXED BY calibre_format_books_state WHERE library_id = ? AND state = 'converting' LIMIT 1`,
    lib,
  );
  explain(
    'claim: next',
    `SELECT * FROM calibre_format_books INDEXED BY calibre_format_books_state WHERE library_id = ? AND state = 'waiting' ORDER BY id LIMIT 1`,
    lib,
  );
  explain(
    'planner',
    `SELECT id FROM proposed_changes INDEXED BY proposed_changes_formats WHERE stage = ${FORMATS_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'proposed' AND class = 'auto' ORDER BY id LIMIT 200`,
    lib,
    formatsAnalysisId(1),
  );
  explain(
    'card: proposals',
    `SELECT field, class, state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_formats WHERE stage = ${FORMATS_STAGE} AND library_id = ? GROUP BY field, class, state`,
    lib,
  );
  explain(
    'arrivals: hand and format books',
    `SELECT calibre_id, added_at FROM calibre_known_books INDEXED BY calibre_known_books_waiting WHERE library_id = ? AND origin IN ('hand', 'format') AND run_id IS NULL`,
    lib,
  );
  const [, countsMs] = time(() => pass.counts(lib));
  const [, barsMs] = time(() => pass.bars(lib));
  const [, listMs] = time(() => pass.list(lib, 'convert', 0, 20));
  report.queries = { plans, countsMs, barsMs, listMs, fillMs, proposals: rows.length };
  const scans = Object.entries(plans).filter(([, v]) =>
    v.plan.some((d) => /^SCAN (proposed_changes|calibre_known_books|batch_items)/.test(d)),
  );
  report.scansOfBigTables = scans.map(([k]) => k);
  log(
    `card: counts ${countsMs} ms, bars ${barsMs} ms, list ${listMs} ms; scans of big tables: ${scans.length}`,
  );
  fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  db.close();
}

void main();
