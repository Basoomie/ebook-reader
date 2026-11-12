/**
 * WP15f: the only writer in the audiobooks folder (src/audio/audio-write.ts). New files
 * only, in three allowed places; never a rename, overwrite or delete of a file it did not
 * create; no partial file left behind. Every test proves the existing files byte-identical.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAudioFolderByRelPath,
  listAudioFolders,
  upsertAudioFolder,
} from '../src/audio/audio-index';
import {
  AudioWriter,
  mergedNameCandidates,
  safeBaseName,
  WriteAborted,
  WriteRefused,
} from '../src/audio/audio-write';
import type { AudioScanService } from '../src/audio/scan-service';
import { audioEnv, treeDiff, treeHashes, write } from './helpers/audio-fixtures';
import type { IndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const GUIN = 'japanese/_Unknown/グイン・サーガ';

async function writerEnv(opts: Partial<ConstructorParameters<typeof AudioWriter>[0]> = {}) {
  const env = await audioEnv({ envs, services });
  const logs: string[] = [];
  const writer = new AudioWriter({
    db: env.e.db,
    root: env.root,
    log: (m) => logs.push(m),
    ...opts,
  });
  const rows = () =>
    env.e.db.prepare('SELECT * FROM audio_writes ORDER BY id').all() as {
      id: number;
      state: string;
      temp_rel_path: string;
      final_rel_path: string | null;
      direct: number;
    }[];
  return { ...env, writer, logs, rows, start: treeHashes(env.root) };
}

describe('names', () => {
  it('makes safe, short, numbered names for merged files', () => {
    expect(safeBaseName('Vol 3 - 悪役令嬢: 3')).toBe('Vol 3 - 悪役令嬢_ 3');
    expect(safeBaseName('..hidden/..')).toBe('hidden_');
    expect(safeBaseName('...')).toBe('audiobook');
    const names = mergedNameCandidates('グイン・サーガ');
    expect(names.slice(0, 3)).toEqual([
      'グイン・サーガ.m4b',
      'グイン・サーガ (merged).m4b',
      'グイン・サーガ (merged 2).m4b',
    ]);
    const long = mergedNameCandidates('長'.repeat(200));
    expect(long.every((n) => Buffer.byteLength(n) <= 255)).toBe(true);
  });
});

describe('merged files', () => {
  it('creates one new file next to the originals; everything else stays byte-identical', async () => {
    const t = await writerEnv();
    const progress: number[] = [];
    const result = await t.writer.createMergedFile({
      folderRelPath: GUIN,
      source: Buffer.from('merged audio'),
      onProgress: (w, total) => progress.push(w / total),
    });
    expect(result).toEqual({ name: 'グイン・サーガ.m4b', relPath: `${GUIN}/グイン・サーガ.m4b` });
    expect(fs.readFileSync(path.join(t.root, result.relPath), 'utf8')).toBe('merged audio');
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual({
      added: [result.relPath],
      removed: [],
      changed: [],
    });
    expect(progress.at(-1)).toBe(1);
    expect(t.rows()).toEqual([
      expect.objectContaining({ state: 'done', final_rel_path: result.relPath, direct: 0 }),
    ]);
    expect(t.rows()[0].temp_rel_path).toMatch(
      /^japanese\/_Unknown\/グイン・サーガ\/\.ttsu-write-[0-9a-f]{12}\.partial$/,
    );
  });

  it('copies a source file in chunks and never replaces an existing name', async () => {
    const t = await writerEnv();
    write(t.root, `${GUIN}/グイン・サーガ.m4b`, 'already here');
    write(t.root, `${GUIN}/グイン・サーガ (merged).m4b`, 'also here');
    const before = treeHashes(t.root);
    const src = path.join(makeTempDir('src'), 'big.m4b');
    fs.writeFileSync(src, Buffer.alloc(3 * 1024 * 1024 + 17, 5));
    const result = await t.writer.createMergedFile({ folderRelPath: GUIN, source: src });
    expect(result.name).toBe('グイン・サーガ (merged 2).m4b');
    expect(fs.readFileSync(path.join(t.root, result.relPath)).equals(fs.readFileSync(src))).toBe(
      true,
    );
    expect(treeDiff(before, treeHashes(t.root))).toEqual({
      added: [result.relPath],
      removed: [],
      changed: [],
    });
  });

  it('refuses anything but a present, indexed audiobook folder', async () => {
    const t = await writerEnv();
    const refused = (folderRelPath: string) =>
      expect(
        t.writer.createMergedFile({ folderRelPath, source: Buffer.from('x') }),
      ).rejects.toBeInstanceOf(WriteRefused);
    await refused('japanese'); // the library's audio folder itself (not indexed)
    await refused('japanese/_Archives/old'); // skipped by the scanner
    await refused('japanese-srt/Part 1');
    await refused(`${GUIN}/../..`);
    await refused('../outside');
    // A folder marked missing.
    const folder = getAudioFolderByRelPath(t.e.db, GUIN)!;
    t.e.db.prepare('UPDATE audio_folders SET missing_at = 1 WHERE id = ?').run(folder.id);
    await refused(GUIN);
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual({ added: [], removed: [], changed: [] });
    expect(t.rows()).toEqual([]);
  });

  it('refuses a folder that leads outside the audiobooks folder through a link', async () => {
    const t = await writerEnv();
    const outside = makeTempDir('outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const outsideBefore = treeHashes(outside);
    const linkRel = 'japanese/_Unknown/リンク';
    fs.symlinkSync(outside, path.join(t.root, ...linkRel.split('/')), 'junction');
    const lib = listAudioFolders(t.e.db, t.libId)[0];
    upsertAudioFolder(t.e.db, {
      ...lib,
      relPath: linkRel,
      name: 'リンク',
      files: [{ name: 'a.m4b', size: 1, mtimeMs: 1, durationSeconds: 1 }],
      seenAt: Date.now(),
    });
    await expect(
      t.writer.createMergedFile({ folderRelPath: linkRel, source: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(WriteRefused);
    expect(treeHashes(outside)).toEqual(outsideBefore);
    expect(t.rows()).toEqual([]);
  });

  it('removes its own partial file when stopped or when the source fails', async () => {
    const t = await writerEnv();
    const src = path.join(makeTempDir('src'), 'big.m4b');
    fs.writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 1));
    const ac = new AbortController();
    await expect(
      t.writer.createMergedFile({
        folderRelPath: GUIN,
        source: src,
        signal: ac.signal,
        onProgress: (w) => {
          if (w > 0) ac.abort();
        },
      }),
    ).rejects.toBeInstanceOf(WriteAborted);
    await expect(
      t.writer.createMergedFile({ folderRelPath: GUIN, source: path.join(src, 'nope') }),
    ).rejects.toThrow();
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual({ added: [], removed: [], changed: [] });
    expect(t.rows().map((r) => r.state)).toEqual(['cleaned', 'cleaned']);
  });

  it('creates the final name directly where hard links are not available', async () => {
    const t = await writerEnv({
      ops: {
        link: async () => {
          throw Object.assign(new Error('no links'), { code: 'EPERM' });
        },
      },
    });
    write(t.root, `${GUIN}/グイン・サーガ.m4b`, 'already here');
    const before = treeHashes(t.root);
    const result = await t.writer.createMergedFile({
      folderRelPath: GUIN,
      source: Buffer.from('m'),
    });
    expect(result.name).toBe('グイン・サーガ (merged).m4b');
    expect(treeDiff(before, treeHashes(t.root))).toEqual({
      added: [result.relPath],
      removed: [],
      changed: [],
    });
    expect(t.logs.some((l) => /no hard links/.test(l))).toBe(true);

    // A failure while writing directly removes only the file it created.
    const ac = new AbortController();
    ac.abort();
    const src = path.join(makeTempDir('src'), 'a.m4b');
    fs.writeFileSync(src, 'abc');
    const mid = treeHashes(t.root);
    await expect(
      t.writer.createMergedFile({ folderRelPath: GUIN, source: src, signal: ac.signal }),
    ).rejects.toBeInstanceOf(WriteAborted);
    expect(treeDiff(mid, treeHashes(t.root))).toEqual({ added: [], removed: [], changed: [] });
  });

  it('gives new files the configured owner and mode', async () => {
    const calls: string[] = [];
    const t = await writerEnv({
      owner: { uid: 99, gid: 100, mode: 0o666 },
      ops: {
        chown: async (_h, uid, gid) => void calls.push(`chown ${uid}:${gid}`),
        chmod: async (_h, mode) => void calls.push(`chmod ${mode.toString(8)}`),
      },
    });
    await t.writer.createMergedFile({ folderRelPath: GUIN, source: Buffer.from('m') });
    expect(calls).toEqual(['chown 99:100', 'chmod 666']);

    // A chown the file system refuses is reported once and the file is kept.
    const u = await writerEnv({
      owner: { uid: 99, gid: 100, mode: null },
      ops: {
        chown: async () => {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        },
      },
    });
    await u.writer.createMergedFile({ folderRelPath: GUIN, source: Buffer.from('m') });
    await u.writer.createMergedFile({ folderRelPath: GUIN, source: Buffer.from('n') });
    expect(u.logs.filter((l) => /owner\/mode/.test(l))).toHaveLength(1);
    expect(treeDiff(u.start, treeHashes(u.root)).added).toHaveLength(2);
  });
});

describe('recovery after an interruption', () => {
  it('removes only the partial files recorded as its own', async () => {
    const t = await writerEnv();
    const insert = (temp: string, state: string, direct = 0) =>
      t.e.db
        .prepare(
          `INSERT INTO audio_writes (purpose, temp_rel_path, direct, state, created_at, updated_at)
           VALUES ('merge', ?, ?, ?, 1, 1)`,
        )
        .run(temp, direct, state);
    // A temp file being written when the server stopped.
    const writing = `${GUIN}/.ttsu-write-aaaaaaaaaaaa.partial`;
    write(t.root, writing, 'half');
    insert(writing, 'writing');
    // A temp file created just before its row said so.
    const reserving = `${GUIN}/.ttsu-write-bbbbbbbbbbbb.partial`;
    write(t.root, reserving, 'half');
    insert(reserving, 'reserving');
    // Published (hard link made) but the temp name not yet removed.
    const published = `${GUIN}/.ttsu-write-cccccccccccc.partial`;
    write(t.root, published, 'whole');
    write(t.root, `${GUIN}/done.m4b`, 'whole');
    insert(published, 'published');
    // A direct create that never got its file: the name belongs to someone else now.
    insert(`${GUIN}/01.mp3`, 'reserving', 1);
    // A row whose path is not a temp name must never be removed, even when 'writing'
    // and not direct (a corrupted row).
    insert(`${GUIN}/02.mp3`, 'writing');
    // A finished write stays.
    insert(`${GUIN}/done.m4b`, 'done', 1);

    const before = treeHashes(t.root);
    expect(await t.writer.recover()).toBe(5);
    expect(treeDiff(before, treeHashes(t.root))).toEqual({
      added: [],
      removed: [published, writing, reserving].sort(),
      changed: [],
    });
    expect(fs.existsSync(path.join(t.root, GUIN, '01.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(t.root, GUIN, '02.mp3'))).toBe(true);
    expect(fs.readFileSync(path.join(t.root, GUIN, 'done.m4b'), 'utf8')).toBe('whole');
    expect(await t.writer.recover()).toBe(0);
  });
});

describe('generated folders (WP16, WP17)', () => {
  it("writes only under the library's _generated and -generated folders", async () => {
    const t = await writerEnv();
    expect(t.writer.generatedRoots(t.libId)).toEqual({
      subtitles: 'japanese-srt/_generated',
      audio: 'japanese-generated',
    });
    const a = await t.writer.createGeneratedFile({
      libraryId: t.libId,
      area: 'subtitles',
      relPath: 'スパイ教室/vol2.srt',
      source: Buffer.from('1\n'),
    });
    expect(a.relPath).toBe('japanese-srt/_generated/スパイ教室/vol2.srt');
    const b = await t.writer.createGeneratedFile({
      libraryId: t.libId,
      area: 'audio',
      relPath: 'book.m4b',
      source: Buffer.from('a'),
    });
    expect(b.relPath).toBe('japanese-generated/book.m4b');
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual({
      added: [b.relPath, a.relPath].sort(),
      removed: [],
      changed: [],
    });

    // Never replaces a file there either.
    const before = treeHashes(t.root);
    await expect(
      t.writer.createGeneratedFile({
        libraryId: t.libId,
        area: 'audio',
        relPath: 'book.m4b',
        source: Buffer.from('other'),
      }),
    ).rejects.toThrow(/exists already/);
    for (const relPath of [
      '../escape.srt',
      '../../japanese/x.m4b',
      '.hidden.srt',
      'a/.b/c.srt',
      '',
    ]) {
      await expect(
        t.writer.createGeneratedFile({
          libraryId: t.libId,
          area: 'subtitles',
          relPath,
          source: Buffer.from('x'),
        }),
      ).rejects.toBeInstanceOf(WriteRefused);
    }
    await expect(
      t.writer.createGeneratedFile({
        libraryId: 'no-such-library',
        area: 'audio',
        relPath: 'x.m4b',
        source: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(WriteRefused);
    expect(treeDiff(before, treeHashes(t.root))).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('the only writer', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const WRITE_CALL =
    /\b(writeFile|writeFileSync|appendFile|createWriteStream|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|mkdir|mkdirSync|copyFile|cp|cpSync|link|symlink|chmod|chown|truncate|utimes|lchown|fchown)\s*\(/;
  const WRITE_OPEN = /\bopen(Sync)?\([^)]*['"](w|wx|a|ax|r\+|w\+|a\+)['"]/;

  it('no other file under src/audio writes', () => {
    const allowed = new Set(['audio-write.ts', 'merge-workdir.ts']);
    const offenders: string[] = [];
    for (const name of fs.readdirSync(path.join(SRC, 'audio'))) {
      if (allowed.has(name)) continue;
      const text = fs.readFileSync(path.join(SRC, 'audio', name), 'utf8');
      text.split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return;
        if (WRITE_CALL.test(code) || WRITE_OPEN.test(code)) {
          offenders.push(`${name}:${i + 1}: ${code}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('only the startup code and the merge service use the writer', () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/audio-write'/.test(fs.readFileSync(full, 'utf8'))) {
          users.push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(users.sort()).toEqual(['audio/merge-service.ts', 'index.ts']);
  });
});
