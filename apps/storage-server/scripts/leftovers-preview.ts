/**
 * Audiobook cleanup leftovers, item 6: stage 7's library changes in Preview on copies of the
 * live databases, with item 6 in place. The real code (library-changes.ts with stage 7's own
 * tree and plan) on a working copy of a cleanup.db (migrated; the one-time AI move is not needed
 * on a copy), the stage-5 corrections applied as stage 5 applies them (the ST 黄 #6 one is new),
 * a copy of ttsu.db for the reader's links, and Audiobookshelf answered from a copy of its own
 * database (GET only: libraries, items with their import times, users' progress and bookmarks;
 * no password or token column is read). The library is read only (metadata.json and inodes) over
 * SMB, only while Calibre is idle (checked on /cleanup first).
 *
 *   npx vite-node scripts/leftovers-preview.ts -- --db <cleanup.db copy> --ttsu <ttsu.db copy>
 *     --abs <absdatabase.sqlite copy> --torrents Z:/torrents/audiobooks/japanese
 *     --media Z:/media/audiobooks --out <dir>
 *
 * Writes <out>/preview.json: the seen step's counts and each book's evidence, every field of
 * every book that differs from what was written with its state (fieldState), the changes, the
 * review (with the older values ABS kept) and the books kept as built.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage7 } from '../src/cleanup/audio/stage7-arrivals';
import { LibraryChanges } from '../src/cleanup/audio/library-changes';
import { fieldState } from '../src/cleanup/audio/library-plan';
import { CORRECTIONS } from '../src/cleanup/audio/meta-corrections';
import { setUserValue, valuesOf } from '../src/cleanup/ai-decide/values';
import type { SwitchReader } from '../src/cleanup/audio/stage6-switch';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'cleanup.db');
for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
const src = new Database(arg('db'), { readonly: true });
await src.backup(file);
src.close();
const db = new Database(file);
migrateCleanup(db, { beforeAiMove: () => undefined });

// Stage 5's corrections step, as it runs at every pass (stage5-meta.ts correctionsStep).
const p5 = JSON.parse(
  (
    db.prepare('SELECT progress_json FROM audio_stages WHERE stage = 5').get() as {
      progress_json: string;
    }
  ).progress_json,
) as { analysisId: string };
const find = db.prepare(
  'SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? AND record = ?',
);
let corrected = 0;
for (const c of CORRECTIONS)
  for (const { unit_key } of find.all(p5.analysisId, c.record) as { unit_key: string }[]) {
    const cur = valuesOf(db, 'audio5', unit_key).find((x) => x.field === c.field);
    if (cur?.source === 'user') continue;
    setUserValue(db, 'audio5', unit_key, c.field, c.value, Date.now());
    corrected++;
  }

// Audiobookshelf from a copy of its database (GET only).
const abs = new Database(arg('abs'), { readonly: true, fileMustExist: true });
const libs = abs.prepare('SELECT id, name FROM libraries').all() as { id: string; name: string }[];
const folders = abs.prepare('SELECT libraryId, path FROM libraryFolders').all() as {
  libraryId: string;
  path: string;
}[];
const itemOfMedia = new Map(
  (
    abs.prepare('SELECT id, mediaId FROM libraryItems').all() as { id: string; mediaId: string }[]
  ).map((r) => [r.mediaId, r.id]),
);
const ms = (t: string) => Date.parse(t.replace(' +00:00', 'Z').replace(' ', 'T'));
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  if ((init?.method ?? 'GET') !== 'GET') throw new Error('the Preview only reads Audiobookshelf');
  const u = new URL(String(url));
  if (u.pathname === '/api/libraries')
    return json({
      libraries: libs.map((l) => ({
        id: l.id,
        name: l.name,
        folders: folders.filter((f) => f.libraryId === l.id).map((f) => ({ fullPath: f.path })),
      })),
    });
  const items = /^\/api\/libraries\/([^/]+)\/items$/.exec(u.pathname);
  if (items) {
    const limit = Number(u.searchParams.get('limit') ?? 500);
    const page = Number(u.searchParams.get('page') ?? 0);
    const rows = abs
      .prepare(
        'SELECT id, relPath, createdAt FROM libraryItems WHERE libraryId = ? ORDER BY createdAt, id LIMIT ? OFFSET ?',
      )
      .all(items[1], limit, page * limit) as { id: string; relPath: string; createdAt: string }[];
    const total = (
      abs.prepare('SELECT COUNT(*) AS n FROM libraryItems WHERE libraryId = ?').get(items[1]) as {
        n: number;
      }
    ).n;
    return json({
      results: rows.map((r) => ({ id: r.id, relPath: r.relPath, addedAt: ms(r.createdAt) })),
      total,
    });
  }
  const item = /^\/api\/items\/([^/]+)$/.exec(u.pathname);
  if (item) {
    const r = abs.prepare('SELECT id, lastScan FROM libraryItems WHERE id = ?').get(item[1]) as
      | { id: string; lastScan: string | null }
      | undefined;
    return r
      ? json({ id: r.id, lastScan: r.lastScan ? ms(r.lastScan) : null })
      : new Response('{}', { status: 404 });
  }
  if (u.pathname === '/api/users')
    return json({ users: abs.prepare('SELECT id, username FROM users').all() });
  const user = /^\/api\/users\/([^/]+)$/.exec(u.pathname);
  if (user) {
    const row = abs
      .prepare('SELECT id, username, bookmarks FROM users WHERE id = ?')
      .get(user[1]) as { id: string; username: string; bookmarks: string | null } | undefined;
    if (!row) return new Response('{}', { status: 404 });
    const progress = abs
      .prepare('SELECT mediaItemId, currentTime, isFinished FROM mediaProgresses WHERE userId = ?')
      .all(user[1]) as { mediaItemId: string; currentTime: number; isFinished: number }[];
    return json({
      username: row.username,
      mediaProgress: progress.map((p) => ({
        libraryItemId: itemOfMedia.get(p.mediaItemId) ?? null,
        currentTime: p.currentTime,
        isFinished: p.isFinished === 1,
      })),
      bookmarks: JSON.parse(row.bookmarks ?? '[]'),
    });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const absConf = { baseUrl: 'http://abs-copy', apiKey: 'none', timeoutMs: 30_000 };

const ttsu = new Database(arg('ttsu'), { readonly: true });
const media = arg('media');
const roots = { torrents: arg('torrents'), library: path.join(media, 'japanese'), media };
const lock = new DiskLock(5);
const stage7 = new AudioStage7({
  db,
  roots,
  lock,
  reanalyse: () => undefined,
  abs: () => absConf,
  fetchImpl,
  timeZone: 'UTC',
});
const refuse = () => {
  throw new Error('the Preview never changes the reader');
};
const reader: SwitchReader = {
  db: ttsu,
  setHold: refuse,
  held: () => false,
  audioFolders: () => ['japanese'],
  scanIdle: async () => undefined,
  scanForSwitch: refuse,
  scanned: () => 0,
  wakeScan: refuse,
  resumeMerges: refuse,
  busy: () => [],
  snapshot: refuse,
};
const s7 = stage7 as unknown as {
  existingTree: () => Promise<never>;
  currentPlan: () => Promise<never>;
};
const changes = new LibraryChanges({
  db,
  media,
  lock,
  abs: () => absConf,
  fetchImpl,
  reader: () => reader,
  tree: () => s7.existingTree(),
  plan: () => s7.currentPlan(),
  sidecarVersion: () => ({ version: null, lastSeen: null }),
  log: (m) => console.log(m),
});
const t0 = Date.now();
const c = changes.start('analyse');
for (let i = 0; i < 10_000; i++) {
  const r = await changes.step(1, c, () => false);
  if (typeof r === 'object') throw new Error(r.pause);
  if (r === 'done') break;
  if ((c.phase === 'read' || c.phase === 'seen') && c.total && c.done % 1000 < 200)
    console.log(`  ${c.phase} ${c.done}/${c.total}`);
}

// Every field of every book of japanese/ that differs from what was written, with its state.
const parse = (b: Buffer | null) =>
  b ? (JSON.parse(b.toString('utf8')) as Record<string, unknown>) : null;
const FIELDS = [
  'tags',
  'title',
  'authors',
  'narrators',
  'series',
  'publishedYear',
  'publisher',
  'description',
  'asin',
  'language',
];
const books = db
  .prepare(
    `SELECT id, folder, files_json, metadata, before, seen, seen_state, seen_detail FROM audio_library_books WHERE area = 'main' ORDER BY id`,
  )
  .all() as {
  id: number;
  folder: string;
  files_json: string;
  metadata: Buffer;
  before: Buffer | null;
  seen: Buffer | null;
  seen_state: string | null;
  seen_detail: string | null;
}[];
const tagsOf = db.prepare('SELECT tags_json FROM audio_file_health WHERE file_id = ?');
const fields: Record<string, unknown>[] = [];
const byState: Record<string, number> = {};
const seenStates: Record<string, number> = {};
const unproven: { folder: string; detail: string | null }[] = [];
for (const b of books) {
  seenStates[b.seen_state ?? 'unknown'] = (seenStates[b.seen_state ?? 'unknown'] ?? 0) + 1;
  if (b.seen_state === 'unproven') unproven.push({ folder: b.folder, detail: b.seen_detail });
  // A proven book's file is its `seen` (read just now); the others are read again.
  const diskBytes =
    b.seen_state === 'seen'
      ? b.seen
      : fs.readFileSync(path.join(media, ...b.folder.split('/'), 'metadata.json'));
  const disk = parse(diskBytes) ?? {};
  const written = parse(b.metadata) ?? {};
  const first = (JSON.parse(b.files_json) as { fileId: number }[])[0];
  const tags = first
    ? (JSON.parse(
        (tagsOf.get(first.fileId) as { tags_json: string | null } | undefined)?.tags_json ?? 'null',
      ) as Record<string, string> | null)
    : null;
  for (const field of FIELDS) {
    const state = fieldState({
      field,
      disk,
      written,
      seen: b.seen_state === 'seen' ? parse(b.seen) : null,
      before: parse(b.before),
      yours: false,
      tags,
    });
    if (state === 'ours') continue;
    byState[state] = (byState[state] ?? 0) + 1;
    fields.push({
      folder: b.folder,
      field,
      state,
      disk: disk[field] ?? null,
      written: written[field] ?? null,
      evidence: b.seen_detail,
    });
  }
}
const all = (kind: 'changes' | 'review' | 'reader' | 'links' | 'kept') =>
  changes.list(1, kind, { limit: 500 });
const report = {
  ms: Date.now() - t0,
  corrected,
  ledger: c.ledger,
  candidates: c.candidates,
  seen: c.seen,
  seenStates,
  unproven,
  fieldStates: byState,
  fields,
  counts: c.counts,
  times: c.phaseTimes,
  changes: all('changes'),
  review: all('review'),
  kept: all('kept'),
  reader: all('reader'),
  links: all('links'),
  ops: db
    .prepare(`SELECT kind, COUNT(*) AS n FROM audio_library_ops WHERE run_id = 1 GROUP BY kind`)
    .all(),
};
fs.writeFileSync(path.join(out, 'preview.json'), JSON.stringify(report, null, 1));
console.log(
  `corrections applied ${corrected}; ledger ${c.ledger}, differ ${c.candidates}, in ${Math.round(report.ms / 1000)} s`,
);
console.log('seen', JSON.stringify(c.seen), 'states', JSON.stringify(seenStates));
console.log('field states', JSON.stringify(byState));
console.log('counts', JSON.stringify(c.counts));
console.log('ops', JSON.stringify(report.ops));
for (const x of report.changes.items as {
  folderFrom: string;
  folderTo: string | null;
  fields: { field: string; from: unknown; to: unknown }[];
  userFields: string[];
  absKept?: { field: string }[];
  renames: unknown[];
  renamesHeld: boolean;
  reviews: { kind: string }[];
}[])
  console.log(
    `- ${x.folderFrom}${x.folderTo ? ` -> ${x.folderTo}` : ''} | fields ${x.fields.map((f) => `${f.field} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`).join('; ')}${x.userFields.length ? ` | yours ${x.userFields.join(',')}` : ''}${x.absKept?.length ? ` | ABS kept ${x.absKept.map((f) => f.field).join(',')}` : ''}${x.renames.length ? ` | renames ${x.renames.length}${x.renamesHeld ? ' held' : ''}` : ''}${x.reviews.length ? ` | review ${x.reviews.map((r) => r.kind).join(',')}` : ''}`,
  );
for (const x of report.kept.items as { folderFrom: string }[])
  console.log(`- kept as built: ${x.folderFrom}`);
console.log('reader files', report.reader.total, 'links', report.links.total);
