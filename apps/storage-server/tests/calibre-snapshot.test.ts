import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  configureSnapshotLockWarning,
  snapshotMetadataDb,
  SnapshotFailed,
  SnapshotPostponed,
  SnapshotSkipped,
} from '../src/calibre/snapshot';
import { copyWithoutLock, nextStepPages } from '../src/calibre/snapshot-worker';
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

  it('copies it in steps sized to the disk while it keeps changing', async () => {
    statHook.bumpAfter = -1;
    const { lib, db } = await busyLibrary();
    const touch = db.prepare('UPDATE books SET title = ? WHERE id = 1');
    let n = 0;
    // 50 commits a second (Calibre's backlog commits about once a second). Every 2 ms, Windows'
    // disk syncs keep the writer's lock taken nearly all the time and a copy that never waits
    // long for it is postponed: the next test.
    const writer = setInterval(() => touch.run(`t${n++}`), 20);
    try {
      const dest = path.join(makeTempDir('cache'), 'snap.db');
      // From memory a step grows to the whole file within a few steps, so the copy gets
      // through between two writes (before 2026-11-26 100-page steps never did).
      const res = await snapshotMetadataDb(lib.dbFile, dest, {
        timeoutMs: 10_000,
        allowChanging: true,
        lockFreeTries: 0,
      });
      expect(res.libraryUuid).toBe(lib.uuid);
      expect(res.lockMs).toBeLessThan(2_000);
      const copy = new Database(res.file, { readonly: true });
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      expect((copy.prepare('SELECT COUNT(*) n FROM filler').get() as { n: number }).n).toBe(2000);
      copy.close();
    } finally {
      clearInterval(writer);
      db.close();
    }
  });

  it('is postponed, never copied in one long step, when Calibre writes between every few steps (2026-11-28)', async () => {
    statHook.bumpAfter = -1;
    const { lib, db } = await busyLibrary();
    const touch = db.prepare('UPDATE books SET title = ? WHERE id = 1');
    let n = 0;
    const writer = setInterval(() => touch.run(`t${n++}`), 2);
    const dir = makeTempDir('cache');
    const dest = path.join(dir, 'snap.db');
    try {
      // Steps held to about 1 ms stand in for a slow disk: the copy needs many steps, Calibre
      // writes between them, and it is given up rather than finished under one long lock.
      const err = await snapshotMetadataDb(lib.dbFile, dest, {
        timeoutMs: 10_000,
        allowChanging: true,
        lockFreeTries: 0,
        maxLockMs: 1,
        budgetMs: 300,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SnapshotPostponed);
      expect(err).toBeInstanceOf(SnapshotSkipped); // the callers' "try later"
      expect((err as Error).message).toMatch(
        /^Calibre kept writing metadata.db: 0 lock-free read\(s\) and \d+ short-lock backup\(s\) in \d+ s found it changed \(last: (Calibre wrote between two steps 3 times|out of time)\)$/,
      );
    } finally {
      clearInterval(writer);
      db.close();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('step sizes (2026-11-28)', () => {
  it('sizes each step to half the longest lock at the last step pace, at most double the last', () => {
    // From memory: 256 pages in 2 ms → double (512), not the 128,000 the pace allows.
    expect(nextStepPages(256, 2, 2_000)).toBe(512);
    // A cold disk (the NAS: 1 MiB in about 200 ms): 1,280 pages fit in 1 s; it grows there.
    expect(nextStepPages(256, 200, 2_000)).toBe(512);
    expect(nextStepPages(2_048, 1_600, 2_000)).toBe(1_280);
    // A disk that stalls: 256 pages took 5 s → 51 pages, never below 16.
    expect(nextStepPages(256, 5_000, 2_000)).toBe(51);
    expect(nextStepPages(256, 60_000, 2_000)).toBe(16);
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
      const res = await snapshotMetadataDb(source, dest, { timeoutMs: 15_000, lockFreeTries: 0 });
      expect(res.libraryUuid).toBe('u-1');
      expect(res.steps).toBeGreaterThan(1);
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

describe("Calibre's lock (2026-11-27: Calibre's start failed with 'database is locked')", () => {
  it('copies a metadata.db nobody writes without taking any lock', async () => {
    const source = bigDatabase(2);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    const res = await snapshotMetadataDb(source, dest, { timeoutMs: 15_000 });
    expect(res.lockFree).toBe(true);
    expect(res.lockMs).toBe(0);
    expect(res.steps).toBe(0);
    expect(res.libraryUuid).toBe('u-1');
    expect(fs.readFileSync(dest).equals(fs.readFileSync(source))).toBe(true);
  });

  it('never keeps a lock-free read while a journal file is there', () => {
    const source = bigDatabase(1);
    fs.writeFileSync(`${source}-journal`, '');
    const tmp = path.join(makeTempDir('cache'), 'x.tmp');
    expect(copyWithoutLock(source, tmp)).toBe(false);
  });

  it('every copy is a committed state while a writer keeps rewriting pages across the file', async () => {
    // Each commit sets every row (pages all over the file) to the same version, so a copy read
    // part-way through a commit would hold two versions.
    const file = path.join(makeTempDir('calibre'), 'metadata.db');
    const db = new Database(file);
    db.exec(
      "CREATE TABLE library_id (id INTEGER PRIMARY KEY, uuid TEXT); INSERT INTO library_id (uuid) VALUES ('u-1');" +
        'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, pad BLOB)',
    );
    const ins = db.prepare('INSERT INTO t (v, pad) VALUES (0, ?)');
    db.transaction(() => {
      for (let i = 0; i < 300; i++) ins.run(Buffer.alloc(3000, i % 255));
    })();
    // Commits without waiting for the disk, so some reads fall between two of them.
    db.pragma('synchronous = OFF');
    const bump = db.prepare('UPDATE t SET v = ?');
    let v = 0;
    const writer = setInterval(() => bump.run(++v), 15);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    let lockFree = 0;
    let locked = 0;
    try {
      for (let i = 0; i < 30; i++) {
        const res = await snapshotMetadataDb(file, dest, {
          timeoutMs: 15_000,
          allowChanging: true,
        });
        if (res.lockFree) lockFree += 1;
        else locked += 1;
        const copy = new Database(dest, { readonly: true });
        try {
          expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
          const n = copy.prepare('SELECT COUNT(DISTINCT v) n FROM t').get() as { n: number };
          expect(n.n).toBe(1);
        } finally {
          copy.close();
        }
      }
    } finally {
      clearInterval(writer);
      db.close();
    }
    expect(v).toBeGreaterThan(30);
    expect(lockFree).toBeGreaterThan(0);
    expect(lockFree + locked).toBe(30);
  }, 120_000);

  it('a lock-free copy never makes Calibre wait; a backup holds the lock in short steps', async () => {
    const source = bigDatabase(80);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    // The old one-step copy, for scale: how long one step over the whole file holds the lock.
    const direct = new Database(source, { readonly: true });
    const from = Date.now();
    await direct.backup(path.join(makeTempDir('cache'), 'one-step.db'), {
      progress: () => 0x7fffffff,
    });
    const oneStepMs = Date.now() - from;
    direct.close();

    // Stands in for Calibre: takes its exclusive lock every millisecond, waiting for it as
    // Calibre does (Calibre waits up to 10 s; here 2 s), and notes the longest wait.
    const calibre = new Database(source);
    calibre.pragma('busy_timeout = 2000');
    let refused = 0;
    let tries = 0;
    let longestWait = 0;
    const takeLock = () => {
      tries += 1;
      const t = Date.now();
      try {
        calibre.exec('BEGIN EXCLUSIVE');
        calibre.exec('COMMIT');
      } catch (err) {
        if (/locked|busy/i.test(String(err))) refused += 1;
        else throw err;
      }
      longestWait = Math.max(longestWait, Date.now() - t);
    };
    const run = async (opts: { lockFreeTries?: number; maxLockMs?: number }) => {
      refused = 0;
      tries = 0;
      longestWait = 0;
      const timer = setInterval(takeLock, 1);
      try {
        return await snapshotMetadataDb(source, dest, { timeoutMs: 30_000, ...opts });
      } finally {
        clearInterval(timer);
      }
    };
    try {
      const lockFree = await run({});
      expect(lockFree.lockFree).toBe(true);
      expect(lockFree.lockMs).toBe(0);
      expect(tries).toBeGreaterThan(0);
      expect(refused).toBe(0);

      // Steps sized for 4 ms: many short steps, each far shorter than one step over the file.
      const stepped = await run({ lockFreeTries: 0, maxLockMs: 4 });
      expect(stepped.lockFree).toBe(false);
      expect(stepped.steps).toBeGreaterThan(10);
      expect(stepped.lockMs).toBeLessThan(oneStepMs);
      expect(refused).toBe(0);
      // Its waits are mostly SQLite's own pauses between tries (up to 100 ms each), far under
      // Calibre's 10 s.
      expect(longestWait).toBeLessThan(1_000);
      const copy = new Database(dest, { readonly: true });
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      copy.close();
    } finally {
      calibre.close();
    }
  }, 60_000);

  it('a backup begun while Calibre holds its write lock waits for it, never ends with no copy', async () => {
    // SQLite reports 0 pages remaining for a refused first step, and better-sqlite3 then ended
    // the backup as done and deleted the copy ("unable to open database file" on Linux).
    const source = bigDatabase(4);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    const calibre = new Database(source);
    calibre.pragma('busy_timeout = 2000');
    calibre.exec('BEGIN EXCLUSIVE');
    const release = setTimeout(() => calibre.exec('COMMIT'), 300);
    try {
      const res = await snapshotMetadataDb(source, dest, { timeoutMs: 15_000, lockFreeTries: 0 });
      expect(res.libraryUuid).toBe('u-1');
      expect(res.lockFree).toBe(false);
      const copy = new Database(dest, { readonly: true });
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      copy.close();
    } finally {
      clearTimeout(release);
      if (calibre.inTransaction) calibre.exec('COMMIT');
      calibre.close();
    }
  });

  it('warns when a copy held the lock longer than CALIBRE_LOCK_WARN_SECONDS', async () => {
    const source = bigDatabase(4);
    const dest = path.join(makeTempDir('cache'), 'snap.db');
    const lines: string[] = [];
    configureSnapshotLockWarning(0, (m) => lines.push(m));
    try {
      await snapshotMetadataDb(source, dest, { timeoutMs: 15_000, lockFreeTries: 0 });
      await snapshotMetadataDb(source, dest, { timeoutMs: 15_000 });
    } finally {
      configureSnapshotLockWarning(5, (m) => console.warn(m));
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /held its database lock for .* s in one step \(Calibre gives up after 10 s/,
    );
  });
});
