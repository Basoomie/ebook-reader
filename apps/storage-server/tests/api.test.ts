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

describe('legacy endpoints next to the API', () => {
  it('keep working when the database is unavailable', async () => {
    const { app } = makeTestApp({}, unavailableDatabase());
    const auth = `Bearer ${LEGACY_TOKEN}`;
    const put = await request(app)
      .put('/file?path=book%2Fa.json')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send('{"x":1}');
    expect(put.status).toBe(200);
    const get = await request(app).get('/file?path=book%2Fa.json').set('Authorization', auth);
    expect(get.status).toBe(200);
    expect(get.text).toBe('{"x":1}');
    const list = await request(app).get('/list?path=book').set('Authorization', auth);
    expect(list.body.map((e: any) => e.name)).toEqual(['a.json']);
  });

  it('do not accept per-user tokens (they keep using AUTH_TOKEN until the client moves over)', async () => {
    const { app, newUserToken } = makeTestApp();
    const token = newUserToken();
    const res = await request(app).get('/list?path=').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    const file = await request(app).get(`/file?path=x&token=${token}`);
    expect(file.status).toBe(401);
  });

  it('still store JSON bodies raw (the API JSON parser does not leak into them)', async () => {
    const { app, config } = makeTestApp();
    const body = '{"a":   1}';
    await request(app)
      .put('/file?path=raw.json')
      .set('Authorization', `Bearer ${LEGACY_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(body);
    const fs = await import('fs');
    const path = await import('path');
    expect(fs.readFileSync(path.join(config.dataRoot, 'raw.json'), 'utf8')).toBe(body);
  });

  it('never expose the database through the file API', async () => {
    const { app } = makeTestApp();
    const res = await request(app)
      .get('/list?path=')
      .set('Authorization', `Bearer ${LEGACY_TOKEN}`);
    expect(res.body).toEqual([]);
  });
});
