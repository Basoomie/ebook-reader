/**
 * Search history (2026-11-24): the "search-history" sync kind.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers/test-app';

async function setup() {
  const t = makeTestApp();
  const auth = { Authorization: `Bearer ${t.newUserToken('d')}` };
  const deviceId = randomUUID();
  const reg = await request(t.app).post('/api/v1/devices/register').set(auth).send({ deviceId });
  expect(reg.status).toBe(200);
  const push = async (changes: unknown[]) =>
    (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body.results as {
      status: string;
      reason?: string;
    }[];
  const stored = (id: string) => {
    if (!t.database.ok) throw new Error('no db');
    return t.database.db
      .prepare(`SELECT data, deleted_at FROM sync_records WHERE kind = 'search-history' AND id = ?`)
      .get(id) as { data: string; deleted_at: number | null } | undefined;
  };
  return { push, stored, deviceId };
}

const LIB = 'lib:0123456789abcdef';
const BOOK = 'book:fedcba9876543210';

describe('search-history kind', () => {
  it('stores library and book searches and refuses bad ones', async () => {
    const { push, stored, deviceId } = await setup();
    const now = Date.now();
    const change = (id: string, data: unknown) => ({
      kind: 'search-history',
      id,
      updatedAt: now,
      data,
    });
    const bookId = randomUUID();
    const results = await push([
      change(LIB, { query: ' author:西尾維新 ', usedAt: now }),
      change(BOOK, { query: '戦場ヶ原', book: bookId, title: '化物語', usedAt: now }),
      change('book:1111111111111111', {
        query: '怪異',
        book: `local:${deviceId}:12`,
        title: '',
        usedAt: now,
      }),
      change('lib:123', { query: 'x', usedAt: now }),
      change('other:0123456789abcdef', { query: 'x', usedAt: now }),
      change('lib:2222222222222222', { query: '   ', usedAt: now }),
      change('lib:3333333333333333', { query: 'x'.repeat(501), usedAt: now }),
      change('book:4444444444444444', { query: 'x'.repeat(201), book: bookId, usedAt: now }),
      change('lib:5555555555555555', { query: 'x', usedAt: 'now' }),
      change('lib:6666666666666666', { query: 'x', usedAt: now, book: bookId }),
      change('book:7777777777777777', { query: 'x', book: 'not-a-book', usedAt: now }),
      change('book:8888888888888888', {
        query: 'x',
        book: bookId,
        title: 't'.repeat(201),
        usedAt: now,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(JSON.parse(stored(LIB)!.data)).toEqual({ query: 'author:西尾維新', usedAt: now });
    expect(JSON.parse(stored(BOOK)!.data)).toEqual({
      query: '戦場ヶ原',
      book: bookId,
      title: '化物語',
      usedAt: now,
    });
  });

  it('keeps no text once a search is removed', async () => {
    const { push, stored } = await setup();
    const now = Date.now();
    await push([
      { kind: 'search-history', id: LIB, updatedAt: now, data: { query: 'secret', usedAt: now } },
    ]);
    const del = await push([
      { kind: 'search-history', id: LIB, updatedAt: now + 1, deletedAt: now + 1 },
    ]);
    expect(del[0].status).toBe('applied');
    const row = stored(LIB)!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.data).not.toContain('secret');
  });
});
