/**
 * Bookmeter listings, step 1 (measuring): for every saved `bookmeter` id (the reader's ttsu.db
 * snapshot), the Bookmeter searches stored for its book (stage 4's search, More Bookmeter
 * coverage's Q1/Q2) re-parsed from the fetch cache with each listing's 登録 count, and per listing
 * whether stage 4's own acceptance (acceptBookmeter: today's checks, then the chosen rules) takes
 * it as this book, with the checks it fails. Read only: snapshot copies on this PC and the
 * cache's plain files; nothing fetched, nothing written but the output.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-listing-extract.ts --cleanup <cleanup.db copy>
 *     --ttsu <ttsu.db copy> --calibre <reader's calibre snapshot copy> --cache <folder with fetch/>
 *     --out <file.jsonl>
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getSettings } from '../src/cleanup/settings';
import { Stage4Analysis } from '../src/cleanup/stage4/analysis';
import { chosenDecision, mainTitle } from '../src/cleanup/stage4/bookmeter-rules';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { decodeIgnore } from '../src/cleanup/stage4/ref-text';
import {
  BOOKMETER_AUTHOR_SEARCH_KEY,
  BOOKMETER_SEARCH_KEY,
  acceptBookmeter,
  editionNotes,
  parseBookmeterSearch,
} from '../src/cleanup/stage4/store-links';
import { nfkc } from '../src/cleanup/title-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a copy on this PC only (never the NAS or a live database)`);
}

/** Each list item's 登録 count, by Bookmeter id (the search list shows it under the pages). */
function registrations(body: Buffer): Map<string, number> {
  const h = decodeIgnore(body);
  const out = new Map<string, number>();
  for (const li of h.split('<li class="group__book">').slice(1)) {
    const id = /<div class="detail__title"><a href="\/books\/(\d+)">/.exec(li)?.[1];
    const m = /<dt class="options__title">登録<\/dt><dd class="options__item">([\d,]+)<\/dd>/.exec(
      li,
    );
    if (id) out.set(id, m ? parseInt(m[1].replace(/,/g, ''), 10) : -1);
  }
  return out;
}

async function main() {
  for (const k of ['cleanup', 'ttsu', 'calibre']) refuseLive(arg(k)!);
  const db = new Database(arg('cleanup')!, { readonly: true });
  const ttsu = new Database(arg('ttsu')!, { readonly: true });
  const cache = arg('cache')!;
  const rows = ttsu
    .prepare(
      `SELECT bs.library_id AS lib, bs.calibre_uuid AS uuid, bs.calibre_id AS cid, b.title, bi.value AS saved
       FROM book_identifiers bi JOIN books b ON b.id = bi.book_id
       JOIN book_sources bs ON bs.book_id = b.id AND bs.kind = 'calibre' AND bs.missing_at IS NULL
       WHERE bi.type = 'bookmeter' ORDER BY bs.calibre_id`,
    )
    .all() as { lib: string; uuid: string; cid: number; title: string; saved: string }[];
  if (arg('limit')) rows.splice(+arg('limit')!);
  // --only <jsonl>: just these books (a sample), with --live <dir> the live searches made for them.
  if (arg('only')) {
    const keep = new Set(
      fs
        .readFileSync(arg('only')!, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l).uuid as string),
    );
    for (let i = rows.length - 1; i >= 0; i--) if (!keep.has(rows[i].uuid)) rows.splice(i, 1);
  }
  const lib = rows[0].lib;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bml-'));
  fs.mkdirSync(path.join(tmp, SNAPSHOT_DIRNAME), { recursive: true });
  fs.copyFileSync(arg('calibre')!, path.join(tmp, SNAPSHOT_DIRNAME, `${lib}.db`));
  const queue = new FetchQueue(
    db,
    cache,
    () => getSettings(db).fetch,
    () => undefined,
  );
  const analysis = new Stage4Analysis({
    cleanup: db,
    main: ttsu,
    calibreDir: '',
    cacheDir: tmp,
    dbDir: null,
    queue,
  });
  analysis.loadSnapshot(lib);
  const more = db.prepare(
    'SELECT source, state, hit_json FROM bookmeter_more_books WHERE library_id = ? AND calibre_uuid = ?',
  );
  const reqKey = db.prepare('SELECT key, cache_file FROM fetch_requests WHERE id = ?');
  const read = (key: string): Buffer | null => {
    const h = createHash('sha256').update(`bookmeter\n${key}`).digest('hex');
    const f = path.join(cache, 'fetch', 'bookmeter', h.slice(0, 2), `${h}.br`);
    try {
      return brotliDecompressSync(fs.readFileSync(f));
    } catch {
      return null;
    }
  };
  const out = fs.createWriteStream(arg('out')!);
  let n = 0;
  const t0 = Date.now();
  for (const r of rows) {
    n++;
    if (n % 2000 === 0)
      console.log(`${n} of ${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    const f = analysis.bookmeterFacts(r.lib, r.uuid);
    const m = more.get(r.lib, r.uuid) as
      | { source: string | null; state: string; hit_json: string | null }
      | undefined;
    const moreHit = m?.hit_json ? (JSON.parse(m.hit_json) as { id: string; query?: string }) : null;
    const origin =
      f?.bookmeter.accepted?.id === r.saved
        ? 'stage4'
        : moreHit?.id === r.saved
          ? `more:${m!.source}${moreHit.query ? ':' + moreHit.query : ''}`
          : 'other';
    if (!f) {
      out.write(JSON.stringify({ ...r, origin, facts: false }) + '\n');
      continue;
    }
    const keys: { q: string; key: string }[] = [];
    if (f.searchRequest) {
      const k = reqKey.get(f.searchRequest) as { key: string } | undefined;
      if (k) keys.push({ q: 'stage4', key: k.key });
    }
    const q1 = mainTitle(f.queryTitle);
    const au = (f.input.authors[0] ?? '').replace(/\s/gu, '');
    if (q1 && q1 !== f.queryTitle) keys.push({ q: 'q1', key: `${BOOKMETER_SEARCH_KEY}${q1}` });
    if (au && q1) keys.push({ q: 'q2', key: `${BOOKMETER_AUTHOR_SEARCH_KEY}${au}\n${q1}` });
    const own = (f.input.own ?? []).filter((t): t is string => typeof t === 'string').map(nfkc);
    const edOk = (t: string) => !editionNotes(t).some((x) => !own.some((o) => o.includes(x)));
    const searches = [];
    const liveFile = arg('live')
      ? path.join(
          arg('live')!,
          createHash('sha1')
            .update(`${(f.input.authors[0] ?? '').replace(/\s/g, '')}\n${f.input.title}`)
            .digest('hex') + '.html',
        )
      : null;
    if (liveFile && fs.existsSync(liveFile)) keys.push({ q: 'live', key: liveFile });
    for (const { q, key } of keys) {
      const body = q === 'live' ? fs.readFileSync(key) : read(key);
      if (!body) continue;
      const hits = parseBookmeterSearch(body);
      const reg = registrations(body);
      const failed = f.input.chosen
        ? chosenDecision(
            hits.map((h) => ({
              ...h,
              title: h.listTitle ?? h.title,
              full: h.listTitle !== undefined ? h.title : null,
            })),
            { ...f.input.chosen, title: f.input.title, authors: f.input.authors },
            edOk,
          ).failed
        : hits.map(() => []);
      searches.push({
        q,
        key,
        hits: hits.map((h, i) => ({
          id: h.id,
          title: h.title,
          authors: h.authors,
          pages: h.pages,
          reg: reg.get(h.id) ?? null,
          pass: acceptBookmeter([h], f.input).hit !== null,
          failed: failed[i],
        })),
      });
    }
    out.write(
      JSON.stringify({
        ...r,
        origin,
        facts: true,
        decided: {
          t: f.input.title,
          au: f.input.authors,
          se: f.input.chosen?.series ?? null,
          ix: f.input.chosen?.ix ?? null,
          fmt: f.input.chosen?.fmt ?? null,
          kind: f.kind,
        },
        accepted: f.bookmeter.accepted ?? null,
        more: m ? { source: m.source, state: m.state, hit: moreHit } : null,
        searches,
      }) + '\n',
    );
  }
  out.end();
  console.log(`done: ${rows.length} books in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
