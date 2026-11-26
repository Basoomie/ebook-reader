/**
 * The Date completed sort (Completed collection): the day of a book's latest finished
 * read-through, books without one last in either direction, paged by its cursor.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { listUsers } from '../src/db/users';
import { makeTestApp } from './helpers/test-app';

describe('sort=completed', () => {
  it('orders by the latest finished day, undated last, and pages with the cursor', async () => {
    const t = makeTestApp();
    if (!t.database.ok) throw new Error('no database');
    const db = t.database.db;
    const token = t.newUserToken();
    const userId = listUsers(db)[0].id;
    db.prepare(
      `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
       VALUES ('L', 'L', 'L', 'ja', 1, 0, 0)`,
    ).run();
    let rev = 1;
    const ids = new Map<string, string>();
    const add = (title: string, finished: (string | null)[] | null, status = 'completed') => {
      const id = randomUUID();
      ids.set(id, title);
      db.prepare(
        `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
         VALUES (?, 'L', ?, ?, 0, 0)`,
      ).run(id, title, 1000 + rev);
      db.prepare(
        `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, created_at, updated_at)
         VALUES (?, ?, 'calibre', 'L', ?, 0, 0)`,
      ).run(randomUUID(), id, randomUUID());
      const put = (kind: string, rid: string, data: object) =>
        db
          .prepare(
            `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
             VALUES (?, ?, ?, ?, 'dev', 1, NULL, ?, ?, 1)`,
          )
          .run(userId, kind, rid, id, rev++, JSON.stringify(data));
      put('book-status', id, { status, auto: false });
      (finished ?? []).forEach((day, i) =>
        put('read-through', `${id}:${i + 1}`, {
          number: i + 1,
          origin: 'completion',
          startedOn: null,
          finished: day !== null,
          finishedOn: day,
          manual: false,
          charCount: null,
        }),
      );
    };
    add('Old', ['2026-01-05']);
    add('Newest', ['2026-03-01']);
    add('Reread', ['2026-02-01', '2026-04-10']); // the latest finished day counts
    add('Undated', null);
    add('Middle', ['2026-02-20']);

    const auth = { Authorization: `Bearer ${token}` };
    const titles = async (dir: string, limit?: number) => {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await request(t.app)
          .get('/api/v1/books')
          .query({ q: 'status:completed', sort: 'completed', dir, limit, cursor })
          .set(auth);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        out.push(...(res.body.books as { id: string }[]).map((b) => ids.get(b.id) as string));
        cursor = res.body.nextCursor ?? undefined;
      } while (cursor);
      return out;
    };
    expect(await titles('desc')).toEqual(['Reread', 'Newest', 'Middle', 'Old', 'Undated']);
    expect(await titles('asc')).toEqual(['Old', 'Middle', 'Newest', 'Reread', 'Undated']);
    expect(await titles('desc', 2)).toEqual(['Reread', 'Newest', 'Middle', 'Old', 'Undated']);
    expect(await titles('asc', 2)).toEqual(['Old', 'Middle', 'Newest', 'Reread', 'Undated']);
  });
});
