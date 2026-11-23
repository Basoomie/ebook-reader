/**
 * WP21a: the audiobook cleanup's groundwork (cleanup.db v8, the disk lock shared with the
 * Calibre cleanup, settings and the ABS key), stage 0 (Audiobookshelf snapshot, GET only),
 * stage 1 (identity) and stage 2 (books and file health), and the proofs that nothing is
 * written under the audiobook roots.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AbsClient } from '../src/cleanup/audio/abs-client';
import {
  listSnapshots,
  progressCsv,
  saveSnapshot,
  summarize,
  takeAbsSnapshot,
} from '../src/cleanup/audio/abs-snapshot';
import { checkRoots } from '../src/cleanup/audio/audio-cleanup-service';
import { getAudioStage, setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import {
  buildUnits,
  classifyMulti,
  discFolder,
  idsInNames,
  sourceOf,
} from '../src/cleanup/audio/book-units';
import { importDryRun } from '../src/cleanup/audio/dry-run';
import { decodeMojibake, decodePath } from '../src/cleanup/audio/mojibake';
import { audioProblems, checkHealth, parseProbe, toolArgs } from '../src/cleanup/audio/probe';
import { AudioStage1, identityCounts } from '../src/cleanup/audio/stage1-identity';
import { AudioStage2, booksCounts } from '../src/cleanup/audio/stage2-books';
import { walkRoots } from '../src/cleanup/audio/walk';
import {
  CLEANUP_MIGRATIONS,
  CLEANUP_SCHEMA_VERSION,
  initCleanupDatabase,
  openCleanupDatabase,
} from '../src/cleanup/cleanup-db';
import { DISK_PHASES } from '../src/cleanup/cleanup-service';
import { DISK_OWNERS, DiskLock } from '../src/cleanup/disk-lock';
import { SECRET_NAMES } from '../src/cleanup/secrets';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { makeTempDir } from './helpers/spawn-server';
import { makeCleanupEnv } from './helpers/cleanup-env';

const SRC = path.join(__dirname, '..', 'src');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');
if (!HAS_FFMPEG) console.warn('WP21a health tests SKIPPED: ffmpeg/ffprobe not found on PATH');
const TOOLS = { ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg' };

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21a-db'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

/** Every entry under a folder: name, size, mtime, inode, links and content hash. */
function treeProof(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isDirectory()) {
        out.push(`D ${path.relative(dir, p)} ${st.mtimeMs}`);
        walk(p);
      } else {
        out.push(
          `F ${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${st.ino} ${st.nlink} ${sha(fs.readFileSync(p))}`,
        );
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

function put(root: string, rel: string, data: Buffer | string): string {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

// ---------------------------------------------------------------------------------------
describe('cleanup.db migration 8', () => {
  it('adds the audiobook tables to a v7 file (the live one has 7) and leaves the Calibre stages as they were', () => {
    const dir = makeTempDir('wp21a-mig');
    const file = path.join(dir, 'cleanup.db');
    const v5 = new Database(file);
    for (const m of CLEANUP_MIGRATIONS.filter((x) => x.version <= 7)) {
      v5.exec(m.sql);
      v5.pragma(`user_version = ${m.version}`);
    }
    v5.prepare(`UPDATE stages SET mode = 'analyse', state = 'ready' WHERE stage = 3`).run();
    v5.close();
    const db = openCleanupDatabase(file);
    // Later migrations (WP20d's 9) run on top; the audiobook tables come with 8.
    expect(db.pragma('user_version', { simple: true })).toBe(CLEANUP_SCHEMA_VERSION);
    expect(CLEANUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(getStage(db, 3).mode).toBe('analyse');
    expect(getStage(db, 3).state).toBe('ready');
    expect(
      (
        db.prepare('SELECT stage, mode FROM audio_stages ORDER BY stage').all() as {
          mode: string;
        }[]
      ).map((r) => r.mode),
      // Stages 0-2 (WP21a), 3 (WP21b), 4 (WP21c), 5 (WP21d), 6 (WP21e-1), 7 (WP21f-1), 8 (WP21g),
      // all Off.
    ).toEqual(['off', 'off', 'off', 'off', 'off', 'off', 'off', 'off', 'off']);
    for (const t of [
      'audio_files',
      'audio_identity',
      'audio_books',
      'audio_book_files',
      'audio_file_health',
      'audio_evidence',
      'abs_snapshots',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    db.close();
  });

  it('On is refused for the audiobook stages in this build', () => {
    const db = freshDb();
    expect(() => setAudioStageMode(db, 1, 'on')).toThrow(/switched on/);
    expect(() => setAudioStageMode(db, 0, 'analyse')).toThrow(/no mode/);
    setAudioStageMode(db, 2, 'analyse');
    expect(getAudioStage(db, 2).mode).toBe('analyse');
  });
});

// ---------------------------------------------------------------------------------------
describe('the shared disk lock', () => {
  it('gives the disk to a waiting Calibre job first, and an audiobook holder yields at once', async () => {
    const lock = new DiskLock(5);
    expect(lock.tryAcquire('audio', 'audio')).toBe(true);
    expect(lock.shouldYield('audio')).toBe(false);
    const calibre = lock.acquire('calibre3', 'calibre');
    // A second audiobook job also waits; Calibre must win.
    const audio2 = lock.acquire('audio2', 'audio');
    await new Promise((r) => setTimeout(r, 20));
    expect(lock.shouldYield('audio')).toBe(true);
    expect(lock.state().waiting.map((w) => w.owner)).toEqual(['calibre3', 'audio2']);
    lock.release('audio');
    expect(await calibre).toBe(true);
    expect(lock.state().holder?.owner).toBe('calibre3');
    // A Calibre holder is never asked to yield.
    expect(lock.shouldYield('calibre3')).toBe(false);
    lock.release('calibre3');
    expect(await audio2).toBe(true);
    lock.release('audio2');
    expect(lock.state()).toEqual({ holder: null, waiting: [], calibreApplying: null });
  });

  it('while a Calibre batch is being applied, audiobook jobs wait and a holder gives the disk back', async () => {
    const lock = new DiskLock(5);
    let applying: string | null = null;
    lock.setCalibreApplying(() => applying);
    expect(lock.tryAcquire('audio', 'audio')).toBe(true);
    expect(lock.shouldYield('audio')).toBe(false);
    applying = 'Calibre stage 3 (applying a batch)';
    await new Promise((r) => setTimeout(r, 1100)); // the check is reused for 1 s
    expect(lock.shouldYield('audio')).toBe(true);
    lock.release('audio');
    expect(lock.tryAcquire('audio', 'audio')).toBe(false);
    expect(lock.state().calibreApplying).toBe('Calibre stage 3 (applying a batch)');
    // Calibre's own analysis is not held back by its batch.
    expect(lock.tryAcquire('calibre3', 'calibre')).toBe(true);
    lock.release('calibre3');
    applying = null;
    await new Promise((r) => setTimeout(r, 1100));
    expect(lock.tryAcquire('audio', 'audio')).toBe(true);
  });

  it('an open Calibre batch in cleanup.db holds the audiobook jobs back', async () => {
    const { env, setup } = await makeCleanupEnv();
    try {
      await setup();
      expect(env.service.diskLock.state().calibreApplying).toBeNull();
      env.cleanupDb
        .prepare(
          `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at)
           VALUES ('b1', 3, ?, 'apply', 'claimed', 1, ?, ?)`,
        )
        .run(env.libraryId(), Date.now(), Date.now());
      await new Promise((r) => setTimeout(r, 1100));
      expect(env.service.diskLock.state().calibreApplying).toBe(
        'Calibre stage 3 (applying a batch)',
      );
      expect(env.service.diskLock.tryAcquire(DISK_OWNERS.audio1, 'audio')).toBe(false);
    } finally {
      await env.close();
    }
  });

  it('a Calibre stage that is On with work left holds them back between its batches too; a paused one does not', async () => {
    const { env, setup } = await makeCleanupEnv();
    try {
      await setup();
      const db = env.cleanupDb;
      db.prepare(
        `UPDATE stages SET mode = 'on', state = 'ready', progress_json = ? WHERE stage = 3`,
      ).run(JSON.stringify({ analysisId: 'a1', phase: 'done' }));
      expect(env.service.calibreApplying()).toBeNull(); // On, but nothing left
      db.prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, source,
           class, state, analysis_id, created_at, updated_at)
         VALUES (3, ?, 1, 'u1', 'book', 'rules', 'auto', 'proposed', 'a1', 0, 0)`,
      ).run(env.libraryId());
      // No batch is open (the gap while the reader's index takes in the last one).
      expect(env.service.calibreApplying()).toBe('Calibre stage 3 (between batches)');
      await new Promise((r) => setTimeout(r, 1100));
      expect(env.service.diskLock.calibreBusy()).toBe(true);
      expect(env.service.diskLock.tryAcquire(DISK_OWNERS.audio1, 'audio')).toBe(false);
      db.prepare(`UPDATE stages SET pause_reason = 'library_changed' WHERE stage = 3`).run();
      expect(env.service.calibreApplying()).toBeNull();
      db.prepare(`UPDATE stages SET pause_reason = NULL, mode = 'analyse' WHERE stage = 3`).run();
      expect(env.service.calibreApplying()).toBeNull(); // Preview applies nothing
    } finally {
      await env.close();
    }
  });

  it('an audiobook job cannot take a free disk while a Calibre job waits', () => {
    const lock = new DiskLock(5);
    lock.tryAcquire('x', 'calibre');
    void lock.acquire('calibre2', 'calibre');
    lock.release('x');
    expect(lock.tryAcquire('audio', 'audio')).toBe(false);
  });

  it('waiting stops when the job is stopped, and nothing is held', async () => {
    const lock = new DiskLock(5);
    lock.tryAcquire('calibre1', 'calibre');
    let stop = false;
    const waiting = lock.acquire('audio', 'audio', () => stop);
    stop = true;
    expect(await waiting).toBe(false);
    expect(lock.state().waiting).toEqual([]);
  });

  it('the Calibre phases that read book files are the ones that take it', () => {
    expect(DISK_PHASES).toEqual({
      1: ['stat', 'hash'],
      2: ['read'],
      3: ['text', 'quality'],
      // WP20d: stage 4 reads each EPUB as the measured run did.
      4: ['read'],
    });
  });

  it("Calibre's stage 1 analysis waits while an audiobook job holds the disk, then runs and gives it back", async () => {
    const lock = new DiskLock(5);
    const { env, setup } = await makeCleanupEnv({ service: { diskLock: lock } });
    try {
      await setup();
      lock.tryAcquire(DISK_OWNERS.audio1, 'audio');
      env.service.setMode(1, 'analyse');
      for (let i = 0; i < 20; i++) {
        await env.service.tick();
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(getStage(env.cleanupDb, 1).state).not.toBe('ready');
      expect(lock.shouldYield(DISK_OWNERS.audio1)).toBe(true);
      expect(lock.state().waiting[0].owner).toBe(DISK_OWNERS.calibre1);
      lock.release(DISK_OWNERS.audio1);
      for (let i = 0; i < 100 && getStage(env.cleanupDb, 1).state !== 'ready'; i++) {
        await env.service.tick();
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(getStage(env.cleanupDb, 1).state).toBe('ready');
      expect(lock.state().holder).toBeNull();
      expect(env.service.status().disk).toEqual({
        holder: null,
        waiting: [],
        calibreApplying: null,
      });
    } finally {
      await env.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
describe('settings and the Audiobookshelf key', () => {
  it('validates the audiobook settings and refuses bad values with a message', () => {
    const db = freshDb();
    expect(getSettings(db).audiobooks).toMatchObject({
      absUrl: '',
      readMbPerSecond: 0,
      healthWorkers: 4,
      decodeSeconds: 20,
    });
    expect(() => updateSettings(db, { audiobooks: { absUrl: 'ftp://x' } })).toThrow(/http/);
    expect(() => updateSettings(db, { audiobooks: { absUrl: 'http://u:p@h:13378' } })).toThrow(
      /login/,
    );
    expect(() => updateSettings(db, { audiobooks: { decodeSeconds: 0 } })).toThrow(/decoded/);
    expect(() => updateSettings(db, { audiobooks: { nope: 1 } })).toThrow(/Unknown/);
    const s = updateSettings(db, {
      audiobooks: { absUrl: 'http://192.168.1.5:13378/', readMbPerSecond: 80 },
    });
    expect(s.audiobooks.absUrl).toBe('http://192.168.1.5:13378');
    expect(s.audiobooks.readMbPerSecond).toBe(80);
    expect(s.audiobooks.decodeSeconds).toBe(20);
  });

  it('a stored pace from an earlier build is dropped without losing the other settings', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('audiobooks', ?, 0)`,
    ).run(JSON.stringify({ absUrl: 'http://h:13378', healthFilesPerSecond: 1, healthWorkers: 2 }));
    expect(getSettings(db).audiobooks).toMatchObject({
      absUrl: 'http://h:13378',
      healthWorkers: 2,
    });
    expect('healthFilesPerSecond' in getSettings(db).audiobooks).toBe(false);
  });

  it('the ABS key is a write-only secret', async () => {
    expect(SECRET_NAMES).toContain('absApiKey');
    const { env, setup } = await makeCleanupEnv();
    try {
      await setup();
      const user = env.userToken();
      const auth = { Authorization: `Bearer ${user}` };
      const request = (await import('supertest')).default;
      const r = await request(env.app)
        .put('/api/v1/cleanup/secrets/absApiKey')
        .set(auth)
        .send({ value: 'abs-key-0123456789-WXYZ' })
        .expect(200);
      expect(JSON.stringify(r.body)).not.toContain('abs-key-0123456789');
      expect(r.body.secrets.absApiKey).toMatchObject({ set: true, hint: 'WXYZ' });
      const g = await request(env.app).get('/api/v1/cleanup/settings').set(auth).expect(200);
      expect(JSON.stringify(g.body)).not.toContain('abs-key-0123456789');
      expect(env.service.secrets.read('absApiKey')).toBe('abs-key-0123456789-WXYZ');
    } finally {
      await env.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
describe('names', () => {
  it('decodes Shift-JIS shown as CP437 (real names from the NAS) and leaves everything else', () => {
    expect(decodeMojibake('îNé¬é¡éΩé╜Ä╡ô·è╘é╠ù]û╜âJâîâôâ_ü[ [B0H713688W]')).toBe(
      '君がくれた七日間の余命カレンダー [B0H713688W]',
    );
    expect(decodeMojibake('îîû¼é╠âiâCâgâüâAü@ôVïvæΘë¢é╠ÄûîÅâJâïâe [B0G4W9K832].m4b')).toBe(
      '血脈のナイトメア　天久鷹央の事件カルテ [B0G4W9K832].m4b',
    );
    expect(decodeMojibake('âuâeâBâbâN')).toMatch(/^[゠-ヿ]+$/);
    for (const plain of [
      'Discord',
      'TMW Japanese Audiobooks Collection (Part 2)',
      '君がくれた',
      'Café',
      'Pokémon',
      'Müller',
      '',
    ]) {
      expect(decodeMojibake(plain)).toBeNull();
    }
    expect(decodePath('Discord/moved/âuâeâBâbâN/x.m4b')).toMatch(
      /^Discord\/moved\/[゠-ヿ]+\/x\.m4b$/,
    );
    expect(decodePath('Discord/moved/plain/x.m4b')).toBeNull();
  });

  it('finds ASINs, TMW reading-order numbers, kikubon and audiobook.jp ids and [N巻] labels', () => {
    const ids = idsInNames([
      '[餅月 望] ティアムーン帝国物語シリーズ',
      '[06] ティアムーン帝国物語5.5 [B0BXYZ1234].m4b',
      'アルスラーン戦記6 [kikubon 39]',
      'さるのこしかけ [audiobook.jp 265254]',
      '[5.5巻] お隣の天使様',
      'ＢＯＫＫ１２３４５６',
    ]);
    expect(ids.asins).toEqual(['B0BXYZ1234']);
    // [餅月 望] is not a number; the first [NN] at the start of a name is.
    expect(ids.order).toBe(6);
    expect(idsInNames(['[06] x']).order).toBe(6);
    expect(ids.kikubon).toBe('39');
    expect(ids.audiobookJp).toBe('265254');
    expect(ids.volumes).toEqual(['5.5']);
  });
});

// ---------------------------------------------------------------------------------------
describe('book units', () => {
  it('a folder that holds audio is a book; Disc/CD subfolders fold into it', () => {
    expect(discFolder('Disc 1')).toBe('1');
    expect(discFolder('CD2')).toBe('2');
    expect(discFolder('ＣＤ１')).toBe('1');
    expect(discFolder('DISC-03')).toBe('3');
    expect(discFolder('Disc 1 of 2')).toBe('1');
    // Real ABS folders named like drama CDs are books, not disc folders.
    expect(discFolder('CD 3 - 穏やか貴族の休暇のすすめ。ドラマCD3')).toBeNull();
    const units = buildUnits('torrents', [
      { fileId: 1, rel: 'Discord/moved/本A/Disc 2/01.mp3' },
      { fileId: 2, rel: 'Discord/moved/本A/Disc 10/01.mp3' },
      { fileId: 3, rel: 'Discord/moved/本A/Disc 1/01.mp3' },
      { fileId: 4, rel: 'MAM/本B/本B.m4b' },
      { fileId: 5, rel: 'AI/作者/本C/本C.m4b' },
    ]);
    expect(units.map((u) => [u.unitRelPath, u.source, u.files.map((f) => f.fileId)])).toEqual([
      ['AI/作者/本C', 'ai', [5]],
      ['Discord/moved/本A', 'discord', [3, 1, 2]],
      ['MAM/本B', 'mam', [4]],
    ]);
  });

  it('in the TMW torrents every audio file is one book, also inside [Author] Series/ folders', () => {
    const tmw = 'TMW Japanese Audiobooks Collection (Part 15) - Light Novels V';
    const units = buildUnits('torrents', [
      {
        fileId: 1,
        rel: `${tmw}/[餅月 望] ティアムーン帝国物語シリーズ/[01] ティアムーン帝国物語1 [B0A0000001].m4b`,
      },
      {
        fileId: 2,
        rel: `${tmw}/[餅月 望] ティアムーン帝国物語シリーズ/[02] ティアムーン帝国物語2 [B0A0000002].m4b`,
      },
      { fileId: 3, rel: `${tmw}/[1巻] 盾の勇者の成り上がり 1.m4b` },
    ]);
    expect(units.map((u) => [u.unitKind, u.nameRaw, u.source])).toEqual([
      ['file', '[1巻] 盾の勇者の成り上がり 1', 'tmw'],
      ['file', '[01] ティアムーン帝国物語1 [B0A0000001]', 'tmw'],
      ['file', '[02] ティアムーン帝国物語2 [B0A0000002]', 'tmw'],
    ]);
    expect(sourceOf('library', `${tmw}/x.m4b`)).toBe('library');
  });

  it('library units follow ABS folders', () => {
    const units = buildUnits('library', [
      { fileId: 1, rel: '_Unknown/盾の勇者の成り上がり/Vol 18 - 盾の勇者の成り上がり 18/a.m4b' },
      { fileId: 2, rel: '_Unknown/盾の勇者の成り上がり/Vol 18 - 盾の勇者の成り上がり 18/b.m4b' },
      { fileId: 3, rel: '_Unknown/機械仕掛けの太陽/機械仕掛けの太陽 [B0BKZL4YNK].m4b' },
    ]);
    expect(units.map((u) => [u.bookKey, u.files.length])).toEqual([
      ['library:_Unknown/機械仕掛けの太陽', 1],
      ['library:_Unknown/盾の勇者の成り上がり/Vol 18 - 盾の勇者の成り上がり 18', 2],
    ]);
  });

  it('parts or copies', () => {
    expect(classifyMulti([3600], 60, 3).cls).toBe('single');
    // 水属性の魔法使い 2: two copies of 777 min.
    expect(classifyMulti([777 * 60, 778 * 60], 60, 3).cls).toBe('likely_copies');
    // A short drama CD that is two copies: not flagged as copies, but unclear.
    expect(classifyMulti([50 * 60, 50 * 60], 60, 3).cls).toBe('unclear');
    expect(classifyMulti([300 * 60, 420 * 60], 60, 3).cls).toBe('parts');
    expect(classifyMulti([300 * 60, null], 60, 3)).toEqual({
      cls: 'unclear',
      reason: 'The length of a file is not known',
    });
  });
});

// ---------------------------------------------------------------------------------------
describe('stage 1: identity on a fixture tree', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0));

  function makeTree() {
    const base = makeTempDir('wp21a-tree');
    dirs.push(base);
    const torrents = path.join(base, 'torrents');
    const library = path.join(base, 'library');
    const A = Buffer.alloc(5000, 'a');
    const B = Buffer.alloc(6000, 'b');
    const AI = Buffer.alloc(7000, 'i');
    const tmw = 'TMW Japanese Audiobooks Collection (Part 2)';
    put(torrents, `${tmw}/本A [B0A0000001].m4b`, A);
    put(torrents, 'Discord/moved/本A [B0A0000001]/本A [B0A0000001].m4b', A); // torrent-side copy
    put(torrents, 'MAM/本B/本B.m4b', B);
    put(torrents, 'MAM/本C/本C.m4b', Buffer.alloc(8000, 'c')); // not in the library
    put(torrents, 'AI/作者/本AI/本AI.m4b', AI);
    put(torrents, 'Discord/archive.zip', Buffer.alloc(100, 'z'));
    put(torrents, 'Discord/cover.jpg', Buffer.alloc(100, 'j'));
    put(torrents, '.hidden/x.m4b', A);
    put(library, '_Unknown/本A/本A [B0A0000001].m4b', A);
    put(library, '_Unknown/本B/本B.m4b', B);
    put(library, '_Unknown/本AI/本AI.m4b', AI);
    put(library, '_Unknown/本D/本D.m4b', Buffer.alloc(9000, 'd')); // library only
    put(library, '_Unknown/本E/本E.m4b', Buffer.alloc(8000, 'e')); // same size as 本C, other bytes
    put(library, '_Unknown/本A/metadata.json', '{"title":"本A"}');
    // A library file that is already a hard link to its torrent original.
    put(torrents, 'MAM/本F/本F.m4b', Buffer.alloc(10_000, 'f'));
    fs.mkdirSync(path.join(library, '_Unknown', '本F'), { recursive: true });
    fs.linkSync(
      path.join(torrents, 'MAM', '本F', '本F.m4b'),
      path.join(library, '_Unknown', '本F', '本F.m4b'),
    );
    return { torrents, library };
  }

  async function run(stage: AudioStage1, stop = () => false) {
    for (let i = 0; i < 200; i++) if (await stage.step(stop)) return;
    throw new Error('stage 1 did not finish');
  }

  it('finds copies, library-only files, torrent-only files, torrent-side copies, AI originals, archives, size-only surprises and hard links, and writes nothing', async () => {
    const roots = makeTree();
    const before = treeProof(path.dirname(roots.torrents));
    const db = freshDb();
    const lock = new DiskLock(5);
    const stage = new AudioStage1({ db, roots, lock });
    stage.restart();
    await run(stage);
    const p = stage.progress()!;
    expect(p.error).toBeNull();
    expect(p.phase).toBe('done');
    const counts = identityCounts(db, p.analysisId);
    expect(counts).toMatchObject({
      'library.copy': 3,
      'library.library_only': 1,
      'library.size_only': 1,
      'library.linked': 1,
      'library.ai_original': 1,
      // 本A in TMW and its Discord copy are both originals of the library's 本A.
      'torrents.original': 5,
      'torrents.torrent_only': 1,
      'torrents.archive': 1,
      'torrents.copy_groups': 1,
      'torrents.copy_extra': 1,
    });
    // The hard link is read once: its twin's hash is reused.
    expect(p.hashReused).toBe(1);
    expect(p.walk?.skippedFolders).toBe(1);
    const linked = db
      .prepare(`SELECT nlink FROM audio_files WHERE root = 'library' AND rel_path LIKE '%本F.m4b'`)
      .get() as { nlink: number };
    expect(linked.nlink).toBe(2);
    expect(lock.state().holder).toBeNull();
    expect(treeProof(path.dirname(roots.torrents))).toBe(before);
  });

  it('resumes after a stop in the middle of hashing, and a file that changed is not hashed', async () => {
    const roots = makeTree();
    const db = freshDb();
    const lock = new DiskLock(5);
    const stage = new AudioStage1({ db, roots, lock });
    stage.restart();
    // Walk, then stop during the first hash step.
    await stage.step(() => false);
    expect(stage.progress()!.phase).toBe('hash');
    let calls = 0;
    await stage.step(() => ++calls > 3);
    expect(stage.progress()!.phase).toBe('hash');
    // A library file changes after the walk.
    fs.appendFileSync(path.join(roots.library, '_Unknown', '本B', '本B.m4b'), 'x');
    await run(stage);
    const p = stage.progress()!;
    expect(p.hashChanged).toBeGreaterThanOrEqual(1);
    const counts = identityCounts(db, p.analysisId);
    expect(counts['library.unhashed']).toBe(1);
    expect(counts['library.copy']).toBe(2);
    // A new analysis walks again: the changed file is hashed now (and is no longer a copy).
    stage.restart();
    await run(stage);
    const again = identityCounts(db, stage.progress()!.analysisId);
    expect(again['library.unhashed'] ?? 0).toBe(0);
    expect(again['library.library_only']).toBe(2);
  });

  it('gives the disk to a Calibre job that asks for it, then finishes', async () => {
    const roots = makeTree();
    // Bigger files so hashing takes a moment.
    for (const rel of ['MAM/本B/本B.m4b']) {
      fs.writeFileSync(
        path.join(roots.torrents, ...rel.split('/')),
        Buffer.alloc(8 * 1024 * 1024, 'q'),
      );
      fs.writeFileSync(
        path.join(roots.library, '_Unknown', '本B', '本B.m4b'),
        Buffer.alloc(8 * 1024 * 1024, 'q'),
      );
    }
    const db = freshDb();
    updateSettings(db, { audiobooks: { readMbPerSecond: 8 } });
    const lock = new DiskLock(5);
    const stage = new AudioStage1({ db, roots, lock });
    stage.restart();
    await stage.step(() => false); // walk
    const hashing = stage.step(() => false);
    await new Promise((r) => setTimeout(r, 100));
    expect(lock.holds(DISK_OWNERS.audio1)).toBe(true);
    const calibre = lock.acquire(DISK_OWNERS.calibre3, 'calibre');
    await hashing;
    expect(await calibre).toBe(true);
    expect(stage.progress()!.yields).toBe(1);
    lock.release(DISK_OWNERS.calibre3);
    updateSettings(db, { audiobooks: { readMbPerSecond: 0 } });
    await run(stage);
    expect(identityCounts(db, stage.progress()!.analysisId)['library.copy']).toBe(3);
  });

  it("the live stage 1 takes over a dry run's hashes only for unchanged files", async () => {
    const roots = makeTree();
    const scratchDir = makeTempDir('wp21a-dry');
    const scratch = openCleanupDatabase(path.join(scratchDir, 'cleanup-dryrun.db'));
    const dry = new AudioStage1({ db: scratch, roots, lock: new DiskLock(5) });
    dry.restart();
    await run(dry);
    scratch.close();
    // One file changes after the dry run.
    const changed = path.join(roots.library, '_Unknown', '本A', '本A [B0A0000001].m4b');
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(changed, t, t);
    const live = freshDb();
    const out = importDryRun(live, path.join(scratchDir, 'cleanup-dryrun.db'));
    expect(out.hashes).toBeGreaterThan(5);
    await walkRoots(live, roots);
    const rows = live
      .prepare(
        `SELECT rel_path, sha256, hash_source FROM audio_files WHERE kind = 'audio' AND gone_at IS NULL`,
      )
      .all() as { rel_path: string; sha256: string | null; hash_source: string | null }[];
    const a = rows.find((r) => r.rel_path === '_Unknown/本A/本A [B0A0000001].m4b')!;
    expect(a.sha256).toBeNull();
    expect(rows.filter((r) => r.hash_source === 'dry_run').length).toBe(out.hashes - 1);
    const stage = new AudioStage1({ db: live, roots, lock: new DiskLock(5) });
    stage.restart();
    await run(stage);
    const p = stage.progress()!;
    // Only the changed file (and nothing else) was read.
    expect(p.hashDone - p.hashReused).toBeGreaterThanOrEqual(1);
    expect(p.bytesHashed).toBe(5000);
    expect(identityCounts(live, p.analysisId)['library.copy']).toBe(3);
  });

  it('listing the folders waits while a Calibre job uses the disk (also a batch being applied)', async () => {
    const roots = makeTree();
    const db = freshDb();
    const lock = new DiskLock(5);
    let applying: string | null = 'Calibre stage 3 (applying a batch)';
    lock.setCalibreApplying(() => applying);
    const stage = new AudioStage1({ db, roots, lock });
    stage.restart();
    const walking = stage.step(() => false);
    await new Promise((r) => setTimeout(r, 300));
    // Nothing listed yet: it waits for Calibre.
    expect(db.prepare('SELECT COUNT(*) AS n FROM audio_files').get()).toEqual({ n: 0 });
    applying = null;
    await walking;
    const p = stage.progress()!;
    expect(p.phase).toBe('hash');
    expect(p.walk!.pausedMs).toBeGreaterThanOrEqual(900);
    expect(p.walk!.audio.library).toBe(6);
  });

  it('a root that comes back empty marks nothing gone', async () => {
    const roots = makeTree();
    const db = freshDb();
    await walkRoots(db, roots);
    const empty = makeTempDir('wp21a-empty');
    const r = await walkRoots(db, { torrents: roots.torrents, library: empty });
    expect(r?.errors.join(' ')).toMatch(/came back empty/);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM audio_files WHERE gone_at IS NOT NULL').get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('the cleanup refuses roots that are writable or missing', async () => {
    const roots = makeTree();
    expect((await checkRoots(null)).problem).toMatch(/not set up/);
    expect(
      (await checkRoots({ torrents: roots.torrents, library: path.join(roots.library, 'nope') }))
        .problem,
    ).toMatch(/missing/);
    expect((await checkRoots(roots)).problem).toMatch(/writable/);
  });
});

// ---------------------------------------------------------------------------------------
describe('file health', () => {
  it('tool arguments never name an output file', () => {
    for (const kind of ['decode-start', 'decode-end'] as const) {
      const a = toolArgs(kind, '/dev/fd/3', 20);
      expect(a.slice(-3)).toEqual(['-f', 'null', '-']);
      expect(a).not.toContain('-y');
      expect(a.filter((x) => x === '-i')).toHaveLength(1);
    }
    expect(toolArgs('decode-end', 'in', 20)).toContain('-sseof');
    const both = toolArgs('decode-both', '/dev/fd/3', 20);
    expect(both.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(both).not.toContain('-y');
    expect(both.filter((x) => x === '-i')).toHaveLength(2);
    expect(both.filter((x) => x === '/dev/fd/3')).toHaveLength(2);
    const p = toolArgs('probe', 'in', 20);
    expect(p[p.length - 1]).toBe('in');
    expect(p).not.toContain('-y');
  });

  it('parses ffprobe output, also chapter titles cut in the middle of a character', () => {
    const json = Buffer.concat([
      Buffer.from(
        '{"streams":[{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"44100","channels":2,"bit_rate":"125588"},{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}],"chapters":[{"start_time":"0.000","end_time":"60.0","tags":{"title":"',
      ),
      Buffer.from([0xe3, 0x81]), // a cut UTF-8 character, as in 人はどう悩むのか
      Buffer.from(
        '"}}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"28126.19","tags":{"title":"t","artist":"a","composer":"n"}}}',
      ),
    ]);
    const r = parseProbe(json);
    expect(r).toMatchObject({
      format: 'mp4',
      codec: 'aac',
      profile: 'LC',
      sampleRate: 44100,
      channels: 2,
      bitrate: 125588,
      duration: 28126.19,
      hasCover: true,
      headerOk: true,
      invalidUtf8: true,
    });
    expect(r.chapters).toHaveLength(1);
    expect(r.tags).toEqual({ title: 't', artist: 'a', composer: 'n' });
  });

  it('a container notice about the chapter track is not an audio problem', () => {
    const notice =
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x15261f0d5380] Referenced QT chapter track not found';
    const NL = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    expect(audioProblems(notice + NL)).toBe('');
    expect(
      audioProblems('[in#0 @ 0000018fe743cfc0] Referenced QT chapter track not found' + CR + NL),
    ).toBe('');
    expect(audioProblems(notice + NL + '    Last message repeated 1 times' + NL)).toBe('');
    // Real problems stay, also next to the notice, with their own repeat line.
    const bad = '[aac @ 0x1] Number of bands (59) exceeds limit (40).';
    const repeat = '    Last message repeated 3 times';
    expect(audioProblems(notice + NL + bad + NL + repeat)).toBe(bad + NL + repeat);
    expect(audioProblems('')).toBe('');
  });

  describe.skipIf(!HAS_FFMPEG)('with ffmpeg', () => {
    function ff(args: string[]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
    }
    function makeAudio(dir: string) {
      const m4b = path.join(dir, 'book.m4b');
      const meta = path.join(dir, 'meta.txt');
      fs.writeFileSync(
        meta,
        ';FFMETADATA1\ntitle=本\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=第一章\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=8000\ntitle=第二章\n',
      );
      ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=8',
        '-i',
        meta,
        '-map_metadata',
        '1',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        m4b,
      ]);
      const mp3 = path.join(dir, 'book.mp3');
      ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=300:duration=6',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '32k',
        mp3,
      ]);
      const ogg = path.join(dir, 'ogg.ogg');
      ff(['-f', 'lavfi', '-i', 'sine=frequency=500:duration=6', '-c:a', 'libvorbis', ogg]);
      const fakeWav = path.join(dir, '08 涼宮ハルヒの憤慨.wav');
      fs.copyFileSync(ogg, fakeWav);
      fs.rmSync(ogg);
      // Damaged: the tail of an mp3 cut off and garbage written over its middle.
      const broken = path.join(dir, 'broken.mp3');
      const buf = fs.readFileSync(mp3);
      const half = Buffer.from(buf.subarray(0, Math.floor(buf.length * 0.7)));
      half.fill(0x55, Math.floor(half.length * 0.6), half.length);
      fs.writeFileSync(broken, half);
      fs.writeFileSync(path.join(dir, 'not-audio.m4b'), Buffer.alloc(3000, 'n'));
      fs.rmSync(meta);
      return { m4b, mp3, fakeWav, broken, notAudio: path.join(dir, 'not-audio.m4b') };
    }

    it('one combined run for both ends gives exactly the results of two separate runs', async () => {
      const dir = makeTempDir('wp21a-same');
      const f = makeAudio(dir);
      // A file damaged only at the start, and one damaged at both ends.
      const mp3 = fs.readFileSync(f.mp3);
      const startBad = Buffer.from(mp3);
      startBad.fill(0x55, 0, Math.floor(startBad.length * 0.3));
      fs.writeFileSync(path.join(dir, 'start-bad.mp3'), startBad);
      const bothBad = Buffer.from(mp3);
      bothBad.fill(0x55, 0, Math.floor(bothBad.length * 0.3));
      bothBad.fill(0x55, Math.floor(bothBad.length * 0.7));
      fs.writeFileSync(path.join(dir, 'both-bad.mp3'), bothBad);
      const files = [
        f.m4b,
        f.mp3,
        f.fakeWav,
        f.broken,
        f.notAudio,
        path.join(dir, 'start-bad.mp3'),
        path.join(dir, 'both-bad.mp3'),
      ];
      for (const decodeSeconds of [2, 20]) {
        for (const file of files) {
          const opts = { decodeSeconds, timeoutMs: 30_000 };
          const combined = await checkHealth(file, TOOLS, opts);
          const separate = await checkHealth(file, TOOLS, { ...opts, combined: false });
          // ffmpeg's messages carry memory addresses; compare them without.
          // (The message is cut at a fixed length, so compare its start.)
          const strip = (r: typeof combined) => ({
            ...r,
            decodeError: r.decodeError?.replace(/@ (0x)?[0-9a-fA-F]+/g, '@').slice(0, 150) ?? null,
            error: r.error?.replace(/@ (0x)?[0-9a-fA-F]+/g, '@').slice(0, 150) ?? null,
          });
          expect(strip(combined), `${path.basename(file)} at ${decodeSeconds} s`).toEqual(
            strip(separate),
          );
        }
      }
    }, 120_000);

    it('a file whose chapter track reference is broken plays clean (live run, 2026-11-18)', async () => {
      const dir = makeTempDir('wp21a-qtchap');
      const f = makeAudio(dir);
      // Point the chapter track reference (tref/chap) at a track that does not exist.
      const buf = fs.readFileSync(f.m4b);
      const tref = buf.indexOf(Buffer.from('tref'));
      expect(tref).toBeGreaterThan(0);
      const chap = buf.indexOf(Buffer.from('chap'), tref);
      buf.writeUInt32BE(99, chap + 4);
      const file = path.join(dir, 'chapter-ref.m4b');
      fs.writeFileSync(file, buf);
      const opts = { decodeSeconds: 2, timeoutMs: 30_000 };
      for (const combined of [true, false]) {
        const r = await checkHealth(file, TOOLS, { ...opts, combined });
        expect(r).toMatchObject({
          headerOk: true,
          startDecodeOk: true,
          endDecodeOk: true,
          decodeError: null,
        });
        // ffprobe's note stays on the file, and the chapter list still reads.
        expect(r.error).toMatch(/Referenced QT chapter track not found/);
        expect(r.chapters).toHaveLength(2);
      }
    });

    it('reads format from the content, chapters, and checks start and end', async () => {
      const dir = makeTempDir('wp21a-health');
      const f = makeAudio(dir);
      const before = treeProof(dir);
      const opts = { decodeSeconds: 2, timeoutMs: 30_000 };
      const m4b = await checkHealth(f.m4b, TOOLS, opts);
      expect(m4b).toMatchObject({
        format: 'mp4',
        codec: 'aac',
        headerOk: true,
        startDecodeOk: true,
        endDecodeOk: true,
        decodeError: null,
      });
      expect(m4b.chapters.map((c) => c.title)).toEqual(['第一章', '第二章']);
      expect(m4b.duration).toBeGreaterThan(7.5);
      const wav = await checkHealth(f.fakeWav, TOOLS, opts);
      expect(wav).toMatchObject({ format: 'ogg', codec: 'vorbis', headerOk: true });
      const mp3 = await checkHealth(f.mp3, TOOLS, opts);
      expect(mp3).toMatchObject({
        format: 'mp3',
        codec: 'mp3',
        startDecodeOk: true,
        endDecodeOk: true,
      });
      const broken = await checkHealth(f.broken, TOOLS, opts);
      expect(broken.headerOk).toBe(true);
      expect(
        broken.endDecodeOk === false || broken.decodeError !== null || broken.error !== null,
      ).toBe(true);
      const bad = await checkHealth(f.notAudio, TOOLS, opts);
      expect(bad.headerOk).toBe(false);
      expect(bad.error).toBeTruthy();
      expect(treeProof(dir)).toBe(before);
    });

    it('stage 2 builds books, checks every file, classifies copies and keeps evidence, writing nothing', async () => {
      const base = makeTempDir('wp21a-s2');
      const torrents = path.join(base, 'torrents');
      const library = path.join(base, 'library');
      const tmp = makeTempDir('wp21a-s2-src');
      const f = makeAudio(tmp);
      const tmw = 'TMW Japanese Audiobooks Collection (Part 15) - Light Novels V';
      put(torrents, `${tmw}/[作者] シリーズ/[01] 本1 [B0A0000001].m4b`, fs.readFileSync(f.m4b));
      put(torrents, `${tmw}/[作者] シリーズ/[02] 本2 [B0A0000002].m4b`, fs.readFileSync(f.m4b));
      put(
        torrents,
        'Discord/moved/涼宮ハルヒの驚愕前/Audio/08 涼宮ハルヒの憤慨.wav',
        fs.readFileSync(f.fakeWav),
      );
      put(
        torrents,
        'Discord/moved/îNé¬é¡éΩé╜Ä╡ô·è╘é╠ù]û╜âJâîâôâ_ü[ [B0H713688W]/a.mp3',
        fs.readFileSync(f.mp3),
      );
      put(
        torrents,
        'Discord/moved/îNé¬é¡éΩé╜Ä╡ô·è╘é╠ù]û╜âJâîâôâ_ü[ [B0H713688W]/b.mp3',
        fs.readFileSync(f.mp3),
      );
      put(torrents, 'MAM/壊れた/broken.mp3', fs.readFileSync(f.broken));
      put(library, '_Unknown/本1/本1.m4b', fs.readFileSync(f.m4b));
      put(
        library,
        '_Unknown/本1/metadata.json',
        JSON.stringify({ title: '本1', asin: 'B0A0000001' }),
      );
      put(library, '_Unknown/本X/Disc 1/a.m4b', fs.readFileSync(f.m4b));
      put(library, '_Unknown/本X/Disc 2/a.m4b', fs.readFileSync(f.mp3));
      const before = treeProof(base);
      const db = freshDb();
      updateSettings(db, {
        audiobooks: { decodeSeconds: 2, copyHintMinMinutes: 0 },
      });
      // Stage 1 first, so the recorded ABS items name their torrent originals.
      const s1 = new AudioStage1({ db, roots: { torrents, library }, lock: new DiskLock(5) });
      s1.restart();
      for (let i = 0; i < 100; i++) if (await s1.step(() => false)) break;
      const stage = new AudioStage2({ db, roots: { torrents, library }, tools: TOOLS });
      stage.restart();
      for (let i = 0; i < 100; i++) if (await stage.step(() => false)) break;
      const p = stage.progress()!;
      expect(p.error).toBeNull();
      expect(p.phase).toBe('done');
      expect(p.healthDone).toBe(9);
      const counts = booksCounts(db, p.analysisId);
      expect(counts).toMatchObject({
        'torrents.source.tmw': 2,
        'torrents.source.discord': 2,
        'torrents.source.mam': 1,
        'books.decoded_names': 1,
        'torrents.likely_copies': 1,
        'torrents.health.ext_mismatch': 1,
        // Audiobookshelf's items are recorded, never book units (user, 2026-11-17).
        'library.abs_items': 2,
        'library.abs_items.multi': 1,
        // 本1 is a copy of the TMW files; 本X's Disc 2 is a copy of the Discord mp3s.
        'library.abs_items.no_torrent_book': 0,
      });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM audio_books WHERE root = 'library'`).get(),
      ).toEqual({ n: 0 });
      const decoded = db
        .prepare(`SELECT name_decoded FROM audio_books WHERE name_decoded IS NOT NULL`)
        .get() as { name_decoded: string };
      expect(decoded.name_decoded).toBe('君がくれた七日間の余命カレンダー [B0H713688W]');
      const ev = db
        .prepare(
          `SELECT data FROM audio_evidence WHERE book_key = 'library:_Unknown/本1' AND kind = 'abs_item'`,
        )
        .get() as { data: string };
      const evidence = JSON.parse(ev.data);
      expect(evidence.absMetadata).toEqual({ title: '本1', asin: 'B0A0000001' });
      // Its file is a copy of the two identical TMW files; their torrent books are recorded.
      expect(evidence.files[0].identity).toBe('copy');
      expect(evidence.torrentBooks).toHaveLength(2);
      expect(evidence.torrentBooks[0]).toMatch(/^torrents:TMW .*\[01\]/);
      const discs = JSON.parse(
        (
          db
            .prepare(`SELECT data FROM audio_evidence WHERE book_key = 'library:_Unknown/本X'`)
            .get() as { data: string }
        ).data,
      );
      expect(discs.files.map((f: { disc: string }) => f.disc)).toEqual(['1', '2']);
      const tmwEv = JSON.parse(
        (
          db
            .prepare(`SELECT data FROM audio_evidence WHERE book_key LIKE 'torrents:TMW%[01]%'`)
            .get() as { data: string }
        ).data,
      );
      expect(tmwEv.ids).toMatchObject({ asins: ['B0A0000001'], order: 1 });
      expect(tmwEv.files[0].chapters).toBe(2);
      // A second analysis reads no clean file again (nothing changed); the one damaged file is
      // checked once more (a stored failed play is checked again in every analysis, so a change
      // in what counts as a problem reaches the results already stored; live run 2026-11-18).
      const damagedBefore = db
        .prepare(
          'SELECT file_id FROM audio_file_health WHERE start_decode_ok = 0 OR end_decode_ok = 0',
        )
        .all();
      expect(damagedBefore).toHaveLength(1);
      stage.restart();
      for (let i = 0; i < 100; i++) if (await stage.step(() => false)) break;
      expect(stage.progress()!.healthReused).toBe(8);
      expect(stage.progress()!.healthDone).toBe(9);
      expect(
        db
          .prepare(
            'SELECT file_id FROM audio_file_health WHERE start_decode_ok = 0 OR end_decode_ok = 0',
          )
          .all(),
      ).toEqual(damagedBefore);
      // A clean file stored as failed by an older rule comes back clean.
      const firstId = (
        db
          .prepare(
            'SELECT MIN(file_id) AS id FROM audio_file_health WHERE start_decode_ok = 1 AND end_decode_ok = 1',
          )
          .get() as { id: number }
      ).id;
      db.prepare(
        `UPDATE audio_file_health SET start_decode_ok = 0, decode_error = 'start: old rule' WHERE file_id = ?`,
      ).run(firstId);
      stage.restart();
      for (let i = 0; i < 100; i++) if (await stage.step(() => false)) break;
      expect(stage.progress()!.healthReused).toBe(7);
      expect(
        db
          .prepare('SELECT start_decode_ok, decode_error FROM audio_file_health WHERE file_id = ?')
          .get(firstId),
      ).toEqual({ start_decode_ok: 1, decode_error: null });
      expect(treeProof(base)).toBe(before);
    });

    it('stage 2 reads nothing while a Calibre job uses the disk, then runs', async () => {
      const base = makeTempDir('wp21a-wait');
      const torrents = path.join(base, 'torrents');
      const library = path.join(base, 'library');
      const f = makeAudio(makeTempDir('wp21a-wait-src'));
      put(torrents, 'MAM/本1/本1.m4b', fs.readFileSync(f.m4b));
      put(library, '_Unknown/本1/本1.m4b', fs.readFileSync(f.m4b));
      const db = freshDb();
      updateSettings(db, { audiobooks: { decodeSeconds: 2 } });
      let busy = true;
      const st = new AudioStage2({
        db,
        roots: { torrents, library },
        tools: TOOLS,
        calibreBusy: () => busy,
      });
      st.restart();
      let stop = false;
      setTimeout(() => (stop = true), 1500);
      for (let i = 0; i < 20 && !stop; i++) await st.step(() => stop);
      // Nothing listed, nothing checked.
      expect(db.prepare('SELECT COUNT(*) AS n FROM audio_files').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM audio_file_health').get()).toEqual({ n: 0 });
      busy = false;
      for (let i = 0; i < 100; i++) if (await st.step(() => false)) break;
      expect(st.progress()!.phase).toBe('done');
      expect(st.progress()!.healthDone).toBe(2);
    });

    it('several files at once give the same results as one at a time, also when Calibre starts and stops using the disk', async () => {
      const base = makeTempDir('wp21a-par');
      const torrents = path.join(base, 'torrents');
      const library = path.join(base, 'library');
      const f = makeAudio(makeTempDir('wp21a-par-src'));
      const sources = [f.m4b, f.mp3, f.fakeWav, f.broken, f.notAudio];
      for (let k = 0; k < 12; k++) {
        const src = sources[k % sources.length];
        put(torrents, `MAM/本${k}/${k}${path.extname(src)}`, fs.readFileSync(src));
      }
      put(library, '_Unknown/本0/0.m4b', fs.readFileSync(f.m4b));
      const roots = { torrents, library };
      const runWith = async (busy: () => boolean, workers: number) => {
        const db = freshDb();
        updateSettings(db, {
          audiobooks: { healthWorkers: workers, decodeSeconds: 2 },
        });
        const st = new AudioStage2({ db, roots, tools: TOOLS, calibreBusy: busy });
        st.restart();
        for (let i = 0; i < 200; i++) if (await st.step(() => false)) break;
        expect(st.progress()!.error).toBeNull();
        expect(st.progress()!.healthDone).toBe(13);
        const rows = db
          .prepare(
            `SELECT f.root, f.rel_path, h.format, h.codec, h.duration, h.chapter_count, h.has_cover,
               h.header_ok, h.start_decode_ok, h.end_decode_ok,
               (h.decode_error IS NOT NULL) AS decode_problem, (h.error IS NOT NULL) AS error
             FROM audio_file_health h JOIN audio_files f ON f.id = h.file_id ORDER BY f.root, f.rel_path`,
          )
          .all();
        const counts = booksCounts(db, st.progress()!.analysisId);
        return { rows, counts };
      };
      const oneAtATime = await runWith(() => false, 1);
      const parallel = await runWith(() => false, 4);
      expect(parallel.rows).toEqual(oneAtATime.rows);
      expect(parallel.counts).toEqual(oneAtATime.counts);
      // Calibre starts and stops using the disk during the run.
      const t0 = Date.now();
      const switching = await runWith(() => Math.floor((Date.now() - t0) / 300) % 2 === 1, 4);
      expect(switching.rows).toEqual(oneAtATime.rows);
    }, 120_000);

    it("the live stage 2 takes over a dry run's file checks; only changed files are checked again", async () => {
      const base = makeTempDir('wp21a-s2imp');
      const torrents = path.join(base, 'torrents');
      const library = path.join(base, 'library');
      const f = makeAudio(makeTempDir('wp21a-s2imp-src'));
      put(torrents, 'MAM/本1/本1.m4b', fs.readFileSync(f.m4b));
      put(torrents, 'MAM/本2/本2.mp3', fs.readFileSync(f.mp3));
      put(library, '_Unknown/本1/本1.m4b', fs.readFileSync(f.m4b));
      const roots = { torrents, library };
      const opts = { decodeSeconds: 2 };
      // The dry runs, each in its own scratch database (as on the NAS).
      const d1 = path.join(makeTempDir('wp21a-dry1'), 'cleanup-dryrun.db');
      const d2 = path.join(makeTempDir('wp21a-dry2'), 'cleanup-dryrun.db');
      const s1db = openCleanupDatabase(d1);
      const s1 = new AudioStage1({ db: s1db, roots, lock: new DiskLock(5) });
      s1.restart();
      for (let i = 0; i < 100; i++) if (await s1.step(() => false)) break;
      s1db.close();
      const s2db = openCleanupDatabase(d2);
      updateSettings(s2db, { audiobooks: opts });
      const s2 = new AudioStage2({ db: s2db, roots, tools: TOOLS });
      s2.restart();
      for (let i = 0; i < 100; i++) if (await s2.step(() => false)) break;
      expect(s2.progress()!.healthDone).toBe(3);
      s2db.close();
      // One file changes after the dry runs.
      const t = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(torrents, 'MAM', '本2', '本2.mp3'), t, t);
      const live = freshDb();
      updateSettings(live, { audiobooks: opts });
      const a = importDryRun(live, d1);
      const b = importDryRun(live, d2);
      expect(a.hashes).toBe(2); // the two 本1 copies (same size on both sides)
      expect(b.checks).toBe(3);
      const stage = new AudioStage2({ db: live, roots, tools: TOOLS });
      stage.restart();
      for (let i = 0; i < 100; i++) if (await stage.step(() => false)) break;
      const p = stage.progress()!;
      expect(p.error).toBeNull();
      // Two checks taken over; only the changed file was checked again.
      expect(p.healthReused).toBe(2);
      expect(p.healthDone).toBe(3);
      const checked = live
        .prepare(
          `SELECT f.rel_path, h.format FROM audio_file_health h JOIN audio_files f ON f.id = h.file_id
           WHERE f.gone_at IS NULL ORDER BY f.rel_path`,
        )
        .all();
      expect(checked).toHaveLength(3);
      expect(
        live
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_files WHERE gone_at IS NULL AND sha256 IS NOT NULL`,
          )
          .get(),
      ).toEqual({ n: 2 });
    });
  });
});

// ---------------------------------------------------------------------------------------
describe('stage 0: Audiobookshelf, read only', () => {
  let server: http.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  /** A stand-in modeled on ABS v2.37.1's answers; it records every request's method. */
  async function stubAbs({ admin = true } = {}) {
    const methods: string[] = [];
    const app = express();
    app.use((req, res, next) => {
      methods.push(`${req.method} ${req.path}`);
      if (req.path !== '/status' && req.headers.authorization !== 'Bearer key-1') {
        res.sendStatus(401);
        return;
      }
      next();
    });
    app.get('/status', (_req, res) =>
      res.json({ app: 'audiobookshelf', serverVersion: '2.37.1', isInit: true }),
    );
    app.get('/api/libraries', (_req, res) =>
      res.json({
        libraries: [
          {
            id: 'lib1',
            name: 'Japanese Audiobooks',
            folders: [{ fullPath: '/audiobooks/japanese' }],
            mediaType: 'book',
            provider: 'audible.jp',
          },
        ],
      }),
    );
    app.get('/api/libraries/lib1', (_req, res) =>
      res.json({
        id: 'lib1',
        name: 'Japanese Audiobooks',
        folders: [{ fullPath: '/audiobooks/japanese' }],
        mediaType: 'book',
        provider: 'audible.jp',
        settings: { coverAspectRatio: 1, disableWatcher: false },
      }),
    );
    app.get('/api/libraries/lib1/items', (_req, res) =>
      res.json({ results: [], total: 5354, limit: 1, page: 0 }),
    );
    app.get('/api/users', (_req, res) => {
      if (!admin) {
        res.sendStatus(403);
        return;
      }
      res.json({
        users: [
          { id: 'u1', username: 'root', type: 'root' },
          { id: 'u2', username: 'basim', type: 'user' },
        ],
      });
    });
    app.get('/api/users/u1', (_req, res) =>
      res.json({ id: 'u1', username: 'root', type: 'root', mediaProgress: [] }),
    );
    app.get('/api/users/u2', (_req, res) =>
      res.json({
        id: 'u2',
        username: 'basim',
        type: 'user',
        mediaProgress: [
          {
            libraryItemId: 'i1',
            progress: 0.279,
            currentTime: 5000,
            duration: 18000,
            isFinished: false,
            lastUpdate: 1_700_000_000_000,
            displayTitle: '本1',
          },
          {
            libraryItemId: 'i2',
            progress: 1,
            currentTime: 9000,
            duration: 9000,
            isFinished: true,
            lastUpdate: 1_600_000_000_000,
            displayTitle: '本2',
          },
          {
            libraryItemId: 'gone',
            progress: 0.01,
            currentTime: 60,
            duration: 6000,
            isFinished: false,
            lastUpdate: 1_500_000_000_000,
            displayTitle: '消えた本',
          },
        ],
      }),
    );
    app.get('/api/items/i1', (_req, res) =>
      res.json({
        id: 'i1',
        libraryId: 'lib1',
        path: '/audiobooks/japanese/_Unknown/本1',
        relPath: '_Unknown/本1',
        media: { metadata: { title: '本1', authorName: '作者' } },
      }),
    );
    app.get('/api/items/i2', (_req, res) =>
      res.json({
        id: 'i2',
        libraryId: 'lib1',
        path: '/audiobooks/japanese/_Unknown/本2',
        relPath: '_Unknown/本2',
        media: { metadata: { title: '本2, "続"' } },
      }),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, methods };
  }

  it('reads libraries, counts and every user’s progress with titles and paths, only with GET', async () => {
    const { url, methods } = await stubAbs();
    const client = new AbsClient({ baseUrl: url, apiKey: 'key-1', timeoutMs: 5000 });
    const d = await takeAbsSnapshot(client, url, 1_800_000_000_000);
    expect(methods.every((m) => m.startsWith('GET '))).toBe(true);
    expect(d.serverVersion).toBe('2.37.1');
    expect(d.libraries).toEqual([
      expect.objectContaining({
        name: 'Japanese Audiobooks',
        itemCount: 5354,
        folders: ['/audiobooks/japanese'],
        settings: { coverAspectRatio: 1, disableWatcher: false },
      }),
    ]);
    expect(
      d.progress.map((p) => [p.title, p.isFinished, p.progressPercent, p.inAbs, p.relPath]),
    ).toEqual([
      ['本2, "続"', true, 100, true, '_Unknown/本2'],
      ['本1', false, 27.9, true, '_Unknown/本1'],
      ['消えた本', false, 1, false, null],
    ]);
    expect(summarize(d)).toMatchObject({
      libraries: 1,
      items: 5354,
      users: 2,
      progress: 3,
      finished: 1,
      inProgress: 2,
      notInAbs: 1,
      // Every library on its own (user, 2026-11-18); the book no longer in ABS has no library.
      perLibrary: [{ name: 'Japanese Audiobooks', items: 5354, progress: 2 }],
    });
    // A snapshot saved before perLibrary existed gets it from its data when listed.
    const db = freshDb();
    const id = saveSnapshot(db, d);
    const old = { ...summarize(d) } as Partial<ReturnType<typeof summarize>>;
    delete old.perLibrary;
    db.prepare('UPDATE abs_snapshots SET summary_json = ? WHERE id = ?').run(
      JSON.stringify(old),
      id,
    );
    expect(listSnapshots(db)[0].summary.perLibrary).toEqual([
      { name: 'Japanese Audiobooks', items: 5354, progress: 2 },
    ]);
    const csv = progressCsv(d);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(
      'basim,"本2, ""続""",,Japanese Audiobooks,/audiobooks/japanese/_Unknown/本2,yes,yes,100,2:30:00,2:30:00',
    );
    expect(csv).toContain('消えた本,,,,no,no,1,0:01:00,1:40:00');
  });

  it('says plainly when the key is wrong or not an admin’s', async () => {
    const { url } = await stubAbs({ admin: false });
    await expect(
      takeAbsSnapshot(new AbsClient({ baseUrl: url, apiKey: 'nope', timeoutMs: 5000 }), url),
    ).rejects.toThrow(/refused the API key/);
    await expect(
      takeAbsSnapshot(new AbsClient({ baseUrl: url, apiKey: 'key-1', timeoutMs: 5000 }), url),
    ).rejects.toThrow(/not an admin/);
  });

  it('a key Audiobookshelf refuses is never saved over the working one (2026-11-22)', async () => {
    const { url, methods } = await stubAbs();
    const { env, setup } = await makeCleanupEnv({ audio: {} });
    try {
      await setup();
      const request = (await import('supertest')).default;
      const auth = { Authorization: `Bearer ${env.userToken()}` };
      const put = (value: string) =>
        request(env.app).put('/api/v1/cleanup/secrets/absApiKey').set(auth).send({ value });
      await request(env.app)
        .put('/api/v1/cleanup/settings')
        .set(auth)
        .send({ audiobooks: { absUrl: url } })
        .expect(200);
      await put('key-1').expect(200);
      expect(methods).toContain('GET /api/users');
      // The 14-character value that paused stage 7: refused, the working key kept.
      const refused = await put('xxxxxxxxxx5XQ*').expect(400);
      expect(refused.body.error.code).toBe('abs_key_refused');
      expect(refused.body.error.message).toMatch(/refused this API key \(401\).*not saved/);
      expect(JSON.stringify(refused.body)).not.toContain('5XQ*');
      expect(env.service.secrets.read('absApiKey')).toBe('key-1');
      // No answer: not checked, so not saved either.
      updateSettings(env.cleanupDb, { audiobooks: { absUrl: 'http://127.0.0.1:9' } });
      const down = await put('key-2').expect(400);
      expect(down.body.error.message).toMatch(/could not be checked, so it was not saved/);
      expect(env.service.secrets.read('absApiKey')).toBe('key-1');
    } finally {
      await env.close();
    }
    // A key whose user is not an admin is refused too.
    server?.close();
    const nonAdmin = await stubAbs({ admin: false });
    const second = await makeCleanupEnv({ audio: {} });
    try {
      await second.setup();
      const request = (await import('supertest')).default;
      updateSettings(second.env.cleanupDb, { audiobooks: { absUrl: nonAdmin.url } });
      const r = await request(second.env.app)
        .put('/api/v1/cleanup/secrets/absApiKey')
        .set({ Authorization: `Bearer ${second.env.userToken()}` })
        .send({ value: 'key-1' })
        .expect(400);
      expect(r.body.error.message).toMatch(/\(403\).*not an admin/);
      expect(second.env.service.secrets.read('absApiKey')).toBeNull();
    } finally {
      await second.env.close();
    }
  });

  it('through the /cleanup/audio routes: settings, snapshot, downloads, modes and lists', async () => {
    const { url } = await stubAbs();
    const { env, setup } = await makeCleanupEnv({ audio: {} });
    try {
      await setup();
      const request = (await import('supertest')).default;
      const auth = { Authorization: `Bearer ${env.userToken()}` };
      // Before the address and key: the snapshot is refused with a plain reason.
      const refused = await request(env.app)
        .post('/api/v1/cleanup/audio/abs-snapshots')
        .set(auth)
        .expect(409);
      expect(refused.body.error.message).toMatch(/address and API key/);
      await request(env.app)
        .put('/api/v1/cleanup/settings')
        .set(auth)
        .send({ audiobooks: { absUrl: url } })
        .expect(200);
      await request(env.app)
        .put('/api/v1/cleanup/secrets/absApiKey')
        .set(auth)
        .send({ value: 'key-1' })
        .expect(200);
      await request(env.app).post('/api/v1/cleanup/audio/abs-snapshots').set(auth).expect(202);
      let status: { stage0: { latest: { id: number } | null } } | null = null;
      for (let i = 0; i < 50 && !status?.stage0.latest; i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await request(env.app).get('/api/v1/cleanup/audio/status').set(auth).expect(200))
          .body;
      }
      const id = status!.stage0.latest!.id;
      const json = await request(env.app)
        .get(`/api/v1/cleanup/audio/abs-snapshots/${id}`)
        .set(auth)
        .expect(200);
      expect(json.body.progress).toHaveLength(3);
      expect(JSON.stringify(json.body)).not.toContain('key-1');
      const file = await request(env.app)
        .get(`/api/v1/cleanup/audio/abs-snapshots/${id}.json`)
        .set(auth)
        .expect(200);
      expect(file.headers['content-disposition']).toMatch(
        /attachment; filename="audiobookshelf-snapshot-\d+\.json"/,
      );
      const csv = await request(env.app)
        .get(`/api/v1/cleanup/audio/abs-snapshots/${id}.csv`)
        .set(auth)
        .expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toContain('消えた本');
      await request(env.app)
        .get('/api/v1/cleanup/audio/abs-snapshots/99.csv')
        .set(auth)
        .expect(404);
      await request(env.app).get('/api/v1/cleanup/audio/abs-snapshots/x').set(auth).expect(404);
      // Modes: On is refused for stages 1-5 (only stage 6, WP21e-1); Preview without the folders
      // says why it waits.
      await request(env.app)
        .put('/api/v1/cleanup/audio/stages/1')
        .set(auth)
        .send({ mode: 'on' })
        .expect(409);
      const prev = await request(env.app)
        .put('/api/v1/cleanup/audio/stages/1')
        .set(auth)
        .send({ mode: 'analyse' })
        .expect(200);
      expect(prev.body.stages[1].mode).toBe('analyse');
      await env.audio!.tick();
      const st = (await request(env.app).get('/api/v1/cleanup/audio/status').set(auth).expect(200))
        .body;
      expect(st.stage1.waiting).toMatch(/not set up/);
      await request(env.app).get('/api/v1/cleanup/audio/files?list=nope').set(auth).expect(400);
      expect(
        (
          await request(env.app)
            .get('/api/v1/cleanup/audio/files?list=library_only')
            .set(auth)
            .expect(200)
        ).body,
      ).toEqual({ total: 0, items: [] });
      expect(
        (
          await request(env.app)
            .get('/api/v1/cleanup/audio/books?list=likely_copies')
            .set(auth)
            .expect(200)
        ).body.total,
      ).toBe(0);
      // The Calibre status shows the shared disk lock.
      expect(
        (await request(env.app).get('/api/v1/cleanup/status').set(auth).expect(200)).body.disk,
      ).toEqual({ holder: null, waiting: [], calibreApplying: null });
    } finally {
      await env.close();
    }
  });

  it('the client can only send GET', () => {
    const src = fs.readFileSync(path.join(SRC, 'cleanup', 'audio', 'abs-client.ts'), 'utf8');
    expect(src).toMatch(/method: 'GET'/);
    expect(src).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b|body:/);
    expect((src.match(/fetchImpl\(/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
describe('nothing in the audiobook cleanup writes under the audiobook roots', () => {
  const dir = path.join(SRC, 'cleanup', 'audio');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const WRITES =
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rmdir|rmSync|rm\(|link\(|linkSync|symlink|copyFile|cp\(|cpSync|utimes|chmod|chown|truncate|createWriteStream|futimes|lchown)\b/;

  it('only audio-source-fs touches the file system, and it has no write call', () => {
    const src = fs
      .readFileSync(path.join(dir, 'audio-source-fs.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(WRITES);
    // Files are opened for reading only.
    for (const m of src.matchAll(/fs\.open\(([^)]*)\)/g)) expect(m[1]).toMatch(/'r'|O_RDONLY/);
    expect(src).toMatch(/createReadStream\(file, \{ flags: 'r'/);
    for (const f of files) {
      if (f === 'audio-source-fs.ts' || f === 'dry-run.ts') continue;
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(s, f).not.toMatch(/from 'fs'|from 'fs\/promises'|require\('fs'\)/);
      // Code only: WP21e-2's switch names the sidecar's operations ('rename', …) in strings.
      const code = s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''")
        .replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(WRITES);
    }
  });

  it('probe.ts is the only module that starts a process, and only ffprobe, ffmpeg, fpcalc or faad', () => {
    const src = fs.readFileSync(path.join(dir, 'probe.ts'), 'utf8');
    expect(src.match(/\bspawn\(/g)).toHaveLength(1);
    expect(src).toMatch(/spawn\(bin, args,/);
    // Every program start: run(...) and, for fpcalc's stdin pipe (WP21b), start(...).
    const calls = [...src.matchAll(/(?:await run|= start)\(\s*([^,]+),/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    // WP21b adds fpcalc (Chromaprint) and faad (faad2) for stage 3.
    for (const c of calls) {
      expect(c).toMatch(/^tools\.(ffprobePath|ffmpegPath|fpcalcPath|faadPath)$/);
    }
    // No other call of run() or start() than those checked above.
    const all = (src.match(/\b(?:run|start)\(/g) ?? []).length;
    const defs = (src.match(/function (?:run|start)\(/g) ?? []).length;
    const inside = (src.match(/return start\(bin, args, fd, timeoutMs, opts\)/g) ?? []).length;
    expect(all - defs - inside).toBe(calls.length);
    for (const f of files) {
      if (f === 'probe.ts') continue;
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/child_process/);
    }
  });

  it('the dry run writes only into its own --out folder', () => {
    const src = fs.readFileSync(path.join(dir, 'dry-run.ts'), 'utf8');
    const writes = src.match(/writeFileSync\(/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(src.match(/writeFileSync\(\s*path\.join\(out,/g) ?? []).toHaveLength(writes.length);
    expect(src).toMatch(/mkdirSync\(out,/);
    expect(src).toMatch(/inside one of the audiobook folders/);
  });

  it('no module outside the audiobook cleanup reads the roots through audio-source-fs', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          p.endsWith('.ts') &&
          !p.startsWith(dir) &&
          /audio-source-fs/.test(fs.readFileSync(p, 'utf8'))
        )
          offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
