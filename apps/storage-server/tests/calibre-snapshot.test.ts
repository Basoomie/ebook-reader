import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { snapshotMetadataDb, SnapshotFailed, SnapshotSkipped } from '../src/calibre/snapshot';
import { CalibreRoot, fingerprint } from './helpers/calibre-fixture';
import { makeTempDir } from './helpers/spawn-server';

// Lets a test pretend metadata.db changed between the stat before and after the copy.
const statHook = vi.hoisted(() => ({ bumpAfter: -1, calls: 0 }));
vi.mock('../src/calibre/source-fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/calibre/source-fs')>();
  return {
    ...actual,
    statFile: async (file: string) => {
      const st = await actual.statFile(file);
      if (st && file.endsWith('metadata.db')) {
        statHook.calls++;
        if (statHook.bumpAfter >= 0 && statHook.calls > statHook.bumpAfter) {
          return { ...st, mtimeMs: st.mtimeMs + 1000 };
        }
      }
      return st;
    },
  };
});

async function sourceLibrary() {
  const root = new CalibreRoot();
  const lib = root.library('a');
  await lib.addBook({ title: 'One' });
  return { root, lib };
}

describe('metadata.db snapshot', () => {
  it('copies metadata.db with the backup API and leaves the source untouched', async () => {
    statHook.bumpAfter = -1;
    const { root, lib } = await sourceLibrary();
    const before = fingerprint(root.dir);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    const res = await snapshotMetadataDb(lib.dbFile, dest, { timeoutMs: 10_000 });
    expect(res.libraryUuid).toBe(lib.uuid);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
    expect(fingerprint(root.dir)).toEqual(before);
  });

  it('discards the copy when metadata.db changed while it was copied', async () => {
    const { lib } = await sourceLibrary();
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    statHook.calls = 0;
    statHook.bumpAfter = 1; // the first stat is real, the one after the copy differs
    try {
      await expect(snapshotMetadataDb(lib.dbFile, dest, { timeoutMs: 10_000 })).rejects.toThrow(
        SnapshotSkipped,
      );
    } finally {
      statHook.bumpAfter = -1;
    }
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
  });

  it('keeps the previous snapshot when a new copy fails', async () => {
    const { lib } = await sourceLibrary();
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    await snapshotMetadataDb(lib.dbFile, dest, { timeoutMs: 10_000 });
    const good = fs.readFileSync(dest);
    fs.writeFileSync(`${lib.dbFile}-journal`, '');
    await expect(snapshotMetadataDb(lib.dbFile, dest, { timeoutMs: 10_000 })).rejects.toThrow(
      /journal/,
    );
    expect(fs.readFileSync(dest).equals(good)).toBe(true);
  });

  it('gives up on a copy that takes too long', async () => {
    const { lib } = await sourceLibrary();
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    await expect(snapshotMetadataDb(lib.dbFile, dest, { timeoutMs: -1 })).rejects.toThrow(
      /took longer/,
    );
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });

  it('rejects files that are not a Calibre library', async () => {
    const dir = makeTempDir('calibre');
    const notDb = path.join(dir, 'metadata.db');
    fs.writeFileSync(notDb, 'hello');
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    await expect(snapshotMetadataDb(notDb, dest, { timeoutMs: 10_000 })).rejects.toThrow(
      SnapshotFailed,
    );
  });
});

describe('a metadata.db Calibre writes every few milliseconds (NAS 2026-11-15)', () => {
  async function busyLibrary() {
    const { root, lib } = await sourceLibrary();
    // Big enough for many 100-page steps (~8 MB).
    const db = new Database(lib.dbFile);
    db.exec('CREATE TABLE IF NOT EXISTS filler (x BLOB)');
    const ins = db.prepare('INSERT INTO filler VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run(Buffer.alloc(4000, i % 255));
    })();
    return { root, lib, db };
  }

  it('copies it in one step even while it keeps changing; step by step switches to one step after 3 restarts', async () => {
    statHook.bumpAfter = -1;
    const { lib, db } = await busyLibrary();
    const touch = db.prepare('UPDATE books SET title = ? WHERE id = 1');
    let n = 0;
    const writer = setInterval(() => touch.run(`t${n++}`), 2);
    try {
      const dest = path.join(makeTempDir('cache'), 'snap.db');
      // 100 pages at a time is restarted by every write; after 3 restarts the rest goes in one
      // step (before 2026-11-26 it never got through).
      const stepped = await snapshotMetadataDb(lib.dbFile, dest, {
        timeoutMs: 10_000,
        allowChanging: true,
      });
      // How often the writer lands between two steps depends on timing; never more than 3.
      expect(stepped.restarts).toBeLessThanOrEqual(3);
      expect(stepped.libraryUuid).toBe(lib.uuid);
      const res = await snapshotMetadataDb(lib.dbFile, dest, {
        timeoutMs: 10_000,
        allowChanging: true,
        oneStep: true,
      });
      const copy = new Database(res.file, { readonly: true });
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      expect((copy.prepare('SELECT COUNT(*) n FROM filler').get() as { n: number }).n).toBe(2000);
      copy.close();
    } finally {
      clearInterval(writer);
      db.close();
    }
  });
});

/** A database of about `mb` MB (4 KiB pages) to copy. */
function bigDatabase(mb: number): string {
  const file = path.join(makeTempDir('calibre'), 'metadata.db');
  const db = new Database(file);
  db.exec(
    "CREATE TABLE library_id (id INTEGER PRIMARY KEY, uuid TEXT); INSERT INTO library_id (uuid) VALUES ('u-1')",
  );
  db.exec('CREATE TABLE filler (x BLOB)');
  const ins = db.prepare('INSERT INTO filler VALUES (?)');
  db.transaction(() => {
    for (let i = 0; i < mb * 256; i++) ins.run(Buffer.alloc(4000, i % 255));
  })();
  db.close();
  return file;
}

/** Keeps this thread's event loop busy: every turn runs 50 ms of synchronous work. */
function busyLoop(): () => void {
  let on = true;
  const turn = () => {
    const end = Date.now() + 50;
    while (Date.now() < end);
    if (on) setTimeout(turn, 0);
  };
  setTimeout(turn, 0);
  return () => {
    on = false;
  };
}

describe('a busy server (NAS 2026-11-26: the copy took longer than 600 s)', () => {
  it('copies on its own thread: a busy main thread no longer slows the copy', async () => {
    statHook.bumpAfter = -1;
    const source = bigDatabase(20); // about 5,000 pages: 50 steps of 100 pages
    const stop = busyLoop();
    try {
      // The cause, shown with better-sqlite3 itself: on the calling thread each 100-page step
      // waits for a turn of its event loop, so 50 steps take at least 50 x 50 ms.
      const inThread = new Database(source, { readonly: true });
      let steps = 0;
      const started = Date.now();
      await expect(
        inThread.backup(path.join(makeTempDir('cache'), 'in-thread.db'), {
          progress: () => {
            steps += 1;
            if (Date.now() - started > 1500) throw new Error('over 1.5 s');
            return 100;
          },
        }),
      ).rejects.toThrow('over 1.5 s');
      inThread.close();
      expect(steps).toBeLessThan(40);

      // The fix: the same copy on a worker thread, while the main thread is just as busy.
      const dest = path.join(makeTempDir('cache'), 'snap.db');
      const res = await snapshotMetadataDb(source, dest, { timeoutMs: 15_000 });
      expect(res.libraryUuid).toBe('u-1');
      expect(res.steps).toBeGreaterThanOrEqual(50);
      expect(res.copyMs).toBeLessThan(1500);
    } finally {
      stop();
    }
  }, 60_000);

  it('returns the SHA-256 of the copy when asked', async () => {
    const source = bigDatabase(2);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    const res = await snapshotMetadataDb(source, dest, { timeoutMs: 15_000, hash: true });
    const sha = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    expect(res.sha256).toBe(sha);
  });

  it('a copy past its time limit is stopped and leaves no temporary file', async () => {
    const source = bigDatabase(20);
    const dir = makeTempDir('cache');
    const dest = path.join(dir, 'snap.db');
    await expect(snapshotMetadataDb(source, dest, { timeoutMs: 1 })).rejects.toThrow(
      /took longer than/,
    );
    // The stopped thread's file goes once the thread has stopped.
    for (let i = 0; i < 100 && fs.readdirSync(dir).length > 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes a temporary file an older server left behind', async () => {
    const source = bigDatabase(1);
    const dir = makeTempDir('cache');
    const dest = path.join(dir, 'snap.db');
    fs.writeFileSync(`${dest}.tmp`, 'left behind');
    await snapshotMetadataDb(source, dest, { timeoutMs: 15_000 });
    expect(fs.readdirSync(dir)).toEqual(['snap.db']);
  });
});
