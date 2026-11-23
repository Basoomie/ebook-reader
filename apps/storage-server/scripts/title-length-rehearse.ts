/**
 * Titles too long for a Calibre folder, stop C: the Preview, rehearsed on working copies of the
 * live databases with the branch's own code (nothing is written anywhere but the working copy):
 *   1. the held proposals before (the live copy as it is), cleanup.db v26 applied (the holds of
 *      stages 2 and 5 opened again);
 *   2. stage 4's one-time pass (TITLE_FIT_VERSION) on the copy: its held books proposed again;
 *   3. every title a write would fit now, the way the planner does (fitTitle with Calibre's
 *      current first author): stage 2's opened title changes, Calibre's own titles of the books
 *      whose other changes wait (stages 4 and 5), and every Calibre title too long today;
 *   4. the new arrivals' files the WP20g Preview read whose title is too long (the live export);
 *   5. the invariants: every name fits, no volume number lost, labeled books reported apart.
 * Writes preview.md and preview.json.
 *
 *   npx ts-node --transpile-only scripts/title-length-rehearse.ts --db <live cleanup.db copy>
 *     --work <dir> --main <ttsu.db copy> --metadata <metadata.db copy> --calibre <books folder>
 *     --export <export.json> --gold <gold800.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { calibreNameBytes, NAME_MAX_BYTES } from '../src/cleanup/calibre-names';
import { mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { nums } from '../src/cleanup/stage4/pick';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { printedNumber } from '../src/cleanup/stage4/series-order';
import { fitTitle, UNKNOWN_ID } from '../src/cleanup/title-fit';
import { nfkc } from '../src/cleanup/title-rules';
import { migrateWorkingCopy } from './lib/cleanup-ai';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) throw new Error(`missing --${n}`);
  return process.argv[i + 1];
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const LONG = 'Too long for a folder name%';

interface Row {
  group: string;
  calibreId: number | string;
  stage: string;
  step: string;
  rules: string[];
  before: string;
  after: string;
  bytes: number;
  number: string;
  numberOk: boolean;
  label: string | null;
  note: string;
}

function volumeOf(t: string, series: string | null): string {
  const name =
    series ??
    nfkc(t)
      .replace(/^[【[].*?[】\]]\s*/u, '')
      .split(/[～~〜―─:：（(【\s]|\d/u)[0];
  const n = name ? printedNumber(t, name) : null;
  return n === null ? '-' : `#${n}`;
}

/** The volume number read from the title before is still in the title after. */
function kept(v0: string, v1: string, after: string): boolean {
  if (v0 === v1 || v0 === '-') return true;
  return nums(after).has(Number(v0.slice(1)));
}

async function main() {
  const work = arg('work');
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, 'cleanup.db');
  for (const x of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(x, { force: true });
  fs.copyFileSync(arg('db'), file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const meta = new Database(arg('metadata'), { readonly: true, fileMustExist: true });
  const gold = JSON.parse(fs.readFileSync(arg('gold'), 'utf8')) as Record<string, { t: string }>;
  const exp = JSON.parse(fs.readFileSync(arg('export'), 'utf8'));

  // ---- the books, from Calibre's metadata.db as the reader last copied it
  const books = new Map<
    number,
    {
      id: number;
      uuid: string;
      title: string;
      path: string;
      authors: string[];
      series: string | null;
    }
  >();
  const authorsOf = meta.prepare(
    'SELECT a.name FROM books_authors_link l JOIN authors a ON a.id = l.author WHERE l.book = ? ORDER BY l.id',
  );
  for (const b of meta
    .prepare(
      `SELECT b.id, b.uuid, b.title, b.path, (SELECT s.name FROM books_series_link l JOIN series s ON s.id = l.series WHERE l.book = b.id) AS series FROM books b`,
    )
    .all() as { id: number; uuid: string; title: string; path: string; series: string | null }[])
    books.set(b.id, {
      ...b,
      authors: (authorsOf.all(b.id) as { name: string }[]).map((x) => x.name),
    });

  // ---- 1. before: the holds as the live copy has them
  const before = db
    .prepare(
      `SELECT id, stage, calibre_id, calibre_uuid, field, class, review_reason, new_json, decided_by
       FROM proposed_changes WHERE state = 'proposed' AND review_reason LIKE ?`,
    )
    .all(LONG) as {
    id: number;
    stage: number;
    calibre_id: number;
    calibre_uuid: string;
    field: string;
    class: string;
    review_reason: string;
    new_json: string;
    decided_by: string | null;
  }[];
  log(
    `held before: ${before.length} proposals of ${new Set(before.map((x) => x.calibre_id)).size} books`,
  );
  const v0 = db.pragma('user_version', { simple: true });
  migrateWorkingCopy(db);
  log(`cleanup.db ${v0} -> ${db.pragma('user_version', { simple: true })}`);
  const reopened = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proposed_changes WHERE id IN (${before.map((x) => x.id).join(',') || 0}) AND class = 'auto'`,
    )
    .get() as { n: number };
  log(`opened again by the migration: ${reopened.n}`);

  // ---- 2. stage 4's one-time pass on the copy
  const p0 = getStage(db, 4).progress as unknown as Stage4Progress;
  const cacheDir = path.join(work, 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p0.libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata'), snap);
  const mainDb = new Database(arg('main'), { readonly: true, fileMustExist: true });
  const fetchDir = path.join(work, 'fetch-empty');
  fs.mkdirSync(fetchDir, { recursive: true });
  const queue = new FetchQueue(db, fetchDir, () => getSettings(db).fetch, log);
  const analysis = new Stage4Analysis({
    cleanup: db,
    main: mainDb,
    calibreDir: arg('calibre'),
    cacheDir,
    dbDir: null,
    queue,
    log,
  });
  const p = getStage(db, 4).progress as unknown as Stage4Progress;
  const s4before = before.filter((x) => x.stage === 4);
  const classesBefore = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT calibre_uuid, field, class, review_reason FROM proposed_changes WHERE stage = 4 AND state = 'proposed'
       AND calibre_uuid IN (${[...new Set(s4before.map((x) => `'${x.calibre_uuid}'`))].join(',') || "''"})`,
    )
    .all() as {
    calibre_uuid: string;
    field: string;
    class: string;
    review_reason: string | null;
  }[])
    classesBefore.set(`${r.calibre_uuid}|${r.field}`, `${r.class}: ${r.review_reason ?? ''}`);
  const t4 = Date.now();
  await (analysis as unknown as { titleFitStep(p: Stage4Progress): Promise<void> }).titleFitStep(p);
  log(`stage 4 pass: ${p.titleFit?.books} books in ${Date.now() - t4} ms`);
  const s4after = db
    .prepare(
      `SELECT calibre_id, calibre_uuid, field, class, review_reason, old_json, new_json, evidence_json
       FROM proposed_changes WHERE stage = 4 AND state = 'proposed'
         AND calibre_uuid IN (${[...new Set(s4before.map((x) => `'${x.calibre_uuid}'`))].join(',') || "''"})
       ORDER BY calibre_id, field`,
    )
    .all() as {
    calibre_id: number;
    calibre_uuid: string;
    field: string;
    class: string;
    review_reason: string | null;
    old_json: string;
    new_json: string;
    evidence_json: string;
  }[];

  // ---- labels
  const labelOf = new Map<number, string>();
  for (const [gid, cid] of mapLabeledIds(db, p0.libraryId, Object.keys(gold)))
    labelOf.set(cid, gold[gid].t);

  const rows: Row[] = [];
  const libDir = path.join(arg('calibre'), 'japanese-library');
  const add = (
    group: string,
    id: number | string,
    stage: string,
    title: string,
    first: string,
    authors: string[],
    series: string | null,
    note = '',
  ) => {
    const cid = typeof id === 'number' ? id : UNKNOWN_ID;
    const f = fitTitle(title, { calibreId: cid, firstAuthor: first, authors });
    if (f.step === 'none') return;
    const v0 = volumeOf(title, series);
    const v1 = volumeOf(f.title, series);
    rows.push({
      group,
      calibreId: id,
      stage,
      step: f.step,
      rules: f.rules,
      before: title,
      after: f.title,
      bytes: f.bytesAfter,
      number: `${v0} → ${v1}`,
      // A number newly readable is fine; one lost is not (still printed in the title).
      numberOk: kept(v0, v1, f.title),
      label: typeof id === 'number' ? (labelOf.get(id) ?? null) : null,
      note,
    });
  };

  // ---- 3a. stage 2's opened title changes (fitted at the plan with Calibre's current author)
  const seen = new Set<string>();
  for (const h of before) {
    const b = books.get(h.calibre_id);
    if (!b) {
      if (!seen.has(`gone:${h.calibre_id}`))
        rows.push({
          group: 'held, book no longer in Calibre',
          calibreId: h.calibre_id,
          stage: `stage ${h.stage}`,
          step: 'none',
          rules: [],
          before: h.field === 'title' ? (JSON.parse(h.new_json) as string) : '',
          after: '',
          bytes: 0,
          number: '',
          numberOk: true,
          label: null,
          note: 'The planner skips it (no longer in Calibre)',
        });
      seen.add(`gone:${h.calibre_id}`);
      continue;
    }
    if (h.stage === 4) continue; // decided again by stage 4's pass (below)
    const key = `${h.stage}:${h.calibre_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const titleRow = before.find(
      (x) => x.stage === h.stage && x.calibre_id === h.calibre_id && x.field === 'title',
    );
    const authorRow = before.find(
      (x) => x.stage === h.stage && x.calibre_id === h.calibre_id && x.field === 'authors',
    );
    let first = b.authors[0] ?? 'Unknown';
    if (authorRow) {
      const a = (JSON.parse(authorRow.new_json) as string[])[0] ?? 'Unknown';
      if (calibreNameBytes(b.id, '', a) <= NAME_MAX_BYTES) first = a;
    }
    const title = titleRow ? (JSON.parse(titleRow.new_json) as string) : b.title;
    // The planner's own check: a fitted Calibre title only where the book's folder exists.
    if (!titleRow) {
      let folder = false;
      try {
        folder = fs.statSync(path.join(libDir, ...b.path.split('/'))).isDirectory();
      } catch {
        folder = false;
      }
      if (!folder) {
        rows.push({
          group: 'held, record without files (left alone, not in scope)',
          calibreId: b.id,
          stage: `stage ${h.stage}`,
          step: 'none',
          rules: [],
          before: b.title,
          after: '',
          bytes: 0,
          number: '',
          numberOk: true,
          label: null,
          note: "No folder in Calibre's library: its changes stay in review",
        });
        continue;
      }
    }
    if (calibreNameBytes(b.id, title, first) <= NAME_MAX_BYTES) {
      rows.push({
        group: `held, fits now (stage ${h.stage})`,
        calibreId: b.id,
        stage: `stage ${h.stage}`,
        step: 'none',
        rules: [],
        before: title,
        after: title,
        bytes: calibreNameBytes(b.id, title, first),
        number: '',
        numberOk: true,
        label: labelOf.get(b.id) ?? null,
        note: 'Fits as it is now (Calibre changed since it was held)',
      });
      continue;
    }
    add(
      `held, stage ${h.stage}${titleRow ? ' title change' : ': Calibre’s title'}`,
      b.id,
      `stage ${h.stage}`,
      title,
      first,
      [...b.authors],
      b.series,
    );
  }

  // ---- 3b. stage 4's held books after its pass
  const fitNotes: Row[] = [];
  for (const r of s4after) {
    if (r.field !== 'title') continue;
    const ev = JSON.parse(r.evidence_json) as {
      fit?: { from: string; step: string; rules: string[] };
    };
    if (!ev.fit) continue;
    const b = books.get(r.calibre_id);
    const after = JSON.parse(r.new_json) as string;
    const v0 = volumeOf(ev.fit.from, b?.series ?? null);
    const v1 = volumeOf(after, b?.series ?? null);
    fitNotes.push({
      group: 'held, stage 4 (decided again)',
      calibreId: r.calibre_id,
      stage: 'stage 4',
      step: ev.fit.step,
      rules: ev.fit.rules,
      before: ev.fit.from,
      after,
      bytes: calibreNameBytes(r.calibre_id, after, b?.authors[0] ?? 'Unknown'),
      number: `${v0} → ${v1}`,
      numberOk: kept(v0, v1, after),
      label: labelOf.get(r.calibre_id) ?? null,
      note: `${r.class}${r.review_reason ? `: ${r.review_reason}` : ''}`,
    });
  }
  rows.push(...fitNotes);
  const s4classes = s4after.map((r) => ({
    calibreId: r.calibre_id,
    field: r.field,
    before: classesBefore.get(`${r.calibre_uuid}|${r.field}`) ?? '(none)',
    after: `${r.class}: ${r.review_reason ?? ''}`,
  }));

  // ---- 3c. every Calibre title too long today (fitted at its next write by any stage)
  for (const b of books.values()) {
    const first = b.authors[0] ?? 'Unknown';
    if (calibreNameBytes(b.id, b.title, first) <= NAME_MAX_BYTES) continue;
    if (rows.some((r) => r.calibreId === b.id)) continue;
    if (calibreNameBytes(b.id, '', first) > NAME_MAX_BYTES) {
      rows.push({
        group: 'library: first author too long (stays in review)',
        calibreId: b.id,
        stage: '-',
        step: 'author_too_long',
        rules: [],
        before: b.title,
        after: b.title,
        bytes: 0,
        number: '',
        numberOk: true,
        label: null,
        note: first.slice(0, 40),
      });
      continue;
    }
    add(
      'library: Calibre’s title too long today',
      b.id,
      'next write',
      b.title,
      first,
      b.authors,
      b.series,
    );
  }

  // ---- 4. the new arrivals read so far
  for (const f of exp.files as { id: number; rel_path: string; outcome: string; facts: any }[]) {
    if (!(f.facts?.nameBytes > NAME_MAX_BYTES) && f.outcome !== 'too_long') continue;
    const au = (f.facts.authors ?? []) as string[];
    add(
      'new arrival (added with this title)',
      `f${f.id}`,
      'arrivals',
      f.facts.title,
      au[0] ?? 'Unknown',
      au,
      null,
      f.rel_path,
    );
  }

  // ---- 5. the invariants
  const over = rows.filter(
    (r) => r.step !== 'author_too_long' && r.step !== 'none' && r.bytes > NAME_MAX_BYTES,
  );
  const lost = rows.filter((r) => !r.numberOk);
  const steps: Record<string, number> = {};
  for (const r of rows) steps[r.step] = (steps[r.step] ?? 0) + 1;
  const groups: Record<string, number> = {};
  for (const r of rows) groups[r.group] = (groups[r.group] ?? 0) + 1;
  const report = {
    at: new Date().toISOString(),
    heldBefore: { proposals: before.length, books: new Set(before.map((x) => x.calibre_id)).size },
    reopened: reopened.n,
    stage4Pass: p.titleFit,
    steps,
    groups,
    invariants: {
      over: over.length,
      numbersLost: lost.length,
      labeled: rows.filter((r) => r.label).length,
    },
    s4classes,
    rows,
  };
  fs.writeFileSync(path.join(work, 'preview.json'), JSON.stringify(report, null, 1));
  const cell = (s: unknown) =>
    String(s ?? '')
      .replace(/\|/gu, '\\|')
      .replace(/\n/gu, ' ');
  const L: string[] = [
    '# Titles too long for a Calibre folder: stop C, the Preview',
    '',
    `Rehearsed ${report.at} on working copies (cleanup.db snapshot, metadata.db as the reader last copied it, the arrivals export); nothing written.`,
    '',
    `Held before: ${before.length} proposals of ${report.heldBefore.books} books. Opened again by cleanup.db v26: ${reopened.n}. Stage 4's pass proposed ${p.titleFit?.books ?? 0} books again.`,
    '',
    `By step: ${Object.entries(steps)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}. Invariants: names over 255 bytes ${over.length}, volume numbers lost ${lost.length}, labeled books ${report.invariants.labeled}.`,
    '',
  ];
  for (const g of Object.keys(groups)) {
    L.push(
      `## ${g} (${groups[g]})`,
      '',
      '| book | step | rules | number | before | after | note |',
      '|---|---|---|---|---|---|---|',
    );
    for (const r of rows.filter((x) => x.group === g))
      L.push(
        `| ${r.calibreId} | ${r.step} | ${r.rules.join(' + ')} | ${cell(r.number)} | ${cell(r.before)} | ${cell(r.after)} | ${cell(r.note)}${r.label ? ` · label: ${cell(r.label)}` : ''} |`,
      );
    L.push('');
  }
  L.push(
    '## Stage 4: the held books’ fields before and after its pass',
    '',
    '| book | field | before | after |',
    '|---|---|---|---|',
  );
  for (const c of s4classes)
    L.push(`| ${c.calibreId} | ${c.field} | ${cell(c.before)} | ${cell(c.after)} |`);
  fs.writeFileSync(path.join(work, 'preview.md'), L.join('\n'));
  log(
    `preview: ${rows.length} rows ${JSON.stringify(steps)}; over ${over.length}, numbers lost ${lost.length}`,
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
