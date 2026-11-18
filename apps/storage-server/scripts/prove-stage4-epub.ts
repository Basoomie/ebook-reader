/**
 * WP20d proof: readRefEpub() reads the labeled books' EPUBs exactly as ref4.py did.
 *
 *   node -r ts-node/register/transpile-only scripts/prove-stage4-epub.ts <cleanup-reference dir> <metadata.db copy> <library dir>
 *
 * Every labeled book still in the library (stages 1 and 3 removed some) is read from its EPUB and
 * compared with the stored record's file fields. Calibre never rewrites the book files on a
 * metadata change, so the files are the ones ref4 read. Reads only (the database read-only).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { readRefEpub } from '../src/cleanup/stage4/ref-epub';

const [refDir, mdb, libDir] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  unknown
>;
const db = new Database(mdb, { readonly: true, fileMustExist: true });
const row = db.prepare(
  `SELECT b.path, d.name FROM books b JOIN data d ON d.book = b.id AND d.format = 'EPUB' WHERE b.id = ?`,
);
const FIELDS = [
  'opf_title',
  'creators',
  'asin',
  'chars',
  'images',
  'front_text',
  'colophon_text',
] as const;

async function main(): Promise<void> {
  const tally: Record<string, { same: number; differ: number; ex: string[] }> = {};
  let missing = 0;
  let failed = 0;
  let n = 0;
  const t0 = Date.now();
  for (const id of Object.keys(gold)) {
    const r = row.get(Number(id)) as { path: string; name: string } | undefined;
    if (!r) {
      missing += 1;
      continue;
    }
    const rec = JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as {
      file: Record<string, unknown>;
    };
    if (rec.file.error) continue;
    let f: Record<string, unknown>;
    try {
      f = (await readRefEpub(path.join(libDir, r.path, `${r.name}.epub`))) as unknown as Record<
        string,
        unknown
      >;
    } catch (err) {
      failed += 1;
      console.log(`read failed ${id}: ${(err as Error).message}`);
      continue;
    }
    n += 1;
    for (const k of FIELDS) {
      const t = (tally[k] ??= { same: 0, differ: 0, ex: [] });
      const a = JSON.stringify(f[k] ?? null);
      const b = JSON.stringify(rec.file[k] ?? null);
      if (a === b) t.same += 1;
      else {
        t.differ += 1;
        if (t.ex.length < 4) t.ex.push(`${id}: ts ${a.slice(0, 160)} | py ${b.slice(0, 160)}`);
      }
    }
  }
  console.log(
    `read ${n} books (${missing} no longer in the library, ${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
  for (const [k, t] of Object.entries(tally)) {
    console.log(`${t.differ ? 'DIFF' : 'OK  '} ${k}: ${t.same} equal, ${t.differ} differ`);
    for (const e of t.ex) console.log('    ' + e);
  }
}
void main();
