import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { copyRealFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

/** Search suggestions (search palette step 1): GET /api/v1/names. */

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
  return { e, libId, auth: { Authorization: `Bearer ${e.token()}` } };
}

describe('GET /names', () => {
  it('requires a token and a known field', async () => {
    const { e, auth } = await realLibraryEnv();
    expect((await request(e.app).get('/api/v1/names?field=tag')).status).toBe(401);
    const bad = await request(e.app).get('/api/v1/names?field=title').set(auth);
    expect(bad.status).toBe(400);
  });

  it('counts each name like the group cards do', async () => {
    const { e, auth } = await realLibraryEnv();
    for (const by of ['series', 'author', 'tag'] as const) {
      const groups = await request(e.app).get(`/api/v1/groups?by=${by}&limit=200`).set(auth);
      expect(groups.status).toBe(200);
      const want = new Map<string, number>(
        groups.body.groups
          .filter((g: { name: string | null }) => g.name !== null)
          .map((g: { name: string; bookCount: number }) => [g.name, g.bookCount]),
      );
      const res = await request(e.app).get(`/api/v1/names?field=${by}&limit=50`).set(auth);
      expect(res.status).toBe(200);
      const got = new Map<string, number>(
        res.body.names.map((n: { name: string; count: number }) => [n.name, n.count]),
      );
      expect(got, by).toEqual(want);
    }
  });

  it('filters by the text folded like the search, best first', async () => {
    const { e, auth } = await realLibraryEnv();
    const res = await request(e.app)
      .get('/api/v1/names')
      .query({ field: 'author', text: '日向' })
      .set(auth);
    expect(res.body.names[0]).toMatchObject({ name: '日向夏' });
    const series = await request(e.app)
      .get('/api/v1/names')
      .query({ field: 'series', text: 'ひとりごと', limit: 1 })
      .set(auth);
    expect(series.body.names).toHaveLength(1);
    const none = await request(e.app)
      .get('/api/v1/names')
      .query({ field: 'tag', text: 'no such tag at all' })
      .set(auth);
    expect(none.body.names).toEqual([]);
  });

  it('only counts books of the asked library', async () => {
    const { e, auth } = await realLibraryEnv();
    const res = await request(e.app)
      .get('/api/v1/names')
      .query({ field: 'author', library: 'no-such-library' })
      .set(auth);
    expect(res.body.names).toEqual([]);
  });
});
