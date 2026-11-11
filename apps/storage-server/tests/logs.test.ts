/**
 * WP18: the server's recent log lines for the bug report.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { initDatabase } from '../src/db/database';
import { createPairingCode } from '../src/db/pairing';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { captureConsole, MAX_LOG_LINE_CHARS, RecentLogs } from '../src/logs/recent-logs';
import { REDACTED } from '../src/logs/redact';
import { makeTempDir } from './helpers/spawn-server';
import { testConfig } from './helpers/test-app';

const TOKEN = `ttsu_${'a1B2c3D4e5'.repeat(4)}xyz`;

function fakeConsole() {
  const printed: [string, unknown[]][] = [];
  const target = {
    log: (...a: unknown[]) => printed.push(['log', a]),
    info: (...a: unknown[]) => printed.push(['info', a]),
    warn: (...a: unknown[]) => printed.push(['warn', a]),
    error: (...a: unknown[]) => printed.push(['error', a]),
  } as unknown as Console;
  return { target, printed };
}

describe('RecentLogs', () => {
  it('keeps every console line and still prints it', () => {
    const logs = new RecentLogs(10, 1000);
    const { target, printed } = fakeConsole();
    const restore = captureConsole(logs, target);
    target.log('Database: %s (schema v%d)', '/db/ttsu.db', 8);
    target.warn('Warning:', { a: 1 });
    target.error(new Error('boom'));
    target.info('info line');
    restore();
    target.log('after restore');

    expect(printed.map(([level]) => level)).toEqual(['log', 'warn', 'error', 'info', 'log']);
    const { lines, startedAt } = logs.snapshot();
    expect(startedAt).toBe(1000);
    expect(lines.map((l) => [l.level, l.text.split('\n')[0]])).toEqual([
      ['log', 'Database: /db/ttsu.db (schema v8)'],
      ['warn', 'Warning: { a: 1 }'],
      ['error', 'Error: boom'],
      ['info', 'info line'],
    ]);
    expect(lines[2].text).toContain('at '); // the stack
    expect(lines.every((l) => typeof l.time === 'number')).toBe(true);
  });

  it('keeps the newest lines up to the limit and cuts long lines', () => {
    const logs = new RecentLogs(3);
    for (let i = 0; i < 5; i++) logs.add('log', [`line ${i}`]);
    logs.add('log', ['x'.repeat(MAX_LOG_LINE_CHARS + 10)]);
    const snap = logs.snapshot();
    expect(snap.lines.map((l) => l.text.slice(0, 6))).toEqual(['line 3', 'line 4', 'xxxxxx']);
    expect(snap.dropped).toBe(3);
    expect(snap.lines[2].text).toMatch(/… \(10 more characters cut\)$/);
    logs.configure({ maxLines: 1 });
    expect(logs.snapshot()).toMatchObject({ maxLines: 1, dropped: 5 });
  });

  it('removes tokens, pairing codes and AUTH_TOKEN when capturing', () => {
    const logs = new RecentLogs();
    logs.add('log', [`token ${TOKEN}`]);
    logs.add('error', ['request failed', { headers: { authorization: `Bearer ${TOKEN}` } }]);
    logs.add('log', ['GET /file?token=the-legacy-secret&name=a']);
    logs.add('log', ['Pairing code 7K3M-Q9TZ for "Boox" (valid 10 min)']);
    logs.add('warn', ['body {"code":"7k3m-q9tz"} was not JSON']);
    logs.add('log', ['legacy secret the-legacy-secret in a path']);
    logs.configure({ secrets: ['the-legacy-secret'] });
    logs.add('log', ['later: the-legacy-secret']);
    const text = JSON.stringify(logs.snapshot());
    expect(text).not.toContain(TOKEN.slice(5));
    expect(text).not.toContain('7K3M-Q9TZ');
    expect(text).not.toContain('7k3m-q9tz');
    expect(text).not.toContain('the-legacy-secret');
    expect(text).toContain(REDACTED);
    expect(text).toContain('for \\"Boox\\"');
  });
});

describe('GET /logs/recent', () => {
  function app() {
    const config = testConfig();
    const database = initDatabase(config.dbDir, config.dataRoot);
    if (!database.ok) throw new Error('no database');
    const logs = new RecentLogs(50, 1234);
    const created = createApp({ config, database, version: '9.9.9-test', logs });
    const [owner] = listUsers(database.db);
    return { app: created, db: database.db, owner, logs };
  }

  it('needs a token', async () => {
    expect((await request(app().app).get('/api/v1/logs/recent')).status).toBe(401);
  });

  it('returns the lines with the server version, secrets removed', async () => {
    const t = app();
    const { token } = createToken(t.db, t.owner.id, 'Desktop');
    const code = createPairingCode(t.db, t.owner.id, 'Phone', 10);
    t.logs.add('log', ['Collections: created "Planned"']);
    t.logs.add('log', [`Pairing: ${code.code} given for Phone with token ${token}`]);
    const res = await request(t.app)
      .get('/api/v1/logs/recent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ startedAt: 1234, maxLines: 50, dropped: 0 });
    expect(typeof res.body.serverVersion).toBe('string');
    expect(res.body.lines.map((l: { text: string }) => l.text)).toEqual([
      'Collections: created "Planned"',
      `Pairing: ${REDACTED} given for Phone with token ttsu_${REDACTED}`,
    ]);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(code.code);
  });
});

describe('LOG_BUFFER_LINES', () => {
  it('defaults to 2000 and falls back on bad values', () => {
    const base = { AUTH_TOKEN: 'x', DATA_DIR: makeTempDir('data') };
    expect(loadConfig(base).config.logs.bufferLines).toBe(2000);
    expect(loadConfig({ ...base, LOG_BUFFER_LINES: '500' }).config.logs.bufferLines).toBe(500);
    const bad = loadConfig({ ...base, LOG_BUFFER_LINES: 'lots' });
    expect(bad.config.logs.bufferLines).toBe(2000);
    expect(bad.warnings.join('\n')).toMatch(/LOG_BUFFER_LINES/);
  });
});
