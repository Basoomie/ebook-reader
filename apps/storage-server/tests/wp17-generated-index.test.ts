/**
 * WP17: migration 15 keeps the WP16 jobs, and the scanner indexes `<audio folder>-generated/`
 * (audio and the subtitles next to it) without weakening the empty-scan guard.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AudioScanService } from '../src/audio/scan-service';
import { migrate, MIGRATIONS } from '../src/db/migrations';
import { audioEnv, m4b, write } from './helpers/audio-fixtures';
import type { IndexerEnv } from './helpers/indexer-env';

const track: { envs: IndexerEnv[]; services: AudioScanService[] } = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

describe('migration 15', () => {
  it('rebuilds worker_jobs for the new kinds and keeps every WP16 job', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((m) => m.version <= 14)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'me', 1)").run();
    db.prepare(
      `INSERT INTO worker_jobs (user_id, book_id, kind, library_id, audio_folder_rel_path,
         audio_file_name, link_confirmed_at, state, stage, progress, attempts, output_rel_path,
         linked, created_at, updated_at)
       VALUES ('u1', 'b1', 'sync_subtitles', 'l1', 'japanese/x', 'x.m4b', 5, 'done', NULL, 1, 1,
         'japanese-srt/_generated/x.srt', 1, 10, 20)`,
    ).run();
    expect(migrate(db)).toBe(15);
    const row = db.prepare('SELECT * FROM worker_jobs').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: 'sync_subtitles',
      audio_file_name: 'x.m4b',
      output_rel_path: 'japanese-srt/_generated/x.srt',
      linked: 1,
      chapters_done: 0,
      params: null,
    });
    // A voice sample has no book; a subtitle job still needs its audio.
    db.prepare(
      `INSERT INTO worker_jobs (user_id, kind, state, created_at, updated_at)
       VALUES ('u1', 'voice_sample', 'queued', 1, 1)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO worker_jobs (user_id, book_id, kind, state, created_at, updated_at)
           VALUES ('u1', 'b2', 'sync_subtitles', 'queued', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM tts_models WHERE removed_at IS NULL').get() as {
          n: number;
        }
      ).n,
    ).toBe(4);
    db.close();
  });
});

describe('generated audiobooks in the index', () => {
  it('indexes japanese-generated with its subtitles, labels them, and keeps the empty-scan guard', async () => {
    const env = await audioEnv(track);
    write(env.root, 'japanese-generated/作者/本/本.m4b', m4b(100));
    write(env.root, 'japanese-generated/作者/本/本.srt', '1\n00:00:00,000 --> 00:00:01,000\n本\n');
    const lib = env.service.libraries()[0];
    await env.service.scanLibrary(lib);
    const search = async (q: string, kind = 'audio') =>
      (
        await request(env.e.app)
          .get(`/api/v1/audio/search?q=${encodeURIComponent(q)}&kind=${kind}`)
          .set(env.auth)
      ).body;
    expect((await search('本')).audio).toEqual([
      expect.objectContaining({
        relPath: 'japanese-generated/作者/本',
        generated: true,
        parentName: '作者',
      }),
    ]);
    expect((await search('本', 'subtitle')).subtitles).toEqual([
      expect.objectContaining({ relPath: 'japanese-generated/作者/本/本.srt', generated: true }),
    ]);
    expect((await search('スパイ')).audio.every((f: { generated: boolean }) => !f.generated)).toBe(
      true,
    );

    // The audio folder empties (an unmounted share): the scan refuses and marks nothing
    // missing, although the generated folder still has an audiobook.
    fs.rmSync(path.join(env.root, 'japanese'), { recursive: true, force: true });
    fs.mkdirSync(path.join(env.root, 'japanese'));
    await env.service.scanLibrary(lib);
    const status = (await request(env.e.app).get('/api/v1/audio/status').set(env.auth)).body;
    expect(JSON.stringify(status)).toMatch(/No audiobooks found in japanese/);
    const missing = env.e.db
      .prepare('SELECT COUNT(*) AS n FROM audio_folders WHERE missing_at IS NOT NULL')
      .get() as { n: number };
    expect(missing.n).toBe(0);

    // A generated folder that goes away is marked missing on the next good scan.
    write(env.root, 'japanese/_Unknown/x/x.m4b', m4b(10));
    fs.rmSync(path.join(env.root, 'japanese-generated'), { recursive: true, force: true });
    await env.service.scanLibrary(lib);
    const gen = env.e.db
      .prepare("SELECT missing_at FROM audio_folders WHERE rel_path = 'japanese-generated/作者/本'")
      .get() as { missing_at: number | null };
    expect(gen.missing_at).not.toBeNull();
  });
});
