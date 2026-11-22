/**
 * The re-pick's effect, judged by the stage's own title test: for every book whose store record
 * changed between two cleanup.db copies (before / after), is the old record the book, the new one?
 * A record "is the book" when its cleaned title equals the file's (as identifyDescriptions and the
 * BookWalker id use it), and, for a title with a volume number, the record prints that number.
 *
 *   npx ts-node --transpile-only scripts/repick-judge.ts --before pre.db --after now.db --out x.json
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { gunzipSync, inflateSync } from 'zlib';
import { clean } from '../src/cleanup/stage4/rules-v3';
import { N } from '../src/cleanup/title-rules';
import { nums } from '../src/cleanup/stage4/pick';
import { recordFit, type BookFacts } from '../src/cleanup/stage4/record-judge';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : '';
};
const blob = (b: Buffer | null): any => {
  if (!b) return null;
  for (const f of [gunzipSync, inflateSync, (x: Buffer) => x])
    try {
      return JSON.parse(f(b).toString());
    } catch {
      /* next */
    }
  return null;
};
const open = (p: string) => new Database(p, { readonly: true, fileMustExist: true });
const before = open(arg('--before'));
const after = open(arg('--after'));
const lib = (after.prepare('SELECT library_id FROM stage4_books LIMIT 1').get() as any).library_id;

type Rec = { key: string | null; title: string; words: string };
const recs = (db: Database.Database) => {
  const out = new Map<string, { amazon: Rec; bookwalker: Rec; ranobedb: Rec; query: any }>();
  for (const r of db
    .prepare(
      "SELECT calibre_uuid, data FROM evidence_records WHERE library_id = ? AND kind = 'online'",
    )
    .iterate(lib) as Iterable<{ calibre_uuid: string; data: Buffer }>) {
    const j = blob(r.data) ?? {};
    const am = j.amazon?.product ?? {};
    const bw = j.bookwalker?.detail ?? {};
    const rd = j.ranobedb?.book ?? {};
    out.set(r.calibre_uuid, {
      amazon: {
        key: am.asin ?? null,
        title: am.title ?? '',
        words: [...(am.rank_categories ?? []), ...(am.breadcrumbs ?? [])].join(','),
      },
      bookwalker: { key: bw.url ?? null, title: bw.title ?? '', words: bw.keywords ?? '' },
      ranobedb: {
        key: rd.id != null ? String(rd.id) : null,
        title: rd.title_orig ?? '',
        words: '',
      },
      query: j.query ?? {},
    });
  }
  return out;
};
const A = recs(before);
const B = recs(after);
const refStmt = after.prepare(
  "SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = 'reffile'",
);
const ids = new Map(
  (after.prepare('SELECT calibre_uuid, calibre_id FROM stage4_books').all() as any[]).map((r) => [
    r.calibre_uuid,
    r.calibre_id,
  ]),
);

const isBook = (rec: Rec, ft: string): boolean | null => {
  if (!rec.key || !rec.title) return null;
  const same = N(clean(rec.title)) === N(clean(ft));
  const qn = nums(ft);
  const tn = nums(rec.title);
  const numOk = !qn.size ? !tn.size || tn.has(1) : [...qn].some((x) => tn.has(x));
  return same || (numOk && N(clean(rec.title))?.startsWith(N(clean(ft)) ?? '\u0000') === true);
};

const counts: Record<string, number> = {};
const rows: any[] = [];
for (const [u, b] of B) {
  const a = A.get(u);
  if (!a) continue;
  let ft: string | null = null;
  let book: BookFacts | null = null;
  for (const store of ['amazon', 'bookwalker', 'ranobedb'] as const) {
    if (a[store].key === b[store].key) continue;
    if (ft === null) {
      const r = blob((refStmt.get(lib, u) as any)?.data ?? null) ?? {};
      const f = r.file && typeof r.file === 'object' ? r.file : r;
      ft = (f.opf_title as string) || '';
      book = {
        title: ft || b.query.title || '',
        text: `${f.front_text ?? ''}
${f.colophon_text ?? ''}`,
        textBook: b.query.text_book !== false,
      };
    }
    let v: string;
    if (arg('--fit')) {
      const o = recordFit(book!, a[store]);
      const n = recordFit(book!, b[store]);
      v =
        n === o
          ? o === null
            ? 'same: neither fits'
            : 'same fit'
          : o === null
            ? 'BETTER: only new fits'
            : n === null
              ? 'WORSE: only old fits'
              : n > o
                ? 'BETTER: fits more'
                : 'WORSE: fits less';
    } else {
      const o = isBook(a[store], ft);
      const n = isBook(b[store], ft);
      v =
        o === true && n !== true
          ? 'LOST: old was the book, new is not'
          : o !== true && n === true
            ? 'FIXED: new is the book, old was not'
            : o === true && n === true
              ? 'both the book'
              : 'neither the book';
    }
    const k = `${store} | ${v}`;
    counts[k] = (counts[k] ?? 0) + 1;
    rows.push({
      id: ids.get(u),
      uuid: u,
      store,
      verdict: v,
      file: ft,
      old: a[store],
      new: b[store],
    });
  }
}
for (const k of Object.keys(counts).sort()) console.log(String(counts[k]).padStart(5), k);
writeFileSync(arg('--out'), JSON.stringify(rows, null, 1));
