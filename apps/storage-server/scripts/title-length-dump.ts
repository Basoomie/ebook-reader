/**
 * Titles too long for a Calibre folder, stop B: every title source in one file, read-only, from
 * copies (never a live database): Calibre's title and authors (metadata.db copy), the file's title
 * (stage 2's evidence), stage 4's search title and chosen store titles, the labeled books, the
 * held proposals and the new arrivals' catalog (an export from the live server).
 *
 *   npx ts-node --transpile-only scripts/title-length-dump.ts --cleanup <cleanup.db copy>
 *     --metadata <metadata.db copy> --gold <gold800.json> --export <export.json> --out <titles.json>
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { mapLabeledIds } from '../src/cleanup/stage2-gate';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  if (i < 0) throw new Error(`missing ${k}`);
  return process.argv[i + 1];
};
const blob = (b: Buffer | null): any => {
  if (!b) return null;
  try {
    return JSON.parse(gunzipSync(b).toString('utf8'));
  } catch {
    return null;
  }
};
const cleanup = new Database(arg('--cleanup'), { readonly: true, fileMustExist: true });
const meta = new Database(arg('--metadata'), { readonly: true, fileMustExist: true });
const gold = JSON.parse(readFileSync(arg('--gold'), 'utf8')) as Record<string, any>;
const exp = JSON.parse(readFileSync(arg('--export'), 'utf8'));
const LIB = '6efee4ba-c851-4f7b-9804-998f52a5d024';

const books = meta
  .prepare(
    `SELECT b.id, b.uuid, b.title, b.path, b.series_index AS sidx,
       (SELECT s.name FROM books_series_link l JOIN series s ON s.id = l.series WHERE l.book = b.id) AS series,
       (SELECT COUNT(*) FROM data d WHERE d.book = b.id) AS formats
     FROM books b`,
  )
  .all() as any[];
const authorsOf = meta.prepare(
  `SELECT a.name FROM books_authors_link l JOIN authors a ON a.id = l.author WHERE l.book = ? ORDER BY l.id`,
);
const ev = cleanup.prepare(
  `SELECT kind, data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind IN ('file', 'online')`,
);
const labelOf = new Map<number, any>();
for (const [id, cid] of mapLabeledIds(cleanup, LIB, Object.keys(gold))) {
  labelOf.set(cid, { id, ...gold[id] });
}

const out: any[] = [];
for (const b of books) {
  const row: any = {
    id: b.id,
    uuid: b.uuid,
    title: b.title,
    authors: (authorsOf.all(b.id) as { name: string }[]).map((a) => a.name),
    series: b.series,
    sidx: b.sidx,
    formats: b.formats,
    path: b.path,
  };
  for (const r of ev.all(LIB, b.uuid) as { kind: string; data: Buffer }[]) {
    const j = blob(r.data);
    if (!j) continue;
    if (r.kind === 'file') {
      row.fileTitle = j.file?.title ?? null;
      row.fileAuthors = (j.file?.creators ?? [])
        .filter((c: any) => !c.role || c.role === 'aut')
        .map((c: any) => c.name);
    } else {
      row.query = j.query?.title ?? null;
      row.amazon = j.amazon?.product?.title ?? null;
      row.bookwalker = j.bookwalker?.detail?.title ?? null;
      row.ranobedb = j.ranobedb?.book?.title_orig ?? null;
    }
  }
  const g = labelOf.get(b.id);
  if (g)
    row.label = { id: g.id, t: g.t, alt_t: g.alt_t ?? null, se: g.se ?? null, ix: g.ix ?? null };
  out.push(row);
}
writeFileSync(
  arg('--out'),
  JSON.stringify({ at: new Date().toISOString(), books: out, held: exp.held, arrivals: exp.files }),
);
console.log(
  `${out.length} books, ${labelOf.size} labeled, ${exp.held.length} held, ${exp.files.length} arrival files`,
);
