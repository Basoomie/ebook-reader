/**
 * New volumes of series you're reading (docs/design/series-arrivals.md): the rules of section
 * 2, the baseline when switched on, the wait for the new arrivals, told once, one message per
 * round, and the words.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { listUsers } from '../src/db/users';
import { SERIES_ARRIVAL_EVENT } from '../src/series-arrivals/events';
import { buildMessage, formatNumbers } from '../src/series-arrivals/message';
import { SeriesArrivals } from '../src/series-arrivals/service';
import { makeTestApp } from './helpers/test-app';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);

interface Sent {
  event: string;
  lines: string[];
  link: string | null;
}

function setup() {
  const t = makeTestApp();
  if (!t.database.ok) throw new Error('no database');
  const db: Database.Database = t.database.db;
  t.newUserToken();
  const userId = listUsers(db)[0].id;
  let now = T0;
  let rev = 1;
  let doneBefore = Infinity;
  const sent: Sent[] = [];
  const digest: { text: string; link: string | null }[] = [];
  const settings = {
    sections: { jobs: true, cleanup: true, data: true, stats: false } as Record<string, boolean>,
    events: { [SERIES_ARRIVAL_EVENT]: { discord: false, email: false } } as Record<
      string,
      { discord: boolean; email: boolean }
    >,
    waits: { seriesArrivalWaitHours: 24 },
  };
  const service = new SeriesArrivals({
    db,
    notifications: {
      settings: () => settings,
      notify: (m) => sent.push(m),
      addDigestLine: (_e, text, link) => digest.push({ text, link: link ?? null }),
    },
    arrivalsDoneBefore: () => doneBefore,
    now: () => now,
    log: () => {},
  });

  for (const [lib, enabled] of [
    ['L', 1],
    ['M', 1],
    ['D', 0],
  ] as const) {
    db.prepare(
      `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
       VALUES (?, ?, ?, 'ja', ?, 0, 0)`,
    ).run(lib, lib, lib, enabled);
  }

  function book(
    title: string,
    series: string | null,
    index: number | null,
    o: { library?: string; missing?: boolean } = {},
  ): string {
    const id = randomUUID();
    const library = o.library ?? 'L';
    let seriesId: number | null = null;
    if (series !== null) {
      db.prepare('INSERT OR IGNORE INTO series (name) VALUES (?)').run(series);
      seriesId = (db.prepare('SELECT id FROM series WHERE name = ?').get(series) as { id: number })
        .id;
    }
    db.prepare(
      `INSERT INTO books (id, library_id, title, series_id, series_index, added_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, library, title, seriesId, index, now, now, now);
    db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, missing_at, created_at, updated_at)
       VALUES (?, ?, 'calibre', ?, ?, ?, 0, 0)`,
    ).run(randomUUID(), id, library, randomUUID(), o.missing ? now : null);
    return id;
  }

  function record(kind: string, id: string, bookId: string | null, data: object) {
    db.prepare(
      `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
       VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)
       ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data, rev = excluded.rev`,
    ).run(userId, kind, id, bookId, now, rev++, JSON.stringify(data), now);
  }
  const status = (bookId: string, s: string) =>
    record('book-status', bookId, bookId, { status: s, auto: false });
  const finished = (bookId: string) =>
    record('read-through', `${bookId}:1`, bookId, {
      number: 1,
      origin: 'completion',
      startedOn: null,
      finished: true,
      finishedOn: '2026-10-01',
      manual: false,
      charCount: null,
    });
  const hide = (library: string, name: string) =>
    record('series-next-hide', randomUUID().slice(0, 16), null, { library, name, hiddenAt: now });

  const decision = (bookId: string) =>
    (
      db.prepare('SELECT reason FROM series_arrival_books WHERE book_id = ?').get(bookId) as
        | { reason: string }
        | undefined
    )?.reason;

  return {
    db,
    service,
    settings,
    sent,
    digest,
    book,
    status,
    finished,
    hide,
    decision,
    switchOn: () => (settings.events[SERIES_ARRIVAL_EVENT] = { discord: true, email: false }),
    switchOff: () => (settings.events[SERIES_ARRIVAL_EVENT] = { discord: false, email: false }),
    later: (ms: number) => (now += ms),
    setDoneBefore: (v: number) => (doneBefore = v),
    now: () => now,
  };
}

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

/** A series you're reading (vol 1 Completed), the alert on, a minute later. */
function reading(series = 'S', library = 'L') {
  const v1 = s.book(`${series} 1`, series, 1, { library });
  s.status(v1, 'completed');
  s.switchOn();
  s.service.round();
  s.later(60_000);
  return v1;
}

describe('switching on and off', () => {
  it('records nothing while off, and books from before it was on are never told', () => {
    const v1 = s.book('S 1', 'S', 1);
    s.status(v1, 'completed');
    const old = s.book('S 2', 'S', 2);
    expect(s.service.round().on).toBe(false);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM series_arrival_state').get()).toEqual({ n: 0 });
    s.later(60_000);
    s.switchOn();
    s.service.round();
    s.later(60_000);
    const v3 = s.book('S 3', 'S', 3);
    s.later(60_000);
    s.service.round();
    expect(s.decision(old)).toBeUndefined();
    expect(s.decision(v3)).toBe('told');
    expect(s.sent).toHaveLength(1);
  });

  it('the section off counts as off', () => {
    s.switchOn();
    s.settings.sections.data = false;
    expect(s.service.isOn()).toBe(false);
  });

  it('turning it back on sends no backlog of what came while it was off', () => {
    reading();
    s.switchOff();
    s.service.round();
    s.later(60_000);
    const whileOff = s.book('S 2', 'S', 2);
    s.later(60_000);
    s.switchOn();
    s.service.round();
    s.later(60_000);
    s.service.round();
    expect(s.decision(whileOff)).toBeUndefined();
    expect(s.sent).toHaveLength(0);
  });
});

describe('the rules', () => {
  it('any new volume of a series you are reading, before or after where you are, told once', () => {
    reading();
    const v5 = s.book('S 5', 'S', 5);
    const v05 = s.book('S 0.5', 'S', 0.5);
    s.later(60_000);
    s.service.round();
    expect(s.decision(v5)).toBe('told');
    expect(s.decision(v05)).toBe('told');
    s.later(60_000);
    s.service.round();
    expect(s.sent).toHaveLength(1);
  });

  it('a finished read-through counts as reading; Reading counts; Unread does not', () => {
    const a = s.book('A 1', 'A', 1);
    s.finished(a);
    const b = s.book('B 1', 'B', 1);
    s.status(b, 'reading');
    const c = s.book('C 1', 'C', 1);
    s.status(c, 'unread');
    s.switchOn();
    s.service.round();
    s.later(60_000);
    const a2 = s.book('A 2', 'A', 2);
    const b2 = s.book('B 2', 'B', 2);
    const c2 = s.book('C 2', 'C', 2);
    s.later(60_000);
    s.service.round();
    expect([s.decision(a2), s.decision(b2), s.decision(c2)]).toEqual([
      'told',
      'told',
      'not_reading',
    ]);
  });

  it('a series whose started volumes are all Dropped is left out; one Dropped among read ones is not', () => {
    const d1 = s.book('D 1', 'D', 1);
    s.status(d1, 'dropped');
    const e1 = s.book('E 1', 'E', 1);
    s.status(e1, 'completed');
    const e2 = s.book('E 2', 'E', 2);
    s.status(e2, 'dropped');
    // Finished once, then Dropped: Dropped wins.
    const f1 = s.book('F 1', 'F', 1);
    s.finished(f1);
    s.status(f1, 'dropped');
    s.switchOn();
    s.service.round();
    s.later(60_000);
    const d2 = s.book('D 2', 'D', 2);
    const e3 = s.book('E 3', 'E', 3);
    const f2 = s.book('F 2', 'F', 2);
    s.later(60_000);
    s.service.round();
    expect([s.decision(d2), s.decision(e3), s.decision(f2)]).toEqual([
      'not_reading',
      'told',
      'not_reading',
    ]);
  });

  it('a series hidden from Next in your series is left out, and counts from when it is shown again', () => {
    reading('H');
    s.hide('L', 'H');
    s.later(60_000);
    const h2 = s.book('H 2', 'H', 2);
    s.later(60_000);
    s.service.round();
    expect(s.decision(h2)).toBe('not_reading');
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM series_arrival_series').get()).toEqual({ n: 0 });
    // Shown again: a sync delete of the hide record.
    s.db.prepare("UPDATE sync_records SET deleted_at = 1 WHERE kind = 'series-next-hide'").run();
    s.service.round();
    s.later(60_000);
    const h3 = s.book('H 3', 'H', 3);
    s.later(60_000);
    s.service.round();
    expect(s.decision(h3)).toBe('told');
  });

  it('one library at a time: the same series name in another library is not read', () => {
    reading('S', 'L');
    const m2 = s.book('S 2 (manga)', 'S', 2, { library: 'M' });
    s.later(60_000);
    s.service.round();
    expect(s.decision(m2)).toBe('not_reading');
  });

  it('a book that arrived before its series counted is not news', () => {
    s.switchOn();
    s.service.round();
    s.later(60_000);
    const v1 = s.book('S 1', 'S', 1);
    const v2 = s.book('S 2', 'S', 2);
    s.setDoneBefore(-Infinity); // a run is open: both wait
    s.service.round();
    s.later(60_000);
    s.status(v1, 'completed');
    s.setDoneBefore(Infinity);
    s.service.round();
    expect(s.decision(v2)).toBe('before_series');
  });

  it('omnibus N.9 never; bonus N.1 and side books N.5 told', () => {
    reading();
    const o = s.book('S 1-3', 'S', 3.9);
    const bonus = s.book('S 1 bonus', 'S', 1.1);
    const side = s.book('S side', 'S', 2.5);
    s.later(60_000);
    s.service.round();
    expect([s.decision(o), s.decision(bonus), s.decision(side)]).toEqual([
      'omnibus',
      'told',
      'told',
    ]);
  });

  it('a copy of a number already there (read, or only in the library, or removed) is not told', () => {
    const v1 = reading();
    s.book('S 2', 'S', 2, { missing: true });
    s.later(60_000);
    const copyRead = s.book('S 1 (copy)', 'S', 1);
    const copyRemoved = s.book('S 2 (copy)', 'S', 2);
    const v3 = s.book('S 3', 'S', 3);
    s.later(1);
    const v3b = s.book('S 3 (second copy)', 'S', 3);
    s.later(60_000);
    s.service.round();
    expect(v1).toBeTruthy();
    expect([
      s.decision(copyRead),
      s.decision(copyRemoved),
      s.decision(v3),
      s.decision(v3b),
    ]).toEqual(['copy', 'copy', 'told', 'copy']);
  });

  it('a book you already have a status on is not told; one not shown in the library is not told', () => {
    reading();
    const touched = s.book('S 2', 'S', 2);
    s.status(touched, 'completed');
    const gone = s.book('S 3', 'S', 3, { missing: true });
    s.later(60_000);
    s.service.round();
    expect([s.decision(touched), s.decision(gone)]).toEqual(['touched', 'not_shown']);
  });

  it('a disabled library and a book without a series are not told', () => {
    reading('S', 'D');
    const off = s.book('S 2', 'S', 2, { library: 'D' });
    const loose = s.book('Loose', null, null);
    s.later(60_000);
    s.service.round();
    expect([s.decision(off), s.decision(loose)]).toEqual(['not_shown', 'no_series']);
  });

  it('a series no longer read is forgotten and counts again from when it is read again', () => {
    const v1 = reading();
    s.status(v1, 'unread');
    s.service.round();
    s.later(60_000);
    const v2 = s.book('S 2', 'S', 2);
    s.later(60_000);
    s.service.round();
    expect(s.decision(v2)).toBe('not_reading');
    s.status(v1, 'completed');
    s.service.round();
    s.later(60_000);
    const v3 = s.book('S 3', 'S', 3);
    s.later(60_000);
    s.service.round();
    expect(s.decision(v3)).toBe('told');
  });
});

describe('waiting for the new arrivals', () => {
  it('waits while a run is open, at most the wait time', () => {
    reading();
    s.setDoneBefore(-Infinity);
    const v2 = s.book('S 2', 'S', 2);
    s.later(HOUR);
    expect(s.service.round().waiting).toBe(1);
    expect(s.decision(v2)).toBeUndefined();
    s.later(23 * HOUR);
    s.service.round();
    expect(s.decision(v2)).toBe('told');
  });

  it('is decided when a run finished after the book arrived, with the series the run wrote', () => {
    reading();
    const v2 = s.book('S 2 raw', 'Raw name', 7);
    s.setDoneBefore(-Infinity);
    s.later(HOUR);
    s.service.round();
    // The run writes the cleaned series and number, then ends.
    const sid = (s.db.prepare("SELECT id FROM series WHERE name = 'S'").get() as { id: number }).id;
    s.db.prepare('UPDATE books SET series_id = ?, series_index = 2 WHERE id = ?').run(sid, v2);
    s.setDoneBefore(s.now());
    s.service.round();
    expect(s.decision(v2)).toBe('told');
    expect(s.sent[0].lines[0]).toBe('New in a series you’re reading: S 2');
  });

  it('past the wait time in a long run: told if it is news, else decided when the run ends', () => {
    reading();
    s.setDoneBefore(-Infinity);
    const v2 = s.book('S 2', 'S', 2);
    // Still under Calibre's own spelling of the series, which the run corrects later.
    const raw = s.book('Ｓ 3', 'Ｓ', 3);
    s.later(25 * HOUR);
    s.service.round();
    expect(s.decision(v2)).toBe('told');
    expect(s.decision(raw)).toBeUndefined();
    const sid = (s.db.prepare("SELECT id FROM series WHERE name = 'S'").get() as { id: number }).id;
    s.db.prepare('UPDATE books SET series_id = ? WHERE id = ?').run(sid, raw);
    s.setDoneBefore(s.now());
    s.service.round();
    expect(s.decision(raw)).toBe('told');
    expect(s.sent).toHaveLength(2);
  });

  it('a run that only finished before the book arrived does not count', () => {
    reading();
    s.setDoneBefore(s.now() - 1);
    const v2 = s.book('S 2', 'S', 2);
    s.later(HOUR);
    s.service.round();
    expect(s.decision(v2)).toBeUndefined();
  });
});

describe('one message per round', () => {
  it('groups every book told in a round, with a digest line per series', () => {
    reading('A');
    const b1 = s.book('B 1', 'B', 1);
    s.status(b1, 'reading');
    const c1 = s.book('C 1', 'C', 1);
    s.status(c1, 'reading');
    s.service.round();
    s.later(60_000);
    s.setDoneBefore(-Infinity);
    for (const n of [2, 3, 4]) s.book(`A ${n}`, 'A', n);
    s.book('B 2', 'B', 2);
    s.book('C 5', 'C', 5);
    s.later(60_000);
    s.service.round();
    expect(s.sent).toHaveLength(0);
    s.setDoneBefore(Infinity);
    s.service.round();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].lines).toEqual([
      '5 new volumes in series you’re reading',
      'A 2-4, B 2 and 1 more series',
    ]);
    expect(s.sent[0].link).toBe('/library?sort=added-desc');
    expect(s.digest.map((d) => d.text)).toEqual(['New in A: 2-4', 'New in B: 2', 'New in C: 5']);
  });
});

describe('the words', () => {
  it('numbers: three or more in a row as a range, fractions as written', () => {
    expect(formatNumbers([3, 1, 2, 5, 6, 6.5, 8, 9, 10])).toBe('1-3, 5, 6, 6.5, 8-10');
  });

  it('one book links to its page; one series to the series', () => {
    const one = buildMessage([
      {
        id: 'b1',
        title: '薬屋のひとりごと 16',
        libraryId: 'L',
        seriesName: '薬屋のひとりごと',
        seriesIndex: 16,
      },
    ])!;
    expect(one.lines).toEqual([
      'New in a series you’re reading: 薬屋のひとりごと 16',
      '薬屋のひとりごと 16',
    ]);
    expect(one.link).toBe('/library/book?id=b1');
    const series = buildMessage([
      { id: 'b1', title: 'x', libraryId: 'L', seriesName: 'S', seriesIndex: 1 },
      { id: 'b2', title: 'y', libraryId: 'L', seriesName: 'S', seriesIndex: 2 },
    ])!;
    expect(series.lines).toEqual(['2 new volumes in series you’re reading', 'S 1, 2']);
    expect(series.link).toBe('/library?tab=series&group=S');
  });
});
