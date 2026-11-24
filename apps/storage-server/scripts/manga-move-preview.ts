/**
 * Manga part A, stop 1: the move's Preview on one-step copies of the live state (the reader's
 * snapshot of the library, ttsu.db, cleanup.db made with VACUUM INTO on the NAS). Runs the real
 * pass (select and the spot check) on working copies, times the migration and every step, and
 * reports: counts by tag, the held books and why (with examples), the mokuro ZIP books, the books
 * with a format tag and real text, the books with reading data, the cleanup's state that would
 * follow each book (rows per table), the labeled books among them, and the 30-book spot check
 * with links to each book's page. Writes only the working copies and the report.
 *
 *   npx ts-node --transpile-only scripts/manga-move-preview.ts --db <cleanup copy> --ttsu <ttsu copy>
 *     --metadata <snapshot copy> --work <empty folder> --out <report.md> [--labels <gold800.json>]
 *     [--app http://192.168.1.5:3080]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { listLibraries } from '../src/calibre/libraries';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { booksWithReaderData } from '../src/cleanup/handoff';
import { MovePass } from '../src/cleanup/move/pass';
import { CALIBRE_AI_STAGES } from '../src/cleanup/move/rekey';
import { getMoveState, moveAnalysisId } from '../src/cleanup/move/state';
import type { MoveEvidence } from '../src/cleanup/move/move-batches';
import { MOVE_STAGE } from '../src/cleanup/field-stages';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const n = (x: number) => x.toLocaleString('en-US');

async function main() {
  const work = arg('work')!;
  const app = arg('app') ?? 'http://192.168.1.5:3080';
  fs.mkdirSync(work, { recursive: true });
  const dbFile = path.join(work, 'cleanup.db');
  const ttsuFile = path.join(work, 'ttsu.db');
  fs.copyFileSync(arg('db')!, dbFile);
  fs.copyFileSync(arg('ttsu')!, ttsuFile);
  let t = performance.now();
  const db = openCleanupDatabase(dbFile);
  const migrateMs = Math.round(performance.now() - t);
  log(`cleanup.db migrated to v${db.pragma('user_version', { simple: true })} in ${migrateMs} ms`);
  const main = new Database(ttsuFile);
  const libs = listLibraries(main);
  const lib = libs.find((l) => l.folder === 'japanese-library')!.id;
  const target = libs.find((l) => l.folder === 'manga-library');
  const cacheDir = path.join(work, 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata')!, snap);
  const pass = new MovePass({
    db,
    main,
    cacheDir,
    batches: null as never,
    sourceLibrary: () => lib,
    writeWait: () => 'Preview only',
    withData: (ids) => booksWithReaderData(main, ids),
    log,
  });
  pass.setMode('analyse');
  const steps: { phase: string; ms: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const phase = getMoveState(db).progress.phase;
    t = performance.now();
    const r = await pass.step();
    steps.push({ phase, ms: Math.round(performance.now() - t) });
    if (r !== 'more') break;
  }
  const st = getMoveState(db);
  const p = st.progress;
  log(`phase ${p.phase}: ${JSON.stringify(p.counts)}`);

  const rows = db
    .prepare(
      `SELECT id, calibre_id, calibre_uuid, class, state, evidence_json FROM proposed_changes
       WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ?`,
    )
    .all(lib, moveAnalysisId(p.run)) as {
    id: number;
    calibre_id: number;
    calibre_uuid: string;
    class: string;
    state: string;
    evidence_json: string;
  }[];
  const books = rows.map((r) => ({ ...r, ev: JSON.parse(r.evidence_json) as MoveEvidence }));
  const auto = books.filter((b) => b.class === 'auto');
  const heldBooks = books.filter((b) => b.class === 'review');
  const byTag = { manga: 0, image: 0, both: 0 };
  for (const b of books) {
    const m = b.ev.matched;
    if (m.length > 1) byTag.both++;
    else if (m[0] === 'マンガ') byTag.manga++;
    else byTag.image++;
  }
  const bookLink = (b: (typeof books)[number]) =>
    b.ev.readerBookId ? `${app}/library/book?id=${b.ev.readerBookId}` : '(not in the reader)';
  const line = (b: (typeof books)[number]) =>
    `- ${b.calibre_id} 「${b.ev.title}」 ${b.ev.authors.slice(0, 2).join(', ')} · ${b.ev.matched.join('+')} · ${b.ev.chars === null ? 'no count' : `${n(b.ev.chars)} chars`} · ${b.ev.formats.join(',')}${b.ev.holdDetail ? ` · ${b.ev.holdDetail}` : ''} · ${bookLink(b)}`;

  // The mokuro ZIP books: every book of the library with a ZIP (or CBZ) format.
  const sdb = new Database(snap, { readonly: true });
  const zips = sdb
    .prepare(
      `SELECT b.id, b.title, group_concat(d.format) AS formats,
         (SELECT group_concat(t.name) FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = b.id) AS tags
       FROM books b JOIN data d ON d.book = b.id
       WHERE b.id IN (SELECT book FROM data WHERE format IN ('ZIP', 'CBZ'))
       GROUP BY b.id ORDER BY b.id`,
    )
    .all() as { id: number; title: string; formats: string; tags: string | null }[];
  const mokuro = zips.filter((z) => /mokuro/i.test(z.title));
  const zipTagged = zips.filter((z) => /(^|,)(マンガ|画像のみ)(,|$)/.test(z.tags ?? ''));
  const zipWithEpub = zips.filter((z) => z.formats.split(',').includes('EPUB'));
  sdb.close();

  // What the cleanup knows about the books to move (rows that would follow each book).
  const tables = [
    'proposed_changes',
    'applied_values',
    'user_fields',
    'calibre_marks',
    'evidence_records',
    'stage4_books',
    'stage4_series_order',
    'calibre_title_fits',
    'calibre_seen_changes',
    'bookmeter_more_books',
  ];
  const follow: Record<string, number> = {};
  const qs = Object.fromEntries(
    tables.map((tb) => [
      tb,
      db.prepare(
        `SELECT COUNT(*) AS n FROM ${tb} WHERE library_id = ? AND calibre_uuid = ?${tb === 'proposed_changes' ? ` AND field <> 'book'` : ''}`,
      ),
    ]),
  );
  const ai = db.prepare(
    `SELECT COUNT(*) AS n FROM ai_values WHERE stage IN (${CALIBRE_AI_STAGES.map(() => '?').join(',')}) AND item_key = ?`,
  );
  const open = db.prepare(
    `SELECT stage, class, COUNT(*) AS n FROM proposed_changes WHERE library_id = ? AND calibre_uuid = ?
       AND state = 'proposed' AND field <> 'book' GROUP BY stage, class`,
  );
  const openBy: Record<string, number> = {};
  t = performance.now();
  for (const b of auto) {
    for (const tb of tables)
      follow[tb] = (follow[tb] ?? 0) + (qs[tb].get(lib, b.calibre_uuid) as { n: number }).n;
    follow.ai_values =
      (follow.ai_values ?? 0) +
      (ai.get(...CALIBRE_AI_STAGES, `${lib}:${b.calibre_uuid}`) as { n: number }).n;
    for (const r of open.all(lib, b.calibre_uuid) as { stage: number; class: string; n: number }[])
      openBy[`stage ${r.stage} ${r.class}`] = (openBy[`stage ${r.stage} ${r.class}`] ?? 0) + r.n;
  }
  const followMs = Math.round(performance.now() - t);
  const yoursBooks = auto.filter(
    (b) => (qs.user_fields.get(lib, b.calibre_uuid) as { n: number }).n > 0,
  ).length;

  // Labeled books among them (the gates' reference: gold800.json keyed by Calibre id).
  let labeled: {
    auto: number;
    held: number;
    ids: number[];
    wrong: string[];
    missed: string[];
    labeledImageBooks: number;
  } | null = null;
  if (arg('labels') && fs.existsSync(arg('labels')!)) {
    const gold = JSON.parse(fs.readFileSync(arg('labels')!, 'utf8')) as Record<
      string,
      { t?: string; fmt?: string }
    >;
    const keys = new Set(Object.keys(gold).map(Number));
    const a = auto.filter((b) => keys.has(b.calibre_id)).map((b) => b.calibre_id);
    const isImage = (f?: string) => f === 'manga' || f === 'image-only';
    const moving = new Set(a);
    // A labeled book the move takes whose label is not manga/image-only is a wrong move; a
    // labeled manga/image-only book still in the library and not moved is a missed one.
    const present = new Set(
      (
        new Database(snap, { readonly: true }).prepare('SELECT id FROM books').all() as {
          id: number;
        }[]
      ).map((r) => r.id),
    );
    labeled = {
      auto: a.length,
      held: heldBooks.filter((b) => keys.has(b.calibre_id)).length,
      ids: a,
      wrong: a
        .filter((id) => !isImage(gold[id].fmt))
        .map((id) => `${id} ${gold[id].t} (${gold[id].fmt})`),
      missed: Object.entries(gold)
        .filter(([id, g]) => isImage(g.fmt) && present.has(Number(id)) && !moving.has(Number(id)))
        .map(([id, g]) => `${id} ${g.t} (${g.fmt})`),
      labeledImageBooks: Object.values(gold).filter((g) => isImage(g.fmt)).length,
    };
  }

  // Reading data: what kind.
  const withData = books.filter((b) => b.ev.readerHasData);
  const kinds = main
    .prepare(
      `SELECT kind, COUNT(DISTINCT book_id) AS n FROM sync_records WHERE deleted_at IS NULL AND book_id IN (${withData.map(() => '?').join(',') || "''"}) GROUP BY kind ORDER BY n DESC`,
    )
    .all(...withData.map((b) => b.ev.readerBookId)) as { kind: string; n: number }[];

  const spot = pass.spotList();
  const held = (reason: string) => heldBooks.filter((b) => b.ev.hold === reason);
  const md: string[] = [];
  md.push(`# Manga part A, stop 1: the Preview on one-step copies (${new Date().toISOString()})`);
  md.push('');
  md.push(`- cleanup.db v32 → v33 migration on the live-size copy: ${n(migrateMs)} ms`);
  md.push(`- Steps: ${steps.map((s) => `${s.phase} ${n(s.ms)} ms`).join(', ')}`);
  md.push(
    `- The target library in the reader: ${target ? `${target.folder} (${target.id}), ${target.enabled ? 'on' : 'OFF'}, language ${target.language ?? 'not set'}` : 'not found'}`,
  );
  md.push('');
  md.push('## Counts');
  md.push(
    `- Tagged マンガ or 画像のみ: ${n(books.length)} (マンガ only ${n(byTag.manga)}, 画像のみ only ${n(byTag.image)}, both ${n(byTag.both)})`,
  );
  md.push(`- To move automatically: ${n(auto.length)}`);
  md.push(`- Held for review: ${n(heldBooks.length)} ${JSON.stringify(p.counts.held)}`);
  md.push(
    `- With reading data: ${n(withData.length)} (${n(withData.filter((b) => b.class === 'auto').length)} to move, ${n(withData.filter((b) => b.class === 'review').length)} held); kinds: ${kinds.map((k) => `${k.kind} ${n(k.n)}`).join(', ')}`,
  );
  md.push('');
  for (const reason of ['real_text', 'no_epub', 'no_count', 'too_long', 'not_in_reader']) {
    const list = held(reason);
    if (!list.length) continue;
    md.push(`## Held: ${reason} (${n(list.length)})`);
    for (const b of list.slice(0, 25)) md.push(line(b));
    if (list.length > 25) md.push(`- … ${n(list.length - 25)} more`);
    md.push('');
  }
  md.push('## The mokuro ZIP books');
  md.push(
    `- Books with a ZIP or CBZ format: ${n(zips.length)}; titled "mokuro": ${n(mokuro.length)}; tagged マンガ/画像のみ: ${n(zipTagged.length)}; with an EPUB too: ${n(zipWithEpub.length)}`,
  );
  for (const z of zips.slice(0, 15))
    md.push(`- ${z.id} 「${z.title}」 ${z.formats} · tags ${z.tags ?? '-'}`);
  md.push('');
  md.push('## What follows each book (rows re-keyed to its new identity)');
  md.push(
    `- ${Object.entries(follow)
      .map(([k, v]) => `${k} ${n(v)}`)
      .join(', ')} (read in ${n(followMs)} ms)`,
  );
  md.push(
    `- Open proposals of these books: ${
      Object.entries(openBy)
        .map(([k, v]) => `${k} ${n(v)}`)
        .join(', ') || 'none'
    }`,
  );
  md.push(`- Books with fields that are yours: ${n(yoursBooks)}`);
  if (labeled) {
    md.push(
      `- Labeled books (gold800) among them: ${n(labeled.auto)} to move (${labeled.ids.join(', ')}), ${n(labeled.held)} held`,
    );
    md.push(
      `- Against the labels (${n(labeled.labeledImageBooks)} labeled manga/image-only): moved but labeled otherwise ${n(labeled.wrong.length)}${labeled.wrong.length ? `: ${labeled.wrong.join('; ')}` : ''}; labeled manga/image-only not moved ${n(labeled.missed.length)}${labeled.missed.length ? `: ${labeled.missed.join('; ')}` : ''}`,
    );
  }
  md.push('');
  md.push(`## The spot check (${spot.length} books)`);
  for (const s of spot)
    md.push(
      `- ${s.calibreId} 「${s.title}」 ${s.authors.slice(0, 2).join(', ')} · ${s.matched.join('+')} · ${s.chars === null ? '-' : `${n(s.chars)} chars`} · ${s.readerBookId ? `${app}/library/book?id=${s.readerBookId}` : ''}`,
    );
  fs.writeFileSync(arg('out')!, md.join('\n') + '\n');
  fs.writeFileSync(
    arg('out')!.replace(/\.md$/, '.json'),
    JSON.stringify(
      {
        counts: p.counts,
        byTag,
        steps,
        migrateMs,
        follow,
        openBy,
        labeled,
        zips: zips.length,
        spot,
      },
      null,
      2,
    ),
  );
  log(`report: ${arg('out')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
