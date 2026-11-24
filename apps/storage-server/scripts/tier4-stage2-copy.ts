/**
 * Tier 4, part 1 (cleanup-finish.md): stage 2's "Run the analysis again", rehearsed on working
 * copies of the live databases with the branch's own code. Nothing is written to Calibre, to the
 * NAS or to the inputs: only the working copy in --work.
 *
 * What it does, as the button does: Stage2Analysis.restart + step until done (read → propose →
 * the gate), on a working copy of cleanup.db, with the reader's metadata.db snapshot as Calibre's
 * view. Two inputs replace reading the share for every book:
 *   --files  a listing made on the NAS (`find … -printf '%s\t%T@\t%P\n'` in the library folder):
 *            each book's EPUB and cover.jpg are looked at in it instead of 52,000 stats over SMB;
 *            a book whose EPUB has the size and mtime the stored evidence recorded is the same file
 *            in a moved folder (every Calibre write renames), so its evidence moves with it (the
 *            analysis' own reuse rule, minus the path). Anything else is read from --calibre.
 *   --assume-unchanged  (no listing; a dry pass before the NAS can be read) every EPUB and cover
 *            counts as unchanged since stage 2 read it. Covers stage 4 wrote are then not seen:
 *            the report says so.
 *
 * The report (report.md, report.json, beyond.csv in --work):
 *   (a) the 94 unwritten books (maintenance-todo "Stage 2 leftovers"): what each would write now;
 *   (b) every change proposed beyond them: field, Calibre's value now, the proposed value, class,
 *       reason, who last wrote Calibre's value (stage 4, stage 5, your edit, …) and whether the
 *       guard "never over a value another stage wrote that Calibre still holds" would drop it;
 *   (c) the review list before and after; (d) the gate; (e) book 29728; (f) the 11 records
 *       without files and their EPUBs among the new arrivals.
 *
 *   npx ts-node --transpile-only scripts/tier4-stage2-copy.ts --db <cleanup.db copy>
 *     --main <ttsu.db copy> --metadata <reader's metadata.db snapshot copy> --work <dir>
 *     --gold <gold800.json> (--files <listing.tsv> [--calibre <books folder>] | --assume-unchanged)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getLibrary } from '../src/calibre/libraries';
import { statFile, type SourceStat } from '../src/calibre/source-fs';
import { folderTooLong, recordsWithoutFiles, sameText } from '../src/cleanup/empty-records';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { loadEvidence, saveEvidence, Stage2Analysis } from '../src/cleanup/stage2';
import { readStage2Snapshot } from '../src/cleanup/stage2-snapshot';
import { listFieldPauses } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { migrateWorkingCopy } from './lib/cleanup-ai';

const has = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? null : process.argv[i + 1];
};
const arg = (n: string) => {
  const v = opt(n);
  if (v === null) throw new Error(`missing --${n}`);
  return v;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

/** The 94 books stage 2 left unwritten (maintenance-todo.md, "Stage 2 leftovers", 2026-11-16). */
export const UNWRITTEN_94: { id: number; why: string }[] = [
  ...Array.from({ length: 75 }, (_, i) => ({
    id: 50544 + i,
    why: 'title given twice (refused unwritten)',
  })),
  ...[38273, 38284, 38287, 38291, 38305, 38341].map((id) => ({
    id,
    why: 'root-owned cover (Errno 13)',
  })),
  ...[38253, 38349, 38350].map((id) => ({ id, why: 'cover skipped after the folder moved' })),
  ...[10204, 29728].map((id) => ({ id, why: "authors didn't show after the write" })),
  ...[18280, 24947, 26223, 26288, 27644, 33151].map((id) => ({
    id,
    why: "illustrators didn't show after the write",
  })),
  ...[8260, 8261].map((id) => ({ id, why: 'name too long for the folder (title fixed by hand)' })),
];

/** A working copy only: never a live file on the NAS (never open a live database over SMB). */
function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a working copy on this PC only, never the live file on the NAS`);
}

async function backupInto(src: string, out: string): Promise<void> {
  for (const x of [out, `${out}-wal`, `${out}-shm`]) fs.rmSync(x, { force: true });
  const s = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await s.backup(out);
  } finally {
    s.close();
  }
}

/** `find -printf '%s\t%T@\t%P\n'`: size, mtime in seconds with the fraction, path. */
export function readListing(file: string): Map<string, SourceStat> {
  const out = new Map<string, SourceStat>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const [size, mtime, ...rest] = line.split('\t');
    const rel = rest.join('\t').replace(/\r$/, '');
    if (!rel || !/^\d+$/.test(size)) continue;
    out.set(rel.normalize('NFC'), { size: Number(size), mtimeMs: mtimeToMs(mtime) });
  }
  return out;
}

/** "1731234567.123456789" → Math.floor of the time in ms, exactly as Node's stat gives it. */
export function mtimeToMs(t: string): number {
  const [s, f = ''] = t.trim().split('.');
  return Number(s) * 1000 + Number((f + '000').slice(0, 3));
}

export type Writer =
  | 'stage 2'
  | 'stage 4'
  | 'stage 5'
  | 'your edit'
  | 'arrival'
  | 'title fit'
  | 'none';

/** Who last wrote Calibre's value of this field (the newest applied cleanup change), or none. */
export function lastWriter(
  db: Database.Database,
  libraryId: string,
  uuid: string,
  field: string,
): {
  writer: Writer;
  value: unknown;
  stage: number | null;
  at: number | null;
  yours: string | null;
} {
  const yours = db
    .prepare(
      `SELECT source FROM user_fields WHERE library_id = ? AND calibre_uuid = ?
         AND (field = ? OR (? = 'authors' AND field = 'author_sort') OR (? = 'title' AND field = 'sort'))
       LIMIT 1`,
    )
    .get(libraryId, uuid, field, field, field) as { source: string } | undefined;
  const row = db
    .prepare(
      `SELECT stage, source, new_json, analysis_id, updated_at FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND field = ? AND state = 'applied'
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get(libraryId, uuid, field) as
    | {
        stage: number;
        source: string;
        new_json: string;
        analysis_id: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row)
    return {
      writer: yours ? 'your edit' : 'none',
      value: null,
      stage: null,
      at: null,
      yours: yours?.source ?? null,
    };
  const writer: Writer =
    row.stage === 10
      ? 'your edit'
      : row.analysis_id?.startsWith('arrivals:')
        ? 'arrival'
        : row.source === 'title-fit'
          ? 'title fit'
          : row.stage === 4
            ? 'stage 4'
            : row.stage === 5
              ? 'stage 5'
              : 'stage 2';
  return {
    writer: yours && writer !== 'your edit' ? 'your edit' : writer,
    value: JSON.parse(row.new_json) as unknown,
    stage: row.stage,
    at: row.updated_at,
    yours: yours?.source ?? null,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const cell = (v: unknown) => `"${show(v ?? '').replace(/"/g, '""')}"`;
const md = (v: unknown) =>
  show(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .slice(0, 160);

async function main() {
  const work = arg('work');
  for (const n of ['db', 'main', 'metadata']) refuseLive(arg(n));
  const assume = has('assume-unchanged');
  const listingFile = opt('files');
  if (!assume && !listingFile) throw new Error('--files <listing.tsv> or --assume-unchanged');
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, 'cleanup.db');
  log('copying cleanup.db (one step)…');
  await backupInto(arg('db'), file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const v0 = db.pragma('user_version', { simple: true });
  migrateWorkingCopy(db);
  log(`cleanup.db ${v0} -> ${db.pragma('user_version', { simple: true })}`);
  const mainFile = path.join(work, 'ttsu.db');
  await backupInto(arg('main'), mainFile);
  const main = new Database(mainFile, { readonly: true });
  const before2 = getStage(db, 2).progress as {
    libraryId?: string;
    analysisId?: string;
    startedAt?: number;
    finishedAt?: number;
  };
  const libraryId = before2.libraryId;
  if (!libraryId) throw new Error('stage 2 has no library in the copy');
  const cacheDir = path.join(work, 'cache');
  const snapFile = path.join(cacheDir, SNAPSHOT_DIRNAME, `${libraryId}.db`);
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  fs.copyFileSync(arg('metadata'), snapFile);
  const lib = getLibrary(main, libraryId);
  if (!lib) throw new Error('the library is not in the ttsu.db copy');
  const calibreDir = opt('calibre') ?? path.join(work, 'no-share');
  fs.mkdirSync(path.join(work, 'no-share', lib.folder), { recursive: true });
  const libDir = path.join(calibreDir, lib.folder);
  const snap = readStage2Snapshot(snapFile);
  const settings = getSettings(db);
  updateSettings(db, { gate: { ...settings.gate, labeledBooksFile: arg('gold') } });

  // What the live data held before (the copy as it is).
  const reviewKey = (r: { calibre_uuid: string; field: string; new_json: string }) =>
    `${r.calibre_uuid}|${r.field}|${r.new_json}`;
  const reviewBefore = new Set(
    (
      db
        .prepare(
          `SELECT calibre_uuid, field, new_json FROM proposed_changes WHERE stage = 2 AND library_id = ?
             AND class = 'review' AND state = 'proposed' AND decided_by IS NULL
             AND analysis_id NOT LIKE 'arrivals:%'`,
        )
        .all(libraryId) as { calibre_uuid: string; field: string; new_json: string }[]
    ).map(reviewKey),
  );
  const oldSkips = new Map<number, string[]>();
  for (const r of db
    .prepare(
      `SELECT p.calibre_id, p.field, p.review_reason, bi.state FROM proposed_changes p
       JOIN batch_items bi ON bi.change_id = p.id
       WHERE p.stage = 2 AND p.state = 'skipped' AND p.calibre_id IN (${UNWRITTEN_94.map((b) => b.id).join(',')})`,
    )
    .all() as {
    calibre_id: number;
    field: string;
    review_reason: string | null;
    state: string;
  }[]) {
    const l = oldSkips.get(r.calibre_id) ?? [];
    l.push(`${r.field}: ${r.state}, ${r.review_reason ?? ''}`);
    oldSkips.set(r.calibre_id, l);
  }

  // Each book's EPUB and cover.jpg: the listing (or the stored evidence, when assumed unchanged).
  const listing = listingFile ? readListing(listingFile) : new Map<string, SourceStat>();
  let relocated = 0;
  let notListed = 0;
  let changed = 0;
  const books = [...snap.books.values()].filter((b) => b.filePath);
  for (const b of books) {
    const ev = loadEvidence(db, libraryId, b.uuid);
    if (!ev) continue;
    if (assume) {
      // The files as stage 2 last saw them, at the paths Calibre has now.
      if (ev.size !== null && ev.mtimeMs !== null)
        listing.set(b.filePath!.normalize('NFC'), { size: ev.size, mtimeMs: ev.mtimeMs });
      if (ev.cover && b.hasCover)
        listing.set(`${b.path}/cover.jpg`.normalize('NFC'), {
          size: ev.cover.size,
          mtimeMs: ev.cover.mtimeMs,
        });
    }
    const cur = listing.get(b.filePath!.normalize('NFC'));
    if (!cur) {
      notListed += 1;
      continue;
    }
    if (ev.path === b.filePath) continue;
    if (cur.size === ev.size && cur.mtimeMs === ev.mtimeMs) {
      saveEvidence(db, libraryId, b.uuid, { ...ev, path: b.filePath! });
      relocated += 1;
    } else changed += 1;
  }
  log(
    `evidence moved with its folder: ${relocated}; EPUB changed: ${changed}; not in the listing: ${notListed}`,
  );
  const share = opt('calibre') !== null;
  let sharedStats = 0;
  const stat = async (abs: string): Promise<SourceStat | null> => {
    const rel = path.relative(libDir, abs).split(path.sep).join('/').normalize('NFC');
    const hit = listing.get(rel);
    if (hit) return hit;
    if (!share) return null;
    sharedStats += 1;
    return statFile(abs);
  };

  // The analysis, exactly as "Run the analysis again" runs it.
  const analysis = new Stage2Analysis({
    cleanup: db,
    main,
    calibreDir,
    cacheDir,
    dbDir: work,
    log,
    stat,
  });
  const p0 = analysis.restart(libraryId);
  log(`analysis ${p0.analysisId} started`);
  let lastLog = 0;
  for (;;) {
    if (await analysis.step(() => false)) break;
    const p = analysis.progress()!;
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(
        `${p.phase} ${p.pass} read ${p.readDone}/${p.readTotal} (files read ${p.filesRead}) propose ${p.proposeDone}`,
      );
    }
  }
  const p = analysis.progress()!;
  if (p.error) throw new Error(`the analysis failed: ${p.error}`);
  const stage = getStage(db, 2);
  const gate =
    (stage.precision as { gate?: { labeled: number; missing: number; fields: unknown } }).gate ??
    null;
  const pauses = listFieldPauses(db, 2);
  log(
    `analysis done: ${p.books} books, ${p.booksWithChanges} with changes; files read ${p.filesRead}, stats over the share ${sharedStats}`,
  );

  // The proposals of the new analysis.
  const rows = db
    .prepare(
      `SELECT id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, review_reason, state,
              evidence_json FROM proposed_changes WHERE stage = 2 AND analysis_id = ? ORDER BY calibre_id, field, id`,
    )
    .all(p.analysisId) as {
    id: number;
    calibre_id: number;
    calibre_uuid: string;
    field: string;
    old_json: string;
    new_json: string;
    source: string;
    class: 'auto' | 'review';
    review_reason: string | null;
    state: string;
    evidence_json: string;
  }[];
  const the94 = new Map(UNWRITTEN_94.map((b) => [b.id, b.why]));
  interface Out {
    calibreId: number;
    title: string;
    field: string;
    calibreNow: unknown;
    proposed: unknown;
    class: string;
    state: string;
    reason: string | null;
    source: string;
    group: string | null;
    writer: Writer;
    writtenValue: unknown;
    guardDrops: boolean;
  }
  const out: Out[] = rows.map((r) => {
    const book = snap.books.get(r.calibre_id);
    const ev = JSON.parse(r.evidence_json) as { group?: string | null; reason?: string | null };
    const w = lastWriter(db, libraryId, r.calibre_uuid, r.field);
    const old = JSON.parse(r.old_json) as unknown;
    // The guard: another stage (or you) wrote the value Calibre holds now.
    const guardDrops =
      w.writer === 'your edit' ||
      (['stage 4', 'stage 5', 'arrival', 'title fit'].includes(w.writer) && same(w.value, old));
    return {
      calibreId: r.calibre_id,
      title: book?.title ?? '',
      field: r.field,
      calibreNow: old,
      proposed: JSON.parse(r.new_json) as unknown,
      class: r.class,
      state: r.state,
      reason: r.review_reason ?? ev.reason ?? null,
      source: r.source,
      group: ev.group ?? null,
      writer: w.writer,
      writtenValue: w.value,
      guardDrops,
    };
  });
  const in94 = out.filter((o) => the94.has(o.calibreId));
  const beyond = out.filter((o) => !the94.has(o.calibreId));
  const reviewAfter = new Set(
    rows.filter((r) => r.class === 'review' && r.state === 'proposed').map((r) => reviewKey(r)),
  );
  const reviewGone = [...reviewBefore].filter((k) => !reviewAfter.has(k)).length;
  const reviewNew = [...reviewAfter].filter((k) => !reviewBefore.has(k)).length;

  // The records without files and their EPUBs among the new arrivals (title and first author).
  const empty = recordsWithoutFiles(snapFile);
  const arrivals = db
    .prepare(
      `SELECT rel_path, outcome, calibre_id, calibre_uuid, facts_json FROM calibre_arrival_files
       WHERE facts_json IS NOT NULL AND json_extract(facts_json, '$.title') IS NOT NULL`,
    )
    .all() as {
    rel_path: string;
    outcome: string;
    calibre_id: number | null;
    calibre_uuid: string | null;
    facts_json: string;
  }[];
  // The records whose folder the disk refused (the decided 11); the others are listed apart.
  const otherEmpty = empty.records
    .filter((r) => !folderTooLong(r.path))
    .map((r) => ({ calibreId: r.id, title: r.title, path: r.path, tags: r.tags }));
  const records = empty.records
    .filter((r) => folderTooLong(r.path))
    .map((r) => {
      const hits = arrivals.filter((a) => {
        const f = JSON.parse(a.facts_json) as { title: string; authors?: string[] };
        return sameText(f.title, r.title);
      });
      return {
        calibreId: r.id,
        title: r.title,
        authors: r.authors,
        tags: r.tags,
        arrivals: hits.map((h) => ({
          relPath: h.rel_path,
          outcome: h.outcome,
          calibreId: h.calibre_id,
          inCalibre:
            h.calibre_id !== null && empty.epubBooks.get(h.calibre_id)?.uuid === h.calibre_uuid,
        })),
      };
    });

  const count = (l: Out[], key: (o: Out) => string) => {
    const m = new Map<string, number>();
    for (const o of l) m.set(key(o), (m.get(key(o)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const summary = {
    inputs: {
      db: arg('db'),
      metadata: arg('metadata'),
      listing: listingFile,
      assumeUnchanged: assume,
      stage2Before: {
        analysisId: before2.analysisId,
        startedAt: before2.startedAt ? new Date(before2.startedAt).toISOString() : null,
        finishedAt: before2.finishedAt ? new Date(before2.finishedAt).toISOString() : null,
      },
    },
    reading: {
      relocated,
      changed,
      notListed,
      filesRead: p.filesRead,
      sharedStats,
      readErrors: p.readErrors,
    },
    analysis: {
      id: p.analysisId,
      books: p.books,
      booksWithChanges: p.booksWithChanges,
      folderMoves: p.folderMoves,
      fields: p.fields,
    },
    gate: stage.precision,
    the94: { proposals: in94.length, books: new Set(in94.map((o) => o.calibreId)).size },
    beyond: {
      proposals: beyond.length,
      auto: beyond.filter((o) => o.class === 'auto' && o.state === 'proposed').length,
      review: beyond.filter((o) => o.class === 'review' && o.state === 'proposed').length,
      yoursSetAside: beyond.filter((o) => o.state === 'skipped').length,
      byFieldClassWriter: count(
        beyond,
        (o) =>
          `${o.field} · ${o.class}${o.state === 'skipped' ? ' (set aside)' : ''} · ${o.writer}`,
      ),
      guardWouldDrop: beyond.filter((o) => o.guardDrops && o.state === 'proposed').length,
      autoAfterGuard: beyond.filter(
        (o) => o.class === 'auto' && o.state === 'proposed' && !o.guardDrops,
      ).length,
    },
    review: {
      before: reviewBefore.size,
      after: reviewAfter.size,
      gone: reviewGone,
      new: reviewNew,
    },
    book29728: out.filter((o) => o.calibreId === 29728),
    records,
    otherEmpty,
  };
  fs.writeFileSync(
    path.join(work, 'report.json'),
    JSON.stringify({ summary, the94: in94, beyond }, null, 1),
  );
  const header =
    'calibre_id,title,field,calibre_now,proposed,class,state,reason,source,group,last_writer,written_value,guard_drops';
  fs.writeFileSync(
    path.join(work, 'beyond.csv'),
    '﻿' +
      [
        header,
        ...beyond.map((o) =>
          [
            o.calibreId,
            o.title,
            o.field,
            o.calibreNow,
            o.proposed,
            o.class,
            o.state,
            o.reason,
            o.source,
            o.group,
            o.writer,
            o.writtenValue,
            o.guardDrops,
          ]
            .map(cell)
            .join(','),
        ),
      ].join('\r\n'),
  );
  const lines: string[] = [
    `# Stage 2 analysis again, on a copy (${new Date().toISOString()})`,
    '',
    `Working copies only; nothing written to Calibre. ${assume ? '**Files assumed unchanged since stage 2 read them (no listing): covers stage 4 wrote are not seen.**' : `Listing: ${listingFile}.`}`,
    '',
    `- Stage 2's last analysis in the copy: ${summary.inputs.stage2Before.analysisId} (${summary.inputs.stage2Before.startedAt} → ${summary.inputs.stage2Before.finishedAt}).`,
    `- Reading: ${relocated} books' evidence moved with their folder, ${changed} EPUBs changed, ${notListed} not in the listing, ${p.filesRead} files read, ${p.readErrors} read errors.`,
    `- New analysis ${p.analysisId}: ${p.books} books, ${p.booksWithChanges} with automatic changes, ${p.folderMoves} folder moves.`,
    `- Review list: ${reviewBefore.size} before, ${reviewAfter.size} after (${reviewGone} gone, ${reviewNew} new).`,
    '',
    '## Gate (the labeled books)',
    '',
    `Labeled books read: ${gate?.labeled ?? '–'}, missing: ${gate?.missing ?? '–'}.`,
    '',
    '```json',
    JSON.stringify(gate?.fields ?? stage.precision, null, 1).slice(0, 3000),
    '```',
    '',
    `Field pauses after the analysis: ${pauses.map((x) => `${x.field} (${x.reason})`).join(', ') || 'none'}.`,
    '',
    `## (a) The 94 books: ${summary.the94.proposals} proposals on ${summary.the94.books} books`,
    '',
    '| Book | Old reason | Field | Calibre now | Proposed | Class | Reason |',
    '|---|---|---|---|---|---|---|',
    ...UNWRITTEN_94.flatMap((b) => {
      const mine = in94.filter((o) => o.calibreId === b.id);
      if (mine.length === 0) return [`| ${b.id} | ${b.why} | – | nothing proposed | | | |`];
      return mine.map(
        (o) =>
          `| ${b.id} | ${b.why} | ${o.field} | ${md(o.calibreNow)} | ${md(o.proposed)} | ${o.class}${o.state === 'skipped' ? ' (set aside)' : ''} | ${md(o.reason)} |`,
      );
    }),
    '',
    `## (b) Beyond the 94: ${beyond.length} proposals (${summary.beyond.auto} automatic, ${summary.beyond.review} review, ${summary.beyond.yoursSetAside} set aside as yours)`,
    '',
    `The guard "never over a value another stage wrote that Calibre still holds" would drop ${summary.beyond.guardWouldDrop}; automatic changes left with it: ${summary.beyond.autoAfterGuard}.`,
    '',
    "| Field · class · last writer of Calibre's value | Proposals |",
    '|---|---|',
    ...summary.beyond.byFieldClassWriter.map(([k, n]) => `| ${k} | ${n} |`),
    '',
    'Every row: `beyond.csv`. First 40 automatic ones:',
    '',
    '| Book | Field | Calibre now | Proposed | Last writer | Guard drops |',
    '|---|---|---|---|---|---|',
    ...beyond
      .filter((o) => o.class === 'auto' && o.state === 'proposed')
      .slice(0, 40)
      .map(
        (o) =>
          `| ${o.calibreId} | ${o.field} | ${md(o.calibreNow)} | ${md(o.proposed)} | ${o.writer} | ${o.guardDrops ? 'yes' : 'no'} |`,
      ),
    '',
    '## (e) 29728',
    '',
    ...(summary.book29728.length === 0
      ? ['Nothing proposed.']
      : summary.book29728.map(
          (o) =>
            `- ${o.field}: ${md(o.calibreNow)} → ${md(o.proposed)} (${o.class}${o.reason ? `, ${o.reason}` : ''}; Calibre's value last written by ${o.writer})`,
        )),
    '',
    `## (f) Records without files: ${records.length}`,
    '',
    '| Record | Title | EPUB among the arrivals |',
    '|---|---|---|',
    ...records.map(
      (r) =>
        `| ${r.calibreId} | ${md(r.title).slice(0, 60)} | ${r.arrivals.length === 0 ? 'not found by title' : r.arrivals.map((a) => `${a.outcome}${a.inCalibre ? ` → Calibre ${a.calibreId}` : ''} (${md(a.relPath).slice(0, 60)})`).join('; ')} |`,
    ),
  ];
  lines.push(
    '',
    `Other records without files (a name the disk takes, so they lost their files some other way; not part of the decided deletion): ${otherEmpty.map((r) => `${r.calibreId} ${md(r.title).slice(0, 40)}`).join('; ') || 'none'}.`,
  );
  fs.writeFileSync(path.join(work, 'report.md'), lines.join('\n') + '\n');
  log(`report: ${path.join(work, 'report.md')}`);
  db.close();
  main.close();
}

if (require.main === module)
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
