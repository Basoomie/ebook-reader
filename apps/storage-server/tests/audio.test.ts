/**
 * WP15a: the audiobook and subtitle index, the matcher, durations from file
 * headers, and streaming. The audiobooks folder is read-only to this app: every
 * scan and stream below is checked to leave it byte-identical.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { getScanState, listAudioFolders, listSubtitleFiles } from '../src/audio/audio-index';
import { resolveInsideAudio } from '../src/audio/audio-fs';
import {
  entryKeys,
  extractVolume,
  parseAbsSeries,
  rankEntries,
  stripAudioName,
  type NamedEntry,
} from '../src/audio/match';
import { audioDuration } from '../src/audio/media-duration';
import { parseRange } from '../src/audio/routes';
import { AudioScanService, checkAudioConfig } from '../src/audio/scan-service';
import { normalizeRelativeDir } from '../src/calibre/libraries';
import { DEFAULT_AUDIO, parseAudioConfig } from '../src/config';
import { CalibreRoot, fingerprint } from './helpers/calibre-fixture';
import { IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { audioEnv as audioEnv0, m4b, mp3, reader, write } from './helpers/audio-fixtures';

// ---------------------------------------------------------------- matcher

describe('names and volumes', () => {
  it('strips what the audiobook tools add', () => {
    expect(stripAudioName('Vol 2 - スパイ教室02 《愛娘》のグレーテ')).toBe(
      'スパイ教室02 《愛娘》のグレーテ',
    );
    expect(stripAudioName('Bonus 1 - スパイ教室 短編集01 花嫁ロワイヤル_ (KADOKAWA)')).toBe(
      'スパイ教室 短編集01 花嫁ロワイヤル',
    );
    expect(stripAudioName('[02] スパイ教室02 《愛娘》のグレーテ [B0DNRYZJN7]')).toBe(
      'スパイ教室02 《愛娘》のグレーテ',
    );
    expect(stripAudioName('[3巻] タイトル 3')).toBe('タイトル 3');
    expect(stripAudioName('05 - 神々の山嶺 上')).toBe('神々の山嶺 上');
    expect(stripAudioName('魔法の色を知っているか？ Ｗｈａｔ Ｃｏｌｏｒ')).toBe(
      '魔法の色を知っているか? What Color',
    );
  });

  it('finds the volume number', () => {
    expect(extractVolume('Vol 3 - スパイ教室03 《忘我》のアネット')).toBe(3);
    expect(extractVolume('[3巻] タイトル 3')).toBe(3);
    expect(extractVolume('とある物語 第12巻')).toBe(12);
    expect(extractVolume('陰の実力者になりたくて！ ０２')).toBe(2);
    expect(extractVolume('マジカル★エクスプローラー 生きる12_ (KADOKAWA)')).toBe(12);
    expect(extractVolume('[上巻] 神々の山嶺 上')).toBe(1);
    expect(extractVolume('神々の山嶺 下')).toBeNull();
    expect(extractVolume('むらさきのスカートの女')).toBeNull();
  });

  it('reads both shapes of the ABS series field', () => {
    expect(parseAbsSeries(['スパイ教室 #2'])).toEqual({ name: 'スパイ教室', sequence: '2' });
    expect(parseAbsSeries([{ name: 'X', sequence: '1.5' }])).toEqual({
      name: 'X',
      sequence: '1.5',
    });
    expect(parseAbsSeries(['No number'])).toEqual({ name: 'No number', sequence: null });
    expect(parseAbsSeries([])).toBeNull();
  });
});

function entry(name: string, extra: Partial<NamedEntry & { fileCount: number }> = {}) {
  return {
    name,
    parentName: null,
    ...entryKeys(name),
    volume: extractVolume(name),
    fileCount: 1,
    ...extra,
  };
}

describe('rankEntries', () => {
  const spy1 = entry('Vol 1 - スパイ教室01 《花園》のリリィ', {
    parentName: 'スパイ教室',
    metaTitle: 'スパイ教室',
    metaSeries: 'スパイ教室',
    volume: 1,
  });
  const spy2 = entry('Vol 2 - スパイ教室02 《愛娘》のグレーテ', {
    parentName: 'スパイ教室',
    metaTitle: 'スパイ教室',
    metaSeries: 'スパイ教室',
    volume: 2,
  });
  const kakuriyo = entry('かくりよの宿飯 あやかしお宿に嫁入りします。_ (KADOKAWA)');
  const kage2 = entry('陰の実力者になりたくて! 02_ (KADOKAWA)');
  const kage1 = entry('陰の実力者になりたくて! 01_ (KADOKAWA)');
  const all = [spy1, spy2, kakuriyo, kage2, kage1];

  it('puts the exact title first and never offers another volume above it', () => {
    const r = rankEntries(
      { title: 'スパイ教室02 《愛娘》のグレーテ', seriesName: 'スパイ教室', seriesIndex: 2 },
      all,
    );
    expect(r[0]).toMatchObject({ entry: spy2, tier: 'exact', score: 100 });
    expect(r.map((x) => x.entry)).not.toContain(spy1);
  });

  it('matches full-width and half-width forms of the old-sync books', () => {
    expect(
      rankEntries(
        {
          title: 'かくりよの宿飯　あやかしお宿に嫁入りします。',
          seriesName: null,
          seriesIndex: null,
        },
        all,
      )[0],
    ).toMatchObject({ entry: kakuriyo, tier: 'exact' });
    const kage = rankEntries(
      {
        title: '陰の実力者になりたくて！ ０２',
        seriesName: '陰の実力者になりたくて！',
        seriesIndex: 2,
      },
      all,
    );
    expect(kage[0]).toMatchObject({ entry: kage2, tier: 'exact' });
    // Volume 1 is shown only below, as "another volume".
    expect(kage.find((x) => x.entry === kage1)?.tier ?? 'other-volume').toBe('other-volume');
  });

  it('falls back to the series and its number when the titles differ', () => {
    const r = rankEntries(
      { title: '《愛娘》のグレーテ', seriesName: 'スパイ教室', seriesIndex: 2 },
      [spy1, spy2],
    );
    expect(r[0]).toMatchObject({ entry: spy2 });
    expect(r.map((x) => x.entry)).not.toContain(spy1);
  });

  it('ranks single-file folders before split ones at the same score', () => {
    const split = entry('かくりよの宿飯 あやかしお宿に嫁入りします。', { fileCount: 3 });
    const r = rankEntries(
      { title: 'かくりよの宿飯 あやかしお宿に嫁入りします。', seriesName: null, seriesIndex: null },
      [split, kakuriyo],
    );
    expect(r.map((x) => x.entry)).toEqual([kakuriyo, split]);
  });

  it('suggests nothing for an unrelated title', () => {
    expect(
      rankEntries({ title: 'むらさきのスカートの女', seriesName: null, seriesIndex: null }, all),
    ).toEqual([]);
  });

  it('reads the colon substitute and the Special prefix seen on the NAS (dry run 2026-11-11)', () => {
    const colon = String.fromCharCode(0xa789);
    expect(
      stripAudioName(`Vol 2 - クビシメロマンチスト 人間失格・零崎人識${colon} (講談社文庫)`),
    ).toBe('クビシメロマンチスト 人間失格・零崎人識: (講談社文庫)');
    expect(
      stripAudioName('Special 1 - この素晴らしい世界に祝福を！ オーディオブック特別短編集1'),
    ).toBe('この素晴らしい世界に祝福を! オーディオブック特別短編集1');
    const kubishime = entry(`クビシメロマンチスト 人間失格・零崎人識${colon} (講談社文庫)`);
    expect(
      rankEntries(
        { title: 'クビシメロマンチスト 人間失格・零崎人識', seriesName: null, seriesIndex: null },
        [kubishime],
      )[0]?.tier,
    ).toBe('loose');
  });
});

// ---------------------------------------------------------------- durations

describe('audioDuration', () => {
  it('reads m4b durations with the movie header first or last, versions 0 and 1', async () => {
    expect(await audioDuration(reader(m4b(36_000)), '.m4b')).toBe(36_000);
    expect(await audioDuration(reader(m4b(34_200.5, { moovAtEnd: true })), '.m4b')).toBe(34_200.5);
    expect(await audioDuration(reader(m4b(40_000, { version: 1 })), '.m4a')).toBe(40_000);
  });

  it('reads mp3 durations from Xing, VBRI or the bitrate', async () => {
    expect(await audioDuration(reader(mp3({ xingFrames: 38_281 })), '.mp3')).toBeCloseTo(1000, 0);
    expect(await audioDuration(reader(mp3({ vbriFrames: 3828 })), '.mp3')).toBeCloseTo(100, 0);
    // Constant bitrate 128 kbps: 128,000 bytes ≈ 8 s.
    expect(await audioDuration(reader(mp3({ bytes: 128_000 })), '.mp3')).toBeCloseTo(8, 0);
    expect(await audioDuration(reader(mp3({ xingFrames: 38_281, tag: 5000 })), '.mp3')).toBeCloseTo(
      1000,
      0,
    );
  });

  it('returns null for anything it cannot understand', async () => {
    expect(await audioDuration(reader(Buffer.from('not audio')), '.mp3')).toBeNull();
    expect(await audioDuration(reader(Buffer.from('not audio at all, really')), '.m4b')).toBeNull();
    expect(await audioDuration(reader(Buffer.alloc(0)), '.m4b')).toBeNull();
    expect(await audioDuration(reader(m4b(10)), '.ogg')).toBeNull();
  });
});

describe('parseRange', () => {
  it('serves single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('settings', () => {
  it('reads the audio settings with safe defaults', () => {
    expect(parseAudioConfig({}, [])).toEqual({ dir: null, ...DEFAULT_AUDIO });
    const warnings: string[] = [];
    const c = parseAudioConfig(
      { AUDIOBOOKS_DIR: '/audiobooks', AUDIO_SCAN_HOURS: 'often' },
      warnings,
    );
    expect(c.dir).toBe(path.resolve('/audiobooks'));
    expect(c.scanHours).toBe(DEFAULT_AUDIO.scanHours);
    expect(warnings).toHaveLength(1);
  });

  it('reads the WP15f merge settings and warns about the old read-only switch', () => {
    const warnings: string[] = [];
    const c = parseAudioConfig(
      {
        AUDIOBOOKS_REQUIRE_READONLY: 'true',
        AUDIOBOOKS_FILE_UID: '99',
        AUDIOBOOKS_FILE_GID: '100',
        AUDIOBOOKS_FILE_MODE: '0666',
        AUDIO_MERGE_BITRATE: '96K',
        AUDIO_MERGE_MIN_FREE_MB: '500',
        AUDIO_MERGE_STALL_MINUTES: '5',
        AUDIO_COPY_HINT_MIN_MINUTES: '30',
        AUDIO_COPY_HINT_PERCENT: '5',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
      },
      warnings,
    );
    expect(warnings).toEqual([
      expect.stringMatching(/AUDIOBOOKS_REQUIRE_READONLY .*no longer used/),
    ]);
    expect(c.merge).toEqual({
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: 'ffprobe',
      bitrate: '96k',
      minFreeMb: 500,
      stallMinutes: 5,
      fileUid: 99,
      fileGid: 100,
      fileMode: 0o666,
    });
    expect(c.copyHintMinMinutes).toBe(30);
    expect(c.copyHintPercent).toBe(5);

    const bad: string[] = [];
    const d = parseAudioConfig(
      { AUDIOBOOKS_FILE_UID: 'nobody', AUDIOBOOKS_FILE_MODE: 'rw', AUDIO_MERGE_BITRATE: 'loud' },
      bad,
    );
    expect(bad).toHaveLength(3);
    expect(d.merge).toMatchObject({ fileUid: null, fileMode: null, bitrate: '128k' });
  });

  it('accepts only folders inside the audiobooks root', () => {
    expect(normalizeRelativeDir('japanese')).toBe('japanese');
    expect(normalizeRelativeDir('/japanese-srt/')).toBe('japanese-srt');
    expect(normalizeRelativeDir('a\\b')).toBe('a/b');
    expect(normalizeRelativeDir('none')).toBeNull();
    expect(normalizeRelativeDir('')).toBeNull();
    expect(() => normalizeRelativeDir('../etc')).toThrow();
    expect(() => normalizeRelativeDir('C:/x')).toThrow();
    expect(() => resolveInsideAudio('/audiobooks', 'a/../../etc')).toThrow();
  });

  it('accepts a writable folder (WP15f) and refuses an overlapping one', async () => {
    const dir = makeTempDir('ab-check');
    const base = { ...DEFAULT_AUDIO, dir };
    expect(await checkAudioConfig(base, [])).toBeNull();
    expect(
      await checkAudioConfig(base, [{ name: 'DATA_DIR', dir: path.join(dir, 'data') }]),
    ).toMatch(/overlap/);
    expect(await checkAudioConfig({ ...base, dir: path.join(dir, 'nope') }, [])).toMatch(
      /does not exist/,
    );
  });
});

// ---------------------------------------------------------------- scan and API

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const audioEnv = () => audioEnv0({ envs, services });

describe('scan', () => {
  it('indexes folders that hold audio, skips _Archives and dot folders, and measures durations', async () => {
    const { e, root, libId, before } = await audioEnv();
    const folders = listAudioFolders(e.db, libId);
    expect(folders.map((f) => f.relPath)).toEqual([
      'japanese/_Unknown/かくりよの宿飯 あやかしお宿に嫁入りします。_ (KADOKAWA)',
      'japanese/_Unknown/グイン・サーガ',
      'japanese/_Unknown/スパイ教室/Vol 1 - スパイ教室01 《花園》のリリィ',
      'japanese/_Unknown/スパイ教室/Vol 2 - スパイ教室02 《愛娘》のグレーテ',
      'japanese/_Unknown/神々の山嶺/Vol 1 - 神々の山嶺 上',
      'japanese/_Unknown/神々の山嶺/Vol 2 - 神々の山嶺 下',
    ]);
    const spy2 = folders.find((f) => f.name.startsWith('Vol 2 - スパイ'))!;
    expect(spy2).toMatchObject({
      parentName: 'スパイ教室',
      volume: 2,
      metaTitle: 'スパイ教室',
      metaSeries: 'スパイ教室',
      metaSequence: '2',
      asin: 'B0DNRYZJN7',
      fileCount: 1,
      durationSeconds: 34_200.5,
    });
    const guin = folders.find((f) => f.name === 'グイン・サーガ')!;
    expect(guin.fileCount).toBe(3);
    // One file can't be read, so the folder has no total duration (shown as unknown).
    expect(guin.durationSeconds).toBeNull();
    expect(guin.files[2]).toMatchObject({
      name: '03.mp3',
      durationSeconds: null,
      durationFailed: true,
    });
    expect(guin.files[0].durationSeconds).toBeCloseTo(1000, 0);

    const subs = listSubtitleFiles(e.db, libId);
    expect(subs.map((s) => s.relPath)).toEqual([
      'japanese-srt/Part 1/[1巻] スパイ教室01 《花園》のリリィ.srt',
      'japanese-srt/Part 1/[2巻] スパイ教室02 《愛娘》のグレーテ.srt',
      'japanese-srt/older subs/05 - 神々の山嶺 上.vtt',
      'japanese-srt/subs-new/かくりよの宿飯 あやかしお宿に嫁入りします。.srt',
    ]);
    expect(getScanState(e.db, libId)).toMatchObject({
      status: 'idle',
      folders: 6,
      subtitles: 4,
      archivesSkipped: 1,
    });
    expect(fingerprint(root)).toEqual(before);
  });

  it('marks what disappeared as missing, keeps the rest, and never marks everything missing', async () => {
    const { e, root, service, libId } = await audioEnv();
    fs.rmSync(path.join(root, 'japanese/_Unknown/神々の山嶺/Vol 2 - 神々の山嶺 下'), {
      recursive: true,
    });
    const lib = service.libraries()[0];
    await service.scanLibrary(lib);
    expect(listAudioFolders(e.db, libId)).toHaveLength(5);
    const all = listAudioFolders(e.db, libId, { includeMissing: true });
    expect(all.filter((f) => f.missingAt !== null).map((f) => f.name)).toEqual([
      'Vol 2 - 神々の山嶺 下',
    ]);
    // It comes back when it is there again.
    write(root, 'japanese/_Unknown/神々の山嶺/Vol 2 - 神々の山嶺 下/a.m4b', m4b(52_000));
    await service.scanLibrary(lib);
    expect(listAudioFolders(e.db, libId)).toHaveLength(6);

    // An emptied folder (e.g. the share not mounted) is an error, not 6 missing audiobooks.
    fs.rmSync(path.join(root, 'japanese'), { recursive: true });
    fs.mkdirSync(path.join(root, 'japanese'));
    await service.scanLibrary(service.libraries()[0]);
    expect(getScanState(e.db, libId)).toMatchObject({ status: 'error' });
    expect(getScanState(e.db, libId).lastError).toMatch(/No audiobooks found/);
    expect(listAudioFolders(e.db, libId)).toHaveLength(6);
  });

  it('keeps measured durations across rescans', async () => {
    const { e, service, libId } = await audioEnv();
    await service.scanLibrary(service.libraries()[0]);
    const spy = listAudioFolders(e.db, libId).find((f) => f.name.startsWith('Vol 1 - スパイ'))!;
    expect(spy.durationSeconds).toBe(36_000);
    expect(await service.measureDurations(service.libraries()[0])).toBe(0);
  });
});

describe('audio API', () => {
  it('reports the index and takes scan requests', async () => {
    const { e, auth, libId, service } = await audioEnv();
    const status = await request(e.app).get('/api/v1/audio/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, error: null });
    expect(status.body.libraries[0]).toMatchObject({
      id: libId,
      audioDir: 'japanese',
      subtitleDir: 'japanese-srt',
      folders: 6,
      subtitles: 4,
      durationsPending: 0,
    });
    const scan = await request(e.app).post('/api/v1/audio/scan').set(auth).send({});
    expect(scan.status).toBe(202);
    await service.idle();
    expect(getScanState(e.db, libId).scanRequestedAt).toBeNull();
    expect((await request(e.app).get('/api/v1/audio/status')).status).toBe(401);
  });

  it('suggests ranked audiobooks and subtitles for a book, and never links it', async () => {
    const { e, auth, bookId } = await audioEnv();
    const res = await request(e.app)
      .get(`/api/v1/books/${bookId('スパイ教室02 《愛娘》のグレーテ')}/audio/candidates`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.libraryHasAudio).toBe(true);
    expect(res.body.audio[0]).toMatchObject({
      name: 'Vol 2 - スパイ教室02 《愛娘》のグレーテ',
      tier: 'exact',
      fileCount: 1,
      playable: true,
      durationSeconds: 34_200.5,
    });
    expect(res.body.audio.map((a: { name: string }) => a.name)).not.toContain(
      'Vol 1 - スパイ教室01 《花園》のリリィ',
    );
    expect(res.body.subtitles[0]).toMatchObject({
      name: '[2巻] スパイ教室02 《愛娘》のグレーテ.srt',
    });

    const split = await request(e.app)
      .get(`/api/v1/books/${bookId('グイン・サーガ')}/audio/candidates`)
      .set(auth);
    expect(split.body.audio[0]).toMatchObject({
      name: 'グイン・サーガ',
      fileCount: 3,
      playable: false,
    });

    const none = await request(e.app)
      .get(`/api/v1/books/${bookId('むらさきのスカートの女')}/audio/candidates`)
      .set(auth);
    expect(none.body.audio).toEqual([]);
  });

  it('searches the whole index', async () => {
    const { e, auth } = await audioEnv();
    const audio = await request(e.app).get('/api/v1/audio/search').query({ q: '山嶺' }).set(auth);
    expect(audio.body.audio.map((a: { name: string }) => a.name)).toEqual([
      'Vol 1 - 神々の山嶺 上',
      'Vol 2 - 神々の山嶺 下',
    ]);
    const bySeries = await request(e.app)
      .get('/api/v1/audio/search')
      .query({ q: 'すぱい' })
      .set(auth);
    expect(bySeries.body.audio).toEqual([]);
    const subs = await request(e.app)
      .get('/api/v1/audio/search')
      .query({ q: 'かくりよ', kind: 'subtitle' })
      .set(auth);
    expect(subs.body.subtitles).toHaveLength(1);
  });

  it('streams with ranges through a signed URL, and leaves the folder untouched', async () => {
    const { e, root, auth, libId, before } = await audioEnv();
    const folder = listAudioFolders(e.db, libId).find((f) => f.name.startsWith('Vol 2 - スパイ'))!;
    const detail = await request(e.app).get(`/api/v1/audio/folders/${folder.id}`).set(auth);
    expect(detail.status).toBe(200);
    const url: string = detail.body.files[0].url;
    const bytes = fs.readFileSync(
      path.join(root, ...folder.relPath.split('/'), folder.files[0].name),
    );

    const full = await request(e.app).get(url);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(full.body).equals(bytes)).toBe(true);
    expect(full.headers['content-disposition']).toBeUndefined();

    // The book page's Download menu: same signed URL, saved as a file.
    const saved = await request(e.app).get(`${url}&download=1`);
    expect(saved.status).toBe(200);
    expect(saved.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(folder.files[0].name)}`,
    );
    expect(Buffer.from(saved.body).equals(bytes)).toBe(true);

    const part = await request(e.app).get(url).set('Range', 'bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${bytes.length}`);
    expect(Buffer.from(part.body).equals(bytes.subarray(10, 20))).toBe(true);

    const tail = await request(e.app).get(url).set('Range', `bytes=${bytes.length}-`);
    expect(tail.status).toBe(416);
    expect(tail.headers['content-range']).toBe(`bytes */${bytes.length}`);

    const head = await request(e.app).head(url);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(bytes.length));

    expect(
      (await request(e.app).get(url.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAA'))).status,
    ).toBe(401);
    expect((await request(e.app).get(`/api/v1/audio/files/${folder.id}/0`)).status).toBe(401);
    expect((await request(e.app).get(`/api/v1/audio/files/${folder.id}/0`).set(auth)).status).toBe(
      200,
    );
    expect((await request(e.app).get(`/api/v1/audio/files/${folder.id}/5`).set(auth)).status).toBe(
      404,
    );
    expect(fingerprint(root)).toEqual(before);
  });

  it('refuses an old URL once the file changed, and a folder that went missing', async () => {
    const { e, root, auth, libId, service } = await audioEnv();
    const folder = listAudioFolders(e.db, libId).find((f) => f.name.startsWith('Vol 1 - 神々'))!;
    const url = (await request(e.app).get(`/api/v1/audio/folders/${folder.id}`).set(auth)).body
      .files[0].url;
    const file = path.join(root, ...folder.relPath.split('/'), folder.files[0].name);
    fs.writeFileSync(file, m4b(50_001, { mdatBytes: 4096 }));
    expect((await request(e.app).get(url)).status).toBe(409);

    fs.rmSync(path.dirname(file), { recursive: true });
    await service.scanLibrary(service.libraries()[0]);
    expect((await request(e.app).get(`/api/v1/audio/files/${folder.id}/0`).set(auth)).status).toBe(
      410,
    );
  });

  it('answers 503 when audio linking is off', async () => {
    const calibre = new CalibreRoot();
    calibre.library('a');
    const e = makeIndexerEnv(calibre.dir);
    envs.push(e);
    const auth = { Authorization: `Bearer ${e.token()}` };
    const res = await request(e.app).get('/api/v1/audio/search').query({ q: 'x' }).set(auth);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('audio_off');
    const status = await request(e.app).get('/api/v1/audio/status').set(auth);
    expect(status.body).toMatchObject({ enabled: false, error: 'AUDIOBOOKS_DIR is not set' });
  });
});
