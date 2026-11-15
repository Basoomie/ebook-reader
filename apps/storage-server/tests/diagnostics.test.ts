/**
 * Settings > Diagnostics (Season 2 §7): GET /api/v1/diagnostics reads the server's
 * version and build time, the devices, the PC worker's status and the cleanup helper's
 * last heartbeat, and writes nothing of its own.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AudioScanService } from '../src/audio/scan-service';
import { LATEST_SCHEMA_VERSION } from '../src/db/migrations';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { BUILD_INFO_FILE, readBuiltAt } from '../src/version';
import { type CleanupEnv, healthyHeartbeat, makeCleanupEnv } from './helpers/cleanup-env';
import type { IndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp, testConfig } from './helpers/test-app';
import { HITSUJI, HITSUJI_FOLDER, jobEnv } from './helpers/worker-env';
import { initDatabase } from '../src/db/database';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
const cleanups: CleanupEnv[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
  while (cleanups.length) await cleanups.pop()!.close();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/v1/diagnostics', () => {
  it('needs a user token', async () => {
    const t = makeTestApp();
    if (!t.database.ok) throw new Error('no database');
    await request(t.app).get('/api/v1/diagnostics').expect(401);
    const owner = listUsers(t.database.db)[0].id;
    const worker = createToken(t.database.db, owner, 'PC', Date.now(), 'worker').token;
    await request(t.app).get('/api/v1/diagnostics').set(bearer(worker)).expect(403);
  });

  it('reports the server, and the PC worker and cleanup helper as not set up', async () => {
    const t = makeTestApp();
    const res = await request(t.app)
      .get('/api/v1/diagnostics')
      .set(bearer(t.newUserToken()))
      .expect(200);
    expect(res.body.server).toEqual({
      version: '9.9.9-test',
      builtAt: null,
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
    expect(res.body.pcWorker).toEqual({ available: false });
    expect(res.body.cleanupHelper).toEqual({ available: false });
    expect(res.body.devices).toEqual([]);
    expect(typeof res.body.serverTime).toBe('number');
  });

  it('passes the build time through', async () => {
    const config = testConfig();
    const database = initDatabase(config.dbDir, config.dataRoot);
    if (!database.ok) throw new Error('no database');
    const app = createApp({ config, database, version: '1.0.0', builtAt: 1763164020000 });
    const token = createToken(database.db, listUsers(database.db)[0].id, 'PC').token;
    const res = await request(app).get('/api/v1/diagnostics').set(bearer(token)).expect(200);
    expect(res.body.server.builtAt).toBe(1763164020000);
    expect(res.body.server.version).toBe('1.0.0');
  });

  it('lists the devices that synced, with name, added and last sync, marking the caller', async () => {
    // seedDefaults: the server writes "Planned" as its pseudo-device "Server" (never seen).
    const t = makeTestApp({}, undefined, { seedDefaults: true });
    if (!t.database.ok) throw new Error('no database');
    const pseudo = t.database.db.prepare('SELECT id, last_seen_at FROM devices').all() as {
      id: string;
      last_seen_at: number | null;
    }[];
    expect(pseudo).toEqual([{ id: expect.any(String), last_seen_at: null }]);
    const register = async (label: string) => {
      const token = t.newUserToken(label);
      const id = randomUUID();
      await request(t.app)
        .post('/api/v1/devices/register')
        .set(bearer(token))
        .send({ deviceId: id })
        .expect(200);
      return { token, id };
    };
    const phone = await register('Phone');
    const pc = await register('PC');
    const res = await request(t.app).get('/api/v1/diagnostics').set(bearer(pc.token)).expect(200);
    const devices = res.body.devices as { id: string }[];
    expect(devices.map((d) => d.id).sort()).toEqual([phone.id, pc.id].sort());
    const byId = new Map(devices.map((d) => [d.id, d] as [string, unknown]));
    expect(byId.get(phone.id)).toEqual({
      id: phone.id,
      name: 'Phone',
      createdAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
      current: false,
    });
    expect(byId.get(pc.id)).toEqual({
      id: pc.id,
      name: 'PC',
      createdAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
      current: true,
    });
    // GET /devices itself is unchanged: it still lists the pseudo-device.
    const all = await request(t.app).get('/api/v1/devices').set(bearer(pc.token)).expect(200);
    expect(all.body.devices).toHaveLength(3);
  });

  it("shows the PC worker's state, its running job and how many wait", async () => {
    const t = await jobEnv({ envs, services });
    const diag = async () =>
      (await request(t.app).get('/api/v1/diagnostics').set(t.auth).expect(200)).body.pcWorker;

    expect(await diag()).toMatchObject({
      available: true,
      online: false,
      lastSeenAt: null,
      currentJob: null,
      waiting: 0,
    });

    await t.heartbeat({ version: '1.1.1' }).expect(200);
    await request(t.app)
      .put(`/api/v1/books/${t.bookId(HITSUJI)}/audio-link`)
      .set(t.auth)
      .send({
        audio: {
          state: 'linked',
          folderId: (
            t.e.db
              .prepare('SELECT id FROM audio_folders WHERE rel_path = ?')
              .get(HITSUJI_FOLDER) as { id: number }
          ).id,
        },
      })
      .expect(200);
    await t.queue(HITSUJI).expect(202);
    expect(await diag()).toMatchObject({
      online: true,
      paused: false,
      version: '1.1.1',
      currentJob: null,
      waiting: 1,
    });

    const claimed = await t.claim();
    const running = await diag();
    expect(running.waiting).toBe(0);
    expect(running.currentJob).toMatchObject({
      id: claimed.id,
      kind: 'sync_subtitles',
      bookTitle: HITSUJI,
      state: 'running',
    });
    expect(running.currentJob).not.toHaveProperty('userId');

    t.tick(10 * 60 * 1000);
    expect(await diag()).toMatchObject({ online: false, lastSeenAt: expect.any(Number) });
  });

  it("shows the cleanup helper's last heartbeat", async () => {
    const { env, setup } = await makeCleanupEnv();
    cleanups.push(env);
    await setup();
    const user = bearer(env.userToken());
    const diag = async () =>
      (await request(env.app).get('/api/v1/diagnostics').set(user).expect(200)).body.cleanupHelper;

    expect(await diag()).toEqual({ available: true, online: false, lastSeenAt: null });
    const before = Date.now();
    await request(env.app)
      .post('/api/v1/cleanup-apply/heartbeat')
      .set(bearer(env.applyToken()))
      .send(healthyHeartbeat())
      .expect(200);
    const seen = await diag();
    expect(seen.online).toBe(true);
    expect(seen.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe('readBuiltAt', () => {
  it('reads the build time the build writes, and null without one', () => {
    const dir = makeTempDir('build-info');
    expect(readBuiltAt(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, BUILD_INFO_FILE), JSON.stringify({ builtAt: 1763164020000 }));
    expect(readBuiltAt(dir)).toBe(1763164020000);
    fs.writeFileSync(path.join(dir, BUILD_INFO_FILE), '{"builtAt":"soon"}');
    expect(readBuiltAt(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, BUILD_INFO_FILE), 'not json');
    expect(readBuiltAt(dir)).toBeNull();
  });
});
