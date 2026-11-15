/**
 * Season 2 Phase 10: fonts from Google Fonts, fetched by the storage server. Google is
 * stood in by a stubbed fetch (no test reaches the internet): the list, the css2 answers
 * (whole woff2 for the old Firefox User-Agent, whole TTF otherwise, slices on request),
 * and the files on fonts.gstatic.com.
 */
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFontConfig } from '../src/config';
import { readFontNames } from '../src/fonts/font-name-table';
import {
  cssUrl,
  GOOGLE_LIST_URL,
  isGoogleFileUrl,
  parseFamilyList,
  storedWeights,
  wholeFaces,
  WHOLE_WOFF2_USER_AGENT,
} from '../src/fonts/google-fonts';
import { testTtf, testWoff2 } from './helpers/font-files';
import { makeTestApp } from './helpers/test-app';

const OFL = 'https://scripts.sil.org/OFL';

function familyList(prefix = true) {
  const json = JSON.stringify({
    familyMetadataList: [
      {
        family: 'Zen Old Mincho',
        category: 'Serif',
        subsets: ['menu', 'japanese', 'latin'],
        fonts: { '400': {}, '500': {}, '700': {}, '900': {} },
      },
      { family: 'Hina Mincho', category: 'Serif', subsets: ['japanese'], fonts: { '400': {} } },
      {
        family: 'Noto Sans JP',
        category: 'Sans Serif',
        subsets: ['japanese'],
        fonts: { '400': {}, '700': {} },
      },
      { family: 'Roboto', category: 'Sans Serif', subsets: ['latin'], fonts: { '400': {} } },
    ],
  });
  return prefix ? `)]}'\n${json}` : json;
}

const slug = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, '');

interface GoogleStub {
  calls: { url: string; userAgent: string | null }[];
  files: Map<string, Buffer>;
}

/**
 * A stand-in Google. `sliced`: the woff2 answer comes in unicode-range slices (as for a
 * current browser). `foreignHost`: the CSS points at another host. `down`: every request fails.
 */
function stubGoogle(
  o: { sliced?: boolean; foreignHost?: boolean; down?: boolean; big?: number } = {},
): GoogleStub {
  const stub: GoogleStub = { calls: [], files: new Map() };
  const fileFor = (url: string, weight: number, woff2: boolean) => {
    if (!stub.files.has(url)) {
      const options = {
        copyright: `Copyright 2021 The ${url.split('/')[4]} Project Authors`,
        licenseUrl: OFL,
        padding: (o.big ?? 100) + weight,
        seed: weight,
      };
      stub.files.set(url, woff2 ? testWoff2(options) : testTtf(options));
    }
    return stub.files.get(url) as Buffer;
  };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    stub.calls.push({ url, userAgent: headers['User-Agent'] ?? null });
    if (o.down) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
    if (url === GOOGLE_LIST_URL) return new Response(familyList());
    const u = new URL(url);
    if (u.origin === 'https://fonts.googleapis.com' && u.pathname === '/css2') {
      const [family, spec] = (u.searchParams.get('family') ?? '').split(':wght@');
      const known = ['Zen Old Mincho', 'Hina Mincho', 'Noto Sans JP'];
      if (!known.includes(family)) return new Response('<html>', { status: 400 });
      const woff2 = headers['User-Agent'] === WHOLE_WOFF2_USER_AGENT;
      const host = o.foreignHost ? 'https://evil.example' : 'https://fonts.gstatic.com';
      const css = spec
        .split(';')
        .map(Number)
        .map((w) => {
          const ext = woff2 ? 'woff2' : 'ttf';
          const url = `${host}/s/${slug(family)}/v14/${w}.${ext}`;
          const format = woff2 ? 'woff2' : 'truetype';
          if (woff2 && o.sliced) {
            return [1, 2]
              .map(
                (n) =>
                  `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(${host}/s/x/${w}.${n}.woff2) format('woff2');\n  unicode-range: U+30${n}0-30${n}f;\n}`,
              )
              .join('\n');
          }
          return `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(${url}) format('${format}');\n}`;
        })
        .join('\n');
      return new Response(css);
    }
    if (u.origin === 'https://fonts.gstatic.com') {
      const weight = Number(/\/(\d+)\.(woff2|ttf)$/.exec(u.pathname)?.[1]);
      return new Response(fileFor(url, weight, u.pathname.endsWith('.woff2')));
    }
    return new Response('not found', { status: 404 });
  });
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  const add = (auth: Record<string, string>, family: string) =>
    request(t.app).post('/api/v1/fonts/google').set(auth).send({ family });
  const download = (auth: Record<string, string>, id: string, weight?: number) =>
    request(t.app)
      .get(`/api/v1/fonts/${id}/file`)
      .query(weight === undefined ? {} : { weight })
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  return { t, db, device, add, download, data: t.config.dataRoot };
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      for (const f of filesUnder(full)) out.push(`${name}/${f}`);
    } else out.push(name);
  }
  return out;
}

const fontsDir = (data: string) => path.join(data, '.uploads', 'fonts');

describe('google fonts: list and CSS', () => {
  it('keeps the Japanese families with the weights to store', () => {
    expect(parseFamilyList(familyList())).toEqual([
      { family: 'Hina Mincho', category: 'Serif', weights: [400] },
      { family: 'Noto Sans JP', category: 'Sans Serif', weights: [400, 700] },
      { family: 'Zen Old Mincho', category: 'Serif', weights: [400, 700] },
    ]);
    expect(parseFamilyList(familyList(false))).toHaveLength(3);
    expect(() => parseFamilyList('<html>')).toThrow(/not JSON/);
    expect(() => parseFamilyList('{}')).toThrow(/no families/);
  });

  it('stores 400 (or the weight nearest it) and 700 when there is one', () => {
    expect(storedWeights([100, 400, 700, 900])).toEqual([400, 700]);
    expect(storedWeights([400, 600])).toEqual([400]);
    expect(storedWeights([300, 500])).toEqual([300]);
    expect(storedWeights([700])).toEqual([700]);
    expect(storedWeights([])).toEqual([]);
  });

  it('builds the css2 address as Google writes it', () => {
    expect(cssUrl('Zen Old Mincho', [400, 700])).toBe(
      'https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@400;700',
    );
  });

  it('takes one whole file per weight, from fonts.gstatic.com only', () => {
    const face = (w: number, url: string, format = 'woff2', range = '') =>
      `@font-face { font-family: 'X'; font-style: normal; font-weight: ${w}; src: url(${url}) format('${format}');${range} }`;
    const g = 'https://fonts.gstatic.com/s/x/v1';
    expect(wholeFaces(face(400, `${g}/a.woff2`) + face(700, `${g}/b.woff2`), [400, 700])).toEqual([
      { weight: 400, url: `${g}/a.woff2`, format: 'woff2' },
      { weight: 700, url: `${g}/b.woff2`, format: 'woff2' },
    ]);
    expect(wholeFaces(face(400, `${g}/a.ttf`, 'truetype'), [400])?.[0].format).toBe('truetype');
    // Slices, a missing weight, two files for one weight, another format: not whole.
    expect(wholeFaces(face(400, `${g}/a.woff2`, 'woff2', ' unicode-range: U+3000;'), [400])).toBe(
      null,
    );
    expect(wholeFaces(face(400, `${g}/a.woff2`), [400, 700])).toBeNull();
    expect(wholeFaces(face(400, `${g}/a.woff2`) + face(400, `${g}/c.woff2`), [400])).toBeNull();
    expect(wholeFaces(face(400, `${g}/a.woff`, 'woff'), [400])).toBeNull();
    expect(() => wholeFaces(face(400, 'https://evil.example/a.woff2'), [400])).toThrow(
      /outside https:\/\/fonts.gstatic.com/,
    );
    expect(isGoogleFileUrl('http://fonts.gstatic.com/a')).toBe(false);
    expect(isGoogleFileUrl('https://fonts.gstatic.com.evil.example/a')).toBe(false);
    expect(isGoogleFileUrl('https://user@fonts.gstatic.com/a')).toBe(false);
    expect(isGoogleFileUrl('https://fonts.gstatic.com/s/a/v1/b.woff2')).toBe(true);
  });

  it('reads the copyright and license URL from woff2 and ttf files', () => {
    const o = { copyright: 'Copyright 2021 The Zen Old Mincho Project Authors', licenseUrl: OFL };
    const expected = { copyright: o.copyright, licenseDescription: null, licenseUrl: OFL };
    expect(readFontNames(testWoff2(o))).toEqual(expected);
    expect(readFontNames(testTtf(o))).toEqual(expected);
    expect(readFontNames(testWoff2({}))).toEqual({
      copyright: null,
      licenseDescription: null,
      licenseUrl: null,
    });
    const none = { copyright: null, licenseDescription: null, licenseUrl: null };
    expect(readFontNames(Buffer.from('wOF2 not really a font at all, just text'))).toEqual(none);
    expect(readFontNames(Buffer.from('PK'))).toEqual(none);
    expect(
      readFontNames(testTtf({ copyright: 'a\u0000b\n  c', licenseUrl: 'x'.repeat(900) })),
    ).toEqual({ copyright: 'a b c', licenseDescription: null, licenseUrl: 'x'.repeat(500) });
  });

  it('parses GOOGLE_FONTS_TIMEOUT_SECONDS', () => {
    const warnings: string[] = [];
    expect(parseFontConfig({}, warnings)).toEqual({ maxMb: 64, googleTimeoutSeconds: 60 });
    expect(parseFontConfig({ GOOGLE_FONTS_TIMEOUT_SECONDS: '120' }, warnings)).toEqual({
      maxMb: 64,
      googleTimeoutSeconds: 120,
    });
    expect(parseFontConfig({ GOOGLE_FONTS_TIMEOUT_SECONDS: '1' }, warnings)).toEqual({
      maxMb: 64,
      googleTimeoutSeconds: 60,
    });
    expect(warnings).toHaveLength(1);
  });
});

describe('google fonts: routes', () => {
  it('adds a family: regular and bold stored, the record reaches the other device', async () => {
    const stub = stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const b = await s.device('B');

    const res = await s.add(a.auth, 'Zen Old Mincho');
    expect(res.status).toBe(201);
    const font = res.body.font;
    expect(font).toMatchObject({
      name: 'Zen Old Mincho',
      fileName: 'ZenOldMincho-400.woff2',
      format: 'woff2',
      source: 'google',
      copyright: 'Copyright 2021 The zenoldmincho Project Authors',
      licenseUrl: OFL,
    });
    expect(font.faces).toEqual([
      { weight: 700, format: 'woff2', size: expect.any(Number), sha256: expect.any(String) },
    ]);

    // Only Google's list, its CSS (old Firefox User-Agent) and fonts.gstatic.com files.
    expect(stub.calls.map((c) => new URL(c.url).origin)).toEqual([
      'https://fonts.google.com',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://fonts.gstatic.com',
    ]);
    expect(stub.calls[1]).toEqual({
      url: 'https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@400;700',
      userAgent: WHOLE_WOFF2_USER_AGENT,
    });

    expect(filesUnder(fontsDir(s.data)).sort()).toEqual([
      `${font.id}/font-700.woff2`,
      `${font.id}/font.woff2`,
    ]);

    const record = (await b.pull()).find((r) => r.kind === 'font');
    expect(record).toMatchObject({ id: font.id, deviceId: a.deviceId, deletedAt: null });
    expect(record.data).toEqual({
      name: 'Zen Old Mincho',
      fileName: 'ZenOldMincho-400.woff2',
      format: 'woff2',
      size: font.size,
      sha256: font.sha256,
      createdAt: font.createdAt,
      source: 'google',
      copyright: font.copyright,
      licenseUrl: OFL,
      faces: font.faces,
    });

    // Both files come back byte for byte, with their own hashes.
    const regular = await s.download(b.auth, font.id);
    const bold = await s.download(b.auth, font.id, 700);
    const sources = [...stub.files.values()];
    expect(Buffer.compare(regular.body, sources[0])).toBe(0);
    expect(Buffer.compare(bold.body, sources[1])).toBe(0);
    expect(bold.headers['content-type']).toBe('font/woff2');
    expect(bold.headers['etag']).toBe(`"${font.faces[0].sha256}"`);
    expect((await s.download(b.auth, font.id, 900)).status).toBe(404);

    const list = await request(s.t.app).get('/api/v1/fonts').set(b.auth);
    expect(list.body.google).toBe(true);
    expect(list.body.fonts[0]).toMatchObject({ source: 'google', faces: font.faces });
  });

  it('lists the Japanese families with what adding each would do', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const upload = await request(s.t.app)
      .post('/api/v1/fonts')
      .query({ name: 'Hina Mincho', fileName: 'h.woff2' })
      .set(a.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(testWoff2());
    expect(upload.status).toBe(201);
    expect((await s.add(a.auth, 'Zen Old Mincho')).status).toBe(201);

    const res = await request(s.t.app).get('/api/v1/fonts/google').set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body.families).toEqual([
      { family: 'Hina Mincho', category: 'Serif', weights: [400], status: 'name_taken' },
      { family: 'Noto Sans JP', category: 'Sans Serif', weights: [400, 700], status: 'built_in' },
      { family: 'Zen Old Mincho', category: 'Serif', weights: [400, 700], status: 'added' },
    ]);
    expect((await request(s.t.app).get('/api/v1/fonts/google')).status).toBe(401);
  });

  it('stores a regular-only family as one file', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const font = (await s.add(a.auth, 'Hina Mincho')).body.font;
    expect(font.faces).toEqual([]);
    expect(filesUnder(fontsDir(s.data))).toEqual([`${font.id}/font.woff2`]);
  });

  it('takes whole TTF files when Google answers in slices', async () => {
    const stub = stubGoogle({ sliced: true });
    const s = await setup();
    const a = await s.device('A');
    const res = await s.add(a.auth, 'Zen Old Mincho');
    expect(res.status).toBe(201);
    expect(res.body.font).toMatchObject({ format: 'ttf', fileName: 'ZenOldMincho-400.ttf' });
    expect(res.body.font.faces[0].format).toBe('ttf');
    expect(stub.calls.filter((c) => c.url.includes('/css2')).map((c) => c.userAgent)).toEqual([
      WHOLE_WOFF2_USER_AGENT,
      null,
    ]);
    expect(filesUnder(fontsDir(s.data)).sort()).toEqual([
      `${res.body.font.id}/font-700.ttf`,
      `${res.body.font.id}/font.ttf`,
    ]);
  });

  it('refuses built-in, unknown and taken families, and unregistered devices', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const builtIn = await s.add(a.auth, 'Noto Sans JP');
    expect(builtIn.status).toBe(400);
    expect(builtIn.body.error.code).toBe('built_in');
    const roboto = await s.add(a.auth, 'Roboto');
    expect(roboto.status).toBe(404);
    expect(roboto.body.error.code).toBe('not_a_google_font');
    expect((await s.add(a.auth, '')).body.error.code).toBe('invalid_name');
    expect((await s.add(a.auth, 'Zen Old Mincho')).status).toBe(201);
    const again = await s.add(a.auth, 'Zen Old Mincho');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('name_taken');
    const unregistered = { Authorization: `Bearer ${s.t.newUserToken('new')}` };
    expect((await s.add(unregistered, 'Hina Mincho')).body.error.code).toBe(
      'device_not_registered',
    );
    expect(filesUnder(fontsDir(s.data))).toHaveLength(2);
  });

  it('says when Google is unreachable and leaves nothing behind', async () => {
    stubGoogle({ down: true });
    const s = await setup();
    const a = await s.device('A');
    const list = await request(s.t.app).get('/api/v1/fonts/google').set(a.auth);
    expect(list.status).toBe(502);
    expect(list.body.error).toMatchObject({ code: 'google_unreachable' });
    expect(list.body.error.message).toMatch(/can't be reached: getaddrinfo ENOTFOUND/);
    const res = await s.add(a.auth, 'Zen Old Mincho');
    expect(res.status).toBe(502);
    expect(filesUnder(fontsDir(s.data))).toEqual([]);
    expect((await a.pull()).filter((r) => r.kind === 'font')).toEqual([]);
  });

  it('never fetches files outside fonts.gstatic.com', async () => {
    const stub = stubGoogle({ foreignHost: true });
    const s = await setup();
    const a = await s.device('A');
    const res = await s.add(a.auth, 'Zen Old Mincho');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('google_unexpected');
    expect(stub.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    expect(filesUnder(fontsDir(s.data))).toEqual([]);
  });

  it('refuses a file over FONT_MAX_MB and removes what it downloaded', async () => {
    stubGoogle({ big: 2 * 1024 * 1024 });
    const s = await setup({ fonts: { maxMb: 1, googleTimeoutSeconds: 60 } });
    const a = await s.device('A');
    const res = await s.add(a.auth, 'Zen Old Mincho');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too_large');
    expect(filesUnder(fontsDir(s.data))).toEqual([]);
  });

  it('lets devices delete and restore a Google font, never change its weights', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const b = await s.device('B');
    const font = (await s.add(a.auth, 'Zen Old Mincho')).body.font;
    const data = (await b.pull()).find((r) => r.kind === 'font').data;
    const t0 = Date.now();
    const push = (d: unknown, at = t0) =>
      b.push([{ kind: 'font', id: font.id, updatedAt: at, data: d }]);
    const code = (r: any[]) => r.map((x) => x.error?.code ?? x.status);
    expect(code(await push({ ...data, faces: [] }))).toEqual(['invalid_data']);
    expect(code(await push({ ...data, faces: [{ ...data.faces[0], weight: 900 }] }))).toEqual([
      'invalid_data',
    ]);
    expect(code(await push({ ...data, licenseUrl: 'https://example.com' }))).toEqual([
      'invalid_data',
    ]);
    expect(code(await push({ ...data, source: 'upload' }))).toEqual(['invalid_data']);
    expect(
      code(await b.push([{ kind: 'font', id: font.id, updatedAt: t0 + 1, deletedAt: t0 + 1 }])),
    ).toEqual(['applied']);
    const families = (await request(s.t.app).get('/api/v1/fonts/google').set(a.auth)).body.families;
    expect(families.find((f: any) => f.family === 'Zen Old Mincho').status).toBe('available');
    // Files stay (restorable); restoring needs exactly the stored data.
    expect(filesUnder(fontsDir(s.data))).toHaveLength(2);
    expect(code(await push(data, t0 + 2))).toEqual(['applied']);
  });

  it('keeps an uploaded font record exactly as before', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const res = await request(s.t.app)
      .post('/api/v1/fonts')
      .query({ name: 'Mine', fileName: 'm.ttf' })
      .set(a.auth)
      .set('Content-Type', 'application/octet-stream')
      .send(testTtf());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.font).sort()).toEqual(
      ['createdAt', 'fileName', 'format', 'id', 'name', 'sha256', 'size'].sort(),
    );
    const record = (await a.pull()).find((r) => r.kind === 'font');
    expect(Object.keys(record.data).sort()).toEqual(
      ['createdAt', 'fileName', 'format', 'name', 'sha256', 'size'].sort(),
    );
    expect(s.db.prepare('SELECT source FROM fonts').get()).toEqual({ source: 'upload' });
  });

  it('lists Google fonts in cli fonts list', async () => {
    stubGoogle();
    const s = await setup();
    const a = await s.device('A');
    const font = (await s.add(a.auth, 'Zen Old Mincho')).body.font;
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
    expect(out).toMatch(
      new RegExp(`${font.id}.*Zen Old Mincho.*from Google Fonts  \\+700: \\d+ bytes$`, 'm'),
    );
    fs.rmSync(path.join(fontsDir(s.data), font.id, 'font-700.woff2'));
    const again = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', path.join('src', 'cli.ts'), 'fonts', 'list'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DB_DIR: s.t.config.dbDir, DATA_DIR: s.data },
        encoding: 'utf8',
      },
    );
    expect(again.stdout).toMatch(/\(file missing\)/);
  });
});
