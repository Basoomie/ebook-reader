/**
 * WP21f-2 stop B1: the library changes' Preview on copies of the live databases. The real code
 * (library-changes.ts with stage 7's own tree and plan) runs in Preview on a working copy of a
 * cleanup.db that stages 4 and 5 already decided again (wp21c-redecide.ts + wp21c3-stage5.ts),
 * reading the library read only (metadata.json and inodes of the books that differ; the reader's
 * folders) over SMB, only while Calibre is idle (checked on /cleanup first), and a copy of
 * ttsu.db for the reader's links. Audiobookshelf is not asked here (no key on the PC): the books
 * whose links would be renamed are held as "ABS couldn't be asked" (the live Preview asks it).
 *
 *   npx vite-node scripts/wp21f2-preview.ts -- --db <decided cleanup.db> --ttsu <ttsu.db copy>
 *     --torrents Z:/torrents/audiobooks/japanese --media Z:/media/audiobooks --out <dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage7 } from '../src/cleanup/audio/stage7-arrivals';
import { LibraryChanges } from '../src/cleanup/audio/library-changes';
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
migrateCleanup(db);
const ttsu = new Database(arg('ttsu'), { readonly: true });
const media = arg('media');
const roots = { torrents: arg('torrents'), library: path.join(media, 'japanese'), media };
const lock = new DiskLock(5);
const stage7 = new AudioStage7({
  db,
  roots,
  lock,
  reanalyse: () => undefined,
  abs: () => null,
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
  abs: () => null,
  reader: () => reader,
  tree: () => s7.existingTree(),
  plan: () => s7.currentPlan(),
  sidecarVersion: () => ({ version: null, lastSeen: null }),
  log: (m) => console.log(m),
});
const t0 = Date.now();
const c = changes.start('analyse');
for (let i = 0; i < 1000; i++) {
  const r = await changes.step(1, c, () => false);
  if (typeof r === 'object') throw new Error(r.pause);
  if (r === 'done') break;
  if (c.phase === 'read' && c.total) console.log(`  read ${c.done}/${c.total}`);
}
const all = (kind: 'changes' | 'review' | 'reader' | 'links' | 'kept') =>
  changes.list(1, kind, { limit: 500 });
const report = {
  ms: Date.now() - t0,
  ledger: c.ledger,
  candidates: c.candidates,
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
console.log(`ledger ${c.ledger}, differ ${c.candidates}, in ${Math.round(report.ms / 1000)} s`);
console.log('counts', JSON.stringify(c.counts));
console.log('ops', JSON.stringify(report.ops));
for (const x of report.changes.items as {
  folderFrom: string;
  folderTo: string | null;
  fields: { field: string; from: unknown; to: unknown }[];
  userFields: string[];
  renames: unknown[];
  renamesHeld: boolean;
  reviews: { kind: string }[];
}[])
  console.log(
    `- ${x.folderFrom}${x.folderTo ? ` -> ${x.folderTo}` : ''} | fields ${x.fields.map((f) => f.field).join(',')}${x.userFields.length ? ` | yours ${x.userFields.join(',')}` : ''}${x.renames.length ? ` | renames ${x.renames.length}${x.renamesHeld ? ' held' : ''}` : ''}${x.reviews.length ? ` | review ${x.reviews.map((r) => r.kind).join(',')}` : ''}`,
  );
for (const x of report.kept.items as { folderFrom: string }[])
  console.log(`- kept as built: ${x.folderFrom}`);
console.log('reader files', report.reader.total, 'links', report.links.total);
