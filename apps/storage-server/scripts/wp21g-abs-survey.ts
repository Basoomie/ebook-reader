/**
 * WP21g stop 1: what Audiobookshelf holds in genres and tags today, from the ledger's copies of
 * each book's metadata.json (`seen`: the file as ABS left it after its scan of our last write;
 * `metadata`: what we wrote), compared with the first audio file's own tags (stage 2's probe).
 * Read only, on a copy of cleanup.db.
 *
 *   npx vite-node scripts/wp21g-abs-survey.ts -- --cleanup <cleanup.db copy>
 */
import Database from 'better-sqlite3';

const i = process.argv.indexOf('--cleanup');
const db = new Database(process.argv[i + 1], { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `SELECT id, folder, files_json, metadata, seen, seen_state FROM audio_library_books ORDER BY id`,
  )
  .all() as {
  id: number;
  folder: string;
  files_json: string;
  metadata: Buffer;
  seen: Buffer | null;
  seen_state: string | null;
}[];
const tagsOf = db.prepare('SELECT tags_json FROM audio_file_health WHERE file_id = ?');
const genreCounts = new Map<string, number>();
const tagCounts = new Map<string, number>();
let seen = 0;
let genresSet = 0;
let genresEqualFileGenre = 0;
let tagsDiffer = 0;
const examples: string[] = [];
for (const r of rows) {
  if (!r.seen) continue;
  seen++;
  const s = JSON.parse(r.seen.toString('utf8')) as { genres?: string[]; tags?: string[] };
  const w = JSON.parse(r.metadata.toString('utf8')) as { genres?: string[]; tags?: string[] };
  const files = JSON.parse(r.files_json) as { fileId: number }[];
  const t = files[0]
    ? (tagsOf.get(files[0].fileId) as { tags_json: string | null } | undefined)
    : undefined;
  const ft = t?.tags_json ? (JSON.parse(t.tags_json) as Record<string, string>) : {};
  const g = s.genres ?? [];
  if (g.length) {
    genresSet++;
    for (const x of g) genreCounts.set(x, (genreCounts.get(x) ?? 0) + 1);
    const fileGenres = (ft.genre ?? '')
      .split(/[,、，/／;；]/)
      .map((x) => x.normalize('NFKC').trim())
      .filter(Boolean);
    const split = (l: string[]) =>
      l
        .flatMap((x) => x.split(/[,、，/／;；]/))
        .map((x) => x.normalize('NFKC').trim())
        .filter(Boolean)
        .sort()
        .join('|');
    const same = split(g) === split(fileGenres);
    if (same) genresEqualFileGenre++;
    else if (examples.length < 25)
      examples.push(
        `${r.folder}: genres ${JSON.stringify(g)} file genre ${JSON.stringify(ft.genre ?? null)}`,
      );
  }
  const st = [...(s.tags ?? [])].sort().join('|');
  const wt = [...(w.tags ?? [])].sort().join('|');
  if (st !== wt) {
    tagsDiffer++;
    for (const x of s.tags ?? []) tagCounts.set(x, (tagCounts.get(x) ?? 0) + 1);
  }
}
console.log({ books: rows.length, seen, genresSet, genresEqualFileGenre, tagsDiffer });
console.log('genres', [...genreCounts].sort((a, b) => b[1] - a[1]).slice(0, 30));
console.log('tags where they differ', [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 30));
for (const e of examples) console.log(' ', e);
