/**
 * WP13: custom fonts. Format and name checks, the font folder (files only under
 * DATA_DIR/.uploads/fonts, temp files cleaned up, the old sync and the migration scan
 * unaware), the upload and download routes, and the "font" sync kind (devices may
 * delete or restore a font but never invent or change one).
 */
import { spawnSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseFontConfig } from '../src/config';
import { createToken } from '../src/db/tokens';
import { fontNameProblem, sniffFontFormat } from '../src/fonts/font-format';
import { FontStore, FontTooLargeError, NotAFontError } from '../src/fonts/font-store';
import { cleanFileName } from '../src/fonts/service';
import { listLegacyFolders } from '../src/migration/legacy-fs';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp } from './helpers/test-app';

/** A stand-in font: the right first bytes and some body (the server only sniffs). */
function fakeFont(tag: string | number[] = 'wOF2', size = 2048): Buffer {
  const head = typeof tag === 'string' ? Buffer.from(tag, 'latin1') : Buffer.from(tag);
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

async function setup(overrides: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(overrides);
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  const device = async (label: string) => {
    const token = t.newUserToken(label);
    const auth = { Authorization: `Bearer ${token}` };
    const deviceId = randomUUID();
    const reg = await request(t.app).post('/api/v1/devices/register').set(auth).send({ deviceId });
    expect(reg.status).toBe(200);
    return {
      auth,
      deviceId,
      push: async (changes: unknown[]) =>
        (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body
          .results as any[],
      pull: async () => (await request(t.app).get('/api/v1/sync').set(auth)).body.records as any[],
    };
  };
  const upload = (auth: Record<string, string>, body: Buffer, name: string, fileName = 'a.woff2') =>
    request(t.app)
      .post('/api/v1/fonts')
      .query({ name, fileName })
      .set(auth)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
  return { t, db, device, upload, data: t.config.dataRoot };
}

const codes = (results: any[]) => results.map((r) => r.error?.code ?? r.status);

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      for (const f of filesUnder(full)) out.push(path.join(name, f));
    } else out.push(name);
  }
  return out.map((f) => f.split(path.sep).join('/'));
}

describe('font format and name', () => {
  it('reads the format from the first bytes', () => {
    expect(sniffFontFormat(Buffer.from('wOF2xxxx'))).toBe('woff2');
    expect(sniffFontFormat(Buffer.from('wOFFxxxx'))).toBe('woff');
    expect(sniffFontFormat(Buffer.from('OTTOxxxx'))).toBe('otf');
    expect(sniffFontFormat(Buffer.from([0, 1, 0, 0, 9]))).toBe('ttf');
    expect(sniffFontFormat(Buffer.from('truexxxx'))).toBe('ttf');
    expect(sniffFontFormat(Buffer.from('ttcfxxxx'))).toBeNull();
    expect(sniffFontFormat(Buffer.from('PK\u0003\u0004'))).toBeNull();
    expect(sniffFontFormat(Buffer.from('wOF'))).toBeNull();
  });

  it('accepts names that are safe in the reader CSS', () => {
    expect(fontNameProblem('My Font')).toBeNull();
    expect(fontNameProblem('源ノ明朝 Pro-2_b')).toBeNull();
    expect(fontNameProblem('')).toMatch(/Enter a name/);
    expect(fontNameProblem('1Font')).toMatch(/starting with a letter/);
    expect(fontNameProblem('A, serif')).toMatch(/letters, digits/);
    expect(fontNameProblem("A'B")).toMatch(/letters, digits/);
    expect(fontNameProblem('A  B')).toMatch(/letters, digits/);
    expect(fontNameProblem('A;}')).toMatch(/letters, digits/);
    expect(fontNameProblem('x'.repeat(65))).toMatch(/at most 64/);
    expect(fontNameProblem('noto serif jp')).toMatch(/built-in/);
    expect(fontNameProblem('Serif')).toMatch(/built-in/);
    expect(fontNameProblem('monospace')).toMatch(/built-in/);
  });

  it('keeps only the last part of a file name', () => {
    expect(cleanFileName('C:\\fonts\\A.woff2', 'woff2')).toBe('A.woff2');
    expect(cleanFileName('../x/b.ttf', 'ttf')).toBe('b.ttf');
    expect(cleanFileName('  ', 'otf')).toBe('font.otf');
  });

  it('parses FONT_MAX_MB', () => {
    const warnings: string[] = [];
    expect(parseFontConfig({}, warnings)).toEqual({ maxMb: 64 });
    expect(parseFontConfig({ FONT_MAX_MB: '20' }, warnings)).toEqual({ maxMb: 20 });
    expect(parseFontConfig({ FONT_MAX_MB: 'lots' }, warnings)).toEqual({ maxMb: 64 });
    expect(warnings.length).toBe(1);
  });
});

describe('font folder', () => {
  it('creates nothing until the first font, then only .uploads/fonts', async () => {
    const data = makeTempDir('data');
    const store = new FontStore(data);
    store.init();
    expect(fs.readdirSync(data)).toEqual([]);
    const received = await store.receive(Readable.from([fakeFont()]), 10_000);
    expect(received.format).toBe('woff2');
    expect(received.size).toBe(2048);
    const id = randomUUID();
    const rel = await store.commit(received, id);
    expect(rel).toBe(`${id}/font.woff2`);
    expect(filesUnder(data)).toEqual([`.uploads/fonts/${id}/font.woff2`]);
    expect(await listLegacyFolders(data)).toEqual([]);
  });

  it('removes the temp file when a file is too large or not a font', async () => {
    const data = makeTempDir('data');
    const store = new FontStore(data);
    await expect(store.receive(Readable.from([fakeFont('wOF2', 5000)]), 1000)).rejects.toThrow(
      FontTooLargeError,
    );
    await expect(
      store.receive(Readable.from([fakeFont('PK\u0003\u0004')]), 10_000),
    ).rejects.toThrow(NotAFontError);
    await expect(store.receive(Readable.from([Buffer.from('wO')]), 10_000)).rejects.toThrow(
      NotAFontError,
    );
    // The first bytes split over chunks still count.
    const split = await store.receive(
      Readable.from([Buffer.from('wO'), Buffer.from('F2'), randomBytes(10)]),
      10_000,
    );
    expect(split.format).toBe('woff2');
    await store.discard(split);
    expect(fs.readdirSync(store.root)).toEqual([]);
  });

  it('removes temp files a stopped server left behind', () => {
    const data = makeTempDir('data');
    const store = new FontStore(data);
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(path.join(store.root, '0123456789abcdef.tmp'), 'x');
    fs.writeFileSync(path.join(store.root, 'keep.txt'), 'x');
    store.init();
    expect(fs.readdirSync(store.root)).toEqual(['keep.txt']);
  });

  it('refuses a font folder that is a file, and paths outside it', () => {
    const data = makeTempDir('data');
    fs.writeFileSync(path.join(data, '.uploads'), 'not a folder');
    expect(() => new FontStore(data).init()).toThrow(/plain folder/);
    const store = new FontStore(makeTempDir('data'));
    expect(() => store.resolve('../x')).toThrow(/outside/);
    expect(() => FontStore.fontPath('../x', 'ttf')).toThrow(/Invalid font id/);
  });
});

describe('font routes', () => {
  it('stores an upload, writes its record and serves the file', async () => {
    const s = await setup();
    const a = await s.device('A');
    const body = fakeFont('OTTO', 3000);
    const res = await s.upload(a.auth, body, 'Gothic A', 'C:\\x\\GothicA.otf');
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);
    const font = res.body.font;
    expect(font).toMatchObject({
      name: 'Gothic A',
      fileName: 'GothicA.otf',
      format: 'otf',
      size: 3000,
    });

    const records = (await a.pull()).filter((r) => r.kind === 'font');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: font.id, deviceId: a.deviceId, deletedAt: null });
    expect(records[0].data).toEqual({
      name: 'Gothic A',
      fileName: 'GothicA.otf',
      format: 'otf',
      size: 3000,
      sha256: font.sha256,
      createdAt: font.createdAt,
    });

    const file = await request(s.t.app)
      .get(`/api/v1/fonts/${font.id}/file`)
      .set(a.auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body, body)).toBe(0);
    expect(file.headers['content-type']).toBe('font/otf');
    expect(file.headers['etag']).toBe(`"${font.sha256}"`);
    expect(file.headers['cache-control']).toMatch(/immutable/);

    const list = await request(s.t.app).get('/api/v1/fonts').set(a.auth);
    expect(list.body.maxBytes).toBe(64 * 1024 * 1024);
    expect(list.body.fonts.map((f: any) => f.name)).toEqual(['Gothic A']);

    expect(filesUnder(s.data)).toEqual([`.uploads/fonts/${font.id}/font.otf`]);
  });

  it('refuses taken and unusable names, files that are not fonts, and too large files', async () => {
    const s = await setup({ fonts: { maxMb: 0.01 } });
    const a = await s.device('A');
    expect((await s.upload(a.auth, fakeFont(), 'Mine')).status).toBe(201);

    const taken = await s.upload(a.auth, fakeFont(), 'MINE');
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('name_taken');

    const reserved = await s.upload(a.auth, fakeFont(), 'Noto Sans JP');
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe('invalid_name');

    const unsafe = await s.upload(a.auth, fakeFont(), 'x;}body{');
    expect(unsafe.body.error.code).toBe('invalid_name');

    const zip = await s.upload(a.auth, fakeFont('PK\u0003\u0004'), 'Zip');
    expect(zip.status).toBe(422);
    expect(zip.body.error.code).toBe('not_a_font');

    const empty = await s.upload(a.auth, Buffer.alloc(0), 'Empty');
    expect(empty.body.error.code).toBe('not_a_font');

    const big = await s.upload(a.auth, fakeFont('wOF2', 20_000), 'Big');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('too_large');

    // Only the one font; no temp files left.
    const files = filesUnder(path.join(s.data, '.uploads', 'fonts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\/font\.woff2$/);
  });

  it('answers the existing font for the same bytes', async () => {
    const s = await setup();
    const a = await s.device('A');
    const body = fakeFont();
    const first = await s.upload(a.auth, body, 'One');
    const again = await s.upload(a.auth, body, 'Two');
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body.font.id).toBe(first.body.font.id);
    expect(again.body.font.name).toBe('One');
    expect((await a.pull()).filter((r) => r.kind === 'font')).toHaveLength(1);
  });

  it('needs a registered device and a token, and keeps users apart', async () => {
    const s = await setup();
    const a = await s.device('A');
    const font = (await s.upload(a.auth, fakeFont(), 'Mine')).body.font;

    const unregistered = { Authorization: `Bearer ${s.t.newUserToken('new')}` };
    const res = await s.upload(unregistered, fakeFont(), 'Other');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('device_not_registered');

    expect((await request(s.t.app).get(`/api/v1/fonts/${font.id}/file`)).status).toBe(401);

    const otherUser = randomUUID();
    s.db
      .prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
      .run(otherUser, 'other', Date.now());
    const otherAuth = { Authorization: `Bearer ${createToken(s.db, otherUser, 'x').token}` };
    expect(
      (await request(s.t.app).get(`/api/v1/fonts/${font.id}/file`).set(otherAuth)).status,
    ).toBe(404);
    expect((await request(s.t.app).get('/api/v1/fonts').set(otherAuth)).body.fonts).toEqual([]);
    expect((await request(s.t.app).get('/api/v1/fonts/not-an-id/file').set(a.auth)).status).toBe(
      404,
    );
  });

  it('reports a missing file', async () => {
    const s = await setup();
    const a = await s.device('A');
    const font = (await s.upload(a.auth, fakeFont(), 'Mine')).body.font;
    fs.rmSync(path.join(s.data, '.uploads', 'fonts', font.id), { recursive: true });
    const res = await request(s.t.app).get(`/api/v1/fonts/${font.id}/file`).set(a.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('file_missing');
  });

  it('is off when the font folder is unusable, and the rest of the API still works', async () => {
    const data = makeTempDir('data');
    fs.writeFileSync(path.join(data, '.uploads'), 'not a folder');
    const s = await setup({ dataRoot: data });
    const a = await s.device('A');
    expect((await s.upload(a.auth, fakeFont(), 'Mine')).status).toBe(404);
    expect((await a.pull()).length).toBeGreaterThan(0);
  });
});

describe('font kind', () => {
  it('lets devices delete and restore a font, never invent or change one', async () => {
    const s = await setup();
    const a = await s.device('A');
    const b = await s.device('B');
    const font = (await s.upload(a.auth, fakeFont(), 'Mine')).body.font;
    const data = (await b.pull()).find((r) => r.kind === 'font').data;
    const t0 = Date.now();

    expect(codes(await b.push([{ kind: 'font', id: randomUUID(), updatedAt: t0, data }]))).toEqual([
      'unknown_font',
    ]);
    expect(
      codes(
        await b.push([{ kind: 'font', id: font.id, updatedAt: t0, data: { ...data, name: 'X' } }]),
      ),
    ).toEqual(['invalid_data']);
    expect(
      codes(
        await b.push([{ kind: 'font', id: font.id, updatedAt: t0, data: { ...data, size: 1 } }]),
      ),
    ).toEqual(['invalid_data']);

    // B deletes it: gone for A, the name is free, the file stays.
    expect(
      codes(await b.push([{ kind: 'font', id: font.id, updatedAt: t0 + 1, deletedAt: t0 + 1 }])),
    ).toEqual(['applied']);
    const onA = (await a.pull()).find((r) => r.kind === 'font');
    expect(onA.deletedAt).not.toBeNull();
    expect((await request(s.t.app).get('/api/v1/fonts').set(a.auth)).body.fonts).toEqual([]);
    expect(fs.existsSync(path.join(s.data, '.uploads', 'fonts', font.id))).toBe(true);

    // Restoring needs exactly the font's data.
    expect(codes(await a.push([{ kind: 'font', id: font.id, updatedAt: t0 + 2, data }]))).toEqual([
      'applied',
    ]);
    expect((await request(s.t.app).get('/api/v1/fonts').set(a.auth)).body.fonts).toHaveLength(1);
  });

  it('frees a deleted font name; the same bytes as a deleted font make a new font', async () => {
    const s = await setup();
    const a = await s.device('A');
    const body = fakeFont();
    const font = (await s.upload(a.auth, body, 'Mine')).body.font;
    await a.push([{ kind: 'font', id: font.id, updatedAt: Date.now() + 1, deletedAt: Date.now() }]);
    const again = await s.upload(a.auth, body, 'Mine');
    expect(again.status).toBe(201);
    expect(again.body.font.id).not.toBe(font.id);
  });
});

describe('cli fonts list', () => {
  it('lists fonts with deleted and missing marks', async () => {
    const s = await setup();
    const a = await s.device('A');
    const one = (await s.upload(a.auth, fakeFont(), 'One')).body.font;
    const two = (await s.upload(a.auth, fakeFont(), 'Two')).body.font;
    await a.push([{ kind: 'font', id: two.id, updatedAt: Date.now() + 1, deletedAt: Date.now() }]);
    fs.rmSync(path.join(s.data, '.uploads', 'fonts', one.id), { recursive: true });
    s.db.pragma('wal_checkpoint(TRUNCATE)');
    const res = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', path.join('src', 'cli.ts'), 'fonts', 'list'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DB_DIR: s.t.config.dbDir, DATA_DIR: s.data },
        encoding: 'utf8',
      },
    );
    const out = `${res.stdout}${res.stderr}`;
    expect(res.status).toBe(0);
    expect(out).toMatch(new RegExp(`${one.id}.*One.*\\(file missing\\)`));
    expect(out).toMatch(new RegExp(`${two.id}.*Two.*\\(deleted\\)`));
  });
});
