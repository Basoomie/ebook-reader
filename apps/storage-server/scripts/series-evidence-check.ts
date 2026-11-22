/**
 * Series-order follow-up, stop 2 finding: how many books' AI evidence changes when it is built
 * again on a copy whose Calibre snapshot already holds stage 4's writes (as on the NAS after
 * stage 4 On). Compares every proposed book's evidence hash with the one stored in ai_items,
 * built as the server builds it now (Calibre as stage 4 found it) and as it was built before
 * the fix (Calibre's current title and authors). Opens the copy read-only; asks nothing.
 *
 *   npx ts-node --transpile-only scripts/series-evidence-check.ts --db <copy/cleanup.db>
 *     --main <copy/ttsu.db> --calibre <books folder> [--out <changed.json>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { evidenceHash } from '../src/ai/runner';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { STAGE4_EVIDENCE_VERSION, stage4Evidence } from '../src/cleanup/stage4/ai-prompt';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function main() {
  const file = arg('db')!;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const mainDb = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const p = getStage(db, 4).progress as unknown as Stage4Progress;
  const cacheDir = path.join(path.dirname(file), 'cache');
  const queue = new FetchQueue(
    db,
    path.join(cacheDir, 'cleanup'),
    () => getSettings(db).fetch,
    () => {},
  );
  const analysis = new Stage4Analysis({
    cleanup: db,
    main: mainDb,
    calibreDir: arg('calibre')!,
    cacheDir,
    dbDir: null,
    queue,
    log: () => {},
  });
  const stored = new Map(
    (
      db.prepare(`SELECT item_key, evidence_hash FROM ai_items WHERE stage = 'calibre4'`).all() as {
        item_key: string;
        evidence_hash: string;
      }[]
    ).map((r) => [r.item_key, r.evidence_hash]),
  );
  const books = db
    .prepare(`SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ? AND state = 'proposed'`)
    .all(p.analysisId) as { calibre_uuid: string }[];
  let fixed = 0;
  let unfixed = 0;
  let missing = 0;
  const changed: {
    uuid: string;
    title: [string | null, string | null];
    authors: [string | null, string | null];
  }[] = [];
  const t = Date.now();
  for (const { calibre_uuid: uuid } of books) {
    const inp = analysis.aiInputs(p, uuid);
    const old = stored.get(`${p.libraryId}:${uuid}`);
    if (!inp || !old) {
      missing++;
      continue;
    }
    const ev = stage4Evidence(inp.base);
    if (evidenceHash(STAGE4_EVIDENCE_VERSION, ev) !== old) {
      fixed++;
      changed.push({
        uuid,
        title: [ev.calibre.title, inp.book.title],
        authors: [ev.calibre.authors, inp.book.authors.join('&')],
      });
    }
    const before = {
      ...ev,
      calibre: { title: inp.book.title, authors: inp.book.authors.join('&') },
    };
    if (evidenceHash(STAGE4_EVIDENCE_VERSION, before) !== old) unfixed++;
  }
  console.log(
    JSON.stringify(
      {
        books: books.length,
        missing,
        changedWithFix: fixed,
        changedBeforeFix: unfixed,
        ms: Date.now() - t,
        msPerBook: +((Date.now() - t) / books.length).toFixed(3),
      },
      null,
      1,
    ),
  );
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(changed, null, 1));
}

main();
