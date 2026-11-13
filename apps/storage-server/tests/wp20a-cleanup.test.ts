/**
 * WP20a: the library cleanup in the storage server (cleanup.db, settings and secrets, the
 * sidecar's token, stage-1 analysis, batches, the reader-side handoff, Undo, the ingest
 * hold) on a synthetic Calibre library. The sidecar's side is played by the test through
 * the HTTP API; the Calibre writes it would make through the content server are simulated
 * on the fixture (that is the only place anything is written to the library).
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_SCHEMA_VERSION,
  cleanupDbPath,
  initCleanupDatabase,
} from '../src/cleanup/cleanup-db';
import { chooseKeeper, type SnapshotBook } from '../src/cleanup/stage1';
import { tagsToCopy } from '../src/cleanup/batches';
import { getSettings, isCustomTag, updateSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { calibreDate, fingerprint } from './helpers/calibre-fixture';
import { type CleanupEnv, healthyHeartbeat, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (fill: string, n = 4096) => Buffer.alloc(n, fill);
const iso = (y: number) => calibreDate(new Date(Date.UTC(y, 0, 1)));

describe('cleanup.db', () => {
  it('is created beside ttsu.db with its schema and refuses a newer file', () => {
    const dir = makeTempDir('db');
    const state = initCleanupDatabase(dir);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.schemaVersion).toBe(CLEANUP_SCHEMA_VERSION);
    expect(state.file).toBe(cleanupDbPath(dir));
    expect(
      (
        state.db.prepare('SELECT stage, mode FROM stages ORDER BY stage').all() as {
          mode: string;
        }[]
      ).map((r) => r.mode),
    ).toEqual(['off', 'off', 'off', 'off', 'off', 'off']);
    state.db.pragma(`user_version = ${CLEANUP_SCHEMA_VERSION + 1}`);
    state.db.close();
    const again = initCleanupDatabase(dir);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/newer than this server supports/);
  });

  it('a missing DB_DIR is reported, not thrown', () => {
    const r = initCleanupDatabase(path.join(makeTempDir('x'), 'nope'));
    expect(r.ok).toBe(false);
  });
});

describe('settings', () => {
  it('validates and keeps defaults', () => {
    const state = initCleanupDatabase(makeTempDir('db'));
    if (!state.ok) throw new Error(state.error);
    const db = state.db;
    expect(getSettings(db).pacing.batchSize).toBe(200);
    expect(getSettings(db).gateThresholdPercent).toBe(95);
    expect(() => updateSettings(db, { pacing: { batchSize: 501 } })).toThrow(/Batch size/);
    expect(() => updateSettings(db, { contentServerUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => updateSettings(db, { contentServerUrl: 'http://h:8083/#lib' })).toThrow(
      /library id/,
    );
    expect(() => updateSettings(db, { nope: 1 })).toThrow(/Unknown setting/);
    const s = updateSettings(db, {
      contentServerUrl: 'http://192.168.1.5:8083/',
      pacing: { batchSize: 3 },
    });
    expect(s.contentServerUrl).toBe('http://192.168.1.5:8083');
    expect(s.pacing).toEqual({ ...getSettings(db).pacing, batchSize: 3 });
    db.close();
  });

  it('matches custom tags case-insensitively with a trailing *', () => {
    const p = ['PeepoHappyBooks', 'TMW-collection-*'];
    expect(isCustomTag('peepohappybooks', p)).toBe(true);
    expect(isCustomTag('TMW-collection-13', p)).toBe(true);
    expect(isCustomTag('TMW-collectio', p)).toBe(false);
    expect(isCustomTag('ln', p)).toBe(false);
  });
});

describe('chooseKeeper', () => {
  const book = (id: number, tags: string[], year: number): SnapshotBook => ({
    calibreId: id,
    uuid: `u${id}`,
    title: 't',
    timestamp: Date.UTC(year, 0, 1),
    lastModified: null,
    filePath: '',
    formats: ['EPUB'],
    tags,
  });
  const tags = ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'];
  it('more custom tags wins, then the older record, then the lower id', () => {
    expect(chooseKeeper([book(1, [], 2019), book(2, ['alpindale'], 2022)], tags)).toEqual({
      keep: expect.objectContaining({ calibreId: 2 }),
      rule: 'tags',
    });
    expect(chooseKeeper([book(1, ['ln'], 2021), book(2, ['curated'], 2019)], tags)).toEqual({
      keep: expect.objectContaining({ calibreId: 2 }),
      rule: 'older',
    });
    expect(chooseKeeper([book(5, [], 2020), book(3, [], 2020)], tags).keep.calibreId).toBe(3);
  });
});

describe('tagsToCopy (decided 2026-11-13: your tags move to the kept copy)', () => {
  const ev = (removed: string[], kept: string[]) =>
    ({
      sha256: 'x',
      kept: { calibreId: 1, uuid: 'k', tags: kept },
      removed: {
        calibreId: 2,
        uuid: 'r',
        title: 't',
        tags: removed,
        formats: [],
        lastModified: null,
        filePath: '',
      },
    }) as Parameters<typeof tagsToCopy>[0];
  const tags = ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'];
  it('copies only your own tags the kept copy lacks', () => {
    expect(
      tagsToCopy(ev(['TMW-collection-13', 'needs-metadata'], ['TMW-collection-11']), tags),
    ).toEqual(['TMW-collection-13']);
    expect(tagsToCopy(ev(['PeepoHappyBooks', 'ln'], ['peepohappybooks']), tags)).toEqual([]);
    expect(tagsToCopy(ev(['curated'], []), tags)).toEqual([]);
  });
});

describe('stage 1, batches, handoff and Undo', () => {
  let env: CleanupEnv;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  let user: string;
  let apply: string;

  beforeEach(async () => {
    const made = await makeCleanupEnv();
    env = made.env;
    const A = bytes('a');
    const B = bytes('b', 5000);
    const C = bytes('c', 6000);
    ids = {
      A1: await env.lib.addBook({
        title: 'A',
        tags: ['PeepoHappyBooks'],
        timestamp: iso(2021),
        epub: A,
      }),
      A2: await env.lib.addBook({ title: 'A', tags: ['ln'], timestamp: iso(2019), epub: A }),
      B1: await env.lib.addBook({ title: 'B', timestamp: iso(2019), epub: B }),
      B2: await env.lib.addBook({ title: 'B', timestamp: iso(2021), epub: B }),
      B3: await env.lib.addBook({ title: 'B', timestamp: iso(2022), epub: B }),
      C1: await env.lib.addBook({
        title: 'C',
        timestamp: iso(2022),
        formats: ['EPUB', 'AZW3'],
        epub: C,
      }),
      C2: await env.lib.addBook({ title: 'C', timestamp: iso(2018), epub: C }),
      D1: await env.lib.addBook({ title: 'D', epub: bytes('d', 7000) }),
      D2: await env.lib.addBook({ title: 'D', epub: bytes('e', 7000) }),
      E: await env.lib.addBook({ title: 'E', epub: bytes('f', 8000) }),
    };
    await made.setup();
    uuids = {};
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    for (const [k, id] of Object.entries(ids)) {
      uuids[k] = (
        mdb.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }
      ).uuid;
    }
    mdb.close();
    user = env.userToken();
    apply = env.applyToken();
  });

  afterEach(async () => {
    await env.close();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function analyse(mode: 'analyse' | 'on' = 'analyse') {
    await request(env.app)
      .put('/api/v1/cleanup/stages/1')
      .set(auth(user))
      .send({ mode })
      .expect(200);
    for (let i = 0; i < 50; i++) {
      await env.service.tick();
      if (getStage(env.cleanupDb, 1).state === 'ready') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`analysis did not finish: ${JSON.stringify(getStage(env.cleanupDb, 1))}`);
  }

  async function ready() {
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: 'http://calibre:8081',
        calibreLibraryId: 'japanese-library',
        calibreUsername: 'u',
        backup: { confirmedAt: Date.now() },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: 'calibre-secret-pw' })
      .expect(200);
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(auth(apply))
      .send(healthyHeartbeat())
      .expect(200);
  }

  async function claimAndSaveSnapshot() {
    const claim = await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set(auth(apply))
      .expect(200);
    expect(claim.body.batch).not.toBeNull();
    const batch = claim.body.batch;
    const snap = await request(env.app)
      .get(`/api/v1/cleanup-apply/batches/${batch.id}/metadata-snapshot`)
      .set(auth(apply))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/snapshot-saved`)
      .set(auth(apply))
      .send({ sha256: sha(snap.body as Buffer) })
      .expect(200);
    return batch as {
      id: string;
      kind: string;
      items: {
        itemId: number;
        calibreId: number;
        uuid: string;
        sha256: string;
        kept: { uuid: string };
      }[];
    };
  }

  async function step(
    batchId: string,
    itemId: number,
    body: Record<string, unknown>,
    status = 200,
  ) {
    return request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batchId}/items/${itemId}`)
      .set(auth(apply))
      .send(body)
      .expect(status);
  }

  /** What the sidecar does for one item; the Calibre removal is simulated on the fixture. */
  async function removeItem(
    batchId: string,
    item: { itemId: number; calibreId: number; sha256: string },
  ) {
    await step(batchId, item.itemId, { step: 'verified' });
    await step(batchId, item.itemId, {
      step: 'exported',
      quarantineDir: `/quarantine/${batchId}/${item.calibreId}`,
      exportSha256: item.sha256,
    });
    await step(batchId, item.itemId, { step: 'tagged' });
    env.lib.removeBook(item.calibreId);
    await step(batchId, item.itemId, { step: 'removed' });
  }

  it('finds the identical copies, keeps by custom tags then age, and writes nothing to Calibre', async () => {
    const before = fingerprint(env.root.dir);
    await analyse();
    expect(fingerprint(env.root.dir)).toEqual(before);
    const res = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=1&limit=50')
      .set(auth(user))
      .expect(200);
    const removed = res.body.items
      .map((i: { calibre_id: number }) => i.calibre_id)
      .sort((a: number, b: number) => a - b);
    expect(removed).toEqual([ids.A2, ids.B2, ids.B3, ids.C1].sort((a, b) => a - b));
    const a2 = res.body.items.find((i: { calibre_id: number }) => i.calibre_id === ids.A2);
    expect(a2.class).toBe('auto');
    expect(a2.evidence.rule).toBe('tags');
    expect(a2.evidence.kept.calibreId).toBe(ids.A1);
    const c1 = res.body.items.find((i: { calibre_id: number }) => i.calibre_id === ids.C1);
    expect(c1.evidence.removed.extraFormats).toEqual(['AZW3']);
    expect(c1.evidence.kept.calibreId).toBe(ids.C2);
    const p = getStage(env.cleanupDb, 1).progress as Record<string, number>;
    expect(p.duplicateSets).toBe(3);
    expect(p.toRemove).toBe(4);
    expect(p.extraFormat).toBe(1);
    // Only same-size files were hashed (E has a size of its own).
    const hashed = env.cleanupDb
      .prepare('SELECT calibre_id FROM file_facts WHERE sha256 IS NOT NULL')
      .all()
      .map((r) => (r as { calibre_id: number }).calibre_id);
    expect(hashed).not.toContain(ids.E);
    expect(hashed).toContain(ids.D1);
    // Analysis only: nothing is planned.
    await ready();
    await env.service.tick();
    expect(env.service.batches.list()).toEqual([]);
  });

  it('applies a batch: snapshot first, steps acknowledged, handoff, ingest hold, then the next batch', async () => {
    await ready();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { batchSize: 2, maxBatchPercent: 10 } })
      .expect(200);
    // A2 (removed) has reader data, A1 (kept) has none: the sources swap.
    const a2Reader = env.readerBook(uuids.A2)!.bookId;
    const a1Reader = env.readerBook(uuids.A1)!.bookId;
    env.addReaderData(a2Reader);
    // B2 and B1 both have data: no swap.
    env.addReaderData(env.readerBook(uuids.B2)!.bookId);
    env.addReaderData(env.readerBook(uuids.B1)!.bookId);
    const recordsBefore = env.db.prepare('SELECT * FROM sync_records ORDER BY rev').all();

    await analyse('on');
    await env.service.tick();
    const [batch1] = env.service.batches.list();
    expect(batch1.itemCount).toBe(1); // 10 % of 10 books
    const batch = await (async () => {
      // A report before the snapshot is saved is refused.
      const c = await request(env.app)
        .post('/api/v1/cleanup-apply/claim')
        .set(auth(apply))
        .expect(200);
      await step(c.body.batch.id, c.body.batch.items[0].itemId, { step: 'verified' }, 409);
      // Let the lease run out and claim again with the snapshot.
      env.cleanupDb.prepare('UPDATE batches SET lease_expires_at = 1').run();
      return claimAndSaveSnapshot();
    })();
    expect(batch.id).toBe(batch1.id);
    expect(env.service.holdsIngest(env.libraryId())).toBe(true);
    const item = batch.items[0];
    expect(item.calibreId).toBe(ids.A2);
    // The exported file must be the analysed one.
    await step(batch.id, item.itemId, { step: 'verified' });
    await step(
      batch.id,
      item.itemId,
      { step: 'exported', quarantineDir: '/q', exportSha256: 'f'.repeat(64) },
      409,
    );
    await step(batch.id, item.itemId, {
      step: 'exported',
      quarantineDir: `/quarantine/${batch.id}/${item.calibreId}`,
      exportSha256: item.sha256,
    });
    // Removing before the tags were copied onto the kept copy is refused.
    await step(batch.id, item.itemId, { step: 'removed' }, 409);
    await step(batch.id, item.itemId, { step: 'tagged' });
    env.lib.removeBook(item.calibreId);
    await step(batch.id, item.itemId, { step: 'removed' });
    // The handoff: the data book now has A1's Calibre record; A1's empty book has A2's.
    expect(env.readerBook(uuids.A1)!.bookId).toBe(a2Reader);
    expect(env.readerBook(uuids.A2)!.bookId).toBe(a1Reader);
    // The indexer waits while the batch is claimed.
    await env.index();
    expect(env.readerBook(uuids.A2)!.missing).toBe(false);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    expect(env.service.holdsIngest(env.libraryId())).toBe(false);
    // No next batch until the indexer has taken this one in.
    await env.service.tick();
    expect(env.service.batches.open()).toBeNull();
    await env.index();
    expect(env.readerBook(uuids.A2)!.missing).toBe(true);
    expect(env.readerBook(uuids.A1)!.missing).toBe(false);
    await env.service.tick();
    const next = env.service.batches.open();
    expect(next).not.toBeNull();
    // Synced records were never touched by the handoff.
    expect(env.db.prepare('SELECT * FROM sync_records ORDER BY rev').all()).toEqual(recordsBefore);
    // The kept book's catalog entry shows A1's record again after the ingest.
    const shown = env.db.prepare('SELECT title FROM books WHERE id = ?').get(a2Reader) as {
      title: string;
    };
    expect(shown.title).toBe('A');
  });

  it('both copies with reader data: removed without a swap; Undo re-adds and re-binds a new UUID', async () => {
    await ready();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { batchSize: 500, maxBatchPercent: 10 } })
      .expect(200);
    const a1 = env.readerBook(uuids.A1)!.bookId;
    const a2 = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a1);
    env.addReaderData(a2);
    await analyse('on');
    await env.service.tick();
    const batch = await claimAndSaveSnapshot();
    await removeItem(batch.id, batch.items[0]);
    expect(env.readerBook(uuids.A1)!.bookId).toBe(a1);
    expect(env.readerBook(uuids.A2)!.bookId).toBe(a2);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/finish`)
      .set(auth(user))
      .send({})
      .expect(401);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    await env.index();
    expect(env.readerBook(uuids.A2)!.missing).toBe(true);

    // Undo: the re-add path (new Calibre id and UUID); the reader book keeps its id.
    const undo = await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    expect(undo.body.batch.kind).toBe('undo');
    const ub = await claimAndSaveSnapshot();
    expect(ub.kind).toBe('undo');
    const newId = await env.lib.addBook({ title: 'A', tags: ['ln'], epub: bytes('a') });
    const newUuid = (
      new Database(env.lib.dbFile, { readonly: true })
        .prepare('SELECT uuid FROM books WHERE id = ?')
        .get(newId) as {
        uuid: string;
      }
    ).uuid;
    await step(ub.id, ub.items[0].itemId, {
      step: 'restored',
      method: 'readd',
      calibreId: newId,
      uuid: newUuid,
    });
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${ub.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    await env.index();
    expect(env.readerBook(newUuid)).toEqual({ bookId: a2, missing: false });
    expect(env.service.batches.get(batch.id)!.state).toBe('undone');
    // The undone copy is not proposed again.
    await request(env.app).post('/api/v1/cleanup/stages/1/analyse').set(auth(user)).expect(200);
    await analyse('analyse');
    const res = await request(env.app)
      .get('/api/v1/cleanup/proposals?stage=1&state=proposed')
      .set(auth(user));
    expect(res.body.items.map((i: { calibre_uuid: string }) => i.calibre_uuid)).not.toContain(
      newUuid,
    );
  });

  it('Undo from the trash keeps the UUID and reverses the swap', async () => {
    await ready();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ pacing: { batchSize: 1, maxBatchPercent: 10 } })
      .expect(200);
    const a1 = env.readerBook(uuids.A1)!.bookId;
    const a2 = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a2);
    await analyse('on');
    await env.service.tick();
    const batch = await claimAndSaveSnapshot();
    await removeItem(batch.id, batch.items[0]);
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${batch.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    await env.index();
    expect(env.readerBook(uuids.A1)).toEqual({ bookId: a2, missing: false });
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    const ub = await claimAndSaveSnapshot();
    // Calibre's trash restore brings back the same id and UUID.
    const restoredId = await env.lib.addBook({ title: 'A', uuid: uuids.A2, epub: bytes('a') });
    await step(ub.id, ub.items[0].itemId, {
      step: 'restored',
      method: 'trash',
      calibreId: restoredId,
      uuid: uuids.A2,
    });
    await request(env.app)
      .post(`/api/v1/cleanup-apply/batches/${ub.id}/finish`)
      .set(auth(apply))
      .send({})
      .expect(200);
    await env.index();
    expect(env.readerBook(uuids.A2)).toEqual({ bookId: a2, missing: false });
    expect(env.readerBook(uuids.A1)).toEqual({ bookId: a1, missing: false });
  });

  it('pauses when a copy is no longer identical; waits for the safety checks', async () => {
    await analyse('on');
    await env.service.tick();
    expect(env.service.waiting).toMatch(/safety checks/);
    expect(env.service.batches.list()).toEqual([]);
    await ready();
    // A2's bytes change behind Calibre's back (same last_modified).
    fs.writeFileSync(env.lib.epubFile(ids.A2), bytes('z'));
    await env.service.tick();
    const stage = getStage(env.cleanupDb, 1);
    expect(stage.pauseReason).toBe('not_identical');
    expect(env.service.batches.list()).toEqual([]);
    await request(env.app).post('/api/v1/cleanup/stages/1/resume').set(auth(user)).expect(200);
    await env.service.tick();
    // The changed pair was skipped; the others go on.
    const open = env.service.batches.open();
    expect(open).not.toBeNull();
  });

  it('an expired lease makes the batch claimable again with its item states', async () => {
    await ready();
    await analyse('on');
    await env.service.tick();
    const batch = await claimAndSaveSnapshot();
    await step(batch.id, batch.items[0].itemId, { step: 'verified' });
    env.cleanupDb.prepare('UPDATE batches SET lease_expires_at = 1').run();
    expect(env.service.holdsIngest(env.libraryId())).toBe(false);
    const again = await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set(auth(apply))
      .expect(200);
    expect(again.body.batch.id).toBe(batch.id);
    expect(again.body.batch.items[0].state).toBe('verified');
    // Steps can't be skipped.
    await step(batch.id, batch.items[0].itemId, { step: 'removed' }, 409);
  });
});

describe('tokens, secrets and the routes', () => {
  let env: CleanupEnv;
  beforeEach(async () => {
    const made = await makeCleanupEnv();
    env = made.env;
    await made.setup();
  });
  afterEach(async () => {
    await env.close();
  });

  it("keeps the sidecar's and the user's tokens apart", async () => {
    const user = env.userToken();
    const apply = env.applyToken();
    await request(env.app).get('/api/v1/me').set('Authorization', `Bearer ${apply}`).expect(401);
    await request(env.app)
      .get('/api/v1/cleanup/status')
      .set('Authorization', `Bearer ${apply}`)
      .expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set('Authorization', `Bearer ${user}`)
      .expect(401);
    await request(env.app).post('/api/v1/cleanup-apply/heartbeat').expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set('Authorization', `Bearer ${apply}`)
      .send({})
      .expect(200);
  });

  it('secrets are write-only, encrypted at rest, and only the sidecar gets the password', async () => {
    const user = { Authorization: `Bearer ${env.userToken()}` };
    const apply = { Authorization: `Bearer ${env.applyToken()}` };
    const key = 'sk-ant-api03-very-secret-key-1234';
    const put = await request(env.app)
      .put('/api/v1/cleanup/secrets/anthropicApiKey')
      .set(user)
      .send({ value: key })
      .expect(200);
    expect(JSON.stringify(put.body)).not.toContain('very-secret');
    expect(put.body.secrets.anthropicApiKey).toMatchObject({ set: true, hint: '1234' });
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(user)
      .send({ value: 'pw-123' })
      .expect(200);
    const got = await request(env.app).get('/api/v1/cleanup/settings').set(user).expect(200);
    expect(JSON.stringify(got.body)).not.toContain('very-secret');
    expect(JSON.stringify(got.body)).not.toContain('pw-123');
    expect(got.body.secrets.calibrePassword).toEqual({
      set: true,
      hint: null,
      updatedAt: expect.any(Number),
    });
    const status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(JSON.stringify(status.body)).not.toContain('pw-123');
    // Not in the file in plain text.
    const raw = env.cleanupDb.prepare('SELECT ciphertext FROM secrets').all() as {
      ciphertext: Buffer;
    }[];
    for (const r of raw) {
      expect(r.ciphertext.toString('utf8')).not.toContain('very-secret');
      expect(r.ciphertext.toString('utf8')).not.toContain('pw-123');
    }
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(user)
      .send({ contentServerUrl: 'http://c:8081', calibreLibraryId: 'lib', calibreUsername: 'u' })
      .expect(200);
    const hb = await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({})
      .expect(200);
    expect(hb.body.calibre).toEqual({
      contentServerUrl: 'http://c:8081',
      libraryId: 'lib',
      username: 'u',
      password: 'pw-123',
    });
    await request(env.app).delete('/api/v1/cleanup/secrets/calibrePassword').set(user).expect(200);
    const hb2 = await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({})
      .expect(200);
    expect(hb2.body.calibre).toBeNull();
  });

  it("finds the content server's library id by itself", async () => {
    const user = { Authorization: `Bearer ${env.userToken()}` };
    const apply = { Authorization: `Bearer ${env.applyToken()}` };
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(user)
      .send({ contentServerUrl: 'http://c:8081', calibreUsername: 'u' })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(user)
      .send({ value: 'pw' });
    // Before the sidecar has listed the server's libraries: login without a library.
    let hb = await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({})
      .expect(200);
    expect(hb.body.calibre.libraryId).toBeNull();
    const claim = await request(env.app).post('/api/v1/cleanup-apply/claim').set(apply).expect(200);
    expect(claim.body).toEqual({
      batch: null,
      wait: 'The library on the content server is not known yet',
    });
    // The reader library's folder is japanese-library: that id is picked from the list.
    hb = await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({ libraries: ['english-library', 'japanese-library'] })
      .expect(200);
    expect(hb.body.calibre.libraryId).toBe('japanese-library');
    let status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(status.body.calibre).toEqual({
      id: 'japanese-library',
      auto: true,
      libraries: ['english-library', 'japanese-library'],
    });
    expect(
      status.body.checks.find((c: { name: string }) => c.name === 'library_found'),
    ).toMatchObject({
      ok: true,
      detail: 'japanese-library (found automatically)',
    });
    expect(status.body.checks.some((c: { name: string }) => c.name === 'backup_recorded')).toBe(
      false,
    );
    // Not on the list and more than one library: asked on the page.
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({ libraries: ['a', 'b'] });
    status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(status.body.calibre.id).toBeNull();
    expect(status.body.checks.find((c: { name: string }) => c.name === 'library_found').ok).toBe(
      false,
    );
    // One library only: that one.
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(apply)
      .send({ libraries: ['Books'] });
    status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(status.body.calibre.id).toBe('Books');
    // A library chosen on the page wins.
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(user)
      .send({ calibreLibraryId: 'other' });
    status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(status.body.calibre).toMatchObject({ id: 'other', auto: false });
  });

  it('stages 2-5 cannot be switched on; every stage starts off', async () => {
    const user = { Authorization: `Bearer ${env.userToken()}` };
    const status = await request(env.app).get('/api/v1/cleanup/status').set(user).expect(200);
    expect(status.body.available).toBe(true);
    expect(status.body.stages.map((s: { mode: string }) => s.mode)).toEqual([
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
    ]);
    await request(env.app)
      .put('/api/v1/cleanup/stages/2')
      .set(user)
      .send({ mode: 'on' })
      .expect(409);
    await request(env.app)
      .put('/api/v1/cleanup/stages/1')
      .set(user)
      .send({ mode: 'sideways' })
      .expect(400);
    expect(status.body.target.folder).toBe('japanese-library');
  });

  it('without cleanup.db the routes answer 503 and the rest of the API works', async () => {
    const { createApp } = await import('../src/app');
    const { testConfig } = await import('./helpers/test-app');
    const { initDatabase } = await import('../src/db/database');
    const { createToken } = await import('../src/db/tokens');
    const { listUsers } = await import('../src/db/users');
    const config = testConfig();
    const state = initDatabase(config.dbDir, config.dataRoot);
    if (!state.ok) throw new Error(state.error);
    const app = createApp({
      config,
      database: state,
      version: 't',
      cleanup: { service: null, error: 'test' },
    });
    const token = createToken(state.db, listUsers(state.db)[0].id, 'x').token;
    const s = await request(app)
      .get('/api/v1/cleanup/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(s.body).toEqual({ available: false, error: 'test' });
    await request(app)
      .get('/api/v1/cleanup/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    await request(app).post('/api/v1/cleanup-apply/heartbeat').expect(503);
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    state.db.close();
  });
});

describe('static guards', () => {
  const src = path.resolve(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(src);

  it('the storage server never runs calibredb (only the apply sidecar writes to Calibre)', () => {
    for (const f of files) {
      const text = fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      // No process is ever started with a calibre program, and the cleanup module starts none.
      expect(/(spawn|execFile|exec|fork)\w*\(\s*['"`][^'"`]*calibre/.test(text), f).toBe(false);
      if (f.includes(`${path.sep}cleanup${path.sep}`))
        expect(/child_process/.test(text), f).toBe(false);
    }
  });

  it('source-fs.ts (the only module touching Calibre) has no write functions', () => {
    const text = fs.readFileSync(path.join(src, 'calibre', 'source-fs.ts'), 'utf8');
    const code = text
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(
      /\b(writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|copyFile|truncate|utimes|chmod|chown|symlink|link)\s*\(/,
    );
    expect(code).not.toMatch(/open\([^)]*['"](w|wx|a|r\+)['"]/);
  });

  it('the cleanup module writes files only through batches.ts (its own cache copies)', () => {
    const WRITE =
      /\b(writeFile|appendFile|rename|unlink|rm|rmdir|mkdir|copyFile|truncate|utimes|createWriteStream)\s*\(/;
    for (const f of files.filter((x) => x.includes(`${path.sep}cleanup${path.sep}`))) {
      const code = fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      if (path.basename(f) === 'batches.ts') continue;
      expect(WRITE.test(code), f).toBe(false);
    }
  });
});
