/**
 * Characterization tests for the storage-server endpoints that today's sync
 * (selfhost handler) and whispersync depend on. They were written against the
 * pre-WP1 server and must keep passing unmodified: they are the proof that the
 * legacy API behaves exactly as before.
 *
 * The server is started as a child process from src/index.ts, configured only
 * through environment variables, like the container.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, runUntilExit, spawnServer, SpawnedServer } from './helpers/spawn-server';

const TOKEN = 'legacy-test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let server: SpawnedServer;
let base: string;

function q(p: string): string {
  return encodeURIComponent(p);
}

beforeAll(async () => {
  // CORS_ORIGIN unset on purpose: the pre-WP1 default was '*'.
  server = await spawnServer({ AUTH_TOKEN: TOKEN, CORS_ORIGIN: undefined });
  base = server.baseUrl;
});

afterAll(async () => {
  await server?.stop();
});

describe('startup', () => {
  it('exits with code 1 when AUTH_TOKEN is missing', async () => {
    const { code, output } = await runUntilExit({
      AUTH_TOKEN: '',
      DATA_DIR: makeTempDir('data'),
      DB_DIR: makeTempDir('db'),
      PORT: '0',
    });
    expect(code).toBe(1);
    expect(output).toContain('AUTH_TOKEN');
  });

  it('exits with code 1 when DATA_DIR does not exist', async () => {
    const { code, output } = await runUntilExit({
      AUTH_TOKEN: TOKEN,
      DATA_DIR: path.join(makeTempDir('data'), 'missing'),
      DB_DIR: makeTempDir('db'),
      PORT: '0',
    });
    expect(code).toBe(1);
    expect(output).toContain('DATA_DIR does not exist');
  });
});

describe('auth', () => {
  const endpoints: [string, string][] = [
    ['GET', '/list?path='],
    ['GET', '/file?path=x.txt'],
    ['PUT', '/file?path=x.txt'],
    ['DELETE', '/file?path=x.txt'],
    ['POST', '/mkdir?path=d'],
    ['DELETE', '/rmdir?path=d'],
    ['PUT', '/audio-file?path=b%2Faudio_1.mp3'],
  ];

  for (const [method, url] of endpoints) {
    it(`${method} ${url.split('?')[0]} rejects a missing token with 401`, async () => {
      const res = await fetch(base + url, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it(`${method} ${url.split('?')[0]} rejects a wrong token with 401`, async () => {
      const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
    });
  }

  it('accepts ?token= on GET /file only', async () => {
    await fetch(`${base}/file?path=tok.txt`, { method: 'PUT', headers: AUTH, body: 'hi' });

    const get = await fetch(`${base}/file?path=tok.txt&token=${q(TOKEN)}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hi');

    const wrong = await fetch(`${base}/file?path=tok.txt&token=nope`);
    expect(wrong.status).toBe(401);

    const put = await fetch(`${base}/file?path=tok.txt&token=${q(TOKEN)}`, {
      method: 'PUT',
      body: 'x',
    });
    expect(put.status).toBe(401);

    const list = await fetch(`${base}/list?path=&token=${q(TOKEN)}`);
    expect(list.status).toBe(401);
  });
});

describe('GET /list', () => {
  it('returns [] for a missing directory', async () => {
    const res = await fetch(`${base}/list?path=${q('does/not/exist')}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('lists files and directories with size and lastModified', async () => {
    fs.mkdirSync(path.join(server.dataDir, 'listing', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(server.dataDir, 'listing', 'a.json'), '12345');

    const res = await fetch(`${base}/list?path=listing`, { headers: AUTH });
    expect(res.status).toBe(200);
    const entries = (await res.json()) as any[];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'a.json', isDirectory: false, size: 5 });
    expect(entries[1]).toMatchObject({ name: 'sub', isDirectory: true, size: 0 });
    expect(typeof entries[0].lastModified).toBe('number');
  });

  it('treats a leading slash as relative to the data root', async () => {
    const res = await fetch(`${base}/list?path=${q('/listing')}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).length).toBe(2);
  });

  it('rejects path traversal with 400', async () => {
    const res = await fetch(`${base}/list?path=${q('../')}`, { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid path' });
  });
});

describe('/file', () => {
  it('PUT creates parent dirs, returns lastModified, and GET round-trips bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const put = await fetch(`${base}/file?path=${q('book/deep/data.bin')}`, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { lastModified: number };
    expect(typeof body.lastModified).toBe('number');
    expect(fs.readFileSync(path.join(server.dataDir, 'book', 'deep', 'data.bin'))).toEqual(bytes);

    const get = await fetch(`${base}/file?path=${q('book/deep/data.bin')}`, { headers: AUTH });
    expect(get.status).toBe(200);
    expect(get.headers.get('last-modified')).toBeTruthy();
    expect(get.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
  });

  it('stores JSON bodies raw, whatever the Content-Type', async () => {
    const json = '{"a": 1,   "b": [1,2]}';
    await fetch(`${base}/file?path=${q('book/raw.json')}`, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: json,
    });
    expect(fs.readFileSync(path.join(server.dataDir, 'book', 'raw.json'), 'utf8')).toBe(json);

    const get = await fetch(`${base}/file?path=${q('book/raw.json')}`, { headers: AUTH });
    expect(get.headers.get('content-type')).toContain('application/json');
    expect(await get.text()).toBe(json);
  });

  it('GET supports Range requests (206)', async () => {
    await fetch(`${base}/file?path=${q('book/range.txt')}`, {
      method: 'PUT',
      headers: AUTH,
      body: '0123456789',
    });
    const res = await fetch(`${base}/file?path=${q('book/range.txt')}`, {
      headers: { ...AUTH, Range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('2345');
  });

  it('GET returns 404 for a missing file', async () => {
    const res = await fetch(`${base}/file?path=${q('nope/missing.txt')}`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('rejects path traversal with 400 on GET, PUT and DELETE', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/file?path=${q('../escape.txt')}`, {
        method,
        headers: AUTH,
        body: method === 'PUT' ? 'x' : undefined,
      });
      expect(res.status, method).toBe(400);
    }
  });

  it('DELETE removes a file, then 404s', async () => {
    await fetch(`${base}/file?path=${q('book/del.txt')}`, {
      method: 'PUT',
      headers: AUTH,
      body: 'x',
    });
    const del = await fetch(`${base}/file?path=${q('book/del.txt')}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(fs.existsSync(path.join(server.dataDir, 'book', 'del.txt'))).toBe(false);

    const again = await fetch(`${base}/file?path=${q('book/del.txt')}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(again.status).toBe(404);
  });
});

describe('progress file conflict (409)', () => {
  const dir = 'progress-book';
  const put = (name: string) =>
    fetch(`${base}/file?path=${q(`${dir}/${name}`)}`, { method: 'PUT', headers: AUTH, body: '{}' });

  it('rejects an older progress file and accepts newer ones', async () => {
    expect((await put('progress_7_0_2000_0.5.json')).status).toBe(200);

    const older = await put('progress_7_0_1000_0.4.json');
    expect(older.status).toBe(409);
    expect(await older.json()).toEqual({ error: 'Conflict: existing progress file is newer' });
    expect(fs.existsSync(path.join(server.dataDir, dir, 'progress_7_0_1000_0.4.json'))).toBe(false);

    expect((await put('progress_7_0_3000_0.6.json')).status).toBe(200);
  });

  it('allows re-uploading the same progress filename', async () => {
    expect((await put('progress_7_0_3000_0.6.json')).status).toBe(200);
  });

  it('does not apply the check to non-progress files or unparseable names', async () => {
    expect((await put('stats_1.json')).status).toBe(200);
    expect((await put('progress_bad.json')).status).toBe(200);
  });
});

describe('/mkdir and /rmdir', () => {
  it('mkdir is idempotent', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/mkdir?path=${q('made/here')}`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(fs.statSync(path.join(server.dataDir, 'made', 'here')).isDirectory()).toBe(true);
  });

  it('rmdir deletes recursively, then 404s', async () => {
    fs.mkdirSync(path.join(server.dataDir, 'gone', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(server.dataDir, 'gone', 'inner', 'f.txt'), 'x');

    const res = await fetch(`${base}/rmdir?path=gone`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(server.dataDir, 'gone'))).toBe(false);

    const again = await fetch(`${base}/rmdir?path=gone`, { method: 'DELETE', headers: AUTH });
    expect(again.status).toBe(404);
  });

  it('rmdir refuses to delete the data root', async () => {
    for (const p of ['', '/', '.']) {
      const res = await fetch(`${base}/rmdir?path=${q(p)}`, { method: 'DELETE', headers: AUTH });
      expect(res.status, `path=${JSON.stringify(p)}`).toBe(400);
      expect(await res.json()).toEqual({ error: 'Cannot delete data root' });
    }
    expect(fs.existsSync(server.dataDir)).toBe(true);
  });

  it('rmdir rejects path traversal', async () => {
    const res = await fetch(`${base}/rmdir?path=${q('../x')}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(400);
  });
});

describe('PUT /audio-file', () => {
  it('streams an audio_ file to disk and leaves no .tmp behind', async () => {
    const audio = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await fetch(`${base}/audio-file?path=${q('audio-book/audio_1.mp3')}`, {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'audio/mpeg' },
      body: audio,
    });
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as any).lastModified).toBe('number');

    const dir = path.join(server.dataDir, 'audio-book');
    expect(fs.readdirSync(dir)).toEqual(['audio_1.mp3']);
    expect(fs.statSync(path.join(dir, 'audio_1.mp3')).size).toBe(audio.length);

    const ranged = await fetch(`${base}/file?path=${q('audio-book/audio_1.mp3')}`, {
      headers: { ...AUTH, Range: 'bytes=0-9' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toContain('audio/mpeg');
  });

  it('rejects filenames without the audio_ prefix', async () => {
    const res = await fetch(`${base}/audio-file?path=${q('audio-book/song.mp3')}`, {
      method: 'PUT',
      headers: AUTH,
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Filename must start with audio_' });
  });

  it('rejects path traversal', async () => {
    const res = await fetch(`${base}/audio-file?path=${q('../audio_1.mp3')}`, {
      method: 'PUT',
      headers: AUTH,
      body: 'x',
    });
    expect(res.status).toBe(400);
  });
});

describe('CORS with the default origin setting', () => {
  it('allows any origin and exposes the range headers', async () => {
    const res = await fetch(`${base}/list?path=`, {
      headers: { ...AUTH, Origin: 'http://anywhere.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    for (const h of ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Last-Modified']) {
      expect(exposed).toContain(h);
    }
  });

  it('answers preflight requests for authorized writes', async () => {
    const res = await fetch(`${base}/file?path=x`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://anywhere.example',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});
