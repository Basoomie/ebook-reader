/**
 * WP20e: Bookmeter's edition check measured on a copy of the finished stage-4 cleanup.db, from
 * the stored search answers (nothing is fetched). Every book's Bookmeter hits are accepted again
 * with the rule as it was (no edition check) and as it is now; each book whose accepted hit
 * changes is listed, the labeled ones apart, plus a fixed-seed random sample of the others for a
 * check by hand. Reads only.
 *
 *   npx ts-node --transpile-only scripts/wp20e-bookmeter-editions.ts --db <copy/cleanup.db>
 *     --metadata <copy/metadata.db> [--sample 30] [--out report.json]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { bwAsAmazon } from '../src/cleanup/stage4/bw-standin';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { acceptBookmeter, type BookmeterHit } from '../src/cleanup/stage4/store-links';
import { bookmeterOwnTexts } from '../src/cleanup/stage4/analysis';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = new Database(arg('db')!, { readonly: true });
const cal = new Database(arg('metadata')!, { readonly: true });
const calBook = cal.prepare(
  `SELECT b.title, b.has_cover,
     (SELECT group_concat(a.name, '&') FROM books_authors_link l JOIN authors a ON a.id = l.author WHERE l.book = b.id) AS authors,
     (SELECT group_concat(t.name, '|') FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = b.id) AS tags
   FROM books b WHERE b.uuid = ?`,
);
const refOf = db.prepare(
  `SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = 'reffile'`,
);
const labeledOf = db.prepare(
  `SELECT labeled, calibre_id FROM stage4_books WHERE library_id = ? AND calibre_uuid = ?`,
);
const gz = (b: Buffer) => JSON.parse(gunzipSync(b).toString());

interface Change {
  calibreId: number;
  labeled: boolean;
  title: string;
  opfTitle: string | null;
  before: string | null;
  after: string | null;
  reason: string;
}
let books = 0;
let titlesOnlyChanged = 0;
let acceptedBefore = 0;
let acceptedAfter = 0;
const changes: Change[] = [];
for (const r of db
  .prepare(`SELECT library_id, calibre_uuid, data FROM evidence_records WHERE kind = 'online'`)
  .iterate() as Iterable<{ library_id: string; calibre_uuid: string; data: Buffer }>) {
  let ev;
  try {
    ev = gz(r.data);
  } catch {
    continue;
  }
  const hits = ev.bookmeter?.hits as BookmeterHit[] | undefined;
  if (!hits) continue;
  const refRow = refOf.get(r.library_id, r.calibre_uuid) as { data: Buffer } | undefined;
  const ref = refRow ? gz(refRow.data) : null;
  const c = calBook.get(r.calibre_uuid) as
    | { title: string; authors: string; tags: string | null; has_cover: number }
    | undefined;
  if (!ref?.file || !c) continue;
  books++;
  const rec = {
    calibre: {
      cal_title: c.title,
      cal_authors: c.authors ?? '',
      cal_tags: c.tags ?? '',
      has_cover: c.has_cover,
    },
    file: ref.file,
    amazon: { ...ev.amazon },
    ranobedb: { ...ev.ranobedb },
    bookwalker: { ...ev.bookwalker },
  } as unknown as RefRecord;
  if (ev.amazon?.standin === 'bookwalker') rec.amazon = bwAsAmazon(rec) ?? {};
  const d = decideStage4(rec);
  // The rule as it was: every hit's own title counts as the book's, so no note rejects it.
  const old = acceptBookmeter(hits, {
    title: d.values.t,
    authors: d.values.au,
    own: hits.map((h) => h.title),
  });
  const now = acceptBookmeter(hits, {
    title: d.values.t,
    authors: d.values.au,
    own: bookmeterOwnTexts({ title: c.title }, ref.file, d, rec.amazon?.product?.title),
  });
  // The rule as first asked: only the book's titles (file, Calibre) count.
  const titlesOnly = acceptBookmeter(hits, {
    title: d.values.t,
    authors: d.values.au,
    own: [ref.file.opf_title, c.title],
  });
  if ((titlesOnly.hit?.id ?? null) !== (old.hit?.id ?? null)) titlesOnlyChanged++;
  if (old.hit) acceptedBefore++;
  if (now.hit) acceptedAfter++;
  if ((old.hit?.id ?? null) !== (now.hit?.id ?? null)) {
    const l = labeledOf.get(r.library_id, r.calibre_uuid) as
      | { labeled: number; calibre_id: number }
      | undefined;
    changes.push({
      calibreId: l?.calibre_id ?? -1,
      labeled: !!l?.labeled,
      title: c.title,
      opfTitle: ref.file.opf_title ?? null,
      before: old.hit ? `${old.hit.id} ${old.hit.title}` : null,
      after: now.hit ? `${now.hit.id} ${now.hit.title}` : null,
      reason: now.reason,
    });
  }
}
const rand = mulberry32(20261120);
const others = changes.filter((c) => !c.labeled);
const sample: Change[] = [];
const pool = [...others];
const n = Math.min(parseInt(arg('sample') ?? '30', 10), pool.length);
for (let i = 0; i < n; i++) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
const report = {
  books,
  acceptedBefore,
  acceptedAfter,
  changed: changes.length,
  titlesOnlyChanged,
  labeled: changes.filter((c) => c.labeled),
  sample,
};
console.log(JSON.stringify(report, null, 1));
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
