/**
 * Recently viewed (2026-11-24): the "recently-viewed" sync kind.
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
      .prepare(
        `SELECT data, deleted_at FROM sync_records WHERE kind = 'recently-viewed' AND id = ?`,
      )
      .get(id) as { data: string; deleted_at: number | null } | undefined;
  };
  return { push, stored, deviceId };
}

describe('recently-viewed kind', () => {
  it('stores a view per book and refuses bad ones', async () => {
    const { push, stored, deviceId } = await setup();
    const now = Date.now();
    const change = (id: string, data: unknown) => ({
      kind: 'recently-viewed',
      id,
      updatedAt: now,
      data,
    });
    const bookId = randomUUID();
    const results = await push([
      change(bookId, { viewedAt: now }),
      change('not-a-book', { viewedAt: now }),
      change(`local:${deviceId}:12`, { viewedAt: now }),
      change(randomUUID(), { viewedAt: 'now' }),
      change(randomUUID(), { viewedAt: -1 }),
      change(randomUUID(), { viewedAt: now, title: '化物語' }),
      change(randomUUID(), null),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'applied',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(JSON.parse(stored(bookId)!.data)).toEqual({ viewedAt: now });
  });

  it('keeps nothing once a book is removed, and a later view brings it back', async () => {
    const { push, stored } = await setup();
    const bookId = randomUUID();
    const now = Date.now();
    await push([{ kind: 'recently-viewed', id: bookId, updatedAt: now, data: { viewedAt: now } }]);
    const del = await push([
      { kind: 'recently-viewed', id: bookId, updatedAt: now + 1, deletedAt: now + 1 },
    ]);
    expect(del[0].status).toBe('applied');
    const row = stored(bookId)!;
    expect(row.deleted_at).not.toBeNull();
    expect(JSON.parse(row.data)).toEqual({});
    const again = await push([
      { kind: 'recently-viewed', id: bookId, updatedAt: now + 2, data: { viewedAt: now + 2 } },
    ]);
    expect(again[0].status).toBe('applied');
    expect(stored(bookId)!.deleted_at).toBeNull();
  });
});
