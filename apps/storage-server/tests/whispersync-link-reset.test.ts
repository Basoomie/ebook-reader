/**
 * A change of a book's audiobook or subtitle files removes whispersync's saved match and
 * saved subtitles of that book on every device (decided with the user, 2026-11-13): the
 * server marks their "book-attachment" records deleted, as a device's reset does. Not on
 * a book's first link, nor when the same files are confirmed again; always for a job's
 * new files (they may reuse a name). The playback position stays.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { listAudioFolders, listSubtitleFiles } from '../src/audio/audio-index';
import { getLink, saveLink } from '../src/audio/audio-links';
import type { AudioScanService } from '../src/audio/scan-service';
import { SERVER_DEVICE_ID } from '../src/audio/whispersync-forget';
import { listUsers } from '../src/db/users';
import { audioEnv } from './helpers/audio-fixtures';
import type { IndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const SPY2 = 'スパイ教室02 《愛娘》のグレーテ';
const NAMES = ['whispersync-match', 'whispersync-subtitles'];

async function setup() {
  const env = await audioEnv({ envs, services });
  const { e } = env;
  const auth = { Authorization: `Bearer ${e.token()}` };
  const deviceId = randomUUID();
  expect(
    (await request(e.app).post('/api/v1/devices/register').set(auth).send({ deviceId })).status,
  ).toBe(200);
  const bookId = env.bookId(SPY2);
  const folder = listAudioFolders(e.db, env.libId).find((f) =>
    f.name.startsWith('Vol 2 - スパイ'),
  )!;
  const subs = listSubtitleFiles(e.db, env.libId);
  const sub2 = subs.find((s) => s.relPath.includes('[2巻]'))!;
  const sub1 = subs.find((s) => s.relPath.includes('[1巻]'))!;
  const url = `/api/v1/books/${bookId}/audio-link`;
  const link = (body: Record<string, unknown>) => request(e.app).put(url).set(auth).send(body);
  /** This device saves a match and subtitles (as whispersync does) and its position. */
  const save = async (modifiedAt: number) => {
    for (const name of NAMES) {
      const res = await request(e.app)
        .put(`/api/v1/books/${bookId}/attachments/${name}`)
        .query({ modifiedAt })
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(JSON.stringify({ name, modifiedAt })));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const pushed = await request(e.app)
      .post('/api/v1/sync')
      .set(auth)
      .send({
        changes: [
          {
            kind: 'audiobook-position',
            id: bookId,
            updatedAt: modifiedAt,
            data: { position: 42, modifiedAt },
          },
        ],
      });
    expect(pushed.body.results[0].status).toBe('applied');
  };
  /** What another device pulls: the book's whispersync records by name. */
  const records = async () => {
    const all = (await request(e.app).get('/api/v1/sync').set(auth).query({ limit: 1000 })).body
      .records as any[];
    const of = (kind: string, id: string) => all.find((r) => r.kind === kind && r.id === id);
    return {
      match: of('book-attachment', `${bookId}:whispersync-match`),
      subtitles: of('book-attachment', `${bookId}:whispersync-subtitles`),
      position: of('audiobook-position', bookId),
    };
  };
  const live = async () => {
    const r = await records();
    return {
      match: !!r.match && r.match.deletedAt === null,
      subtitles: !!r.subtitles && r.subtitles.deletedAt === null,
      position: !!r.position && r.position.deletedAt === null,
    };
  };
  const userId = listUsers(e.db)[0].id;
  return { ...env, auth, bookId, folder, sub1, sub2, url, link, save, records, live, userId };
}

const ALL_LIVE = { match: true, subtitles: true, position: true };
const RESET = { match: false, subtitles: false, position: true };

describe('a change of linked files resets whispersync on every device', () => {
  it('keeps the saved data on the first link and when the same files are confirmed again', async () => {
    const t = await setup();
    await t.save(1000);
    const both = {
      audio: { state: 'linked', folderId: t.folder.id },
      subtitle: { state: 'linked', subtitleId: t.sub2.id },
    };
    expect((await t.link(both)).status).toBe(200);
    expect(await t.live()).toEqual(ALL_LIVE);
    expect((await t.link(both)).status).toBe(200);
    expect(await t.live()).toEqual(ALL_LIVE);
  });

  it('removes the match and the saved subtitles when the subtitles change, keeps the position', async () => {
    const t = await setup();
    await t.link({
      audio: { state: 'linked', folderId: t.folder.id },
      subtitle: { state: 'linked', subtitleId: t.sub2.id },
    });
    await t.save(1000);
    expect((await t.link({ subtitle: { state: 'linked', subtitleId: t.sub1.id } })).status).toBe(
      200,
    );
    expect(await t.live()).toEqual(RESET);
    const r = await t.records();
    // Marked by the server, newer than what the device saved.
    expect(r.match.deviceId).toBe(SERVER_DEVICE_ID);
    expect(r.subtitles.deletedAt).toBeGreaterThan(1000);
    expect(r.position.data.position).toBe(42);
    // The files are no longer served (as after a device's reset).
    const gone = await request(t.e.app)
      .get(`/api/v1/books/${t.bookId}/attachments/whispersync-match`)
      .set(t.auth);
    expect(gone.status).toBe(404);

    // Saved again with the new subtitles: kept until the next change.
    await t.save(Date.now() + 1000);
    expect(await t.live()).toEqual(ALL_LIVE);
    await t.link({ subtitle: { state: 'none' } });
    expect(await t.live()).toEqual(RESET);
  });

  it('removes them when the audiobook changes, is set to "No audiobook", or is unlinked', async () => {
    const t = await setup();
    const other = listAudioFolders(t.e.db, t.libId).find((f) =>
      f.name.startsWith('Vol 1 - スパイ'),
    )!;
    await t.link({ audio: { state: 'linked', folderId: t.folder.id } });
    for (const [label, change] of [
      ['another audiobook', () => t.link({ audio: { state: 'linked', folderId: other.id } })],
      ['no audiobook', () => t.link({ audio: { state: 'none' } })],
      ['unlink', () => request(t.e.app).delete(t.url).set(t.auth)],
    ] as const) {
      await t.save(Date.now() + 1000);
      expect(await t.live(), label).toEqual(ALL_LIVE);
      const res = await change();
      expect(res.status, label).toBeLessThan(300);
      expect(await t.live(), label).toEqual(RESET);
    }
    // Unlinking a book without a link changes nothing.
    await t.save(Date.now() + 2000);
    await request(t.e.app).delete(t.url).set(t.auth);
    expect(await t.live()).toEqual(ALL_LIVE);
  });

  it("always removes them for a job's new files, even with the same name", async () => {
    const t = await setup();
    await t.link({
      audio: { state: 'linked', folderId: t.folder.id },
      subtitle: { state: 'linked', subtitleId: t.sub2.id },
    });
    await t.save(1000);
    const current = getLink(t.e.db, t.userId, t.bookId)!;
    // As WP16 links its result: the same path as before (the old file was deleted).
    saveLink(t.e.db, t.userId, { ...current, confirmedAt: Date.now() }, { newFiles: true });
    expect(await t.live()).toEqual(RESET);
    // Nothing saved: nothing to remove, no records made up.
    const before = (await t.records()).match.rev;
    saveLink(t.e.db, t.userId, { ...current, confirmedAt: Date.now() }, { newFiles: true });
    expect((await t.records()).match.rev).toBe(before);
  });
});
