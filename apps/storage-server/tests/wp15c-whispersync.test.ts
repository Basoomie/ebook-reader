/**
 * WP15c: what whispersync needs from the server once it leaves the old sync. The
 * playback position record, book attachments (saved subtitles and saved match, newest
 * wins, resets on every device), the linked audiobook's play URL and the linked subtitle
 * file. The audiobooks folder stays byte-identical; attachments live in DATA_DIR only.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { listAudioFolders, listSubtitleFiles } from '../src/audio/audio-index';
import type { AudioScanService } from '../src/audio/scan-service';
import { audioEnv as audioEnv0 } from './helpers/audio-fixtures';
import { fingerprint } from './helpers/calibre-fixture';
import type { IndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const SPY2 = 'スパイ教室02 《愛娘》のグレーテ';
const GUIN = 'グイン・サーガ';

async function setup() {
  const env = await audioEnv0({ envs, services });
  const { e } = env;
  const device = async () => {
    const auth = { Authorization: `Bearer ${e.token()}` };
    const deviceId = randomUUID();
    const reg = await request(e.app).post('/api/v1/devices/register').set(auth).send({ deviceId });
    expect(reg.status).toBe(200);
    return {
      auth,
      deviceId,
      push: async (changes: unknown[]) =>
        (await request(e.app).post('/api/v1/sync').set(auth).send({ changes })).body
          .results as any[],
      pull: async () =>
        (await request(e.app).get('/api/v1/sync').set(auth).query({ limit: 1000 })).body
          .records as any[],
      upload: (bookId: string, name: string, body: string, modifiedAt: number) =>
        request(e.app)
          .put(`/api/v1/books/${bookId}/attachments/${name}`)
          .query({ modifiedAt })
          .set(auth)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(body)),
      download: (bookId: string, name: string) =>
        request(e.app).get(`/api/v1/books/${bookId}/attachments/${name}`).set(auth),
    };
  };
  return { ...env, device };
}

const codes = (results: any[]) => results.map((r) => r.error?.code ?? r.status);

describe('audiobook position', () => {
  it('is one record per book, newest wins, and can be reset', async () => {
    const t = await setup();
    const a = await t.device();
    const b = await t.device();
    const id = t.bookId(SPY2);
    const at = Date.now();
    expect(
      codes(
        await a.push([
          {
            kind: 'audiobook-position',
            id,
            updatedAt: at,
            data: { position: 123.5, modifiedAt: at },
          },
        ]),
      ),
    ).toEqual(['applied']);
    expect(
      codes(
        await b.push([
          {
            kind: 'audiobook-position',
            id,
            updatedAt: at - 1000,
            data: { position: 50, modifiedAt: at - 1000 },
          },
        ]),
      ),
    ).toEqual(['stale']);
    const rec = (await b.pull()).find((r) => r.kind === 'audiobook-position');
    expect(rec).toMatchObject({ id, bookId: id, data: { position: 123.5, modifiedAt: at } });
    // Bad data and unknown books are refused.
    expect(
      codes(
        await a.push([
          {
            kind: 'audiobook-position',
            id,
            updatedAt: at + 1,
            data: { position: -1, modifiedAt: at },
          },
          {
            kind: 'audiobook-position',
            id,
            updatedAt: at + 2,
            data: { position: 'x', modifiedAt: at },
          },
          {
            kind: 'audiobook-position',
            id: randomUUID(),
            updatedAt: at + 3,
            data: { position: 1, modifiedAt: at },
          },
        ]),
      ),
    ).toEqual(['invalid_data', 'invalid_data', 'unknown_book']);
    // Reset all: a deletion marker.
    expect(
      codes(
        await a.push([{ kind: 'audiobook-position', id, updatedAt: at + 10, deletedAt: at + 10 }]),
      ),
    ).toEqual(['applied']);
  });
});

describe('book attachments', () => {
  it('stores the file, announces it with a record, and serves it to other devices', async () => {
    const t = await setup();
    const a = await t.device();
    const b = await t.device();
    const id = t.bookId(SPY2);
    const body = JSON.stringify({ subtitleData: { name: 'x.srt', subtitles: [] } });
    const up = await a.upload(id, 'whispersync-subtitles', body, 1000);
    expect(up.status).toBe(200);
    expect(up.body.attachment).toMatchObject({ size: Buffer.byteLength(body), modifiedAt: 1000 });
    const rec = (await b.pull()).find((r) => r.kind === 'book-attachment');
    expect(rec).toMatchObject({
      id: `${id}:whispersync-subtitles`,
      bookId: id,
      deviceId: a.deviceId,
      deletedAt: null,
      data: { size: Buffer.byteLength(body), sha256: up.body.attachment.sha256, modifiedAt: 1000 },
    });
    const down = await b.download(id, 'whispersync-subtitles');
    expect(down.status).toBe(200);
    expect(down.headers.etag).toBe(`"${up.body.attachment.sha256}"`);
    expect(down.headers['x-modified-at']).toBe('1000');
    expect(down.text).toBe(body);
    // Stored only under DATA_DIR/.uploads/attachments.
    const file = path.join(
      t.e.config.dataRoot,
      '.uploads',
      'attachments',
      fs.readdirSync(path.join(t.e.config.dataRoot, '.uploads', 'attachments'))[0],
      id,
      'whispersync-subtitles.bin',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
    expect(fingerprint(t.root)).toEqual(t.before);
  });

  it('refuses an upload older than what the server holds (newest wins)', async () => {
    const t = await setup();
    const a = await t.device();
    const b = await t.device();
    const id = t.bookId(SPY2);
    expect((await a.upload(id, 'whispersync-match', '{"elementHtml":"new"}', 2000)).status).toBe(
      200,
    );
    const old = await b.upload(id, 'whispersync-match', '{"elementHtml":"old"}', 1500);
    expect([old.status, old.body.error.code]).toEqual([409, 'stale']);
    expect(old.body.error.record).toMatchObject({ data: { modifiedAt: 2000 } });
    expect((await a.download(id, 'whispersync-match')).text).toBe('{"elementHtml":"new"}');
    // A newer one replaces it.
    expect((await b.upload(id, 'whispersync-match', '{"elementHtml":"newer"}', 3000)).status).toBe(
      200,
    );
    expect((await a.download(id, 'whispersync-match')).text).toBe('{"elementHtml":"newer"}');
  });

  it('a reset (deletion marker) applies on every device; a device may not invent a record', async () => {
    const t = await setup();
    const a = await t.device();
    const b = await t.device();
    const id = t.bookId(SPY2);
    const up = await a.upload(id, 'whispersync-match', '{"elementHtml":"m"}', 1000);
    const recordId = `${id}:whispersync-match`;
    const at = Date.now();
    expect(
      codes(
        await b.push([{ kind: 'book-attachment', id: recordId, updatedAt: at, deletedAt: at }]),
      ),
    ).toEqual(['applied']);
    const seen = (await a.pull()).find((r) => r.kind === 'book-attachment');
    expect(seen).toMatchObject({ id: recordId, deviceId: b.deviceId, deletedAt: at });
    expect((await a.download(id, 'whispersync-match')).status).toBe(404);
    // Restoring with the stored file's data is allowed; other data is refused.
    expect(
      codes(
        await a.push([
          {
            kind: 'book-attachment',
            id: recordId,
            updatedAt: at + 5,
            data: { size: 99, sha256: up.body.attachment.sha256, modifiedAt: 1000 },
          },
          {
            kind: 'book-attachment',
            id: `${t.bookId(GUIN)}:whispersync-match`,
            updatedAt: at + 6,
            data: { size: 1, sha256: 'x', modifiedAt: 1 },
          },
          { kind: 'book-attachment', id: `${id}:other`, updatedAt: at + 7, data: {} },
        ]),
      ),
    ).toEqual(['invalid_data', 'unknown_attachment', 'invalid_id']);
    // DELETE does the same as a pushed deletion marker.
    await a.upload(id, 'whispersync-subtitles', '{}', 5000);
    const del = await request(t.e.app)
      .delete(`/api/v1/books/${id}/attachments/whispersync-subtitles`)
      .set(a.auth);
    expect(del.status).toBe(204);
    expect((await a.download(id, 'whispersync-subtitles')).status).toBe(404);
  });

  it('refuses unknown names and books, a missing modifiedAt and unregistered devices', async () => {
    const t = await setup();
    const a = await t.device();
    const id = t.bookId(SPY2);
    expect((await a.upload(id, 'other', '{}', 1)).status).toBe(404);
    expect((await a.upload(randomUUID(), 'whispersync-match', '{}', 1)).status).toBe(404);
    const noTime = await request(t.e.app)
      .put(`/api/v1/books/${id}/attachments/whispersync-match`)
      .set(a.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('{}'));
    expect(noTime.status).toBe(400);
    const unregistered = await request(t.e.app)
      .put(`/api/v1/books/${id}/attachments/whispersync-match`)
      .query({ modifiedAt: 1 })
      .set({ Authorization: `Bearer ${t.e.token()}` })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('{}'));
    expect([unregistered.status, unregistered.body.error.code]).toEqual([
      409,
      'device_not_registered',
    ]);
  });
});

describe('the linked audiobook for whispersync', () => {
  it('gives a signed play URL for a single-file link and serves the linked subtitle file', async () => {
    const t = await setup();
    const id = t.bookId(SPY2);
    const folder = listAudioFolders(t.e.db, t.libId).find((f) =>
      f.name.startsWith('Vol 2 - スパイ'),
    )!;
    const sub = listSubtitleFiles(t.e.db, t.libId).find((s) => s.relPath.includes('[2巻]'))!;
    const url = `/api/v1/books/${id}/audio-link`;
    const noSub = await request(t.e.app).get(`/api/v1/books/${id}/subtitle-file`).set(t.auth);
    expect(noSub.status).toBe(404);
    await request(t.e.app)
      .put(url)
      .set(t.auth)
      .send({
        audio: { state: 'linked', folderId: folder.id },
        subtitle: { state: 'linked', subtitleId: sub.id },
      });
    const link = (await request(t.e.app).get(url).set(t.auth)).body.link;
    expect(link.playUrl).toMatch(new RegExp(`^/api/v1/audio/files/${folder.id}/0\\?v=`));
    // The URL plays without the token (an <audio> element can't send it).
    const played = await request(t.e.app).get(link.playUrl).set('Range', 'bytes=0-9');
    expect(played.status).toBe(206);

    const subtitle = await request(t.e.app).get(`/api/v1/books/${id}/subtitle-file`).set(t.auth);
    expect(subtitle.status).toBe(200);
    expect(subtitle.headers['content-type']).toMatch(/^text\/plain/);
    expect(subtitle.text).toContain('テスト');
    expect(subtitle.headers['content-disposition']).toContain(encodeURIComponent(sub.name));

    // A split folder has no play URL.
    const guin = listAudioFolders(t.e.db, t.libId).find((f) => f.name === GUIN)!;
    const guinUrl = `/api/v1/books/${t.bookId(GUIN)}/audio-link`;
    await request(t.e.app)
      .put(guinUrl)
      .set(t.auth)
      .send({ audio: { state: 'linked', folderId: guin.id } });
    expect((await request(t.e.app).get(guinUrl).set(t.auth)).body.link.playUrl).toBeNull();

    // A subtitle file that disappeared is reported, not served.
    fs.rmSync(path.join(t.root, ...sub.relPath.split('/')));
    await t.service.scanLibrary(t.service.libraries()[0]);
    const gone = await request(t.e.app).get(`/api/v1/books/${id}/subtitle-file`).set(t.auth);
    expect([gone.status, gone.body.error.code]).toEqual([410, 'missing']);
  });
});
