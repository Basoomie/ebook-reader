/**
 * WP21e-2: the switch to the new audiobook library. The remap of the reader's links, the
 * reader's hold, the linking sidecar's new abilities (each bounded and test-enforced), and the
 * whole switch -> Undo -> switch -> delete japanese-old through the real sidecar over HTTP, the
 * real stage 6 build and the reader's real scanner, with tree proofs of the torrents and the
 * old library.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FROM_LIBRARY,
  INVENTORY_NAMES,
  LinkWriter,
  OLD_ROOT,
  RENAME_PAIRS,
  WriteRefused,
} from '../../cleanup-link/src/writer';
import { LinkWorker } from '../../cleanup-link/src/worker';
import { clearHold, isHeld, setHold, AudioHoldError } from '../src/audio/audio-hold';
import { resolveLink, saveLink, getLink } from '../src/audio/audio-links';
import { AudioScanService } from '../src/audio/scan-service';
import { AudioWriter } from '../src/audio/audio-write';
import { getScanState, requestAudioScan } from '../src/audio/audio-index';
import { updateLibrary } from '../src/calibre/libraries';
import { DEFAULT_AUDIO } from '../src/config';
import { listUsers } from '../src/db/users';
import { createApplyToken } from '../src/cleanup/apply-tokens';
import { updateSettings } from '../src/cleanup/settings';
import {
  afterRenames,
  remapCounts,
  remapLinks,
  type SwitchMove,
} from '../src/cleanup/audio/switch-remap';
import { switchReader, readerBusy } from '../src/cleanup/audio/switch-reader';
import { SWITCH_BATCH_BASE } from '../src/cleanup/audio/stage6-switch';
import { makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { seedBuild, type BuildSeed } from './helpers/build-seed';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const LINK_SRC = path.join(__dirname, '..', '..', 'cleanup-link', 'src');

/** Every entry under a folder: kind, size, mtime, inode, content hash; and its link count. */
function treeProof(dir: string): Map<string, { line: string; nlink: number; ino: string }> {
  const out = new Map<string, { line: string; nlink: number; ino: string }>();
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { bigint: true });
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (st.isDirectory()) {
        out.set(rel, { line: `D ${st.mtimeMs} ${st.ino}`, nlink: 0, ino: String(st.ino) });
        walk(p);
      } else {
        out.set(rel, {
          line: `F ${st.size} ${st.mtimeMs} ${st.dev}:${st.ino} ${sha(fs.readFileSync(p))}`,
          nlink: Number(st.nlink),
          ino: String(st.ino),
        });
      }
    }
  };
  walk(dir);
  return out;
}

const audio = (n: number, size = 4000) => Buffer.alloc(size, n);

// ---------------------------------------------------------------------------------------------
describe('the remap of the reader’s links (switch-remap.ts)', () => {
  const moves: SwitchMove[] = [
    {
      oldPath: 'japanese/A/a.m4b',
      outcome: 'moved',
      newPath: 'japanese-new/作者/A/a.m4b',
      keptPath: null,
    },
    {
      oldPath: 'japanese/AI/x.m4b',
      outcome: 'ai',
      newPath: 'japanese-generated-new/_Unknown/X/x.m4b',
      keptPath: null,
    },
    // A dropped copy: the kept copy's file.
    {
      oldPath: 'japanese/B/b.m4b',
      outcome: 'dropped',
      newPath: null,
      keptPath: 'japanese-new/作者/A/a.m4b',
    },
    // Dropped copies whose kept copy has another file count: its folder (one file / three).
    {
      oldPath: 'japanese/C/1.mp3',
      outcome: 'dropped',
      newPath: null,
      keptPath: 'japanese-new/作者/C',
    },
    {
      oldPath: 'japanese/C/2.mp3',
      outcome: 'dropped',
      newPath: null,
      keptPath: 'japanese-new/作者/C',
    },
    {
      oldPath: 'japanese/D/d.m4b',
      outcome: 'dropped',
      newPath: null,
      keptPath: 'japanese-new/作者/D',
    },
    {
      oldPath: 'japanese/T/t.m4b',
      outcome: 'library_only_pending',
      newPath: 'japanese-new/餅月望/T/Vol 10 - T/t.m4b',
      keptPath: null,
    },
    // A folder whose files land in two folders.
    {
      oldPath: 'japanese/S/1.m4b',
      outcome: 'moved',
      newPath: 'japanese-new/作者/S1/1.m4b',
      keptPath: null,
    },
    {
      oldPath: 'japanese/S/2.m4b',
      outcome: 'moved',
      newPath: 'japanese-new/作者/S2/2.m4b',
      keptPath: null,
    },
    { oldPath: 'japanese/M/merged.m4b', outcome: 'reader_written', newPath: null, keptPath: null },
    // Parts of one book: a folder link maps to their one new folder.
    {
      oldPath: 'japanese/P/Disc 1/01.mp3',
      outcome: 'moved',
      newPath: 'japanese-new/作者/P/Disc 1/01.mp3',
      keptPath: null,
    },
    {
      oldPath: 'japanese/Q/01.mp3',
      outcome: 'moved',
      newPath: 'japanese-new/作者/Q/01.mp3',
      keptPath: null,
    },
    {
      oldPath: 'japanese/Q/02.mp3',
      outcome: 'moved',
      newPath: 'japanese-new/作者/Q/02.mp3',
      keptPath: null,
    },
  ];
  const plannedFiles = new Map<string, string[]>([
    ['japanese-new/作者/C', ['japanese-new/作者/C/c.m4b']],
    [
      'japanese-new/作者/D',
      ['japanese-new/作者/D/1.mp3', 'japanese-new/作者/D/2.mp3', 'japanese-new/作者/D/3.mp3'],
    ],
  ]);
  const link = (
    bookId: string,
    folder: string | null,
    file: string | null,
    state: 'linked' | 'none' = 'linked',
  ) => ({
    userId: 'u',
    bookId,
    state,
    folderRelPath: folder,
    fileName: file,
  });

  it('maps every outcome, reads the build folders as renamed, and lists what it can’t map', () => {
    const r = remapLinks(
      [
        link('moved', 'japanese/A', 'a.m4b'),
        link('ai', 'japanese/AI', 'x.m4b'),
        link('dropped', 'japanese/B', 'b.m4b'),
        link('dropped-one', 'japanese/C', '1.mp3'),
        link('dropped-many', 'japanese/D', 'd.m4b'),
        link('library-only', 'japanese/T', 't.m4b'),
        link('folder', 'japanese/Q', null),
        link('split', 'japanese/S', null),
        link('merged', 'japanese/M', 'merged.m4b'),
        link('unknown', 'japanese/Z', 'z.m4b'),
        link('srt', 'japanese-srt/Part 1', 'x.m4b'),
        link('generated', 'japanese-generated/作者/本', 'book.m4b'),
        link('none', null, null, 'none'),
      ],
      moves,
      { libraryFolder: 'japanese', plannedFiles },
    );
    const by = Object.fromEntries(r.map((x) => [x.bookId, x]));
    expect(by.moved).toMatchObject({
      outcome: 'moved',
      newFolder: 'japanese/作者/A',
      newFile: 'a.m4b',
      changed: true,
    });
    expect(by.ai).toMatchObject({
      outcome: 'ai',
      newFolder: 'japanese-generated/_Unknown/X',
      newFile: 'x.m4b',
    });
    expect(by.dropped).toMatchObject({
      outcome: 'dropped',
      newFolder: 'japanese/作者/A',
      newFile: 'a.m4b',
    });
    expect(by['dropped-one']).toMatchObject({
      outcome: 'dropped',
      newFolder: 'japanese/作者/C',
      newFile: 'c.m4b',
    });
    expect(by['dropped-many']).toMatchObject({
      outcome: 'dropped',
      newFolder: 'japanese/作者/D',
      newFile: null,
    });
    expect(by['dropped-many'].detail).toMatch(/3 files \(choose one\)/);
    expect(by['library-only']).toMatchObject({
      outcome: 'library_only',
      newFolder: 'japanese/餅月望/T/Vol 10 - T',
      newFile: 't.m4b',
    });
    expect(by.folder).toMatchObject({
      outcome: 'folder',
      newFolder: 'japanese/作者/Q',
      newFile: null,
      changed: true,
    });
    expect(by.split).toMatchObject({ outcome: 'listed', changed: false, newFolder: 'japanese/S' });
    expect(by.split.detail).toMatch(/2 folders/);
    expect(by.merged).toMatchObject({
      outcome: 'listed',
      detail: expect.stringMatching(/written by the reader/),
    });
    expect(by.unknown).toMatchObject({ outcome: 'listed', detail: 'not in the move list' });
    for (const k of ['srt', 'generated', 'none'])
      expect(by[k]).toMatchObject({ outcome: 'outside', changed: false });
    expect(remapCounts(r)).toMatchObject({
      moved: 1,
      ai: 1,
      dropped: 3,
      library_only: 1,
      folder: 1,
      listed: 3,
      outside: 3,
      changed: 7,
    });
  });

  it('reads the move list’s first folder as the reader’s (stage 6 names it after the mount: `library` on the NAS)', () => {
    const r = remapLinks(
      [link('moved', 'japanese/A', 'a.m4b')],
      moves.map((m) => ({ ...m, oldPath: m.oldPath.replace(/^japanese\//, 'library/') })),
      { libraryFolder: 'japanese', moveFolder: 'library', plannedFiles },
    );
    expect(r[0]).toMatchObject({
      outcome: 'moved',
      newFolder: 'japanese/作者/A',
      newFile: 'a.m4b',
    });
  });

  it('reads only the two build folders as renamed', () => {
    expect(afterRenames('japanese-new/a/b.m4b')).toBe('japanese/a/b.m4b');
    expect(afterRenames('japanese-generated-new/a')).toBe('japanese-generated/a');
    expect(afterRenames('japanese-new')).toBe('japanese');
    expect(afterRenames('japanese-newer/a')).toBe('japanese-newer/a');
    expect(afterRenames('japanese/x')).toBe('japanese/x');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the linking sidecar’s switch abilities (writer.ts)', () => {
  function disk() {
    const dir = makeTempDir('wp21e2-writer');
    const data = path.join(dir, 'data');
    const torrents = path.join(data, 'torrents', 'audiobooks', 'japanese');
    const media = path.join(data, 'media', 'audiobooks');
    const put = (abs: string, bytes: Buffer | string) => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    };
    put(path.join(torrents, 'TMW/a.m4b'), audio(1));
    put(path.join(media, 'japanese/_Unknown/ティア/t.m4b'), audio(2));
    put(path.join(media, 'japanese/needs_review.csv'), 'a,b\r\n');
    put(path.join(media, 'japanese-new/作者/本/a.m4b'), audio(9));
    fs.mkdirSync(path.join(media, 'japanese-generated-new'), { recursive: true });
    const w = new LinkWriter({ dataDir: data });
    const st = (p: string) => fs.lstatSync(p);
    // As the server reads them: lstat with bigint, as numbers (Windows inodes need it).
    const plan = (p: string) => {
      const s = fs.lstatSync(p, { bigint: true });
      return {
        size: Number(s.size),
        mtimeMs: Math.floor(Number(s.mtimeMs)),
        dev: Number(s.dev),
        ino: Number(s.ino),
      };
    };
    return { dir, data, torrents, media, w, st, plan, put };
  }

  it('renames only the six allowed pairs, never onto an existing name, and only the planned folder', async () => {
    const d = disk();
    const ino = (rel: string) =>
      Number(fs.lstatSync(path.join(d.media, rel), { bigint: true }).ino);
    const japanese = ino('japanese');
    const neu = ino('japanese-new');
    await expect(d.w.renameRoot('japanese', 'elsewhere', japanese)).rejects.toBeInstanceOf(
      WriteRefused,
    );
    await expect(d.w.renameRoot('japanese-srt', 'japanese-old', japanese)).rejects.toBeInstanceOf(
      WriteRefused,
    );
    // Onto an existing name: refused (rename() would replace an empty folder).
    await expect(d.w.renameRoot('japanese-new', 'japanese', neu)).rejects.toThrow(/already there/);
    // The planned inode only.
    await expect(d.w.renameRoot('japanese', 'japanese-old', neu)).rejects.toThrow(/inode/);
    // A symlink in place of the folder: refused.
    fs.symlinkSync(
      path.join(d.media, 'japanese-new'),
      path.join(d.media, 'japanese-generated'),
      'junction',
    );
    await expect(
      d.w.renameRoot('japanese-generated', 'japanese-generated-new', neu),
    ).rejects.toThrow();
    fs.rmSync(path.join(d.media, 'japanese-generated'), { recursive: false, force: true });
    expect(await d.w.renameRoot('japanese', 'japanese-old', japanese)).toEqual({ existed: false });
    expect(await d.w.renameRoot('japanese-new', 'japanese', neu)).toEqual({ existed: false });
    // Again (a lost report): already done counts as done, and the new japanese is not touched.
    expect(await d.w.renameRoot('japanese', 'japanese-old', japanese)).toEqual({ existed: true });
    expect(await d.w.renameRoot('japanese-new', 'japanese', neu)).toEqual({ existed: true });
    expect(ino('japanese-old')).toBe(japanese);
    expect(ino('japanese')).toBe(neu);
    // Undo's pairs.
    expect(await d.w.renameRoot('japanese', 'japanese-new', neu)).toEqual({ existed: false });
    expect(await d.w.renameRoot('japanese-old', 'japanese', japanese)).toEqual({ existed: false });
    expect(RENAME_PAIRS).toEqual([
      ['japanese', 'japanese-old'],
      ['japanese-new', 'japanese'],
      ['japanese-generated-new', 'japanese-generated'],
      ['japanese', 'japanese-new'],
      ['japanese-old', 'japanese'],
      ['japanese-generated', 'japanese-generated-new'],
    ]);
  });

  it('links a library-only file under _from-library only when it is still the same bytes', async () => {
    const d = disk();
    const lib = path.join(d.media, 'japanese/_Unknown/ティア/t.m4b');
    const src = {
      rel: 'japanese/_Unknown/ティア/t.m4b',
      raw: null,
      ...d.plan(lib),
      sha256: sha(audio(2)),
    };
    const torrentsBefore = treeProof(d.torrents);
    // Outside _from-library, outside the live library, a wrong hash, a changed file: refused.
    await expect(d.w.linkToFromLibrary(src, 'TMW/t.m4b')).rejects.toThrow(/_from-library/);
    await expect(
      d.w.linkToFromLibrary({ ...src, rel: 'japanese-new/作者/本/a.m4b' }, '_from-library/x/a.m4b'),
    ).rejects.toThrow(/live library/);
    await expect(
      d.w.linkToFromLibrary({ ...src, sha256: sha(audio(3)) }, '_from-library/ティア/t.m4b'),
    ).rejects.toThrow(/SHA-256/);
    await expect(
      d.w.linkToFromLibrary({ ...src, mtimeMs: src.mtimeMs - 5000 }, '_from-library/ティア/t.m4b'),
    ).rejects.toThrow(/changed \(mtime\)/);
    await expect(d.w.linkToFromLibrary(src, '_from-library/../escape/t.m4b')).rejects.toThrow();
    const r = await d.w.linkToFromLibrary(src, '_from-library/ティア/t.m4b');
    expect(r).toMatchObject({ existed: false, ino: src.ino, sha256: src.sha256 });
    expect(d.plan(path.join(d.torrents, '_from-library/ティア/t.m4b')).ino).toBe(src.ino);
    expect(d.st(lib).nlink).toBe(2);
    // Again: done; another file at the name: refused, never replaced.
    expect((await d.w.linkToFromLibrary(src, '_from-library/ティア/t.m4b')).existed).toBe(true);
    d.put(path.join(d.torrents, '_from-library/ティア/other.m4b'), 'x');
    await expect(d.w.linkToFromLibrary(src, '_from-library/ティア/other.m4b')).rejects.toThrow(
      /different file/,
    );
    // The torrents: only the new names under _from-library; everything else as it was.
    const after = treeProof(d.torrents);
    for (const [rel, e] of torrentsBefore) expect(after.get(rel)?.line, rel).toBe(e.line);
    expect([...after.keys()].filter((k) => !torrentsBefore.has(k)).sort()).toEqual([
      '_from-library',
      '_from-library/ティア',
      '_from-library/ティア/other.m4b',
      '_from-library/ティア/t.m4b',
    ]);
    // Then the planned link from there into the new library (the build's linkFile).
    fs.mkdirSync(path.join(d.media, 'japanese-new/餅月望/ティア'), { recursive: true });
    const l = await d.w.linkFile(
      {
        rel: '_from-library/ティア/t.m4b',
        raw: null,
        size: src.size,
        mtimeMs: src.mtimeMs,
        dev: src.dev,
        ino: src.ino,
      },
      'japanese-new/餅月望/ティア/t.m4b',
    );
    expect(l).toMatchObject({ existed: false, ino: src.ino });
    expect(d.st(lib).nlink).toBe(3);
    expect(FROM_LIBRARY).toBe('_from-library');
  });

  it('copies only the old copy script’s five files into _inventory, create-only', async () => {
    const d = disk();
    fs.renameSync(path.join(d.media, 'japanese'), path.join(d.media, OLD_ROOT));
    const csv = path.join(d.media, OLD_ROOT, 'needs_review.csv');
    await expect(d.w.copyInventory('metadata.json', d.plan(csv))).rejects.toThrow(
      /Not an inventory file/,
    );
    await expect(d.w.copyInventory('../needs_review.csv', d.plan(csv))).rejects.toThrow();
    await expect(
      d.w.copyInventory('needs_review.csv', { ...d.plan(csv), size: 1 }),
    ).rejects.toThrow(/changed/);
    expect(await d.w.copyInventory('needs_review.csv', d.plan(csv))).toEqual({
      existed: false,
      size: 5,
    });
    const copy = path.join(d.media, '_inventory/old-copy-script/needs_review.csv');
    expect(fs.readFileSync(copy, 'utf8')).toBe('a,b\r\n');
    expect(d.plan(copy).ino).not.toBe(d.plan(csv).ino);
    expect((await d.w.copyInventory('needs_review.csv', d.plan(csv))).existed).toBe(true);
    fs.writeFileSync(copy, 'changed');
    await expect(d.w.copyInventory('needs_review.csv', d.plan(csv))).rejects.toThrow(
      /different file/,
    );
    expect(INVENTORY_NAMES).toEqual([
      'needs_extraction.csv',
      'needs_review.csv',
      'restructure_log.csv',
      'unmatched_bonus_content.csv',
      '.processed_files.json',
    ]);
  });

  it('deletes only listed, unchanged entries of japanese-old; a folder only when empty', async () => {
    const d = disk();
    fs.renameSync(path.join(d.media, 'japanese'), path.join(d.media, OLD_ROOT));
    const file = path.join(d.media, OLD_ROOT, '_Unknown/ティア/t.m4b');
    const entry = (rel: string, dir = false) => ({
      rel,
      raw: null,
      ...d.plan(path.join(d.media, rel)),
      dir,
    });
    const newBefore = treeProof(path.join(d.media, 'japanese-new'));
    const torrentsBefore = treeProof(d.torrents);
    await expect(d.w.deleteOld(entry('japanese-new/作者/本/a.m4b'))).rejects.toThrow(
      /Not inside japanese-old/,
    );
    await expect(
      d.w.deleteOld({
        ...entry('japanese-new/作者/本/a.m4b'),
        rel: 'japanese-old/../japanese-new/作者/本/a.m4b',
      }),
    ).rejects.toThrow();
    await expect(
      d.w.deleteOld({ ...entry(`${OLD_ROOT}/_Unknown/ティア/t.m4b`), size: 1 }),
    ).rejects.toThrow(/changed \(size\)/);
    await expect(d.w.deleteOld(entry(`${OLD_ROOT}/_Unknown/ティア`, true))).rejects.toThrow();
    // A symlinked folder above: refused (never followed).
    fs.symlinkSync(
      path.join(d.media, 'japanese-new', '作者'),
      path.join(d.media, OLD_ROOT, 'link'),
      'junction',
    );
    await expect(
      d.w.deleteOld({ ...entry('japanese-new/作者/本/a.m4b'), rel: `${OLD_ROOT}/link/本/a.m4b` }),
    ).rejects.toThrow();
    fs.rmSync(path.join(d.media, OLD_ROOT, 'link'), { force: true });
    const e = entry(`${OLD_ROOT}/_Unknown/ティア/t.m4b`);
    expect(await d.w.deleteOld(e)).toEqual({ existed: false, freed: 4000 });
    expect(fs.existsSync(file)).toBe(false);
    expect(await d.w.deleteOld(e)).toEqual({ existed: true, freed: 0 });
    expect(await d.w.deleteOld(entry(`${OLD_ROOT}/_Unknown/ティア`, true))).toEqual({
      existed: false,
      freed: 0,
    });
    expect(treeProof(path.join(d.media, 'japanese-new'))).toEqual(newBefore);
    expect(treeProof(d.torrents)).toEqual(torrentsBefore);
  });

  it('only writer.ts writes; its switch abilities are exactly these, each in its own method', () => {
    // Line ends normalized: a Windows checkout has CRLF (the method bodies end at "\n  }\n").
    const strip = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const WRITES =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rmdir|rmSync|rm|link|linkSync|symlink|copyFile|cp|cpSync|utimes|chmod|chown|truncate|createWriteStream|futimes|lchown)\(|\b(O_CREAT|O_WRONLY|O_RDWR)\b/;
    for (const f of fs
      .readdirSync(LINK_SRC)
      .filter((x) => x.endsWith('.ts') && x !== 'writer.ts')) {
      const src = strip(fs.readFileSync(path.join(LINK_SRC, f), 'utf8'));
      expect(src, f).not.toMatch(WRITES);
      expect(src, f).not.toMatch(/fs\.open\(/);
    }
    const writer = strip(fs.readFileSync(path.join(LINK_SRC, 'writer.ts'), 'utf8'));
    const methods = Object.getOwnPropertyNames(LinkWriter.prototype).sort();
    expect(methods).toEqual([
      // WP21f-1: the new arrivals (new books' folders, links and metadata.json under japanese/
      // and japanese-generated/; archive entries under the torrents' _extracted/).
      'arrivalParent',
      'checkBook',
      'constructor',
      'copyInventory',
      'deleteOld',
      'extractEntry',
      'inside',
      // WP21f-2: changes to books in the library (metadata.json replaced, a book folder or a
      // link renamed in japanese/, an emptied folder removed, a reader-written file's name
      // under the torrents' AI/ or _merged/).
      'libraryBook',
      'linkArrival',
      'linkFile',
      'linkReaderFile',
      'linkToFromLibrary',
      'makeArrivalFolder',
      'makeFolder',
      'openArchive',
      'realFolders',
      'removeEmptyFolder',
      'renameBookFile',
      'renameBookFolder',
      'renameRoot',
      'replaceBookMetadata',
      'source',
      'torrentFolders',
      'writeArrivalMetadata',
      'writeMetadata',
    ]);
    /** The body of one method (to its closing brace at two spaces). */
    const body = (name: string) => {
      const i = writer.search(new RegExp(`\\n  (private )?async ${name}\\(`));
      expect(i, name).toBeGreaterThan(0);
      const end = writer.indexOf('\n  }\n', i);
      return writer.slice(i, end);
    };
    const count = (re: RegExp, s = writer) => (s.match(re) ?? []).length;
    // Renames: renameRoot's (after the pair check) and WP21f-2's three, each after its guard:
    // a book folder or a link only inside japanese/ (movePath, libraryBook), and metadata.json
    // only over the file the server read (its hash) with this module's own temporary file.
    expect(count(/fs\.rename\(/g)).toBe(4);
    expect(count(/fs\.rename\(/g, body('renameRoot'))).toBe(1);
    for (const [m, guard] of [
      ['renameBookFolder', 'movePath('],
      ['renameBookFile', 'libraryBook('],
      ['replaceBookMetadata', 'expectSha256'],
    ] as const) {
      expect(count(/fs\.rename\(/g, body(m)), m).toBe(1);
      expect(body(m).indexOf(guard), m).toBeGreaterThan(0);
      expect(body(m).indexOf(guard), m).toBeLessThan(body(m).indexOf('fs.rename('));
    }
    expect(body('replaceBookMetadata')).toMatch(/fs\.rename\(temp, abs\)/);
    expect(body('libraryBook').indexOf('destination(')).toBeGreaterThan(0);
    expect(body('renameRoot').indexOf('RENAME_PAIRS')).toBeLessThan(
      body('renameRoot').indexOf('fs.rename('),
    );
    // Removals: the build's temporary file (twice in writeMetadata, twice in
    // writeArrivalMetadata, twice in extractEntry: its own `.ttsu-*-<n>.partial` names) and
    // deleteOld's one file; the one rmdir is deleteOld's (an empty folder), after its
    // japanese-old check.
    expect(count(/fs\.unlink\(/g)).toBe(8);
    expect(count(/fs\.unlink\(/g, body('replaceBookMetadata'))).toBe(1);
    expect(count(/fs\.unlink\(/g, body('writeMetadata'))).toBe(2);
    expect(count(/fs\.unlink\(/g, body('writeArrivalMetadata'))).toBe(2);
    expect(count(/fs\.unlink\(/g, body('extractEntry'))).toBe(2);
    for (const m of ['writeArrivalMetadata', 'extractEntry', 'replaceBookMetadata'])
      for (const line of body(m)
        .split('\n')
        .filter((l) => l.includes('fs.unlink(')))
        expect(line, m).toMatch(/fs\.unlink\((temp|temp\)\.catch)/);
    expect(count(/fs\.unlink\(/g, body('deleteOld'))).toBe(1);
    expect(count(/fs\.rmdir\(/g)).toBe(2);
    expect(count(/fs\.rmdir\(/g, body('deleteOld'))).toBe(1);
    // WP21f-2: an emptied author or series folder of japanese/ only (rmdir: only when empty).
    expect(count(/fs\.rmdir\(/g, body('removeEmptyFolder'))).toBe(1);
    expect(body('removeEmptyFolder').indexOf('LIBRARY_ROOT')).toBeLessThan(
      body('removeEmptyFolder').indexOf('fs.rmdir('),
    );
    expect(body('deleteOld').indexOf('OLD_ROOT')).toBeLessThan(
      body('deleteOld').indexOf('fs.unlink('),
    );
    // New names: links (the build's two, _from-library's one; WP21f-1: a new book's link and its
    // metadata.json, an unpacked entry), folders, the copied files.
    expect(count(/fs\.link\(/g)).toBe(7);
    // WP21f-2: a reader-written file's name only under the torrents' AI/ or _merged/.
    expect(count(/fs\.link\(/g, body('linkReaderFile'))).toBe(1);
    expect(body('linkReaderFile').indexOf('READER_ROOTS')).toBeLessThan(
      body('linkReaderFile').indexOf('fs.link('),
    );
    expect(count(/fs\.link\(/g, body('linkToFromLibrary'))).toBe(1);
    expect(body('linkToFromLibrary').indexOf('FROM_LIBRARY')).toBeLessThan(
      body('linkToFromLibrary').indexOf('fs.link('),
    );
    // WP21f-1: a new book's writes only after the checks of its folder (only under japanese/ or
    // japanese-generated/, holding nothing that isn't planned for it); unpacked entries only
    // under _extracted/.
    for (const m of ['linkArrival', 'writeArrivalMetadata'])
      expect(body(m).indexOf('arrivalParent(')).toBeLessThan(body(m).indexOf('fs.link('));
    expect(body('arrivalParent').indexOf('checkBook(')).toBeGreaterThan(0);
    expect(body('makeArrivalFolder').indexOf('arrivalDestination(')).toBeLessThan(
      body('makeArrivalFolder').indexOf('fs.mkdir('),
    );
    expect(body('extractEntry').indexOf('EXTRACTED')).toBeLessThan(
      body('extractEntry').indexOf('fs.link('),
    );
    expect(count(/fs\.mkdir\(/g)).toBe(5);
    expect(count(/fs\.mkdir\(/g, body('renameBookFolder'))).toBe(1);
    expect(count(/fs\.open\(/g)).toBe(7);
    expect(writer).not.toMatch(/\b(symlink|copyFile|rm\(|rmSync|truncate|utimes|chown)\b/);
    // chmod only on what it made: new folders and its own new files.
    expect(count(/chmod\(/g)).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the reader’s audiobook hold', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('stops scans, link edits, the PC’s claims and every write; merges wait; a restart keeps it', async () => {
    const { env, setup } = await makeCleanupEnv();
    close = () => env.close();
    await setup();
    const media = makeTempDir('wp21e2-hold');
    fs.mkdirSync(path.join(media, 'japanese', 'A'), { recursive: true });
    fs.writeFileSync(path.join(media, 'japanese', 'A', 'a.m4b'), audio(1));
    updateLibrary(env.db, env.libraryId(), { audioDir: 'japanese' });
    const scan = new AudioScanService({
      db: env.db,
      config: { ...DEFAULT_AUDIO, dir: media },
      otherDirs: [],
    });
    await scan.start({ timer: false });
    await scan.idle();
    setHold(env.db, 'switch', 'test');
    // A requested scan waits (nothing read); after the hold it runs.
    fs.mkdirSync(path.join(media, 'japanese', 'B'));
    fs.writeFileSync(path.join(media, 'japanese', 'B', 'b.m4b'), audio(2));
    requestAudioScan(env.db, env.libraryId());
    scan.wake();
    await scan.idle();
    expect(getScanState(env.db, env.libraryId()).scanRequestedAt).not.toBeNull();
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM audio_folders`).get()).toEqual({ n: 1 });
    // The switch's own scan runs while held.
    await scan.scanForSwitch();
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM audio_folders`).get()).toEqual({ n: 2 });
    expect(scan.scanned.folders).toBe(2);
    // Every write is refused.
    const writer = new AudioWriter({ db: env.db, root: media });
    await expect(
      writer.createGeneratedFile({
        libraryId: env.libraryId(),
        area: 'audio',
        relPath: 'X/x.m4b',
        source: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(AudioHoldError);
    await expect(
      writer.createGeneratedFolder({
        libraryId: env.libraryId(),
        area: 'audio',
        parentParts: ['X'],
        folderNames: ['Y'],
      }),
    ).rejects.toBeInstanceOf(AudioHoldError);
    await expect(
      writer.createMergedFile({ folderRelPath: 'japanese/A', source: Buffer.from('m') }),
    ).rejects.toBeInstanceOf(AudioHoldError);
    expect(fs.existsSync(path.join(media, 'japanese-generated'))).toBe(false);
    expect(fs.existsSync(path.join(media, 'japanese-merged'))).toBe(false);
    // A restart (a new scanner on the same database) still holds.
    const again = new AudioScanService({
      db: env.db,
      config: { ...DEFAULT_AUDIO, dir: media },
      otherDirs: [],
    });
    expect(isHeld(env.db, 'switch')).toBe(true);
    fs.mkdirSync(path.join(media, 'japanese', 'C'));
    fs.writeFileSync(path.join(media, 'japanese', 'C', 'c.m4b'), audio(3));
    requestAudioScan(env.db, env.libraryId());
    await again.start({ timer: false });
    await again.idle();
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM audio_folders`).get()).toEqual({ n: 2 });
    clearHold(env.db, 'switch');
    again.wake();
    await again.idle();
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM audio_folders`).get()).toEqual({ n: 3 });
    // merge_wait refuses merged files (and only them).
    setHold(env.db, 'merge_wait', 'test');
    await expect(
      writer.createMergedFile({ folderRelPath: 'japanese/A', source: Buffer.from('m') }),
    ).rejects.toThrow(/Merging waits/);
    const gen = await writer.createGeneratedFile({
      libraryId: env.libraryId(),
      area: 'audio',
      relPath: 'X/x.m4b',
      source: Buffer.from('x'),
    });
    expect(gen.relPath).toBe('japanese-generated/X/x.m4b');
    clearHold(env.db, 'merge_wait');
    const merged = await writer.createMergedFile({
      folderRelPath: 'japanese/A',
      source: Buffer.from('m'),
    });
    expect(merged.relPath).toBe('japanese-merged/A/A.m4b');
    await again.stop();
    await scan.stop();
  });

  it('the PC gets no job and links can’t change while the switch holds', async () => {
    const { env, setup } = await makeCleanupEnv();
    close = () => env.close();
    await setup();
    const { SubtitleJobService } = await import('../src/audio/subtitle-jobs');
    const media = makeTempDir('wp21e2-hold2');
    fs.mkdirSync(path.join(media, 'japanese'), { recursive: true });
    const scan = new AudioScanService({
      db: env.db,
      config: { ...DEFAULT_AUDIO, dir: media },
      otherDirs: [],
    });
    const jobs = new SubtitleJobService({
      db: env.db,
      scan,
      writer: new AudioWriter({ db: env.db, root: media }),
      config: DEFAULT_AUDIO.worker,
    });
    const user = listUsers(env.db)[0].id;
    env.db
      .prepare(
        `INSERT INTO worker_jobs (user_id, book_id, kind, library_id, state, created_at, updated_at)
         VALUES (?, 'b1', 'preview_audiobook', ?, 'queued', 0, 0)`,
      )
      .run(user, env.libraryId());
    setHold(env.db, 'switch', 'test');
    expect(jobs.claim(['preview_audiobook'])).toBeNull();
    expect(readerBusy(env.db)).toEqual([]);
    clearHold(env.db, 'switch');
    env.db.prepare(`UPDATE worker_jobs SET state = 'running'`).run();
    expect(readerBusy(env.db)).toEqual([expect.stringMatching(/1 job\(s\) running on the PC/)]);
  });
});

// ---------------------------------------------------------------------------------------------
/** WP21e-1's library, without a reader-written file, with the old library's other files. */
function scenario(): BuildSeed {
  const v = (title: string, more: Record<string, unknown> = {}) => ({
    title,
    authors: ['作者A'],
    narrators: ['読み手'],
    series: [],
    drama: false,
    multi_narr: false,
    publisher: '出版社',
    year: 2021,
    language: 'ja',
    store_id: null,
    description: 'あらすじ。',
    ...more,
  });
  const X1 = 'TMW/[作者A] シリーズX/[01] シリーズX 1 [B0AAAAAAA1].m4b';
  const X2 = 'TMW/[作者A] シリーズX/[02] シリーズX 2 [B0AAAAAAA2].m4b';
  return {
    files: [
      { root: 'torrents', rel: X1, bytes: audio(1) },
      {
        root: 'torrents',
        rel: 'TMW/[作者A] シリーズX/[01] シリーズX 1 [B0AAAAAAA1].pdf',
        bytes: 'pdf1',
      },
      { root: 'torrents', rel: 'Discord/シリーズX 1/シリーズX 1.m4b', bytes: audio(1) },
      { root: 'torrents', rel: X2, bytes: audio(2) },
      { root: 'torrents', rel: 'AI/AIシリーズ/AIシリーズ1.m4b', bytes: audio(8) },
      { root: 'torrents', rel: 'MAM/選択/選択 a.m4b', bytes: audio(12) },
      { root: 'torrents', rel: 'MAM/選択/選択 b.m4b', bytes: audio(13) },
      { root: 'torrents', rel: 'MAM/old.zip', bytes: 'zip-bytes' },
      // The live library: copies, ABS's files, a PDF and an archive with torrent twins, the
      // old copy script's files at the root, one library-only file.
      { root: 'library', rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/a.m4b', bytes: audio(1) },
      { root: 'library', rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/metadata.json', bytes: '{}' },
      { root: 'library', rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/cover.jpg', bytes: 'jpg' },
      {
        root: 'library',
        rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/[01] シリーズX 1 [B0AAAAAAA1].pdf',
        bytes: 'pdf1',
      },
      { root: 'library', rel: '_Unknown/シリーズX 1 (Discord)/b.m4b', bytes: audio(1) },
      { root: 'library', rel: '_Unknown/シリーズX 2/c.m4b', bytes: audio(2) },
      { root: 'library', rel: '_Unknown/AIシリーズ1/ai.m4b', bytes: audio(8) },
      { root: 'library', rel: '_Unknown/選択 a/a.m4b', bytes: audio(12) },
      { root: 'library', rel: '_Unknown/old.zip', bytes: 'zip-bytes' },
      { root: 'library', rel: '_Unknown/ティアムーン10/ティアムーン10.m4b', bytes: audio(14) },
      { root: 'library', rel: 'needs_review.csv', bytes: 'a,b\r\n' },
      { root: 'library', rel: '.processed_files.json', bytes: '{"done":[]}' },
    ],
    books: [
      { rel: X1, kind: 'file', files: [X1] },
      {
        rel: 'Discord/シリーズX 1',
        kind: 'folder',
        files: ['Discord/シリーズX 1/シリーズX 1.m4b'],
      },
      { rel: X2, kind: 'file', files: [X2] },
      {
        rel: 'AI/AIシリーズ/AIシリーズ1.m4b',
        kind: 'file',
        files: ['AI/AIシリーズ/AIシリーズ1.m4b'],
      },
      { rel: 'MAM/選択/選択 a.m4b', kind: 'file', files: ['MAM/選択/選択 a.m4b'] },
      { rel: 'MAM/選択/選択 b.m4b', kind: 'file', files: ['MAM/選択/選択 b.m4b'] },
    ],
    copies: [
      {
        key: 'c-x1',
        bookKey: `torrents:${X1}`,
        kind: 'file',
        files: [`torrents:${X1}`],
        group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'keep', rank: 0 },
      },
      {
        key: 'c-x1d',
        bookKey: 'torrents:Discord/シリーズX 1',
        kind: 'file',
        files: ['torrents:Discord/シリーズX 1/シリーズX 1.m4b'],
        group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'drop', rank: 1 },
      },
      { key: 'c-x2', bookKey: `torrents:${X2}`, kind: 'file', files: [`torrents:${X2}`] },
      {
        key: 'c-ai',
        bookKey: 'torrents:AI/AIシリーズ/AIシリーズ1.m4b',
        kind: 'file',
        files: ['torrents:AI/AIシリーズ/AIシリーズ1.m4b'],
        ai: true,
      },
      {
        key: 'c-cha',
        bookKey: 'torrents:MAM/選択/選択 a.m4b',
        kind: 'file',
        files: ['torrents:MAM/選択/選択 a.m4b'],
        group: { key: 'g3', kind: 'group', outcome: 'review', role: 'review', rank: 0 },
      },
      {
        key: 'c-chb',
        bookKey: 'torrents:MAM/選択/選択 b.m4b',
        kind: 'file',
        files: ['torrents:MAM/選択/選択 b.m4b'],
        group: { key: 'g3', kind: 'group', outcome: 'review', role: 'review', rank: 1 },
      },
      {
        key: 'c-tia',
        bookKey: 'library:_Unknown/ティアムーン10',
        kind: 'library_only',
        files: ['library:_Unknown/ティアムーン10/ティアムーン10.m4b'],
      },
    ],
    units: [
      {
        key: 'u-x1',
        kind: 'record',
        name: 'シリーズX 1',
        copies: ['c-x1', 'c-x1d'],
        values: v('シリーズX 1', {
          series: [{ name: 'シリーズX', position: 1, label: '1' }],
          store_id: 'audible:B0AAAAAAA1',
        }),
      },
      {
        key: 'u-x2',
        kind: 'record',
        name: 'シリーズX 2',
        copies: ['c-x2'],
        values: v('シリーズX 2', {
          series: [{ name: 'シリーズX', position: 2, label: '2' }],
          cover: 'https://img.example/x2.jpg',
        }),
      },
      {
        key: 'u-ai',
        kind: 'ai',
        name: 'AIシリーズ1',
        copies: ['c-ai'],
        values: v('AIシリーズ1', { authors: [], narrators: [] }),
      },
      {
        key: 'u-cha',
        kind: 'record',
        name: '選択',
        copies: ['c-cha'],
        values: v('選択', { authors: ['作者D'] }),
      },
      {
        key: 'u-chb',
        kind: 'record',
        name: '選択',
        copies: ['c-chb'],
        values: v('選択', { authors: ['作者D'] }),
      },
      {
        key: 'u-tia',
        kind: 'record',
        name: 'ティアムーン10',
        copies: ['c-tia'],
        values: v('ティアムーン帝国物語10', {
          authors: ['餅月望'],
          series: [{ name: 'ティアムーン帝国物語', position: 10, label: '10' }],
        }),
      },
    ],
    libraryCopies: {
      '_Unknown/シリーズX/Vol 1 - シリーズX 1/a.m4b': [X1, 'Discord/シリーズX 1/シリーズX 1.m4b'],
      '_Unknown/シリーズX 1 (Discord)/b.m4b': ['Discord/シリーズX 1/シリーズX 1.m4b'],
      '_Unknown/シリーズX 2/c.m4b': [X2],
      '_Unknown/AIシリーズ1/ai.m4b': ['AI/AIシリーズ/AIシリーズ1.m4b'],
      '_Unknown/選択 a/a.m4b': ['MAM/選択/選択 a.m4b'],
    },
    libraryOnly: ['_Unknown/ティアムーン10/ティアムーン10.m4b'],
    decisions: { g3: 'keep:c-chb' },
  };
}

describe('the switch through the linking sidecar and the reader', { timeout: 180_000 }, () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function setup() {
    const dir = makeTempDir('wp21e2-switch');
    const data = path.join(dir, 'data');
    const roots = {
      torrents: path.join(data, 'torrents', 'audiobooks', 'japanese'),
      library: path.join(data, 'media', 'audiobooks', 'japanese'),
      media: path.join(data, 'media', 'audiobooks'),
    };
    const { env, setup: indexSetup } = await makeCleanupEnv({
      audio: {
        roots,
        readerWrittenFiles: () => [],
        readerState: () => 'reader',
        readLabels: () => ({ text: JSON.stringify({ books: [] }), error: null }),
      },
    });
    await indexSetup();
    const disk = seedBuild(env.cleanupDb, dir, scenario());
    updateSettings(env.cleanupDb, {
      audiobooks: {
        buildBatchOps: 5,
        buildPreflightOps: 10,
        buildRehashSample: 3,
        deleteBatchOps: 4,
      },
    });
    const server = http.createServer(env.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const token = createApplyToken(env.cleanupDb, 'link sidecar', Date.now(), 'link').token;
    const worker = new LinkWorker(
      {
        serverUrl: `http://127.0.0.1:${port}`,
        token,
        dataDir: data,
        dirMode: 0o777,
        fileMode: 0o666,
        serverTimeoutSeconds: 10,
      },
      () => undefined,
    );
    // Audiobookshelf's libraries, as the switch asks for them (a GET-only snapshot live).
    let absLibs: { name: string | null; folders: string[] }[] | null = [];
    (env.audio as unknown as { absLibraries: () => Promise<unknown> }).absLibraries = async () =>
      absLibs;
    // The reader: its scanner over media/audiobooks, the library's audio folder `japanese`.
    updateLibrary(env.db, env.libraryId(), { audioDir: 'japanese' });
    const scan = new AudioScanService({
      db: env.db,
      config: { ...DEFAULT_AUDIO, dir: roots.media },
      otherDirs: [],
    });
    await scan.start({ timer: false });
    await scan.idle();
    let mergesResumed = 0;
    env.audio!.attachReader(
      switchReader({ db: env.db, scan, resumeMerges: () => mergesResumed++, dbDir: env.dbDir }),
    );
    close = async () => {
      await scan.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await env.close();
    };
    const user = { Authorization: `Bearer ${env.userToken()}` };
    return {
      env,
      disk,
      roots,
      worker,
      user,
      scan,
      setAbs: (l: typeof absLibs) => (absLibs = l),
      merges: () => mergesResumed,
    };
  }

  async function build(env: CleanupEnv, w: LinkWorker, user: Record<string, string>) {
    const s6 = env.audio!.stage6!;
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'analyse' })
      .expect(200);
    for (let i = 0; i < 400 && s6.progress()?.phase !== 'planned'; i++) {
      await s6.step(() => false, 'analyse', {});
      await w.cycle().catch(() => undefined);
    }
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'on' })
      .expect(200);
    for (let i = 0; i < 800 && s6.progress()?.phase !== 'done'; i++) {
      await s6.step(() => false, 'on', {});
      await w.cycle().catch(() => undefined);
    }
    expect(s6.progress()!.check!.passed).toBe(true);
  }

  /** Runs the switch's steps and the sidecar's rounds until `until` holds. */
  async function drive(env: CleanupEnv, w: LinkWorker, until: () => boolean, max = 1500) {
    const sw = env.audio!.switcher!;
    for (let i = 0; i < max && !until(); i++) {
      if (sw.isRunning() && !sw.pause()) await sw.step(() => false);
      await w.cycle().catch(() => undefined);
      if (sw.pause()) break;
    }
    expect(sw.pause(), JSON.stringify(sw.pause())).toBeNull();
    expect(until()).toBe(true);
  }

  it('switches, undoes, switches again and deletes japanese-old; trees, links and holds as planned', async () => {
    const { env, disk, worker, user, setAbs, merges } = await setup();
    const sw = env.audio!.switcher!;
    const uid = listUsers(env.db)[0].id;
    // merge_wait from the start (built, not switched).
    expect(isHeld(env.db, 'merge_wait')).toBe(true);
    // The reader's links: a moved file, a dropped copy, the review page's choice, the AI book,
    // the library-only file, a folder link; one with subtitles; whispersync data on two.
    const L = {
      moved: ['japanese/_Unknown/シリーズX/Vol 1 - シリーズX 1', 'a.m4b'],
      dropped: ['japanese/_Unknown/シリーズX 1 (Discord)', 'b.m4b'],
      chosen: ['japanese/_Unknown/選択 a', 'a.m4b'],
      ai: ['japanese/_Unknown/AIシリーズ1', 'ai.m4b'],
      tia: ['japanese/_Unknown/ティアムーン10', 'ティアムーン10.m4b'],
      folder: ['japanese/_Unknown/シリーズX 2', null],
    } as const;
    let t = 1000;
    for (const [book, [folder, file]] of Object.entries(L))
      saveLink(env.db, uid, {
        bookId: book,
        state: 'linked',
        folderRelPath: folder,
        fileName: file,
        subtitleState: book === 'moved' ? 'linked' : null,
        subtitleRelPath: book === 'moved' ? 'japanese-srt/x.srt' : null,
        source: 'library',
        confirmedAt: t++,
      });
    saveLink(env.db, uid, {
      bookId: 'none',
      state: 'none',
      folderRelPath: null,
      fileName: null,
      subtitleState: null,
      subtitleRelPath: null,
      source: 'library',
      confirmedAt: t++,
    });
    env.addReaderData('moved', 'book-attachment');
    env.addReaderData('dropped', 'audiobook-position');
    const linksBefore = Object.fromEntries(
      Object.keys(L).map((b) => [b, getLink(env.db, uid, b)!]),
    );

    // The build.
    await build(env, worker, user);
    const torrents0 = treeProof(disk.torrents);
    const library0 = treeProof(disk.library);
    const new0 = treeProof(path.join(disk.media, 'japanese-new'));
    const ino = (rel: string) =>
      String(fs.lstatSync(path.join(disk.media, rel), { bigint: true }).ino);
    const inoJapanese = ino('japanese');
    const inoNew = ino('japanese-new');

    // Refusals: Audiobookshelf still has a library on the folder; a merge is queued.
    setAbs([{ name: 'Japanese Audiobooks', folders: ['/audiobooks/japanese'] }]);
    let r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(
      /Japanese Audiobooks.*delete that library in Audiobookshelf first/,
    );
    setAbs(null);
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' });
    expect(r.body.error.message).toMatch(/could not be asked/);
    // A library elsewhere with the same last name (live 2026-11-20: a podcasts library on
    // /podcasts/japanese) is not one of the switch's folders; its own folders are refused even
    // with a trailing slash.
    setAbs([{ name: 'Japanese Audiobooks', folders: ['/audiobooks/japanese/'] }]);
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' });
    expect(r.body.error.message).toMatch(/uses \/audiobooks\/japanese\/: delete that library/);
    setAbs([{ name: 'Japanese Podcasts', folders: ['/podcasts/japanese'] }]);
    env.db
      .prepare(
        `INSERT INTO audio_merge_jobs (user_id, book_id, library_id, folder_rel_path, file_names, state, progress, created_at, updated_at)
         VALUES (?, 'x', ?, 'japanese/a', '[]', 'queued', 0, 0, 0)`,
      )
      .run(uid, env.libraryId());
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' });
    expect(r.body.error.message).toMatch(/1 merge\(s\) waiting/);
    env.db.prepare(`DELETE FROM audio_merge_jobs`).run();
    expect(sw.state()).toBe('none');
    expect(isHeld(env.db, 'switch')).toBe(false);
    // Undo and delete refused before a switch.
    expect(
      (
        await request(env.app)
          .post('/api/v1/cleanup/audio/switch/start')
          .set(user)
          .send({ action: 'undo' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(env.app)
          .post('/api/v1/cleanup/audio/switch/start')
          .set(user)
          .send({ action: 'delete' })
      ).status,
    ).toBe(409);

    // 1. The switch.
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' });
    expect(r.status).toBe(200);
    expect(r.body.switch).toMatchObject({
      state: 'running',
      progress: { action: 'switch', phase: 'hold' },
    });
    expect(isHeld(env.db, 'switch')).toBe(true);
    // While held, a link can't change.
    const put = await request(env.app).delete('/api/v1/books/moved/audio-link').set(user);
    expect([409, 503, 404]).toContain(put.status);
    const phases: string[] = [];
    const phaseOf = () => sw.progress()?.phase ?? '';
    await drive(env, worker, () => {
      if (!phases.includes(phaseOf())) phases.push(phaseOf());
      return sw.state() === 'switched';
    });
    expect(phases).toEqual([
      'hold',
      'late',
      'from_library',
      'check',
      'links',
      'snapshot',
      'rename',
      'remap',
      'rescan',
      'verify',
      'release',
    ]);
    const p = sw.progress()!;
    expect(p.check!.passed).toBe(true);
    expect(p.verify).toMatchObject({
      notResolved: 0,
      playableLost: 0,
      countBefore: 7,
      countAfter: 7,
      passed: true,
    });
    expect(p.links).toMatchObject({
      moved: 1,
      ai: 1,
      dropped: 2,
      library_only: 1,
      folder: 1,
      listed: 0,
      outside: 1,
      changed: 6,
    });
    expect(fs.existsSync(path.join(env.dbDir, 'snapshots', p.snapshot!))).toBe(true);
    expect(isHeld(env.db, 'switch')).toBe(false);
    expect(isHeld(env.db, 'merge_wait')).toBe(false);
    expect(merges()).toBe(1);

    // The folders: renamed, the same folders (inodes).
    expect(ino('japanese-old')).toBe(inoJapanese);
    expect(ino('japanese')).toBe(inoNew);
    expect(fs.existsSync(path.join(disk.media, 'japanese-new'))).toBe(false);
    expect(fs.existsSync(path.join(disk.media, 'japanese-generated'))).toBe(true);
    // The torrents: unchanged but for the library-only file's name under _from-library.
    const torrents1 = treeProof(disk.torrents);
    for (const [rel, e] of torrents0) expect(torrents1.get(rel)?.line, rel).toBe(e.line);
    const tia = library0.get('_Unknown/ティアムーン10/ティアムーン10.m4b')!;
    expect([...torrents1.keys()].filter((k) => !torrents0.has(k))).toEqual([
      '_from-library',
      '_from-library/ティアムーン10',
      '_from-library/ティアムーン10/ティアムーン10.m4b',
    ]);
    expect(torrents1.get('_from-library/ティアムーン10/ティアムーン10.m4b')!.ino).toBe(tia.ino);
    // The old library: byte-identical, same inodes and mtimes; the library-only file has two
    // more names (_from-library and its new folder).
    const old1 = treeProof(path.join(disk.media, 'japanese-old'));
    expect([...old1.keys()]).toEqual([...library0.keys()]);
    for (const [rel, e] of library0) {
      expect(old1.get(rel)!.line, rel).toBe(e.line);
      expect(old1.get(rel)!.nlink, rel).toBe(
        e.nlink + (rel === '_Unknown/ティアムーン10/ティアムーン10.m4b' ? 2 : 0),
      );
    }
    // The new library: what the build made, plus the library-only book (folders, link, metadata).
    const new1 = treeProof(path.join(disk.media, 'japanese'));
    for (const [rel, e] of new0) expect(new1.get(rel)?.line, rel).toBe(e.line);
    const added = [...new1.keys()].filter((k) => !new0.has(k));
    expect(added.filter((k) => k.endsWith('.m4b'))).toHaveLength(1);
    expect(added.some((k) => k.endsWith('metadata.json'))).toBe(true);
    expect(new1.get(added.find((k) => k.endsWith('.m4b'))!)!.ino).toBe(tia.ino);

    // The reader's links: rewritten (confirmed_at kept), every one resolves and plays as before;
    // whispersync's data untouched.
    const moves = env.cleanupDb
      .prepare(`SELECT old_path, outcome, new_path, kept_path FROM audio_build_moves`)
      .all() as {
      old_path: string;
      outcome: string;
      new_path: string | null;
      kept_path: string | null;
    }[];
    const moveOf = (folder: string, file: string) =>
      moves.find((m) => m.old_path === `${folder}/${file}`)!;
    for (const [book, [folder, file]] of Object.entries(L)) {
      const now = getLink(env.db, uid, book)!;
      expect(now.confirmedAt, book).toBe(linksBefore[book].confirmedAt);
      expect(now.subtitleRelPath).toBe(linksBefore[book].subtitleRelPath);
      const res = resolveLink(env.db, now);
      expect(res.status, book).toBe('ok');
      if (file) {
        const m = moveOf(folder, file);
        const want = afterRenames(m.outcome === 'dropped' ? m.kept_path! : m.new_path!);
        expect(`${now.folderRelPath}/${now.fileName}`, book).toBe(want);
        expect(res.playable, book).toBe(true);
      } else expect(now.folderRelPath).toBe('japanese/作者A/シリーズX/Vol 2 - シリーズX 2');
    }
    expect(getLink(env.db, uid, 'ai')!.folderRelPath).toMatch(/^japanese-generated\//);
    expect(getLink(env.db, uid, 'none')).toMatchObject({ state: 'none', folderRelPath: null });
    expect(
      env.db.prepare(`SELECT COUNT(*) AS n FROM sync_records WHERE deleted_at IS NOT NULL`).get(),
    ).toEqual({ n: 0 });
    // The report.
    const csv = await request(env.app)
      .get('/api/v1/cleanup/audio/switch/links.csv')
      .set(user)
      .expect(200);
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(1 + 7);
    const list = await request(env.app)
      .get('/api/v1/cleanup/audio/switch/links?changed=1')
      .set(user)
      .expect(200);
    expect(list.body.total).toBe(6);

    // 2. Undo: refused while Audiobookshelf has a library on the new folder; then back.
    setAbs([{ name: 'Japanese Audiobooks', folders: ['/audiobooks/japanese'] }]);
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'undo' });
    expect(r.status).toBe(409);
    setAbs([]);
    r = await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'undo' });
    expect(r.status).toBe(200);
    await drive(env, worker, () => sw.state() === 'none');
    expect(sw.progress()!.restored).toEqual({ restored: 6, listed: 0 });
    expect(ino('japanese')).toBe(inoJapanese);
    expect(ino('japanese-new')).toBe(inoNew);
    expect(fs.existsSync(path.join(disk.media, 'japanese-old'))).toBe(false);
    expect(fs.existsSync(path.join(disk.media, 'japanese-generated'))).toBe(false);
    for (const [book] of Object.entries(L)) {
      const now = getLink(env.db, uid, book)!;
      expect([now.folderRelPath, now.fileName], book).toEqual([
        linksBefore[book].folderRelPath,
        linksBefore[book].fileName,
      ]);
      expect(resolveLink(env.db, now).status, book).toBe('ok');
    }
    expect(isHeld(env.db, 'merge_wait')).toBe(true);
    expect(isHeld(env.db, 'switch')).toBe(false);

    // 3. Switch again (the library-only file's links are already there).
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    await drive(env, worker, () => sw.state() === 'switched');
    expect(sw.progress()!.verify!.passed).toBe(true);

    // 3b. Covers (stop 3), against a stand-in Audiobookshelf with the fresh library: the store
    // cover by URL, the old library's ABS cover by upload, none for the rest; a book ABS shows a
    // cover for is left alone. Only GET and POST /api/items/:id/cover reach it.
    const books = env.cleanupDb
      .prepare(
        `SELECT folder FROM audio_build_books WHERE state IN ('build', 'pending') AND area = 'main'`,
      )
      .all() as { folder: string }[];
    const items = books.map((b, i) => ({
      id: `li_${i}`,
      relPath: b.folder.replace(/^japanese-new\//, ''),
      media: { coverPath: b.folder.includes('選択') ? '/metadata/items/x/cover.jpg' : null },
    }));
    const calls: { method: string; path: string; type: string; body: string }[] = [];
    const abs = express();
    abs.use(express.raw({ type: () => true, limit: '5mb' }));
    abs.use((req, res) => {
      calls.push({
        method: req.method,
        path: req.path,
        type: String(req.headers['content-type'] ?? ''),
        body: Buffer.isBuffer(req.body) ? req.body.toString('latin1') : '',
      });
      if (req.method === 'GET' && req.path === '/api/libraries')
        return res.json({
          libraries: [
            // Listed first: a podcasts library whose folder has the same last name.
            {
              id: 'pod1',
              name: 'Japanese Podcasts',
              folders: [{ fullPath: '/podcasts/japanese' }],
            },
            {
              id: 'lib1',
              name: 'Japanese Audiobooks',
              folders: [{ fullPath: '/audiobooks/japanese' }],
            },
          ],
        });
      if (req.method === 'GET' && req.path === '/api/libraries/lib1/items')
        return res.json({ results: items, total: items.length });
      if (req.method === 'POST' && /^\/api\/items\/li_\d+\/cover$/.test(req.path))
        return res.json({ success: true });
      res.status(404).json({});
    });
    const absServer = http.createServer(abs);
    await new Promise<void>((r) => absServer.listen(0, '127.0.0.1', r));
    try {
      const absUrl = `http://127.0.0.1:${(absServer.address() as AddressInfo).port}`;
      updateSettings(env.cleanupDb, { audiobooks: { absUrl, coverPaceMs: 0 } });
      await request(env.app)
        .put('/api/v1/cleanup/secrets/absApiKey')
        .set(user)
        .send({ value: 'abs-key-for-covers' })
        .expect(200);
      await request(env.app)
        .post('/api/v1/cleanup/audio/switch/covers')
        .set(user)
        .send({ action: 'start' })
        .expect(200);
      const covers = env.audio!.covers!;
      for (let i = 0; i < 50 && covers.isRunning(); i++) await covers.step(() => false);
      expect(covers.pause()).toBeNull();
      expect(covers.status().state).toBe('done');
      const posts = calls.filter((c) => c.method === 'POST');
      expect(
        calls.every((c) => c.method === 'GET' || /^\/api\/items\/li_\d+\/cover$/.test(c.path)),
      ).toBe(true);
      const byFolder = (part: string) =>
        `/api/items/${items.find((x) => x.relPath.includes(part))!.id}/cover`;
      const urlPost = posts.find((c) => c.path === byFolder('Vol 2 - シリーズX 2'))!;
      expect(urlPost.type).toMatch(/application\/json/);
      expect(JSON.parse(urlPost.body)).toEqual({ url: 'https://img.example/x2.jpg' });
      const filePost = posts.find((c) => c.path === byFolder('Vol 1 - シリーズX 1'))!;
      expect(filePost.type).toMatch(/multipart\/form-data/);
      expect(filePost.body).toContain('jpg');
      expect(posts.some((c) => c.path === byFolder('選択'))).toBe(false);
      expect(posts).toHaveLength(2);
      const listed = await request(env.app)
        .get('/api/v1/cleanup/audio/switch/covers')
        .set(user)
        .expect(200);
      const states = (listed.body.items as { state: string }[]).map((x) => x.state).sort();
      expect(states.filter((x) => x === 'set')).toHaveLength(2);
      expect(states).toContain('has_cover');
      expect(states).toContain('no_source');
    } finally {
      await new Promise<void>((r) => absServer.close(() => r()));
    }

    // 4. Delete japanese-old: refused while Audiobookshelf uses it.
    setAbs([{ name: 'Old', folders: ['/audiobooks/japanese-old'] }]);
    expect(
      (
        await request(env.app)
          .post('/api/v1/cleanup/audio/switch/start')
          .set(user)
          .send({ action: 'delete' })
      ).status,
    ).toBe(409);
    setAbs([{ name: 'Japanese Audiobooks', folders: ['/audiobooks/japanese'] }]);
    // Audiobookshelf's new library adds a cover file to a book folder (allowed by the check).
    const someBook = path.dirname(
      path.join(disk.media, 'japanese', [...new0.keys()].find((k) => k.endsWith('metadata.json'))!),
    );
    fs.writeFileSync(path.join(someBook, 'cover.jpg'), 'abs cover');
    const torrentsBeforeDelete = treeProof(disk.torrents);
    const oldFiles = [...treeProof(path.join(disk.media, 'japanese-old')).entries()].filter(
      ([, e]) => e.line.startsWith('F'),
    );
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'delete' })
      .expect(200);
    const delPhases: string[] = [];
    await drive(env, worker, () => {
      if (!delPhases.includes(phaseOf())) delPhases.push(phaseOf());
      return sw.state() === 'deleted';
    });
    expect(delPhases).toEqual(['check', 'files', 'inventory', 'list', 'delete', 'report']);
    const d = sw.progress()!;
    expect(d.files).toMatchObject({ total: 2, same: 2, different: 0, noTwin: 0 });
    expect(d.inventory!.copied).toEqual(['needs_review.csv', '.processed_files.json']);
    expect(
      fs.readFileSync(path.join(disk.media, '_inventory/old-copy-script/needs_review.csv'), 'utf8'),
    ).toBe('a,b\r\n');
    expect(fs.existsSync(path.join(disk.media, 'japanese-old'))).toBe(false);
    // Freed: the files that had no other name (the copies; not the library-only file).
    const freed = oldFiles
      .filter(([, e]) => e.nlink === 1)
      .reduce((x, [, e]) => x + Number(e.line.split(' ')[1]), 0);
    expect({
      files: d.deletion!.files,
      freed: d.deletion!.freed,
      unknown: d.deletion!.unknown,
    }).toEqual({
      files: oldFiles.length,
      freed,
      unknown: [],
    });
    // The torrents as before the deletion; the library-only file lives on under _from-library.
    expect(treeProof(disk.torrents)).toEqual(
      new Map(
        [...torrentsBeforeDelete].map(([k, e]) => [
          k,
          k === '_from-library/ティアムーン10/ティアムーン10.m4b'
            ? { ...e, nlink: e.nlink - 1 }
            : e,
        ]),
      ),
    );
    // Nothing more can be done; every link still resolves.
    for (const a of ['switch', 'undo', 'delete'] as const)
      expect(
        (
          await request(env.app)
            .post('/api/v1/cleanup/audio/switch/start')
            .set(user)
            .send({ action: a })
        ).status,
      ).toBe(409);
    for (const [book] of Object.entries(L))
      expect(resolveLink(env.db, getLink(env.db, uid, book)!).status, book).toBe('ok');
  });

  it('accepts Audiobookshelf rewriting its own files in the old library, and stops on any other change', async () => {
    const { env, disk, worker, user, setAbs } = await setup();
    const sw = env.audio!.switcher!;
    await build(env, worker, user);
    setAbs([]);
    // ABS rewrote a metadata.json (the same file); the switch's check counts it and goes on.
    const meta = path.join(disk.library, '_Unknown/シリーズX/Vol 1 - シリーズX 1/metadata.json');
    const ino0 = fs.lstatSync(meta).ino;
    fs.writeFileSync(meta, '{"title":"rewritten by ABS"}');
    fs.utimesSync(meta, new Date(), new Date(Date.now() + 5000));
    expect(fs.lstatSync(meta).ino).toBe(ino0);
    // …and added a cover file of its own to another old folder.
    fs.writeFileSync(path.join(disk.library, '_Unknown/シリーズX 2/cover.jpg'), 'abs');
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    for (let i = 0; i < 400 && sw.progress()!.phase !== 'links' && !sw.pause(); i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    expect(sw.pause()).toBeNull();
    const lib = sw.progress()!.check!.items.find((x) => x.key === 'library')!;
    expect(lib).toMatchObject({ ok: true });
    expect(lib.detail).toMatch(/2 of Audiobookshelf's own files rewritten or added/);
    await request(env.app).post('/api/v1/cleanup/audio/switch/cancel').set(user).expect(200);
    // An audio file of the old library changed: the check stops the switch before any rename.
    fs.appendFileSync(path.join(disk.library, '_Unknown/シリーズX 2/c.m4b'), 'x');
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    for (let i = 0; i < 400 && !sw.pause(); i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    expect(sw.pause()).toMatchObject({ reason: 'check_failed' });
    expect(sw.pause()!.detail).toMatch(/The live library unchanged: 0 added, 0 removed, 1 changed/);
    expect(fs.existsSync(path.join(disk.media, 'japanese-old'))).toBe(false);
    await request(env.app).post('/api/v1/cleanup/audio/switch/cancel').set(user).expect(200);
    expect(isHeld(env.db, 'switch')).toBe(false);
  });

  it('pauses on a late arrival before anything changes; Cancel lets go of the hold', async () => {
    const { env, disk, worker, user, setAbs } = await setup();
    const sw = env.audio!.switcher!;
    await build(env, worker, user);
    setAbs([]);
    fs.mkdirSync(path.join(disk.library, '_Unknown', '新しい本'));
    fs.writeFileSync(path.join(disk.library, '_Unknown', '新しい本', 'new.m4b'), audio(40));
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    for (let i = 0; i < 50 && !sw.pause(); i++) await sw.step(() => false);
    expect(sw.pause()).toMatchObject({ reason: 'late_arrivals' });
    expect(sw.progress()!.lateArrivals).toEqual(['_Unknown/新しい本/new.m4b']);
    expect(isHeld(env.db, 'switch')).toBe(true);
    await request(env.app).post('/api/v1/cleanup/audio/switch/cancel').set(user).expect(200);
    expect(sw.state()).toBe('none');
    expect(isHeld(env.db, 'switch')).toBe(false);
    expect(isHeld(env.db, 'merge_wait')).toBe(true);
    expect(fs.existsSync(path.join(disk.media, 'japanese-old'))).toBe(false);
    expect(fs.existsSync(path.join(disk.roots ?? disk.torrents, '_from-library'))).toBe(false);
  });

  it('resumes after a restart in the middle (a new switch object on the same databases)', async () => {
    const { env, worker, user, setAbs } = await setup();
    const sw = env.audio!.switcher!;
    await build(env, worker, user);
    setAbs([]);
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    // Up to the renames' operations being handed out.
    for (let i = 0; i < 400 && sw.progress()!.phase !== 'rename'; i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    await sw.step(() => false);
    const { AudioSwitch } = await import('../src/cleanup/audio/stage6-switch');
    const deps = (sw as unknown as { deps: ConstructorParameters<typeof AudioSwitch>[0] }).deps;
    const reader = (
      sw as unknown as { reader: Parameters<InstanceType<typeof AudioSwitch>['attachReader']>[0] }
    ).reader;
    sw.giveBack();
    const again = new AudioSwitch(deps);
    again.attachReader(reader);
    (env.audio as unknown as { switcher: unknown }).switcher = again;
    expect(isHeld(env.db, 'switch')).toBe(true);
    for (let i = 0; i < 800 && again.state() !== 'switched'; i++) {
      await again.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    expect(again.pause()).toBeNull();
    expect(again.state()).toBe('switched');
    expect(again.progress()!.verify!.passed).toBe(true);
  });

  it('the cover writer can send only POST /api/items/:id/cover; only the covers run uses it', () => {
    const SRC = path.join(__dirname, '..', 'src');
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const w = strip(
      fs.readFileSync(path.join(SRC, 'cleanup', 'audio', 'abs-cover-writer.ts'), 'utf8'),
    );
    expect(w.match(/fetchImpl\(/g)).toHaveLength(1);
    expect(w.match(/method: '[A-Z]+'/g)).toEqual(["method: 'POST'"]);
    expect(w.match(/\/api\/[^`'"]*/g)).toEqual(['/api/items/${itemId}/cover']);
    expect(w).not.toMatch(/\b(PUT|PATCH|DELETE)\b/);
    const users: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n);
        if (fs.statSync(f).isDirectory()) walk(f);
        else if (
          n.endsWith('.ts') &&
          /abs-cover-writer/.test(fs.readFileSync(f, 'utf8')) &&
          n !== 'abs-cover-writer.ts'
        )
          users.push(path.relative(SRC, f).split(path.sep).join('/'));
      }
    };
    walk(SRC);
    expect(users).toEqual(['cleanup/audio/stage6-covers.ts']);
  });

  it('Continue after a failed deletion tries the failed operation again and finishes', async () => {
    const { env, disk, worker, user, setAbs } = await setup();
    const sw = env.audio!.switcher!;
    await build(env, worker, user);
    setAbs([]);
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'switch' })
      .expect(200);
    for (let i = 0; i < 800 && sw.state() !== 'switched'; i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    expect(sw.state()).toBe('switched');
    await request(env.app)
      .post('/api/v1/cleanup/audio/switch/start')
      .set(user)
      .send({ action: 'delete' })
      .expect(200);
    for (let i = 0; i < 400 && sw.progress()!.phase !== 'delete'; i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    // As on the NAS: the first deletion refused (a folder the sidecar can't write), the run
    // paused with it failed.
    const run = sw.progress()!.runId;
    env.cleanupDb
      .prepare(
        `UPDATE audio_switch_ops SET state = 'failed', result_json = '{"error":"EACCES"}'
         WHERE id = (SELECT MIN(id) FROM audio_switch_ops WHERE run_id = ? AND phase = 'delete')`,
      )
      .run(run);
    await sw.step(() => false);
    expect(sw.pause()).toMatchObject({ reason: 'sidecar_failed' });
    // The pause's start is kept (a deploy while paused keeps it), and a save while paused
    // doesn't drop it. Then, as on the NAS, the pause lasts an hour.
    const pausedAt = sw.progress()!.pausedAt!;
    expect(pausedAt).toBeGreaterThan(0);
    await sw.step(() => false);
    expect(sw.progress()!.pausedAt).toBe(pausedAt);
    const hour = 3_600_000;
    const earlier = { ...sw.progress()! };
    earlier.pausedAt = pausedAt - hour;
    earlier.phaseStartedAt -= hour;
    earlier.current = { ...earlier.current!, startedAt: earlier.current!.startedAt - hour };
    earlier.startedAt -= hour;
    env.cleanupDb
      .prepare('UPDATE audio_switch SET progress_json = ? WHERE id = 1')
      .run(JSON.stringify(earlier));
    const before = sw.progress()!;
    expect(before.current).not.toBeNull();
    await request(env.app).post('/api/v1/cleanup/audio/switch/resume').set(user).expect(200);
    // Continue moves the phase's and the bar's start past the pause: the hour counts toward
    // neither the step's time nor the time left (found live: 23 h left after a pause).
    const after = sw.progress()!;
    expect(after.pausedAt ?? null).toBeNull();
    expect(after.phaseStartedAt - before.phaseStartedAt).toBeGreaterThanOrEqual(hour);
    expect(after.current!.startedAt - before.current!.startedAt).toBeGreaterThanOrEqual(hour);
    expect(Date.now() - after.phaseStartedAt).toBeLessThan(hour);
    expect(
      env.cleanupDb
        .prepare(`SELECT COUNT(*) AS n FROM audio_switch_ops WHERE run_id = ? AND state = 'failed'`)
        .get(run),
    ).toEqual({ n: 0 });
    for (let i = 0; i < 800 && sw.state() !== 'deleted' && !sw.pause(); i++) {
      await sw.step(() => false);
      await worker.cycle().catch(() => undefined);
    }
    expect(sw.pause()).toBeNull();
    expect(sw.state()).toBe('deleted');
    expect(sw.progress()!.phaseTimes.delete).toBeLessThan(hour);
    expect(fs.existsSync(path.join(disk.media, 'japanese-old'))).toBe(false);
  });

  it('switch batches never meet a build batch’s id', () => {
    expect(SWITCH_BATCH_BASE).toBeGreaterThan(1e8);
  });

  it('every polled query uses an index', async () => {
    const { env } = await setup();
    const plan = (sql: string, ...a: unknown[]) =>
      (env.cleanupDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[])
        .map((x) => x.detail)
        .join(' | ');
    for (const sql of [
      `SELECT * FROM audio_switch_ops WHERE run_id = 'r' AND phase = 'delete' AND state = 'planned' ORDER BY seq LIMIT 5`,
      `SELECT state, COUNT(*) AS n FROM audio_switch_ops WHERE run_id = 'r' AND phase = 'delete' GROUP BY state`,
      `SELECT id FROM audio_switch_batches WHERE run_id = 'r' AND state = 'claimed' AND lease_until < 5`,
      `SELECT * FROM audio_switch_links WHERE run_id = 'r' ORDER BY outcome, book_id LIMIT 10`,
      `SELECT * FROM audio_switch_files WHERE run_id = 'r' AND state = 'planned' ORDER BY lib_rel LIMIT 1`,
      `UPDATE audio_switch_ops SET state = 'planned', batch_id = NULL WHERE batch_id = 1 AND state = 'claimed'`,
    ])
      expect(plan(sql), sql).not.toMatch(/SCAN audio_switch/);
  });
});
