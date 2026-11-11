/**
 * WP12a: reading sessions (`stat-session`), their corrections (`stat-session-fix`)
 * and the frozen `stat-day` kind.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_CONFIG, parseSyncConfig } from '../src/config';
import { listUsers } from '../src/db/users';
import { parseStatSessionId } from '../src/sync/kinds';
import { SyncStore } from '../src/sync/store';
import { makeTestApp } from './helpers/test-app';

function insertBook(db: Database.Database): string {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'lib', 'Lib', ?, ?)`,
  ).run(now, now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', 'Book', ?, ?, ?)`,
  ).run(id, now, now, now);
  return id;
}

async function setup(overrides: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(overrides);
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  async function device(label: string) {
    const auth = { Authorization: `Bearer ${t.newUserToken(label)}` };
    const id = randomUUID();
    const reg = await request(t.app)
      .post('/api/v1/devices/register')
      .set(auth)
      .send({ deviceId: id });
    expect(reg.status).toBe(200);
    const push = async (changes: unknown[]) =>
      (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body.results as any[];
    return { id, push };
  }
  return { db, device, userId: listUsers(db)[0].id };
}

const codes = (results: any[]) => results.map((r) => r.error?.code ?? r.status);

const session = (extra: Record<string, unknown> = {}) => ({
  day: '2026-11-12',
  startedAt: 1_790_000_000_000,
  endedAt: 1_790_000_600_000,
  seconds: 540,
  chars: 9000,
  lookups: 3,
  readThroughId: null,
  source: 'tracker',
  closed: false,
  ...extra,
});

describe('ids', () => {
  it('parses session ids', () => {
    const [b, d, s] = [randomUUID(), randomUUID(), randomUUID()];
    expect(parseStatSessionId(`${b}:${d}:${s}`)).toEqual({ bookId: b, deviceId: d, sessionId: s });
    expect(parseStatSessionId(`${b}:${d}`)).toBeNull();
    expect(parseStatSessionId(`${b}:${d}:x`)).toBeNull();
  });
});

describe('stat-session kind', () => {
  it('accepts a session from its own device and refuses other devices', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const a = await t.device('A');
    const b = await t.device('B');
    const id = `${book}:${a.id}:${randomUUID()}`;
    expect(
      codes(await a.push([{ kind: 'stat-session', id, updatedAt: 1, data: session() }])),
    ).toEqual(['applied']);
    // B can neither change A's session nor write a session in A's name.
    expect(
      codes(
        await b.push([{ kind: 'stat-session', id, updatedAt: 5, data: session({ chars: 1 }) }]),
      ),
    ).toEqual(['not_owner']);
    // The owner updates it while open, then seals it.
    expect(
      codes(
        await a.push([
          { kind: 'stat-session', id, updatedAt: 2, data: session({ chars: 9500 }) },
          { kind: 'stat-session', id, updatedAt: 3, data: session({ chars: 9600, closed: true }) },
        ]),
      ),
    ).toEqual(['applied', 'applied']);
    // Sealed: nothing changes it any more, the refusal carries the server's copy.
    const after = await a.push([
      { kind: 'stat-session', id, updatedAt: 4, data: session({ chars: 1, closed: true }) },
    ]);
    expect(codes(after)).toEqual(['session_sealed']);
    expect(after[0].record.data).toMatchObject({ chars: 9600, closed: true });
    // Never deleted.
    expect(codes(await a.push([{ kind: 'stat-session', id, updatedAt: 6, deletedAt: 6 }]))).toEqual(
      ['not_deletable'],
    );
  });

  it('validates ids and payloads', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const a = await t.device('A');
    const sid = () => `${book}:${a.id}:${randomUUID()}`;
    const bad = [
      session({ day: '2026-11-1' }),
      session({ endedAt: 1 }),
      session({ seconds: -1 }),
      session({ seconds: 1.5 }),
      session({ seconds: 2 * 86_400 + 1 }),
      session({ chars: '9' }),
      session({ lookups: -2 }),
      session({ source: 'manual' }),
      session({ source: 'completion' }),
      session({ readThroughId: `${randomUUID()}:2` }),
      session({ readThroughId: `${book}:0` }),
      session({ closed: 'yes' }),
    ];
    expect(
      codes(
        await a.push(bad.map((data) => ({ kind: 'stat-session', id: sid(), updatedAt: 1, data }))),
      ),
    ).toEqual(bad.map(() => 'invalid_data'));
    expect(
      codes(
        await a.push([
          { kind: 'stat-session', id: `${book}:${a.id}`, updatedAt: 1, data: session() },
          {
            kind: 'stat-session',
            id: `${randomUUID()}:${a.id}:${randomUUID()}`,
            updatedAt: 1,
            data: session(),
          },
          {
            kind: 'stat-session',
            id: sid(),
            updatedAt: 1,
            data: session({ readThroughId: `${book}:2` }),
          },
          {
            kind: 'stat-session',
            id: sid(),
            updatedAt: 1,
            data: session({ source: 'completion', seconds: 0, lookups: 0, closed: true }),
          },
        ]),
      ),
    ).toEqual(['invalid_id', 'unknown_book', 'applied', 'applied']);
  });

  it('keeps sessions of a book that left the catalog view (missing in Calibre)', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    t.db
      .prepare(
        `INSERT INTO book_sources
           (id, book_id, kind, library_id, calibre_uuid, calibre_id, missing_at, created_at, updated_at)
         VALUES (?, ?, 'calibre', 'lib1', ?, 1, ?, 1, 1)`,
      )
      .run(randomUUID(), book, randomUUID(), Date.now());
    const a = await t.device('A');
    const id = `${book}:${a.id}:${randomUUID()}`;
    expect(
      codes(await a.push([{ kind: 'stat-session', id, updatedAt: 1, data: session() }])),
    ).toEqual(['applied']);
  });
});

describe('stat-session-fix kind', () => {
  it('lets any device exclude or correct a session, and undo it', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const a = await t.device('A');
    const b = await t.device('B');
    const id = `${book}:${a.id}:${randomUUID()}`;
    expect(
      codes(
        await b.push([
          { kind: 'stat-session-fix', id, updatedAt: 1, data: { excluded: true } },
          { kind: 'stat-session-fix', id, updatedAt: 2, data: { seconds: 60, chars: 500 } },
          { kind: 'stat-session-fix', id, updatedAt: 3, deletedAt: 3 },
        ]),
      ),
    ).toEqual(['applied', 'applied', 'applied']);
    expect(
      codes(
        await a.push([
          { kind: 'stat-session-fix', id, updatedAt: 4, data: {} },
          { kind: 'stat-session-fix', id, updatedAt: 4, data: { excluded: false } },
          { kind: 'stat-session-fix', id, updatedAt: 4, data: { chars: -1 } },
          {
            kind: 'stat-session-fix',
            id: `${book}:${a.id}`,
            updatedAt: 4,
            data: { excluded: true },
          },
          {
            kind: 'stat-session-fix',
            id: `${randomUUID()}:${a.id}:${randomUUID()}`,
            updatedAt: 4,
            data: { excluded: true },
          },
        ]),
      ),
    ).toEqual(['invalid_data', 'invalid_data', 'invalid_data', 'invalid_id', 'unknown_book']);
  });
});

describe('stat-day freeze', () => {
  const statDay = (dateKey: string) => ({
    dateKey,
    charactersRead: 100,
    readingTime: 60,
    minReadingSpeed: 0,
    altMinReadingSpeed: 0,
    lastReadingSpeed: 0,
    maxReadingSpeed: 0,
    lastStatisticModified: 1,
  });

  it('refuses stat-day changes from devices, but not the server writing them itself', async () => {
    const t = await setup();
    const book = insertBook(t.db);
    const a = await t.device('A');
    const id = `${book}:2026-10-02`;
    expect(
      codes(
        await a.push([
          { kind: 'stat-day', id, updatedAt: 5, data: statDay('2026-10-02') },
          { kind: 'stat-day', id, updatedAt: 6, deletedAt: 6 },
        ]),
      ),
    ).toEqual(['stat_day_frozen', 'stat_day_frozen']);
    // The WP5 import writes through the store directly.
    const store = new SyncStore(t.db, { maxClockSkewMs: 0 });
    expect(
      store.push(t.userId, a.id, [
        { kind: 'stat-day', id, updatedAt: 5, data: statDay('2026-10-02') },
      ])[0].status,
    ).toBe('applied');
    // Already stored rows can't be overwritten by a device either (the old loss path).
    expect(
      codes(await a.push([{ kind: 'stat-day', id, updatedAt: 99, data: statDay('2026-10-02') }])),
    ).toEqual(['stat_day_frozen']);
    expect(store.getRecord(t.userId, 'stat-day', id)?.updatedAt).toBe(5);
  });

  it('can be lifted with SYNC_FROZEN_KINDS=none', async () => {
    const warnings: string[] = [];
    expect(parseSyncConfig({}, warnings).frozenKinds).toEqual(['stat-day']);
    expect(parseSyncConfig({ SYNC_FROZEN_KINDS: '' }, warnings).frozenKinds).toEqual(['stat-day']);
    expect(parseSyncConfig({ SYNC_FROZEN_KINDS: 'none' }, warnings).frozenKinds).toEqual([]);
    expect(
      parseSyncConfig({ SYNC_FROZEN_KINDS: 'stat-day, reading-goal,Bad Kind' }, warnings)
        .frozenKinds,
    ).toEqual(['stat-day', 'reading-goal']);
    expect(warnings).toHaveLength(1);

    const t = await setup({ sync: { ...DEFAULT_SYNC_CONFIG, frozenKinds: [] } });
    const book = insertBook(t.db);
    const a = await t.device('A');
    expect(
      codes(
        await a.push([
          { kind: 'stat-day', id: `${book}:2026-10-02`, updatedAt: 5, data: statDay('2026-10-02') },
        ]),
      ),
    ).toEqual(['applied']);
  });
});
