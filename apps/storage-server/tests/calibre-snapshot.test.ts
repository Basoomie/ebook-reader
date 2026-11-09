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
