import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../src/db/migrations';
import { listTokens, revokeToken } from '../src/db/tokens';
import { LEGACY_TOKEN, makeTestApp, unavailableDatabase } from './helpers/test-app';

describe('GET /api/v1/health', () => {
  it('needs no token and reports version and schema', async () => {
    const { app } = makeTestApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      version: '9.9.9-test',
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
  });

  it('answers 503 when the database is unavailable', async () => {
    const { app } = makeTestApp({}, unavailableDatabase());
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, database: 'unavailable' });
  });
});

describe('GET /api/v1/me', () => {
  it('returns the user and token for a valid per-user token', async () => {
    const { app, newUserToken } = makeTestApp();
    const token = newUserToken('Phone');
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'owner' });
    expect(res.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.token).toMatchObject({ label: 'Phone' });
  });

  it('rejects missing, wrong and malformed tokens with a JSON 401', async () => {
    const { app } = makeTestApp();
    for (const header of [undefined, 'Bearer ttsu_wrong', 'ttsu_no_bearer', 'Basic abc']) {
      const req = request(app).get('/api/v1/me');
      const res = await (header ? req.set('Authorization', header) : req);
      expect(res.status, String(header)).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'unauthorized', message: 'Missing, unknown or revoked token' },
      });
    }
  });

  it('rejects a revoked token', async () => {
    const { app, newUserToken, database } = makeTestApp();
    const token = newUserToken();
    if (!database.ok) throw new Error('db');
    revokeToken(database.db, listTokens(database.db)[0].id);
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('does not accept the legacy AUTH_TOKEN', async () => {
    const { app } = makeTestApp();
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${LEGACY_TOKEN}`);
    expect(res.status).toBe(401);
  });
});

describe('API routing and errors', () => {
  it('answers unknown routes with a JSON 404 (after auth)', async () => {
    const { app, newUserToken } = makeTestApp();
    const token = newUserToken();
    const res = await request(app).get('/api/v1/nope').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');

    const anon = await request(app).get('/api/v1/nope');
    expect(anon.status).toBe(401);
  });

  it('answers invalid JSON with a JSON 400', async () => {
    const { app, newUserToken } = makeTestApp();
    const token = newUserToken();
    const res = await request(app)
      .post('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('answers every non-health route with 503 when the database is unavailable', async () => {
    const { app } = makeTestApp({}, unavailableDatabase('disk on fire'));
    const res = await request(app).get('/api/v1/me').set('Authorization', 'Bearer ttsu_x');
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'database_unavailable',
      message: 'Database unavailable: disk on fire',
    });
  });
});

describe("the old sync's file endpoints (removed in WP15e)", () => {
  it('are gone, with either token, and write nothing into the data folder', async () => {
    const { app, config, newUserToken } = makeTestApp();
    const userToken = newUserToken();
    const fs = await import('fs');
    const before = fs.readdirSync(config.dataRoot);
    for (const token of [LEGACY_TOKEN, userToken]) {
      const auth = `Bearer ${token}`;
      expect((await request(app).get('/list?path=').set('Authorization', auth)).status).toBe(404);
      expect((await request(app).get('/file?path=a.json').set('Authorization', auth)).status).toBe(
        404,
      );
      expect((await request(app).get(`/file?path=a.json&token=${token}`)).status).toBe(404);
      expect(
        (await request(app).put('/file?path=a.json').set('Authorization', auth).send('{}')).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .put('/audio-file?path=b%2Faudio_1.mp3')
            .set('Authorization', auth)
            .send(Buffer.alloc(10))
        ).status,
      ).toBe(404);
      expect((await request(app).post('/mkdir?path=d').set('Authorization', auth)).status).toBe(
        404,
      );
      expect((await request(app).delete('/rmdir?path=d').set('Authorization', auth)).status).toBe(
        404,
      );
    }
    expect(fs.readdirSync(config.dataRoot)).toEqual(before);
  });

  it('are gone when the database is unavailable too', async () => {
    const { app } = makeTestApp({}, unavailableDatabase());
    const res = await request(app)
      .get('/list?path=')
      .set('Authorization', `Bearer ${LEGACY_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
