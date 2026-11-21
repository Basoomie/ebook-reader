/**
 * WP21f-2: the story order of every multi-file book of a copy of the live cleanup.db, by each
 * source (track tags, a twin's chapter names, the section-word rule, name order), with the
 * chosen one; reports every book the section-word rule orders differently from another source
 * that applies (the user's condition at stop A). Reads only the database: the live health rows
 * have no track tags yet (the probe never kept them), so `--tags` gives the ones read from the
 * files (headers only, over SMB while Calibre was idle: `.tmp-e2e/wp21f2/read-order-tags.mjs`).
 *
 *   npx vite-node scripts/wp21f2-order.ts -- --db <cleanup.db copy> [--tags <multi-tags.json>] --out <report.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { differsFromNames, orderParts, type OrderSource } from '../src/cleanup/audio/story-order';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const db = new Database(arg('db'), { readonly: true });
const s3 = (
  JSON.parse(
    (
      db.prepare('SELECT progress_json FROM audio_stages WHERE stage = 3').get() as {
        progress_json: string;
      }
    ).progress_json,
  ) as { analysisId: string; stage2Id: string }
).analysisId;
const copies = (
  db
    .prepare(
      `SELECT copy_key, kind, file_ids, title_key, volume, asins, abs_asins, name FROM audio_dup_copies WHERE analysis_id = ?`,
    )
    .all(s3) as {
    copy_key: string;
    kind: string;
    file_ids: string;
    title_key: string | null;
    volume: string | null;
    asins: string;
    abs_asins: string;
    name: string;
  }[]
).map((r) => ({
  key: r.copy_key,
  kind: r.kind,
  fileIds: JSON.parse(r.file_ids) as number[],
  titleKey: r.title_key,
  volume: r.volume,
  asins: JSON.parse(r.asins) as string[],
  absAsins: JSON.parse(r.abs_asins) as string[],
  name: r.name,
}));
const files = new Map(
  (
    db
      .prepare(
        `SELECT f.id, f.rel_path, f.decoded_path, h.tags_json, h.chapters_json FROM audio_files f
         LEFT JOIN audio_file_health h ON h.file_id = f.id WHERE f.kind = 'audio'`,
      )
      .all() as {
      id: number;
      rel_path: string;
      decoded_path: string | null;
      tags_json: string | null;
      chapters_json: string | null;
    }[]
  ).map((r) => [r.id, r]),
);
const discs = new Map(
  (
    db.prepare('SELECT file_id, disc FROM audio_book_files').all() as {
      file_id: number;
      disc: string | null;
    }[]
  ).map((r) => [r.file_id, r.disc]),
);
// Track tags read from the files (by path), when given.
const read = new Map<string, { track: string | null; disc: string | null }>();
const tagsFile = arg('tags', '');
if (tagsFile)
  for (const b of JSON.parse(fs.readFileSync(tagsFile, 'utf8')) as {
    list: { root: string; rel: string; track: string | null; disc: string | null }[];
  }[])
    for (const f of b.list) read.set(f.rel, { track: f.track, disc: f.disc });
const relOf = (id: number) => {
  const f = files.get(id)!;
  return f.decoded_path ?? f.rel_path;
};
const base = (rel: string) => path.posix.basename(rel).replace(/\.[^.]+$/, '');
const orders = orderParts(copies, {
  name: (id) => base(relOf(id)),
  disc: (id) => discs.get(id) ?? null,
  tags: (id) => {
    const r = read.get(relOf(id)) ?? read.get(files.get(id)!.rel_path);
    if (r) return r;
    const t = files.get(id)?.tags_json
      ? (JSON.parse(files.get(id)!.tags_json!) as Record<string, string>)
      : {};
    return t.track ? { track: t.track, disc: t.disc ?? null } : null;
  },
  chapters: (id) => {
    const c = files.get(id)?.chapters_json;
    return c ? (JSON.parse(c) as { title?: string }[]).map((x) => x.title ?? '') : null;
  },
});
const report: unknown[] = [];
const bySource: Record<string, number> = {};
const wordsDiffer: string[] = [];
const outOfNameOrder: string[] = [];
for (const c of copies) {
  const o = orders.get(c.key);
  if (!o) continue;
  bySource[o.source] = (bySource[o.source] ?? 0) + 1;
  const names = c.fileIds.map((id) => base(relOf(id)));
  const others = (Object.entries(o.all) as [OrderSource, number[]][]).filter(
    ([s]) => s !== 'words' && s !== 'name',
  );
  if (o.all.words)
    for (const [s, ord] of others)
      if (JSON.stringify(ord) !== JSON.stringify(o.all.words))
        wordsDiffer.push(`${c.name}: words ≠ ${s}`);
  if (differsFromNames(o.order)) outOfNameOrder.push(`${c.name} (${o.source})`);
  report.push({
    copy: c.key,
    name: c.name,
    files: names.length,
    source: o.source,
    twin: o.twin,
    sources: Object.keys(o.all),
    differsFromNames: differsFromNames(o.order),
    order: o.order.map((i) => names[i]),
    words: o.all.words ? o.all.words.map((i) => names[i]) : null,
  });
}
fs.writeFileSync(
  arg('out'),
  JSON.stringify({ stage3: s3, bySource, outOfNameOrder, wordsDiffer, books: report }, null, 1),
);
console.log(`multi-file copies: ${report.length}; chosen source:`, bySource);
console.log('out of name order:', outOfNameOrder);
console.log(
  'the section-word rule orders differently from another source:',
  wordsDiffer.length ? wordsDiffer : 'none',
);
for (const b of report as { name: string; source: string; sources: string[] }[])
  console.log(`  ${b.source.padEnd(5)} [${b.sources.join(',')}] ${b.name}`);
