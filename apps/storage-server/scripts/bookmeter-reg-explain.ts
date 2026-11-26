/**
 * Bookmeter links, second look (2026-11-25): for some books, every Bookmeter answer the link pass
 * read (stage4/bookmeter-listing.ts answersOf, the new author-field search included) with each
 * listing's 登録 count and why the real checks (judgeBookmeter: tier 1 on the list text, tier 2
 * the chosen rules, the guards) take it or not. Read only: copies on this PC and the fetch cache's
 * plain files; nothing fetched, nothing written.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-reg-explain.ts --cleanup <cleanup.db copy>
 *     --ttsu <ttsu.db copy> --calibre <reader's calibre snapshot copy> --cache <folder with fetch/>
 *     [--uuids a,b,c | --series "name1|name2"] [--json]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { BookmeterListings } from '../src/cleanup/stage4/bookmeter-listing';
import { chosenDecision } from '../src/cleanup/stage4/bookmeter-rules';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import {
  bookmeterListingSearch,
  editionNotes,
  judgeBookmeter,
  parseBookmeterSearch,
  type BookmeterHit,
} from '../src/cleanup/stage4/store-links';
import { clean } from '../src/cleanup/stage4/rules-v3';
import { nums } from '../src/cleanup/stage4/pick';
import { N, NA, nfkc } from '../src/cleanup/title-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a copy on this PC only (never the NAS or a live database)`);
}

/** Tier 1's checks one by one (judgeBookmeter's first loop). */
function tier1Fails(h: BookmeterHit, title: string, authors: string[], own: string[]): string[] {
  const listed = h.listTitle ?? h.title;
  const out: string[] = [];
  if ((N(clean(listed)) ?? '') !== (N(clean(title)) ?? '')) out.push('title');
  const au = new Set(authors.map((a) => NA(a)));
  if (!h.authors.some((a) => au.has(NA(a)))) out.push('author');
  if ([...nums(listed)].sort().join(',') !== [...nums(title)].sort().join(','))
    out.push(`volume(${[...nums(listed)].join('/')}≠${[...nums(title)].join('/')})`);
  if (editionNotes(listed).some((n) => !own.some((t) => nfkc(t).includes(n)))) out.push('edition');
  return out;
}

async function main() {
  for (const k of ['cleanup', 'ttsu', 'calibre']) refuseLive(arg(k)!);
  const db = new Database(arg('cleanup')!, { readonly: true });
  const main = new Database(arg('ttsu')!, { readonly: true });
  const lib = (getStage(db, 4).progress as unknown as Stage4Progress).libraryId!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-explain-'));
  const snap = path.join(tmp, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('calibre')!, snap);
  const cache = arg('cache')!;
  const queue = new FetchQueue(db, tmp, () => getSettings(db).fetch);
  const cacheOf = db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?');
  queue.readAnswer = (id: number) => {
    const r = cacheOf.get(id) as { cache_file: string | null } | undefined;
    if (!r?.cache_file) return null;
    try {
      return brotliDecompressSync(fs.readFileSync(path.join(cache, r.cache_file)));
    } catch {
      return null;
    }
  };
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: '',
    cacheDir: tmp,
    dbDir: null,
    queue,
  });
  const pass = new BookmeterListings({
    db,
    analysis,
    queue,
    batches: null as never,
    targetLibrary: () => lib,
    stage4Done: () => true,
    writeWait: () => 'read only',
    referenceFile: () => null,
    log: () => undefined,
  });
  analysis.loadSnapshot(lib);
  let uuids = (arg('uuids') ?? '').split(',').filter(Boolean);
  const series = arg('series');
  if (series) {
    for (const name of series.split('|')) {
      const rows = main
        .prepare(
          `SELECT x.calibre_uuid AS u FROM books b JOIN series s ON s.id = b.series_id
           JOIN book_sources x ON x.book_id = b.id AND x.missing_at IS NULL
           WHERE s.name = ? AND x.library_id = ? ORDER BY b.series_index LIMIT 4`,
        )
        .all(name, lib) as { u: string }[];
      uuids.push(...rows.map((r) => r.u));
    }
  }
  uuids = [...new Set(uuids)];
  const freshOf = db.prepare(
    `SELECT id FROM fetch_requests WHERE site = 'bookmeter' AND key = ? AND state = 'done'`,
  );
  for (const uuid of uuids) {
    const row = db
      .prepare(
        'SELECT state, saved_id FROM bookmeter_listing_books WHERE library_id = ? AND calibre_uuid = ?',
      )
      .get(lib, uuid) as { state: string; saved_id: string } | undefined;
    const f = analysis.bookmeterFacts(lib, uuid);
    if (!f) {
      console.log(`\n${uuid}: no stage-4 facts (pass state ${row?.state})`);
      continue;
    }
    const spec = bookmeterListingSearch(f.input.title, f.input.authors);
    const fr = spec ? (freshOf.get(spec.key) as { id: number } | undefined) : undefined;
    const freshBody = fr ? queue.readAnswer(fr.id) : null;
    const fresh = freshBody ? parseBookmeterSearch(freshBody) : null;
    const hits = pass.answersOf(f, fresh);
    const j = judgeBookmeter(hits, f.input);
    const chosen = f.input.chosen
      ? chosenDecision(
          hits.map((h) => ({
            ...h,
            title: h.listTitle ?? h.title,
            full: h.listTitle !== undefined ? h.title : null,
          })),
          { ...f.input.chosen, title: f.input.title, authors: f.input.authors },
          () => true,
        ).failed
      : null;
    const own = (f.input.own ?? [f.input.title]).filter((t): t is string => typeof t === 'string');
    console.log(
      `\n${f.input.title} / ${f.input.authors.join(', ')} [series ${f.input.chosen?.series ?? '-'} #${f.input.chosen?.ix ?? '-'}, fmt ${f.input.chosen?.fmt ?? '-'}]`,
    );
    console.log(
      `  pass: ${row?.state} saved ${row?.saved_id}; author search ${fresh ? `${fresh.length} hits` : 'none'}; merged ${hits.length}`,
    );
    const sameWork = (h: BookmeterHit) =>
      nfkc(h.title).includes(nfkc(f.input.title).slice(0, 4)) || h.id === row?.saved_id;
    for (const [i, h] of hits.entries()) {
      if (!sameWork(h) && arg('all') === undefined) continue;
      const t = j.tier[i];
      console.log(
        `  ${h.id === row?.saved_id ? '*' : ' '} ${String(h.registrations ?? '?').padStart(6)} ${h.id.padEnd(9)} ${t ? `T${t}` : j.guard[i] ? `G:${j.guard[i]}` : '--'} ${h.title}  [${h.authors.join(', ')}]` +
          (t
            ? ''
            : `  t1:${tier1Fails(h, f.input.title, f.input.authors, own).join(',') || 'ok'} t2:${chosen ? chosen[i].join(',') || 'ok' : '-'}`),
      );
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
