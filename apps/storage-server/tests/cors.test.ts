import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from '../src/config';
import { makeTestApp } from './helpers/test-app';

const APP_ORIGIN = 'http://tower:3080';
const OTHER_ORIGIN = 'http://evil.example';

describe('parseCorsOrigins', () => {
  it('keeps the pre-WP1 default (*) when unset, with a warning', () => {
    for (const value of [undefined, '', '  ', '*']) {
      const warnings: string[] = [];
      expect(parseCorsOrigins(value, warnings)).toBe('*');
      expect(warnings[0]).toContain('allows any origin');
    }
  });

  it('parses and normalizes a comma-separated list', () => {
    const warnings: string[] = [];
    expect(
      parseCorsOrigins(
        ' http://Tower:3080/ , https://tower.tail1234.ts.net,http://tower:3080,http://100.64.0.1:3080',
        warnings,
      ),
    ).toEqual(['http://tower:3080', 'https://tower.tail1234.ts.net', 'http://100.64.0.1:3080']);
    expect(warnings).toEqual([]);
  });

  it('drops invalid entries with a warning', () => {
    const warnings: string[] = [];
    expect(parseCorsOrigins('tower:3080x, ftp://x, *, http://ok:1', warnings)).toEqual([
      'http://ok:1',
    ]);
    expect(warnings).toHaveLength(3);
  });

  it('warns when nothing valid is left', () => {
    const warnings: string[] = [];
    expect(parseCorsOrigins('nonsense', warnings)).toEqual([]);
    expect(warnings.some((w) => w.includes('no valid origins'))).toBe(true);
  });
});

describe('CORS with an explicit origin list', () => {
  const { app, newUserToken } = makeTestApp({ corsOrigins: [APP_ORIGIN] });
  const userToken = newUserToken();

  const routes = [{ name: 'api /api/v1/me', path: '/api/v1/me', auth: userToken }];

  for (const route of routes) {
    it(`${route.name}: allows the app origin`, async () => {
      const res = await request(app)
        .get(route.path)
        .set('Origin', APP_ORIGIN)
        .set('Authorization', `Bearer ${route.auth}`);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(res.headers['vary']).toContain('Origin');
      expect(res.headers['access-control-expose-headers']).toContain('Content-Range');
      expect(res.headers['access-control-expose-headers']).toContain('ETag');
      expect(res.headers['access-control-expose-headers']).toContain('Accept-Ranges');
    });

    it(`${route.name}: gives other origins no Access-Control-Allow-Origin`, async () => {
      const res = await request(app)
        .get(route.path)
        .set('Origin', OTHER_ORIGIN)
        .set('Authorization', `Bearer ${route.auth}`);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it(`${route.name}: answers preflight only for the app origin`, async () => {
      const ok = await request(app)
        .options(route.path)
        .set('Origin', APP_ORIGIN)
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(ok.headers['access-control-allow-headers']).toContain('authorization');

      const blocked = await request(app)
        .options(route.path)
        .set('Origin', OTHER_ORIGIN)
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', 'authorization');
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    });
  }

  it('does not affect clients that send no Origin (curl, workers)', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
  });
});
