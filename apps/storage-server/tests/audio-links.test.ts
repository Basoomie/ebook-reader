/**
 * WP15b: audio links. The user's confirmed audiobook folder and subtitle file for a
 * book, stored by path; never linked automatically, never relinked when a folder
 * disappears. The audiobooks folder stays byte-identical throughout.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAudioFolderByPath,
  listAudioFolders,
  listSubtitleFiles,
} from '../src/audio/audio-index';
import { listLinks } from '../src/audio/audio-links';
import type { AudioScanService } from '../src/audio/scan-service';
import { createToken } from '../src/db/tokens';
import { audioEnv as audioEnv0, m4b, write } from './helpers/audio-fixtures';
import { fingerprint } from './helpers/calibre-fixture';
import type { IndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const SPY2 = 'スパイ教室02 《愛娘》のグレーテ';
const KAKURIYO = 'かくりよの宿飯　あやかしお宿に嫁入りします。';
const GUIN = 'グイン・サーガ';

async function linkEnv() {
  const env = await audioEnv0({ envs, services });
  const { e, libId } = env;
  const folder = (prefix: string) => {
    const f = listAudioFolders(e.db, libId).find((x) => x.name.startsWith(prefix));
    if (!f) throw new Error(`no folder ${prefix}`);
    return f;
  };
  const subtitle = (fragment: string) => {
    const s = listSubtitleFiles(e.db, libId).find((x) => x.relPath.includes(fragment));
    if (!s) throw new Error(`no subtitle ${fragment}`);
    return s;
  };
  const url = (title: string) => `/api/v1/books/${env.bookId(title)}/audio-link`;
  const put = (title: string, body: unknown, auth = env.auth) =>
    request(e.app)
      .put(url(title))
      .set(auth)
      .send(body as object);
  const get = (title: string, auth = env.auth) => request(e.app).get(url(title)).set(auth);
  return { ...env, folder, subtitle, url, put, get };
}

describe('audio links', () => {
  it('links a folder only when asked, then asks for subtitles separately', async () => {
    const t = await linkEnv();
    // Nothing is linked by scanning or by asking for suggestions.
    await request(t.e.app)
      .get(`/api/v1/books/${t.bookId(SPY2)}/audio/candidates`)
      .set(t.auth);
    expect((await t.get(SPY2)).body).toEqual({ link: null });

    const spy = t.folder('Vol 2 - スパイ');
    const res = await t.put(SPY2, { audio: { state: 'linked', folderId: spy.id } });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({
      bookId: t.bookId(SPY2),
      state: 'linked',
      folderRelPath: spy.relPath,
      fileName: spy.files[0].name,
      status: 'ok',
      subtitleState: null,
      subtitleRelPath: null,
      subtitle: null,
      source: 'library',
      folder: { id: spy.id, name: spy.name, fileCount: 1, playable: true, missing: false },
    });
    expect(res.body.link.confirmedAt).toEqual(expect.any(Number));

    const sub = t.subtitle('[2巻]');
    const withSub = await t.put(SPY2, { subtitle: { state: 'linked', subtitleId: sub.id } });
    expect(withSub.body.link).toMatchObject({
      folderRelPath: spy.relPath,
      subtitleState: 'linked',
      subtitleRelPath: sub.relPath,
      subtitleStatus: 'ok',
      subtitle: { id: sub.id, name: sub.name },
    });
    expect((await t.get(SPY2)).body.link).toMatchObject({ subtitleRelPath: sub.relPath });

    // "No subtitles", then back to "not chosen yet".
    expect((await t.put(SPY2, { subtitle: { state: 'none' } })).body.link).toMatchObject({
      subtitleState: 'none',
      subtitleRelPath: null,
    });
    expect((await t.put(SPY2, { subtitle: { state: null } })).body.link).toMatchObject({
      subtitleState: null,
    });
    expect(fingerprint(t.root)).toEqual(t.before);
  });

  it('asks for subtitles again when the audiobook changes, but not when it is the same', async () => {
    const t = await linkEnv();
    const spy2 = t.folder('Vol 2 - スパイ');
    const spy1 = t.folder('Vol 1 - スパイ');
    const sub = t.subtitle('[2巻]');
    await t.put(SPY2, {
      audio: { state: 'linked', folderId: spy2.id },
      subtitle: { state: 'linked', subtitleId: sub.id },
    });
    const same = await t.put(SPY2, { audio: { state: 'linked', folderId: spy2.id } });
    expect(same.body.link).toMatchObject({ subtitleState: 'linked', subtitleRelPath: sub.relPath });
    const other = await t.put(SPY2, { audio: { state: 'linked', folderId: spy1.id } });
    expect(other.body.link).toMatchObject({
      folderRelPath: spy1.relPath,
      subtitleState: null,
      subtitleRelPath: null,
    });
  });

  it('"No audiobook" stops suggestions until removed; DELETE brings them back', async () => {
    const t = await linkEnv();
    const kakuriyo = t.folder('かくりよ');
    await t.put(KAKURIYO, { audio: { state: 'linked', folderId: kakuriyo.id } });
    const none = await t.put(KAKURIYO, { audio: { state: 'none' } });
    expect(none.body.link).toMatchObject({
      state: 'none',
      folderRelPath: null,
      fileName: null,
      folder: null,
      status: null,
      subtitleState: null,
    });
    // Subtitles need an audiobook.
    const sub = t.subtitle('かくりよ');
    const refused = await t.put(KAKURIYO, { subtitle: { state: 'linked', subtitleId: sub.id } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('no_audiobook');

    const del = await request(t.e.app).delete(t.url(KAKURIYO)).set(t.auth);
    expect(del.status).toBe(204);
    expect((await t.get(KAKURIYO)).body).toEqual({ link: null });
    // Deleting again is fine.
    expect((await request(t.e.app).delete(t.url(KAKURIYO)).set(t.auth)).status).toBe(204);
  });

  it('refuses bad requests and unknown things', async () => {
    const t = await linkEnv();
    const code = async (title: string, body: unknown) => {
      const r = await t.put(title, body);
      return [r.status, r.body.error?.code];
    };
    expect(await code(SPY2, {})).toEqual([400, 'invalid_body']);
    expect(await code(SPY2, { audio: { state: 'maybe' } })).toEqual([400, 'invalid_body']);
    expect(await code(SPY2, { audio: { state: 'linked', folderId: 'x' } })).toEqual([
      400,
      'invalid_body',
    ]);
    expect(await code(SPY2, { audio: { state: 'linked', folderId: 99999 } })).toEqual([
      404,
      'not_found',
    ]);
    expect(await code(SPY2, { subtitle: { state: 'none' } })).toEqual([400, 'no_audiobook']);
    const spy = t.folder('Vol 2 - スパイ');
    await t.put(SPY2, { audio: { state: 'linked', folderId: spy.id } });
    expect(await code(SPY2, { subtitle: { state: 'linked', subtitleId: 99999 } })).toEqual([
      404,
      'not_found',
    ]);
    expect(await code(SPY2, { subtitle: { state: 'sometimes' } })).toEqual([400, 'invalid_body']);

    const unknown = '/api/v1/books/no-such-book/audio-link';
    expect((await request(t.e.app).get(unknown).set(t.auth)).status).toBe(404);
    expect((await request(t.e.app).put(unknown).set(t.auth).send({})).status).toBe(404);
    expect((await request(t.e.app).delete(unknown).set(t.auth)).status).toBe(404);
    expect((await request(t.e.app).get(t.url(SPY2))).status).toBe(401);
  });

  it('links a folder of several files, which says it is not playable', async () => {
    const t = await linkEnv();
    const guin = t.folder(GUIN);
    const res = await t.put(GUIN, { audio: { state: 'linked', folderId: guin.id } });
    expect(res.body.link).toMatchObject({
      state: 'linked',
      fileName: null,
      status: 'ok',
      folder: { fileCount: 3, playable: false },
    });
  });

  it('survives rescans; a vanished folder shows missing and is never relinked', async () => {
    const t = await linkEnv();
    const spy = t.folder('Vol 2 - スパイ');
    const sub = t.subtitle('[2巻]');
    await t.put(SPY2, {
      audio: { state: 'linked', folderId: spy.id },
      subtitle: { state: 'linked', subtitleId: sub.id },
    });
    const lib = t.service.libraries()[0];
    await t.service.scanLibrary(lib);
    expect((await t.get(SPY2)).body.link).toMatchObject({ status: 'ok', subtitleStatus: 'ok' });

    // The folder and the subtitle file go away; a same-named folder appears elsewhere.
    const spyDir = path.join(t.root, ...spy.relPath.split('/'));
    const saved = fs.readdirSync(spyDir).map((n) => [n, fs.readFileSync(path.join(spyDir, n))]);
    fs.rmSync(spyDir, { recursive: true });
    const subFile = path.join(t.root, ...sub.relPath.split('/'));
    const subBytes = fs.readFileSync(subFile);
    fs.rmSync(subFile);
    write(t.root, `japanese/_Unknown/moved/${spy.name}/a.m4b`, m4b(34_200));
    await t.service.scanLibrary(lib);

    const missing = (await t.get(SPY2)).body.link;
    expect(missing).toMatchObject({
      state: 'linked',
      folderRelPath: spy.relPath,
      status: 'missing',
      folder: { missing: true },
      subtitleRelPath: sub.relPath,
      subtitleStatus: 'missing',
    });
    // A missing folder can't be linked anew.
    const again = await t.put(SPY2, { audio: { state: 'linked', folderId: spy.id } });
    expect([again.status, again.body.error.code]).toEqual([409, 'missing']);

    // The same path coming back makes it work again.
    for (const [name, bytes] of saved) write(t.root, `${spy.relPath}/${name}`, bytes as Buffer);
    write(t.root, sub.relPath, subBytes);
    await t.service.scanLibrary(lib);
    expect((await t.get(SPY2)).body.link).toMatchObject({
      status: 'ok',
      subtitleStatus: 'ok',
      folderRelPath: spy.relPath,
    });
    expect(getAudioFolderByPath(t.e.db, t.libId, spy.relPath)?.missingAt).toBeNull();
  });

  it('says "changed" when the linked file of a single-file folder is replaced', async () => {
    const t = await linkEnv();
    const kakuriyo = t.folder('かくりよ');
    await t.put(KAKURIYO, { audio: { state: 'linked', folderId: kakuriyo.id } });
    const dir = path.join(t.root, ...kakuriyo.relPath.split('/'));
    fs.renameSync(path.join(dir, kakuriyo.files[0].name), path.join(dir, 'renamed.m4b'));
    await t.service.scanLibrary(t.service.libraries()[0]);
    expect((await t.get(KAKURIYO)).body.link).toMatchObject({
      status: 'changed',
      fileName: kakuriyo.files[0].name,
    });
  });

  it('keeps links per user, lists them with problems first, and exports them', async () => {
    const t = await linkEnv();
    await t.put(SPY2, { audio: { state: 'linked', folderId: t.folder('Vol 2 - スパイ').id } });
    await t.put(GUIN, { audio: { state: 'linked', folderId: t.folder(GUIN).id } });
    await t.put(KAKURIYO, { audio: { state: 'none' } });

    const list = await request(t.e.app).get('/api/v1/audio/links').set(t.auth);
    expect(list.status).toBe(200);
    expect(
      list.body.links.map((l: { book: { title: string }; state: string }) => [
        l.book.title,
        l.state,
      ]),
    ).toEqual([
      [GUIN, 'linked'], // several files: shown first
      [SPY2, 'linked'],
      [KAKURIYO, 'none'],
    ]);
    expect(list.body.links[1].book).toMatchObject({ authors: expect.any(Array), missing: false });

    // Another user sees none of them.
    const other = randomUUID();
    t.e.db
      .prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
      .run(other, 'second', Date.now());
    const auth2 = { Authorization: `Bearer ${createToken(t.e.db, other, 'b').token}` };
    expect((await t.get(SPY2, auth2)).body).toEqual({ link: null });
    expect((await request(t.e.app).get('/api/v1/audio/links').set(auth2)).body).toEqual({
      links: [],
    });
    expect(listLinks(t.e.db, other)).toEqual([]);

    const exported = await request(t.e.app).get('/api/v1/export').set(t.auth);
    expect(exported.status).toBe(200);
    const links = exported.body.audioLinks;
    expect(links).toHaveLength(3);
    expect(links.find((l: { bookId: string }) => l.bookId === t.bookId(KAKURIYO))).toEqual({
      bookId: t.bookId(KAKURIYO),
      state: 'none',
      folder: null,
      fileName: null,
      subtitleState: null,
      subtitle: null,
      source: 'library',
      confirmedAt: expect.any(Number),
    });
    expect(exported.body.books[t.bookId(SPY2)].title).toBe(SPY2);
    expect(fingerprint(t.root)).toEqual(t.before);
  });

  it('reads links while audio is off, but changes need the audiobooks folder', async () => {
    const t = await linkEnv();
    await t.put(SPY2, { audio: { state: 'linked', folderId: t.folder('Vol 2 - スパイ').id } });
    await t.service.stop();
    // Turn audio off the way an unusable AUDIOBOOKS_DIR does.
    t.service.status.enabled = false;
    expect((await t.get(SPY2)).body.link).toMatchObject({ state: 'linked', status: 'ok' });
    const put = await t.put(SPY2, { audio: { state: 'none' } });
    expect([put.status, put.body.error.code]).toEqual([503, 'audio_off']);
    expect((await request(t.e.app).get('/api/v1/audio/links').set(t.auth)).status).toBe(200);
    expect((await request(t.e.app).delete(t.url(SPY2)).set(t.auth)).status).toBe(204);
  });
});

describe('WP15f: links to one file of a folder of several', () => {
  it('links one file (plays), keeps subtitles only for the same file, and refuses unknown files', async () => {
    const t = await linkEnv();
    const guin = t.folder(GUIN);
    const folderInfo = await request(t.e.app).get(`/api/v1/audio/folders/${guin.id}`).set(t.auth);
    expect(folderInfo.body.looksLikeCopies).toBe(false);

    // The whole folder: linked, but nothing to play.
    const whole = await t.put(GUIN, { audio: { state: 'linked', folderId: guin.id } });
    expect(whole.body.link).toMatchObject({
      fileName: null,
      status: 'ok',
      playable: false,
      file: null,
    });
    expect((await t.get(GUIN)).body.link.playUrl).toBeNull();
    expect(whole.body.link.playUrl).toBeNull();

    // One file: plays.
    const one = await t.put(GUIN, {
      audio: { state: 'linked', folderId: guin.id, fileName: '02.mp3' },
    });
    expect(one.body.link).toMatchObject({
      folderRelPath: guin.relPath,
      fileName: '02.mp3',
      status: 'ok',
      playable: true,
      file: { name: '02.mp3', size: guin.files[1].size },
      subtitleState: null,
    });
    const got = (await t.get(GUIN)).body.link;
    expect(got.playUrl).toMatch(/^\/api\/v1\/audio\/files\/\d+\/1\?/);
    // PUT answers with the same playUrl as GET (the Download menu updates at once).
    expect(one.body.link.playUrl).toBe(got.playUrl);
    const played = await request(t.e.app).get(got.playUrl);
    expect(played.status).toBe(200);
    expect(played.headers['content-type']).toBe('audio/mpeg');

    // Subtitles stay for the same file, and are asked again for another one.
    const sub = t.subtitle('[2巻]');
    await t.put(GUIN, { subtitle: { state: 'linked', subtitleId: sub.id } });
    const same = await t.put(GUIN, {
      audio: { state: 'linked', folderId: guin.id, fileName: '02.mp3' },
    });
    expect(same.body.link).toMatchObject({ subtitleState: 'linked', subtitleRelPath: sub.relPath });
    const other = await t.put(GUIN, {
      audio: { state: 'linked', folderId: guin.id, fileName: '01.mp3' },
    });
    expect(other.body.link).toMatchObject({ fileName: '01.mp3', subtitleState: null });

    const unknown = await t.put(GUIN, {
      audio: { state: 'linked', folderId: guin.id, fileName: 'nope.mp3' },
    });
    expect(unknown.status).toBe(404);
    const bad = await t.put(GUIN, { audio: { state: 'linked', folderId: guin.id, fileName: 3 } });
    expect(bad.status).toBe(400);
    expect((await t.get(GUIN)).body.link.fileName).toBe('01.mp3');

    // A single-file folder still links its file by itself.
    const spy = t.folder('Vol 2 - スパイ');
    const single = await t.put(SPY2, { audio: { state: 'linked', folderId: spy.id } });
    expect(single.body.link).toMatchObject({ fileName: spy.files[0].name, playable: true });

    // The file goes away: "changed", nothing to play.
    fs.renameSync(
      path.join(t.root, ...guin.relPath.split('/'), '01.mp3'),
      path.join(t.root, ...guin.relPath.split('/'), '01-moved.mp3'),
    );
    await request(t.e.app).post('/api/v1/audio/scan').set(t.auth);
    await t.service.idle();
    expect((await t.get(GUIN)).body.link).toMatchObject({
      status: 'changed',
      playable: false,
      playUrl: null,
    });
  });
});
