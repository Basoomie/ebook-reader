/**
 * Season 2 "Cached book whose Calibre file changed": POST /api/v1/books/file-hashes, the
 * SHA-256 of each book's current EPUB (catalog/file-hashes.ts, migration 18). A changed
 * file gets a new hash; a metadata edit or a moved folder doesn't, and an unchanged file
 * is not read again.
 */
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { fileHashes } from '../src/catalog/file-hashes';
import { MIGRATIONS } from '../src/db/migrations';
import { listUsers } from '../src/db/users';
import { CalibreRoot, fingerprint } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

async function env(titles: string[]) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  const calibreIds: number[] = [];
  for (const title of titles) calibreIds.push(await lib.addBook({ title }));
  const e = makeIndexerEnv(root.dir, { maxMissingPercent: 100 });
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const auth = { Authorization: `Bearer ${e.token()}` };
  const books = (await request(e.app).get('/api/v1/books').set(auth)).body.books as {
    id: string;
    title: string;
  }[];
  const idOf = (title: string) => books.find((b) => b.title === title)!.id;
  return { e, root, lib, calibreIds, auth, idOf };
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function hashes(e: IndexerEnv, auth: object, ids: string[]) {
  const res = await request(e.app).post('/api/v1/books/file-hashes').set(auth).send({ ids });
  expect(res.status).toBe(200);
  return res.body.books as { id: string; sha256: string | null; etag: string | null }[];
}

function hashedAt(e: IndexerEnv, id: string): number | undefined {
  return (
    e.db.prepare('SELECT hashed_at FROM file_hashes WHERE book_id = ?').get(id) as
      | { hashed_at: number }
      | undefined
  )?.hashed_at;
}

async function download(e: IndexerEnv, auth: object, id: string) {
  return request(e.app).get(`/api/v1/books/${id}/file`).set(auth);
}

describe('book file hashes (POST /api/v1/books/file-hashes)', () => {
  it("answers the file's SHA-256 and the download's ETag, in the given order, read-only", async () => {
    const { e, root, lib, calibreIds, auth, idOf } = await env(['One', 'Two']);
    const before = fingerprint(root.dir);
    const [one, two] = [idOf('One'), idOf('Two')];
    const answer = await hashes(e, auth, [two, one]);
    expect(answer.map((a) => a.id)).toEqual([two, one]);
    expect(answer[1].sha256).toBe(sha(fs.readFileSync(lib.epubFile(calibreIds[0]))));
    expect(answer[1].etag).toBe((await download(e, auth, one)).headers.etag);
    expect(fingerprint(root.dir)).toEqual(before);
  });

  it('reads an unchanged file once; a replaced file is hashed again', async () => {
    const { e, lib, calibreIds, auth, idOf } = await env(['One']);
    const id = idOf('One');
    const first = (await hashes(e, auth, [id]))[0];
    const stamp = hashedAt(e, id);
    expect(stamp).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    expect((await hashes(e, auth, [id]))[0]).toEqual(first);
    expect(hashedAt(e, id)).toBe(stamp);

    const epub = Buffer.from('a new file with more text in it');
    lib.replaceEpub(calibreIds[0], epub);
    const second = (await hashes(e, auth, [id]))[0];
    expect(second.sha256).toBe(sha(epub));
    expect(second.sha256).not.toBe(first.sha256);
    expect(hashedAt(e, id)).not.toBe(stamp);
  });

  it('a metadata edit changes the ETag, not the hash, and reads nothing', async () => {
    const { e, lib, calibreIds, auth, idOf } = await env(['One']);
    const id = idOf('One');
    const first = (await hashes(e, auth, [id]))[0];
    const stamp = hashedAt(e, id);
    lib.exec((db) =>
      db
        .prepare('UPDATE books SET last_modified = ? WHERE id = ?')
        .run('2030-01-01 00:00:00+00:00', calibreIds[0]),
    );
    await e.indexer.tick();
    const after = (await hashes(e, auth, [id]))[0];
    expect(after.sha256).toBe(first.sha256);
    expect(after.etag).not.toBe(first.etag);
    expect(after.etag).toBe((await download(e, auth, id)).headers.etag);
    expect(hashedAt(e, id)).toBe(stamp);
  });

  it('a folder Calibre moved keeps its hash (found before the next index)', async () => {
    const { e, root, auth, idOf } = await env(['Old title']);
    const id = idOf('Old title');
    const first = (await hashes(e, auth, [id]))[0];
    const stamp = hashedAt(e, id);
    const detail = await request(e.app).get(`/api/v1/books/${id}`).set(auth);
    const oldFile = detail.body.sources[0].filePath as string;
    const libDir = path.join(root.dir, 'a');
    const oldFolder = path.posix.dirname(oldFile);
    const calId = Number(oldFolder.match(/\((\d+)\)$/)![1]);
    const newFolder = `${path.posix.dirname(oldFolder)}/New title (${calId})`;
    fs.mkdirSync(path.join(libDir, ...newFolder.split('/')), { recursive: true });
    fs.renameSync(
      path.join(libDir, ...oldFile.split('/')),
      path.join(libDir, ...newFolder.split('/'), 'New title - A.epub'),
    );
    const cal = new Database(path.join(libDir, 'metadata.db'));
    cal.prepare('UPDATE books SET path = ? WHERE id = ?').run(newFolder, calId);
    cal
      .prepare(`UPDATE data SET name = ? WHERE book = ? AND format = 'EPUB'`)
      .run('New title - A', calId);
    cal.close();
    const moved = (await hashes(e, auth, [id]))[0];
    expect(moved.sha256).toBe(first.sha256);
    expect(hashedAt(e, id)).toBe(stamp);
  });

  it('missing, vanished and unknown books answer null', async () => {
    const { e, root, lib, calibreIds, auth, idOf } = await env(['Stays', 'Goes']);
    const [stays, goes] = [idOf('Stays'), idOf('Goes')];
    lib.removeBook(calibreIds[1]);
    await e.indexer.tick();
    const detail = await request(e.app).get(`/api/v1/books/${stays}`).set(auth);
    fs.rmSync(path.join(root.dir, 'a', ...detail.body.sources[0].filePath.split('/')));
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(await hashes(e, auth, [goes, stays, unknown])).toEqual([
      { id: goes, sha256: null, etag: null },
      { id: stays, sha256: null, etag: null },
      { id: unknown, sha256: null, etag: null },
    ]);
  });

  it('an upload answers its content hash', async () => {
    const { e, idOf } = await env(['Upload']);
    const id = idOf('Upload');
    e.db
      .prepare(
        "UPDATE book_sources SET kind = 'upload', calibre_uuid = NULL, content_hash = ? WHERE book_id = ?",
      )
      .run('ab'.repeat(32), id);
    const user = listUsers(e.db)[0];
    const [answer] = await fileHashes(e.db, user, [id], {
      calibreDir: null,
      uploadSize: async () => 42,
    });
    expect(answer).toEqual({ id, sha256: 'ab'.repeat(32), etag: `"upload-${'ab'.repeat(32)}"` });
    const [gone] = await fileHashes(e.db, user, [id], {
      calibreDir: null,
      uploadSize: async () => null,
    });
    expect(gone.sha256).toBeNull();
  });

  it('needs a token and a list of at most 200 book ids', async () => {
    const { e, auth, idOf } = await env(['One']);
    const id = idOf('One');
    const post = (body: unknown, headers: object = auth) =>
      request(e.app)
        .post('/api/v1/books/file-hashes')
        .set(headers)
        .send(body as object);
    expect((await post({ ids: [id] }, {})).status).toBe(401);
    for (const body of [{}, { ids: 'x' }, { ids: ['nope'] }, { ids: Array(201).fill(id) }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_ids');
    }
  });

  it('answers null for every book when the indexer is off', async () => {
    const { app, newUserToken } = makeTestApp();
    const res = await request(app)
      .post('/api/v1/books/file-hashes')
      .set({ Authorization: `Bearer ${newUserToken()}` })
      .send({ ids: ['00000000-0000-4000-8000-000000000000'] });
    expect(res.status).toBe(200);
    expect(res.body.books[0].sha256).toBeNull();
  });

  it('migration 18 adds the file_hashes table', () => {
    expect(MIGRATIONS.find((m) => m.version === 18)?.sql).toContain('CREATE TABLE file_hashes');
  });
});
