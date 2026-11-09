/**
 * WP6: search, EPUB download, signed thumbnail URLs and device pairing.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { likePattern, searchTerms } from '../src/catalog/queries';
import type { CalibreConfig } from '../src/config';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { createPairingCode, normalizePairingCode, redeemPairingCode } from '../src/db/pairing';
import { rotateSecret, THUMBNAIL_URL_SECRET } from '../src/db/secrets';
import { listUsers } from '../src/db/users';
import { CalibreRoot, copyRealFixture, fingerprint } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

async function realLibraryEnv() {
  const { root, folder } = copyRealFixture();
  const e = makeIndexerEnv(root);
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, folder);
  await e.indexer.tick();
  return { e, root, folder, libId, auth: { Authorization: `Bearer ${e.token()}` } };
}

async function syntheticEnv(
  books: Parameters<ReturnType<CalibreRoot['library']>['addBook']>[0][],
  overrides: Partial<CalibreConfig> = {},
) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const ids: number[] = [];
  for (const b of books) ids.push(await lib.addBook(b));
  const e = makeIndexerEnv(root.dir, overrides);
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  return { e, root, lib, ids, libId, auth: { Authorization: `Bearer ${e.token()}` } };
}

async function titles(e: IndexerEnv, auth: object, query: Record<string, string | number>) {
  const res = await request(e.app).get('/api/v1/books').query(query).set(auth);
  expect(res.status).toBe(200);
  return (res.body.books as { title: string }[]).map((b) => b.title).sort();
}

describe('search (GET /api/v1/books?q=)', () => {
  it('finds Japanese substrings in titles, authors and series', async () => {
    const { e, libId, auth } = await realLibraryEnv();
    expect(await titles(e, auth, { q: '薬屋' })).toEqual([
      '薬屋のひとりごと 1',
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 外伝',
    ]);
    // Author only (日向夏 is not in any title).
    expect(await titles(e, auth, { q: '日向夏' })).toHaveLength(3);
    // Every term must match (here: one title term and one author term).
    expect(await titles(e, auth, { q: '外伝　日向夏' })).toEqual(['薬屋のひとりごと 外伝']);
    expect(await titles(e, auth, { q: 'nothing like this' })).toEqual([]);
    expect(await titles(e, auth, { q: '薬屋', library: libId })).toHaveLength(3);
    expect(await titles(e, auth, { q: '薬屋', library: 'other' })).toEqual([]);
    // No q: unchanged behavior (all 5 books).
    expect(await titles(e, auth, {})).toHaveLength(5);
  });

  it('pages through search results with the same cursor rules', async () => {
    const { e, auth } = await realLibraryEnv();
    const first = await request(e.app)
      .get('/api/v1/books')
      .query({ q: '薬屋', limit: 2 })
      .set(auth);
    expect(first.body.books).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(e.app)
      .get('/api/v1/books')
      .query({ q: '薬屋', limit: 2, cursor: first.body.nextCursor })
      .set(auth);
    expect(second.body.books).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.books, ...second.body.books].map((b: { title: string }) => b.title);
    expect(new Set(all).size).toBe(3);
  });

  it('takes %, _ and ! literally and ignores ASCII case', async () => {
    const { e, auth } = await syntheticEnv([
      { title: '100% Pure' },
      { title: '50_50' },
      { title: 'Wow!' },
      { title: 'Plain', series: { name: 'MySeries', index: 2 } },
      { title: 'Other', authors: ['Ann Author'] },
    ]);
    expect(await titles(e, auth, { q: '%' })).toEqual(['100% Pure']);
    expect(await titles(e, auth, { q: '_' })).toEqual(['50_50']);
    expect(await titles(e, auth, { q: '!' })).toEqual(['Wow!']);
    expect(await titles(e, auth, { q: 'PURE' })).toEqual(['100% Pure']);
    expect(await titles(e, auth, { q: 'myseries' })).toEqual(['Plain']);
    expect(await titles(e, auth, { q: 'ann' })).toEqual(['Other']);
  });

  it('walks books in date order instead of sorting every source (60k-book speed)', async () => {
    const { e } = await realLibraryEnv();
    const plan = (
      e.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT b.id FROM books b
             CROSS JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'
             JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
             LEFT JOIN series se ON se.id = b.series_id
            ORDER BY b.added_at DESC, b.id DESC LIMIT 51`,
        )
        .all() as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan[0]).toBe('SCAN b USING INDEX books_added');
    expect(plan.join('\n')).not.toContain('TEMP B-TREE');
    // The query module uses the same join.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'catalog', 'queries.ts'), 'utf8');
    expect(src).toContain("CROSS JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'");
  });

  it('splits terms on any whitespace and escapes patterns', () => {
    expect(searchTerms('  a  b　c ')).toEqual(['a', 'b', 'c']);
    expect(searchTerms('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8);
    expect(searchTerms(undefined)).toEqual([]);
    expect(likePattern('5%_!')).toBe('%5!%!_!!%');
  });
});

describe('EPUB download (GET /api/v1/books/:id/file)', () => {
  it('streams the exact file and never writes to the library', async () => {
    const { e, root, folder, auth } = await realLibraryEnv();
    const before = fingerprint(root);
    const list = await request(e.app)
      .get('/api/v1/books')
      .query({ q: '薬屋のひとりごと 1' })
      .set(auth);
    const book = list.body.books.find((b: { title: string }) => b.title === '薬屋のひとりごと 1');
    const detail = await request(e.app).get(`/api/v1/books/${book.id}`).set(auth);
    const filePath: string = detail.body.sources[0].filePath;

    const res = await request(e.app)
      .get(`/api/v1/books/${book.id}/file`)
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/epub+zip');
    const expected = fs.readFileSync(path.join(root, folder, ...filePath.split('/')));
    expect(Number(res.headers['content-length'])).toBe(expected.length);
    expect(Buffer.compare(res.body as Buffer, expected)).toBe(0);
    expect(res.headers.etag).toMatch(/^"\d+-\d+"$/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(fingerprint(root)).toEqual(before);
  });

  it('needs a token and reports unknown, missing and vanished books', async () => {
    const { e, root, lib, ids, auth } = await syntheticEnv(
      [{ title: 'Stays' }, { title: 'Goes' }],
      { maxMissingPercent: 100 },
    );
    const books = (await request(e.app).get('/api/v1/books').set(auth)).body.books as {
      id: string;
      title: string;
    }[];
    const stays = books.find((b) => b.title === 'Stays')!;
    const goes = books.find((b) => b.title === 'Goes')!;

    expect((await request(e.app).get(`/api/v1/books/${stays.id}/file`)).status).toBe(401);
    const ok = await request(e.app).get(`/api/v1/books/${stays.id}/file`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-length']).toBe('1');

    const unknown = await request(e.app).get('/api/v1/books/nope/file').set(auth);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    // Calibre removes "Goes": the book is flagged missing and its file is not served.
    lib.removeBook(ids[1]);
    await e.indexer.tick();
    const missing = await request(e.app).get(`/api/v1/books/${goes.id}/file`).set(auth);
    expect(missing.status).toBe(410);
    expect(missing.body.error.code).toBe('missing');

    // The file disappears from disk while the index still lists the book.
    const detail = await request(e.app).get(`/api/v1/books/${stays.id}`).set(auth);
    fs.rmSync(path.join(root.dir, 'a', ...detail.body.sources[0].filePath.split('/')));
    const vanished = await request(e.app).get(`/api/v1/books/${stays.id}/file`).set(auth);
    expect(vanished.status).toBe(404);
    expect(vanished.body.error.code).toBe('file_missing');
  });

  it('never follows a stored path out of the library folder', async () => {
    const { e, auth } = await syntheticEnv([{ title: 'Sneaky' }]);
    const [book] = (await request(e.app).get('/api/v1/books').set(auth)).body.books;
    e.db
      .prepare('UPDATE book_sources SET file_path = ? WHERE book_id = ?')
      .run('../../../../etc/passwd', book.id);
    const res = await request(e.app).get(`/api/v1/books/${book.id}/file`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('file_missing');
  });

  it('answers 503 when the indexer is off', async () => {
    const { app, newUserToken } = makeTestApp();
    const res = await request(app)
      .get('/api/v1/books/x/file')
      .set({ Authorization: `Bearer ${newUserToken()}` });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('indexer_off');
  });
});

describe('signed thumbnail URLs', () => {
  it('lets a plain <img> load a listed thumbnail without the token', async () => {
    const { e, auth } = await realLibraryEnv();
    const books = (await request(e.app).get('/api/v1/books').set(auth)).body.books as {
      id: string;
      thumbnail: string;
    }[];
    const [a, b] = books;

    const res = await request(e.app).get(a.thumbnail).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');

    // A wrong signature is refused, unless the token is sent too.
    const tampered = a.thumbnail.replace(/s=[\w-]+/, 's=AAAAAAAAAAAAAAAAAAAAAA');
    expect((await request(e.app).get(tampered)).status).toBe(401);
    expect((await request(e.app).get(tampered).set(auth)).status).toBe(200);

    // A signature unlocks only its own book.
    const query = a.thumbnail.split('?')[1];
    const other = await request(e.app).get(`/api/v1/books/${b.id}/thumbnail?${query}`);
    expect(other.status).toBe(401);

    // No signature and no token.
    expect((await request(e.app).get(a.thumbnail.split('?')[0])).status).toBe(401);

    // Rotating the key invalidates every URL handed out before.
    rotateSecret(e.db, THUMBNAIL_URL_SECRET);
    expect((await request(e.app).get(a.thumbnail)).status).toBe(401);
    const fresh = (await request(e.app).get('/api/v1/books').set(auth)).body.books[0].thumbnail;
    expect(fresh).not.toBe(a.thumbnail);
    expect((await request(e.app).get(fresh)).status).toBe(200);
  });
});

describe('device pairing', () => {
  it('normalizes codes the way people type them', () => {
    expect(normalizePairingCode(' k7qm-3xwd ')).toBe('K7QM3XWD');
    expect(normalizePairingCode('O0 I1 L1')).toBe('001111');
  });

  it('trades a code once for a working token with the code label', async () => {
    const { app, database } = makeTestApp();
    if (!database.ok) throw new Error('no db');
    const user = listUsers(database.db)[0];
    const { code } = createPairingCode(database.db, user.id, 'Boox', 10);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const typed = code.toLowerCase().replace('-', ' ');
    const res = await request(app).post('/api/v1/pair').send({ code: typed });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Boox');
    expect(res.body.token).toMatch(/^ttsu_/);

    const me = await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${res.body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.token.label).toBe('Boox');

    const again = await request(app).post('/api/v1/pair').send({ code });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('invalid_code');

    const row = database.db.prepare('SELECT used_at, token_id FROM pairing_codes').get() as {
      used_at: number;
      token_id: string;
    };
    expect(row.used_at).toBeGreaterThan(0);
    expect(row.token_id).toBe(me.body.token.id);
    // Only the hash is stored.
    const stored = JSON.stringify(database.db.prepare('SELECT * FROM pairing_codes').all());
    expect(stored).not.toContain(code.replace('-', ''));
  });

  it('refuses expired codes and bad bodies', async () => {
    const { app, database } = makeTestApp();
    if (!database.ok) throw new Error('no db');
    const user = listUsers(database.db)[0];
    const old = createPairingCode(database.db, user.id, 'Old', 10, Date.now() - 11 * 60_000);
    expect((await request(app).post('/api/v1/pair').send({ code: old.code })).status).toBe(401);
    expect(redeemPairingCode(database.db, old.code)).toBeNull();
    expect((await request(app).post('/api/v1/pair').send({})).status).toBe(401);
    expect((await request(app).post('/api/v1/pair').send({ code: 42 })).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/pair').set('Content-Type', 'application/json').send('{x'))
        .status,
    ).toBe(400);
  });

  it('rate-limits wrong codes', async () => {
    const { app, database } = makeTestApp({
      pairing: { codeMinutes: 10, maxFailuresPerMinute: 3 },
    });
    if (!database.ok) throw new Error('no db');
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/v1/pair').send({ code: 'AAAA-AAAA' })).status).toBe(
        401,
      );
    }
    const { code } = createPairingCode(database.db, listUsers(database.db)[0].id, 'Late', 10);
    const blocked = await request(app).post('/api/v1/pair').send({ code });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');
  });

  it('adds the WP6 tables to an existing version-2 database without touching tokens', () => {
    const file = path.join(makeTempDir('db'), 'ttsu.db');
    const db = new Database(file);
    for (const m of MIGRATIONS.filter((m) => m.version <= 2)) db.exec(m.sql);
    db.pragma('user_version = 2');
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'owner', 1)").run();
    db.prepare(
      "INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES ('t1', 'u1', 'Phone', 'h', 1)",
    ).run();
    expect(migrate(db)).toBe(3);
    expect(db.prepare('SELECT label FROM api_tokens').all()).toEqual([{ label: 'Phone' }]);
    db.close();
  });
});
