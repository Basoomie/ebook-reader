/**
 * Replaced books: the real pass (inherit/pass.ts) in Preview on WORKING COPIES of cleanup.db and
 * ttsu.db, with Calibre's metadata.db copy: every replacement looked at, the proposals counted by
 * field, each proposal's "before" compared with what Calibre holds now (the write's check skips a
 * book whose value differs), the five series of the user's report listed, and the polled queries
 * explained and timed at the end size. Nothing is written to Calibre (the planner is never
 * called). Never point it at a live database: it migrates and writes the copy it is given.
 *
 *   npx ts-node --transpile-only scripts/inherit-rehearse.ts --db <working cleanup.db>
 *     --main <working ttsu.db> --metadata <metadata.db copy> [--out <report.json>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { performance } from 'perf_hooks';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { INHERIT_ANALYSIS, InheritPass } from '../src/cleanup/inherit/pass';
import { fieldEquals } from '../src/cleanup/stage2-batches';
import { migrate } from '../src/db/migrations';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function refuseLive(p: string) {
  if (!p || /^[\\/]{2}|^[A-Z]:[\\/]ttsu|appdata|[\\/]db[\\/]cleanup\.db$/i.test(p))
    throw new Error(`Refusing a path that may be live: ${p}`);
}

const FIVE = [/小市民/, /物語/, /この素晴らしい世界に祝福を/, /本好きの下剋上/, /薬屋のひとりごと/];

function calibreCurrent(meta: Database.Database) {
  const cc = meta.prepare(`SELECT id FROM custom_columns WHERE label = 'illustrator'`).get() as
    | { id: number }
    | undefined;
  const ill = cc
    ? (meta
        .prepare(
          `SELECT l.book, v.value FROM books_custom_column_${cc.id}_link l
           JOIN custom_column_${cc.id} v ON v.id = l.value ORDER BY l.id`,
        )
        .all() as { book: number; value: string }[])
    : [];
  const by = <T>(rows: { book: number }[], f: (r: never) => T) => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      const l = m.get(r.book) ?? [];
      l.push(f(r as never));
      m.set(r.book, l);
    }
    return m;
  };
  const ids = by(
    meta.prepare('SELECT book, type, val FROM identifiers').all() as never[],
    (r: { type: string; val: string }) => [r.type, r.val] as const,
  );
  const series = new Map(
    (
      meta
        .prepare(
          `SELECT b.id AS book, s.name, b.series_index AS idx FROM books b
           JOIN books_series_link l ON l.book = b.id JOIN series s ON s.id = l.series`,
        )
        .all() as { book: number; name: string; idx: number }[]
    ).map((r) => [r.book, r]),
  );
  const pub = new Map(
    (
      meta
        .prepare(
          `SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher`,
        )
        .all() as { book: number; name: string }[]
    ).map((r) => [r.book, r.name]),
  );
  const langs = by(
    meta
      .prepare(
        `SELECT l.book, g.lang_code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code ORDER BY l.item_order`,
      )
      .all() as never[],
    (r: { lang_code: string }) => r.lang_code,
  );
  const tags = by(
    meta
      .prepare(`SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag`)
      .all() as never[],
    (r: { name: string }) => r.name,
  );
  const illus = by(ill as never[], (r: { value: string }) => r.value);
  return (id: number) => ({
    title: '',
    authors: [],
    authorSort: '',
    uuid: '',
    hasCover: false,
    lastModified: null,
    comments: '',
    identifiers: Object.fromEntries(ids.get(id) ?? []),
    series: series.get(id)?.name ?? null,
    seriesIndex: series.get(id)?.idx ?? null,
    publisher: pub.get(id) ?? '',
    languages: langs.get(id) ?? [],
    illustrators: illus.get(id) ?? [],
    tags: tags.get(id) ?? [],
  });
}

async function main() {
  for (const k of ['db', 'main', 'metadata']) refuseLive(arg(k)!);
  const db = new Database(arg('db')!);
  db.pragma('journal_mode = WAL');
  const main = new Database(arg('main')!);
  const quiet = console.log;
  console.log = () => undefined;
  try {
    migrateCleanup(db, { beforeAiMove: () => undefined });

    migrate(main);
  } finally {
    console.log = quiet;
  }
  const meta = new Database(arg('metadata')!, { readonly: true });
  const libs = db.prepare(`SELECT DISTINCT library_id AS l FROM undo_records`).all() as {
    l: string;
  }[];
  const report: Record<string, unknown> = {};
  for (const { l: lib } of libs) {
    const pass = new InheritPass(
      {
        db,
        main,
        batches: {
          stage2: { plan: async () => ({ batch: null, reason: 'rehearsal' }) },
          stage4: { plan: async () => ({ batch: null, reason: 'rehearsal' }) },
          stage5: { plan: async () => ({ batch: null, reason: 'rehearsal' }) },
        },
        writeWait: () => 'rehearsal',
      },
      lib,
    );
    pass.setMode('analyse');
    const t0 = performance.now();
    let steps = 0;
    const stepMs: number[] = [];
    for (;;) {
      const s = performance.now();
      const r = await pass.step();
      stepMs.push(performance.now() - s);
      steps++;
      if (r !== 'more') break;
    }
    const view = pass.view(0, 0);
    if (!view.total && !Object.keys(view.books).length) continue;
    // Each proposal's "before" against Calibre now (the write's check).
    const current = calibreCurrent(meta);
    const rows = db
      .prepare(
        `SELECT id, calibre_id, field, old_json, new_json, json_extract(evidence_json, '$.title') AS title
         FROM proposed_changes WHERE source = 'inherit' AND library_id = ? AND analysis_id = ?`,
      )
      .all(lib, INHERIT_ANALYSIS) as {
      id: number;
      calibre_id: number;
      field: string;
      old_json: string;
      new_json: string;
      title: string;
    }[];
    const differs: unknown[] = [];
    for (const r of rows) {
      const cur = current(r.calibre_id);
      const ok =
        r.field === 'tags'
          ? true
          : fieldEquals(
              r.field,
              cur as never,
              JSON.parse(r.old_json) ?? (r.field === 'identifiers' ? {} : null),
              false,
            );
      if (!ok)
        differs.push({
          id: r.calibre_id,
          title: r.title,
          field: r.field,
          before: r.old_json,
          calibre:
            r.field === 'identifiers'
              ? cur.identifiers
              : r.field === 'series'
                ? [cur.series, cur.seriesIndex]
                : (cur as Record<string, unknown>)[r.field],
        });
    }
    const five = rows
      .filter((r) => FIVE.some((p) => p.test(r.title ?? '')))
      .map((r) => `${r.calibre_id} ${r.title} | ${r.field}: ${r.old_json} -> ${r.new_json}`);
    // The polled queries at the end size.
    const plans: Record<string, string[]> = {};
    const explain = (name: string, sql: string, ...p: unknown[]) => {
      plans[name] = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map(
        (x) => x.detail,
      );
    };
    explain(
      'counts',
      `SELECT state, COUNT(*) FROM proposed_changes WHERE source = 'inherit' AND library_id = ? AND analysis_id = 'inherit' GROUP BY state`,
      lib,
    );
    explain(
      'open',
      `SELECT COUNT(*) FROM proposed_changes WHERE source = 'inherit' AND library_id = ? AND analysis_id = 'inherit' AND state IN ('proposed', 'queued') AND class = 'auto'`,
      lib,
    );
    const timed = (fn: () => unknown) => {
      const s = performance.now();
      for (let i = 0; i < 20; i++) fn();
      return Math.round(((performance.now() - s) / 20) * 100) / 100;
    };
    report[lib] = {
      steps,
      totalMs: Math.round(performance.now() - t0),
      maxStepMs: Math.round(Math.max(...stepMs)),
      books: view.books,
      fields: view.fields,
      proposals: rows.length,
      beforeDiffersFromCalibre: differs.length,
      differs: differs.slice(0, 40),
      five,
      plans,
      pollMs: {
        pending: timed(() => pass.step()),
        counts: timed(() => pass.counts()),
        open: timed(() => pass.open()),
        view: timed(() => pass.view(0)),
      },
    };
  }
  const out = JSON.stringify(report, null, 1);
  if (arg('out')) fs.writeFileSync(arg('out')!, out);
  console.log(out);
}

void main();
