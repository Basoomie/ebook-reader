/**
 * WP21g stop 1: the full rehearsal on copies of the live databases. The real stage 8 pass (check,
 * read, pair, values, covers, gate, Preview) runs on a working copy of cleanup.db, with the
 * reader's Calibre snapshot copy, a ttsu.db copy for the reader's links, and Audiobookshelf answered
 * from a copy of its own database (GET only; last night's backup). The library is not read over
 * SMB: each book folder is mirrored locally with the metadata.json Audiobookshelf left there (the
 * ledger's `seen`, else what we wrote), so the Preview's dry run of the library changes reads the
 * same values the live run will. Covers are not read here (the live run reads them under the disk
 * lock).
 *
 *   npx vite-node scripts/wp21g-preview.ts -- --cleanup <cleanup.db copy> --calibre <snapshot copy>
 *     --ttsu <ttsu.db copy> --abs <absdatabase.sqlite copy> --labels <ebook-pairs.json> --out <dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage7 } from '../src/cleanup/audio/stage7-arrivals';
import { AudioStage8 } from '../src/cleanup/audio/stage8-ebooks';
import { setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import type { SwitchReader } from '../src/cleanup/audio/stage6-switch';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const out = arg('out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'cleanup.db');
const src = new Database(arg('cleanup'), { readonly: true });
await src.backup(file);
src.close();
const db = new Database(file);
const t0 = Date.now();
migrateCleanup(db, { beforeAiMove: () => undefined });
console.log(`migrated to ${db.pragma('user_version', { simple: true })} in ${Date.now() - t0} ms`);

// The library mirrored from the ledger (metadata.json as Audiobookshelf left it).
const media = path.join(out, 'media');
let mirrored = 0;
for (const r of db
  .prepare(
    `SELECT folder, metadata, CASE WHEN seen_state = 'seen' THEN seen END AS seen FROM audio_library_books`,
  )
  .iterate() as Iterable<{ folder: string; metadata: Buffer; seen: Buffer | null }>) {
  const dir = path.join(media, ...r.folder.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), r.seen ?? r.metadata);
  mirrored++;
}
fs.mkdirSync(path.join(media, 'japanese-generated'), { recursive: true });
fs.mkdirSync(path.join(out, 'torrents'), { recursive: true });
fs.mkdirSync(path.join(out, 'calibre'), { recursive: true });
console.log(`mirrored ${mirrored} book folders`);

// Audiobookshelf from its database copy (GET only).
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
  if ((init?.method ?? 'GET') !== 'GET') throw new Error('the rehearsal only reads Audiobookshelf');
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

const labelsText = fs.readFileSync(arg('labels'), 'utf8');
const lock = new DiskLock(5);
const stage8 = new AudioStage8({
  db,
  lock,
  calibre: () => ({
    libraryId: 'japanese',
    snapshotFile: arg('calibre'),
    libraryDir: path.join(out, 'calibre'),
  }),
  readLabels: () => ({ text: labelsText, error: null }),
});
const stage7 = new AudioStage7({
  db,
  roots: { torrents: path.join(out, 'torrents'), library: path.join(media, 'japanese'), media },
  lock,
  reanalyse: () => undefined,
  abs: () => absConf,
  fetchImpl,
  timeZone: 'UTC',
  stage8,
});
const ttsu = new Database(arg('ttsu'), { readonly: true });
const refuse = () => {
  throw new Error('the rehearsal never changes the reader');
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
stage7.attachReader(reader);
setAudioStageMode(db, 8, 'analyse');

const fakeRun = { runId: 1, waiting: null } as never;
const preview = () =>
  (stage7 as unknown as { ebookPreview: (p: never) => Promise<never> }).ebookPreview(fakeRun);
const times: Record<string, number> = {};
stage8.begin(1);
let last = '';
let phaseAt = Date.now();
for (let i = 0; i < 100_000; i++) {
  const r = await stage8.step(() => false, preview);
  const p = stage8.progress()!;
  if (p.phase !== last) {
    if (last) times[last] = (times[last] ?? 0) + Date.now() - phaseAt;
    phaseAt = Date.now();
    last = p.phase;
    console.log(`  phase ${p.phase}`);
  }
  if (typeof r === 'object') throw new Error(r.stop);
  if (r === 'done') break;
}
const p = stage8.progress()!;
console.log({
  counts: p.counts,
  values: p.values,
  covers: p.covers,
  preview: p.preview,
  ebooks: p.ebooks,
  times,
});
console.log(
  `gate: ${p.gate?.passed ? 'passed' : 'FAILED'} (${p.gate?.wrong.length} wrong of ${p.gate?.labels})`,
);

// The Preview's changes by class, and the invariants.
const rows = db.prepare('SELECT * FROM audio_ebook_preview ORDER BY folder_from').all() as {
  book_id: number;
  unit_key: string | null;
  folder_from: string;
  folder_to: string | null;
  fields_json: string;
  reviews_json: string;
}[];
const byField = new Map<string, number>();
const reviewKinds = new Map<string, number>();
const kindOf = db.prepare(
  `SELECT kind FROM audio_meta_units WHERE unit_key = ? ORDER BY rowid DESC LIMIT 1`,
);
const dramaOf = db.prepare(
  `SELECT value_json FROM ai_values WHERE stage = 'audio5' AND item_key = ? AND field = 'drama'`,
);
const problems: string[] = [];
const lines: string[] = [];
for (const r of rows) {
  const fields = JSON.parse(r.fields_json) as {
    field: string;
    from: unknown;
    to: unknown;
    conflict?: boolean;
  }[];
  const reviews = JSON.parse(r.reviews_json) as { kind: string; text: string }[];
  for (const f of fields)
    byField.set(f.field + (f.conflict ? ' (conflict)' : ''), (byField.get(f.field) ?? 0) + 1);
  for (const x of reviews) reviewKinds.set(x.kind, (reviewKinds.get(x.kind) ?? 0) + 1);
  const k = r.unit_key ? (kindOf.get(r.unit_key) as { kind: string } | undefined)?.kind : null;
  const drama = r.unit_key
    ? (dramaOf.get(r.unit_key) as { value_json: string } | undefined)?.value_json === 'true'
    : false;
  if (k === 'ai' || k === 'radio' || drama)
    problems.push(`${r.folder_from}: a ${drama ? 'drama CD' : k} book would change`);
  if (r.folder_to && !r.folder_from.startsWith('japanese/'))
    problems.push(`${r.folder_from}: moved outside japanese/`);
  if (fields.some((f) => f.field === 'description' || f.field === 'title' || f.field === 'authors'))
    problems.push(`${r.folder_from}: stage 8 changes ${fields.map((f) => f.field).join(', ')}`);
  lines.push(
    `- ${r.folder_from}${r.folder_to ? ` → ${r.folder_to}` : ''} | ${fields.map((f) => `${f.field}${f.conflict ? '!' : ''}: ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)}`).join('; ')}${reviews.length ? ` | review ${reviews.map((x) => x.kind).join(',')}` : ''}`,
  );
}
console.log('fields', Object.fromEntries(byField), 'reviews', Object.fromEntries(reviewKinds));
console.log(`invariant problems: ${problems.length}`);
for (const x of problems.slice(0, 30)) console.log('  ', x);
fs.writeFileSync(path.join(out, 'preview.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'pairs.csv'), stage8.csv());
console.log(`wrote ${path.join(out, 'preview.md')} and pairs.csv`);
