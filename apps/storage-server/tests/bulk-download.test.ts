/**
 * The library's bulk downloads (select mode): Select All's ids, the download plan's
 * sizes, and the streamed store-only ZIP (exact length, CRCs, ZIP64 when forced). The
 * Calibre library and the audiobooks folder stay byte-identical.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32 } from 'zlib';
import { listAudioFolders, listSubtitleFiles } from '../src/audio/audio-index';
import type { AudioScanService } from '../src/audio/scan-service';
import { createToken } from '../src/db/tokens';
import { uniqueNames, zipSize, zipStream, type ZipEntry } from '../src/catalog/zip-stream';
import { audioEnv } from './helpers/audio-fixtures';
import { fingerprint } from './helpers/calibre-fixture';
import type { IndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

interface Read {
  name: string;
  crc: number;
  size: number;
  data: Buffer;
}

/** Reads an archive back from its central directory (ZIP64 fields included). */
function readZip(zip: Buffer): Read[] {
  let end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  let count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (offset === 0xffffffff) {
    const locator = end - 20;
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50);
    const end64 = Number(zip.readBigUInt64LE(locator + 8));
    expect(zip.readUInt32LE(end64)).toBe(0x06064b50);
    count = Number(zip.readBigUInt64LE(end64 + 32));
    offset = Number(zip.readBigUInt64LE(end64 + 48));
    end = end64;
  }
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt16LE(offset + 8) & 0x0808).toBe(0x0808);
    const crc = zip.readUInt32LE(offset + 16);
    let size = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    let local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const extra = zip.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen);
    if (extra.length) {
      expect(extra.readUInt16LE(0)).toBe(0x0001);
      let at = 4;
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(at));
        at += 16;
      }
      if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(at));
    }
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    expect(zip.readUInt32LE(dataAt + size)).toBe(0x08074b50);
    out.push({ name, crc, size, data });
    offset += 46 + nameLen + extraLen;
  }
  return out;
}

const entry = (name: string, data: Buffer, chunk = 7): ZipEntry => ({
  name,
  size: data.length,
  open: async () =>
    Readable.from(
      Array.from({ length: Math.ceil(data.length / chunk) }, (_, i) =>
        data.subarray(i * chunk, (i + 1) * chunk),
      ),
    ),
});

describe('zip stream', () => {
  const files = [
    entry('スパイ教室02.epub', Buffer.from('an epub, more or less '.repeat(40))),
    entry('empty.srt', Buffer.alloc(0)),
    entry('cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
  ];

  for (const forceZip64 of [false, true]) {
    it(`writes exactly the announced bytes, readable back${forceZip64 ? ' (ZIP64)' : ''}`, async () => {
      const { size, stream } = zipStream(files, { forceZip64 });
      const zip = await collect(stream);
      expect(zip.length).toBe(size);
      expect(zipSize(files, { forceZip64 })).toBe(size);
      const read = readZip(zip);
      expect(read.map((r) => r.name)).toEqual(files.map((f) => f.name));
      for (const r of read) {
        const original = await collect(await files.find((f) => f.name === r.name)!.open());
        expect(r.data.equals(original)).toBe(true);
        expect(r.crc).toBe(crc32(original));
      }
    });
  }

  it('stops with an error when a file is not the announced size', async () => {
    const short = { ...entry('a.epub', Buffer.from('12345')), size: 6 };
    await expect(collect(zipStream([short]).stream)).rejects.toThrow(/changed while/);
    const long = { ...entry('b.epub', Buffer.from('1234567')), size: 6 };
    await expect(collect(zipStream([long]).stream)).rejects.toThrow(/changed while/);
  });

  it('makes names unique the way Windows compares them', () => {
    expect(uniqueNames(['a.epub', 'A.epub', 'a.epub', 'b', 'b'])).toEqual([
      'a.epub',
      'A (2).epub',
      'a (3).epub',
      'b',
      'b (2)',
    ]);
  });
});

const SPY2 = 'スパイ教室02 《愛娘》のグレーテ';

async function ready(t: { e: IndexerEnv; auth: Record<string, string> }, token: string) {
  for (let i = 0; i < 200; i++) {
    const res = await request(t.e.app).get(`/api/v1/books/download-zip/${token}`).set(t.auth);
    if (res.body.state !== 'preparing') return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the ZIP was never ready');
}

describe('bulk download routes', () => {
  async function env() {
    const t = await audioEnv({ envs, services });
    const calibreBefore = fingerprint(t.calibreDir);
    const spy = listAudioFolders(t.e.db, t.libId).find((f) => f.name.startsWith('Vol 2 - スパイ'))!;
    const sub = listSubtitleFiles(t.e.db, t.libId).find((s) => s.relPath.includes('[2巻]'))!;
    const linked = await request(t.e.app)
      .put(`/api/v1/books/${t.bookId(SPY2)}/audio-link`)
      .set(t.auth)
      .send({
        audio: { state: 'linked', folderId: spy.id },
        subtitle: { state: 'linked', subtitleId: sub.id },
      });
    expect(linked.status).toBe(200);
    const ids = (await request(t.e.app).get('/api/v1/books/ids').set(t.auth)).body.ids as string[];
    return { ...t, spy, sub, ids, calibreBefore };
  }

  it('lists every matching id for Select All, with the list filters', async () => {
    const t = await env();
    expect(t.ids.sort()).toEqual(
      (t.e.db.prepare('SELECT id FROM books').all() as { id: string }[]).map((r) => r.id).sort(),
    );
    const one = await request(t.e.app).get('/api/v1/books/ids').query({ q: 'スパイ' }).set(t.auth);
    expect(one.body).toEqual({ ids: [t.bookId(SPY2)] });
    const bad = await request(t.e.app)
      .get('/api/v1/books/ids')
      .query({ q: '/usr/bin' })
      .set(t.auth);
    expect(bad.status).toBe(400);
    expect((await request(t.e.app).get('/api/v1/books/ids')).status).toBe(401);
  });

  it('plans sizes per kind from stored data only', async () => {
    const t = await env();
    const res = await request(t.e.app)
      .post('/api/v1/books/download-plan')
      .set(t.auth)
      .send({ ids: [...t.ids, randomUUID()] });
    expect(res.status).toBe(200);
    expect(res.body.items).toBeUndefined();
    expect(res.body.unknown).toBe(1);
    const epubBytes = (
      t.e.db.prepare('SELECT SUM(file_size) AS n FROM book_sources').get() as { n: number }
    ).n;
    expect(res.body.totals.book).toEqual({ count: 4, bytes: epubBytes, unknown: 0 });
    expect(res.body.totals.cover.count).toBe(4);
    expect(res.body.totals.audio).toEqual({
      count: 1,
      bytes: t.spy.files[0].size,
      unknown: 0,
    });
    expect(res.body.totals.subtitles).toEqual({ count: 1, bytes: t.sub.size, unknown: 0 });

    const items = await request(t.e.app)
      .post('/api/v1/books/download-plan')
      .set(t.auth)
      .send({ ids: [t.bookId(SPY2)], items: true });
    expect(items.body.items).toEqual([
      expect.objectContaining({
        id: t.bookId(SPY2),
        title: SPY2,
        audio: expect.objectContaining({
          name: t.spy.files[0].name,
          url: expect.stringMatching(/^\/api\/v1\/audio\/files\//),
        }),
        subtitles: { name: t.sub.name, size: t.sub.size },
      }),
    ]);
    const bad = await request(t.e.app)
      .post('/api/v1/books/download-plan')
      .set(t.auth)
      .send({ ids: ['nope'] });
    expect(bad.status).toBe(400);
  });

  it('streams each kind as one ZIP from a one-off address', async () => {
    const t = await env();
    const kinds: Record<string, (r: Read[]) => void> = {
      book: (read) => {
        expect(read).toHaveLength(4);
        expect(read.every((r) => r.name.endsWith('.epub'))).toBe(true);
        // Byte for byte the library's EPUBs.
        const epubs: string[] = [];
        const walk = (d: string) =>
          fs.readdirSync(d, { withFileTypes: true }).forEach((x) => {
            if (x.isDirectory()) walk(path.join(d, x.name));
            else if (x.name.endsWith('.epub')) epubs.push(path.join(d, x.name));
          });
        walk(t.calibreDir);
        const hex = (b: Buffer) => b.toString('base64');
        expect(read.map((r) => hex(r.data)).sort()).toEqual(
          epubs.map((f) => hex(fs.readFileSync(f))).sort(),
        );
      },
      cover: (read) => {
        expect(read).toHaveLength(4);
        expect(read[0].name).toMatch(/-cover\.jpg$/);
        expect(read[0].data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      },
      audio: (read) => {
        const file = path.join(t.root, t.spy.relPath, t.spy.files[0].name);
        expect(read.map((r) => r.name)).toEqual([t.spy.files[0].name]);
        expect(read[0].data.equals(fs.readFileSync(file))).toBe(true);
      },
      subtitles: (read) => {
        expect(read.map((r) => r.name)).toEqual([t.sub.name]);
        expect(read[0].data.equals(fs.readFileSync(path.join(t.root, t.sub.relPath)))).toBe(true);
      },
    };
    for (const [kind, check] of Object.entries(kinds)) {
      const started = await request(t.e.app)
        .post('/api/v1/books/download-zip')
        .set(t.auth)
        .send({ ids: t.ids, kind });
      expect(started.status).toBe(202);
      const prep = await ready(t, started.body.token);
      expect([kind, prep.body.state, prep.body.skipped]).toEqual([kind, 'ready', []]);
      expect(prep.body.url).toMatch(/^\/api\/v1\/bulk-downloads\/[\w-]+\/.+\.zip$/);
      // No token: the address itself is the permission.
      const zip = await request(t.e.app)
        .get(prep.body.url)
        .buffer(true)
        .parse((res, done) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => done(null, Buffer.concat(parts)));
        });
      expect(zip.status).toBe(200);
      expect(zip.headers['content-type']).toBe('application/zip');
      expect(zip.headers['content-disposition']).toContain('attachment');
      const body = zip.body as Buffer;
      expect(Number(zip.headers['content-length'])).toBe(body.length);
      expect(body.length).toBe(prep.body.size);
      const read = readZip(body);
      for (const r of read) expect(r.crc).toBe(crc32(r.data));
      check(read);
    }
    const unknown = await request(t.e.app).get('/api/v1/bulk-downloads/nope/x.zip');
    expect(unknown.status).toBe(404);
    // Another user can't see the job; cancelling ends the address.
    const started = await request(t.e.app)
      .post('/api/v1/books/download-zip')
      .set(t.auth)
      .send({ ids: t.ids, kind: 'book' });
    const done = await ready(t, started.body.token);
    const otherId = randomUUID();
    t.e.db
      .prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
      .run(otherId, 'second', Date.now());
    const other = { Authorization: `Bearer ${createToken(t.e.db, otherId, 'b').token}` };
    const peek = await request(t.e.app)
      .get(`/api/v1/books/download-zip/${started.body.token}`)
      .set(other);
    expect(peek.status).toBe(404);
    const cancel = await request(t.e.app)
      .delete(`/api/v1/books/download-zip/${started.body.token}`)
      .set(t.auth);
    expect(cancel.status).toBe(204);
    expect((await request(t.e.app).get(done.body.url)).status).toBe(404);
    // Nothing of that kind: the job fails with a reason.
    const none = await request(t.e.app)
      .post('/api/v1/books/download-zip')
      .set(t.auth)
      .send({ ids: [t.ids.find((id) => id !== t.bookId(SPY2))], kind: 'audio' });
    expect((await ready(t, none.body.token)).body).toMatchObject({
      state: 'failed',
      error: 'None of the selected books has this to download.',
    });
    const badKind = await request(t.e.app)
      .post('/api/v1/books/download-zip')
      .set(t.auth)
      .send({ ids: t.ids, kind: 'everything' });
    expect(badKind.status).toBe(400);
    expect(fingerprint(t.root)).toEqual(t.before);
    expect(fingerprint(t.calibreDir)).toEqual(t.calibreBefore);
  });
});
