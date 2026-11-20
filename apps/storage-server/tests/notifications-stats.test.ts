/**
 * Notifications N2: the daily, weekly and monthly stats messages. Fake Discord and fake SMTP
 * only. The totals are checked against tests/fixtures/stats-parity.json, whose summaries the
 * web app's own test proves are the Stats page's (apps/web/tests/stats/server-stats.test.ts).
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/database';
import { listUsers } from '../src/db/users';
import { DEFAULT_NOTIFICATIONS_CONFIG, NotificationsConfig } from '../src/notifications/config';
import { listEvents, SECTIONS } from '../src/notifications/events';
import { NotificationService, zonedClock } from '../src/notifications/service';
import { defaultSettings, mergeSettings } from '../src/notifications/settings';
import { stats, StatsPeriod, StatsSummary } from '../src/notifications/stats-bundle';
import {
  changeOf,
  formatValue,
  lastEnded,
  LINE_KEYS,
  loadStatsInput,
  periodSummary,
  periodTitle,
  previousTitle,
  readCalendar,
  statsToday,
} from '../src/notifications/stats-report';
import { SyncStore } from '../src/sync/store';
import { fakeDiscord, FakeDiscord, fakeSmtp, quotedPrintable } from './helpers/notify-fakes';
import { testConfig } from './helpers/test-app';

interface Fixture {
  devices: string[];
  books: { id: string; charCount: number }[];
  records: {
    kind: string;
    id: string;
    deviceId: string;
    updatedAt: number;
    data: Record<string, unknown>;
  }[];
  cases: { weekStart: number; period: StatsPeriod; summary: StatsSummary }[];
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'stats-parity.json'), 'utf8'),
) as Fixture;

const LINK = 'http://192.168.1.5:3080';
const D1 = fixture.devices[0];

interface Env {
  db: Database.Database;
  dbDir: string;
  userId: string;
  store: SyncStore;
  clock: { t: number };
  svc: NotificationService;
  discord: FakeDiscord;
  /** One round at `iso` (UTC), and wait for its sending. */
  at(iso: string): Promise<void>;
  setGlobal(key: string, value: string | null): void;
}

const envs: Env[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (envs.length) {
    const e = envs.pop()!;
    await e.svc.stop();
    await e.discord.close();
    e.db.close();
  }
  while (closers.length) await closers.pop()!();
});

function seedCatalog(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
     VALUES ('lib1', 'japanese-library', 'ja', 'ja', 1, ?, ?)`,
  ).run(now, now);
  for (const b of fixture.books) {
    db.prepare(
      `INSERT INTO books (id, library_id, title, char_count, added_at, created_at, updated_at)
       VALUES (?, 'lib1', 'Book', ?, ?, ?, ?)`,
    ).run(b.id, b.charCount, now, now, now);
    db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, created_at, updated_at)
       VALUES (?, ?, 'calibre', 'lib1', ?, ?, ?)`,
    ).run(`src-${b.id}`, b.id, b.id, now, now);
  }
}

/** The fixture's records through the real sync store, each from its own device. */
function seedRecords(store: SyncStore, userId: string): void {
  const now = Date.UTC(2026, 11, 31);
  for (const r of fixture.records) {
    const [result] = store.push(
      userId,
      r.deviceId,
      [{ kind: r.kind, id: r.id, updatedAt: r.updatedAt, data: r.data }],
      now,
    );
    expect(result.status, `${r.kind} ${r.id}: ${JSON.stringify(result)}`).toBe('applied');
  }
}

async function makeEnv(
  o: {
    zone?: string;
    hour?: string | null;
    weekStart?: string | null;
    statsOn?: boolean;
    config?: Partial<NotificationsConfig>;
    dbDir?: string;
    seed?: boolean;
  } = {},
): Promise<Env> {
  const dbDir = o.dbDir ?? testConfig().dbDir;
  const database = initDatabase(dbDir, testConfig().dataRoot);
  if (!database.ok) throw new Error('no database');
  const db = database.db;
  const userId = listUsers(db)[0].id;
  const store = new SyncStore(db, { maxClockSkewMs: 0 });
  if (o.seed !== false) {
    seedCatalog(db);
    seedRecords(store, userId);
  }
  const clock = { t: Date.UTC(2026, 10, 1) };
  const discord = await fakeDiscord();
  const svc = new NotificationService({
    db,
    dbDir,
    config: {
      ...DEFAULT_NOTIFICATIONS_CONFIG,
      allowAnyWebhook: true,
      retryMinutes: [0, 0],
      ...o.config,
    },
    now: () => clock.t,
    log: () => undefined,
    logError: (m, err) => {
      throw new Error(`${m} ${String(err)}`);
    },
  });
  const env: Env = {
    db,
    dbDir,
    userId,
    store,
    clock,
    svc,
    discord,
    async at(iso: string) {
      clock.t = Date.parse(iso);
      await svc.tick();
    },
    setGlobal(key, value) {
      const result = store.writeAs(
        userId,
        D1,
        { kind: 'setting', id: `global:${key}`, updatedAt: ++settingClock, data: { value } },
        settingClock,
      );
      expect(result.status, JSON.stringify(result)).toBe('applied');
    },
  };
  if (o.hour !== undefined) env.setGlobal('startDayHoursForTracker', o.hour);
  if (o.weekStart !== undefined) env.setGlobal('statsWeekStart', o.weekStart);
  svc.putSecret('discordWebhookUrl', discord.url);
  svc.updateSettings({
    linkBase: LINK,
    digest: { timeZone: o.zone ?? 'UTC' },
    sections: { stats: o.statsOn ?? true },
  });
  envs.push(env);
  return env;
}

const sent = (e: Env) => e.discord.messages;

/** Settings records' updatedAt: whole numbers that only grow (lww). */
let settingClock = Date.UTC(2026, 9, 1);

/** A Subject header, decoded (RFC 2047 Q words; the space between two words is dropped). */
function subjectOf(data: string): string {
  const raw = /\r\nSubject: (.+(?:\r\n[ \t].+)*)/.exec(data)![1].replace(/\r\n[ \t]/g, ' ');
  return raw
    .replace(/\?=\s+=\?UTF-8\?Q\?/g, '')
    .replace(/=\?UTF-8\?Q\?(.*?)\?=/g, (_m, q: string) =>
      Buffer.from(
        q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/g, (_x, h: string) => `%${h}`),
        'utf8',
      ).toString(),
    )
    .replace(/%([0-9A-F]{2})(%[0-9A-F]{2})*/g, (m) => decodeURIComponent(m));
}

describe('settings and events', () => {
  it('adds a Stats section, off by default, with three messages on and "no reading" skipped', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(['jobs', 'cleanup', 'data', 'stats']);
    const ev = listEvents().filter((e) => e.section === 'stats');
    expect(ev.map((e) => [e.id, e.label, e.kind])).toEqual([
      ['stats_daily', 'Daily stats', 'report'],
      ['stats_weekly', 'Weekly stats', 'report'],
      ['stats_monthly', 'Monthly stats', 'report'],
    ]);
    const d = defaultSettings();
    expect(d.sections.stats).toBe(false);
    expect(d.stats).toEqual({ noReading: 'skip' });
    for (const e of ev) expect(d.events[e.id]).toEqual({ discord: true, email: true });
    expect(mergeSettings(d, { stats: { noReading: 'send' } }).stats.noReading).toBe('send');
    expect(() => mergeSettings(d, { stats: { noReading: 'maybe' } })).toThrow(/skip or send/);
  });

  it('reads the day start and week start the settings source synced, else the defaults', async () => {
    const e = await makeEnv({ seed: false });
    expect(readCalendar(e.db, e.userId)).toEqual({ dayStartHour: 0, weekStart: 1 });
    e.setGlobal('startDayHoursForTracker', '4');
    e.setGlobal('statsWeekStart', '0');
    expect(readCalendar(e.db, e.userId)).toEqual({ dayStartHour: 4, weekStart: 0 });
    // Never set on the source (null) = the default; nonsense = the default.
    e.setGlobal('startDayHoursForTracker', null);
    e.setGlobal('statsWeekStart', '9');
    expect(readCalendar(e.db, e.userId)).toEqual({ dayStartHour: 0, weekStart: 1 });
    e.setGlobal('startDayHoursForTracker', '25');
    expect(readCalendar(e.db, e.userId).dayStartHour).toBe(0);
  });
});

describe('periods', () => {
  const today = (iso: string, zone: string, hour: number) =>
    statsToday(zonedClock(Date.parse(iso), zone), hour);

  it('a day starts at the day-start hour in the zone, across daylight-saving changes', () => {
    expect(today('2026-11-17T06:59:00Z', 'America/Denver', 0)).toBe('2026-11-16');
    expect(today('2026-11-17T07:00:00Z', 'America/Denver', 0)).toBe('2026-11-17');
    expect(today('2026-11-17T10:59:00Z', 'America/Denver', 4)).toBe('2026-11-16');
    expect(today('2026-11-17T11:00:00Z', 'America/Denver', 4)).toBe('2026-11-17');
    expect(today('2026-11-17T03:59:00Z', 'UTC', 4)).toBe('2026-11-16');
    // 1 Nov 2026: 2:00 MDT falls back to 1:00 MST (08:00Z); day start 2 h.
    expect(today('2026-11-01T07:30:00Z', 'America/Denver', 2)).toBe('2026-10-31'); // 01:30 MDT
    expect(today('2026-11-01T08:30:00Z', 'America/Denver', 2)).toBe('2026-10-31'); // 01:30 MST
    expect(today('2026-11-01T09:00:00Z', 'America/Denver', 2)).toBe('2026-11-01'); // 02:00 MST
    // 8 Mar 2026: 2:00 MST springs to 3:00 MDT.
    expect(today('2026-03-08T08:59:00Z', 'America/Denver', 2)).toBe('2026-03-07');
    expect(today('2026-03-08T09:00:00Z', 'America/Denver', 2)).toBe('2026-03-08');
  });

  it('the last ended day, week (either week start) and month, over a month and a year end', () => {
    expect(lastEnded('day', '2026-12-01', 1)).toEqual({
      kind: 'day',
      from: '2026-11-30',
      to: '2026-11-30',
    });
    expect(lastEnded('week', '2026-11-16', 1)).toEqual({
      kind: 'week',
      from: '2026-11-09',
      to: '2026-11-15',
    });
    expect(lastEnded('week', '2026-11-16', 0)).toEqual({
      kind: 'week',
      from: '2026-11-08',
      to: '2026-11-14',
    });
    expect(lastEnded('month', '2026-12-01', 1)).toEqual({
      kind: 'month',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(lastEnded('month', '2027-01-01', 1)).toEqual({
      kind: 'month',
      from: '2026-12-01',
      to: '2026-12-31',
    });
    const week = lastEnded('week', '2027-01-04', 1);
    expect(periodTitle('week', week)).toBe('week 28 Dec 2026 – 3 Jan 2027');
    expect(previousTitle(week, stats.stepPeriod(week, -1, 1))).toBe('21 – 27 Dec 2026');
    const jan = lastEnded('month', '2027-02-01', 1);
    expect(previousTitle(jan, stats.stepPeriod(jan, -1, 1))).toBe('December 2026');
    const nov = lastEnded('month', '2026-12-01', 1);
    expect(previousTitle(nov, stats.stepPeriod(nov, -1, 1))).toBe('October');
    const day = lastEnded('day', '2026-11-17', 1);
    expect(
      `${periodTitle('day', day)} (vs ${previousTitle(day, stats.stepPeriod(day, -1, 1))})`,
    ).toBe('Mon 16 Nov 2026 (vs Sun 15 Nov)');
  });
});

describe('totals', () => {
  it('equal the Stats page for every fixture period (the parity fixture, from ttsu.db)', async () => {
    const e = await makeEnv();
    const input = loadStatsInput(e.db, e.userId);
    for (const c of fixture.cases) {
      expect(periodSummary(input, c.period), `${c.period.kind} ${c.period.from}`).toEqual(
        c.summary,
      );
    }
  });

  it('the change follows the Stats page rules (changeLine)', () => {
    const summary = (o: Partial<StatsSummary>): StatsSummary => ({
      seconds: 0,
      chars: 0,
      speed: 0,
      lookups: 0,
      booksCompleted: 0,
      daysRead: 0,
      manualChars: 0,
      ...o,
    });
    const pairs: [Partial<StatsSummary>, Partial<StatsSummary>][] = [
      [{}, {}],
      [
        { seconds: 4900, chars: 84000, speed: 16164, lookups: 11 },
        { seconds: 2900, chars: 74000, speed: 4966, lookups: 3 },
      ],
      [{ seconds: 600, chars: 15000, speed: 18000, lookups: 1 }, {}],
      [{}, { seconds: 600, chars: 15000, speed: 18000, lookups: 1 }],
      [
        { seconds: 1000, chars: 100500, speed: 900, lookups: 7 },
        { seconds: 1000, chars: 100000, speed: 1000, lookups: 7 },
      ],
      [
        { seconds: 30, chars: 5 },
        { seconds: 61, chars: 5 },
      ],
    ];
    for (const [a, b] of pairs) {
      const cur = summary(a);
      const prev = summary(b);
      for (const key of LINE_KEYS) {
        const c = changeOf(key, cur[key], prev[key]);
        const expected =
          c.kind === 'none'
            ? null
            : c.kind === 'speed-new'
              ? `${formatValue(key, cur[key])} vs no tracked reading X`
              : c.kind === 'same'
                ? 'No change vs X'
                : c.kind === 'new'
                  ? `${c.sign}${c.amount} vs X (none then)`
                  : `${c.sign}${c.amount} (${c.sign}${c.percent}%) vs X`;
        expect(stats.changeLine(key, cur, prev, 'X'), `${key} ${cur[key]} vs ${prev[key]}`).toBe(
          expected,
        );
      }
    }
  });
});

describe('sending', () => {
  it('the first round only remembers; a day goes at the day start (midnight) in the zone', async () => {
    const e = await makeEnv({ zone: 'America/Denver' });
    await e.at('2026-11-17T06:00:00Z'); // 23:00 on Mon 16 Nov in Denver
    expect(sent(e)).toEqual([]);
    await e.at('2026-11-17T07:00:30Z'); // 00:00 on Tue 17 Nov
    expect(sent(e)).toEqual([
      [
        'ッツ Reader: Mon 16 Nov 2026 (vs Sun 15 Nov)',
        'Characters: 11,000 (no change)',
        'Reading time: 30 min (no change)',
        'Speed: 22,000 / h (no change)',
        'Lookups: 7 (no change)',
        `[View Stats](${LINK}/statistics?period=day:2026-11-16)`,
      ].join('\n'),
    ]);
    await e.at('2026-11-17T07:01:00Z');
    expect(sent(e)).toHaveLength(1);
    const log = e.svc.diagnostics().log[0];
    expect([log.kind, log.label, log.status]).toEqual(['report', 'Daily stats', 'sent']);
  });

  it('a later day start (4 h) waits until then', async () => {
    const e = await makeEnv({ zone: 'America/Denver', hour: '4' });
    await e.at('2026-11-17T06:00:00Z');
    await e.at('2026-11-17T07:00:30Z'); // midnight: still Mon 16 Nov
    expect(sent(e)).toEqual([]);
    await e.at('2026-11-17T11:00:30Z'); // 04:00
    expect(sent(e)).toHaveLength(1);
    expect(sent(e)[0]).toMatch(/^ッツ Reader: Mon 16 Nov 2026 /);
  });

  it('the weekly and monthly messages, with the changes worked out as on the Stats page', async () => {
    const e = await makeEnv();
    await e.at('2026-11-15T23:00:00Z');
    await e.at('2026-11-16T00:00:30Z');
    expect(sent(e)).toHaveLength(2); // Sunday's day, then the week
    expect(sent(e)[1]).toBe(
      [
        'ッツ Reader: week 9 – 15 Nov 2026 (vs 2 – 8 Nov)',
        'Characters: 84,000 (+10,000, +14%)',
        'Reading time: 1 h 21 min (+33 min, +69%)',
        'Speed: 16,164 / h (+11,198 / h, +225%)',
        'Lookups: 11 (+8, +267%)',
        `[View Stats](${LINK}/statistics?period=week:2026-11-09)`,
      ].join('\n'),
    );
    e.discord.messages.length = 0;
    await e.at('2026-11-30T23:00:00Z');
    await e.at('2026-12-01T00:00:30Z');
    // 30 Nov had no reading (skipped by default); the month goes.
    expect(sent(e)).toEqual([
      [
        'ッツ Reader: November 2026 (vs October)',
        'Characters: 184,000 (+148,000, +411%)',
        'Reading time: 3 h 20 min (+1 h 30 min, +82%)',
        'Speed: 15,600 / h (−4,037 / h, −21%)',
        'Lookups: 30 (+26, +650%)',
        `[View Stats](${LINK}/statistics?period=month:2026-11-01)`,
      ].join('\n'),
    ]);
  });

  it('"No reading" is skipped by default, or sent when chosen', async () => {
    const e = await makeEnv();
    await e.at('2026-11-11T12:00:00Z');
    await e.at('2026-11-12T00:00:30Z'); // Wed 11 Nov: no reading
    expect(sent(e)).toEqual([]);
    e.svc.updateSettings({ stats: { noReading: 'send' } });
    await e.at('2026-11-12T23:00:00Z');
    await e.at('2026-11-13T00:00:30Z'); // Thu 12 Nov: reading after a day without
    await e.at('2026-11-30T23:00:00Z');
    e.discord.messages.length = 0;
    await e.at('2026-11-30T23:30:00Z');
    await e.at('2026-12-02T00:00:30Z'); // 1 Dec: no reading, sent; Nov's month too
    expect(sent(e)[0]).toBe(
      [
        'ッツ Reader: Tue 1 Dec 2026',
        'No reading.',
        `[View Stats](${LINK}/statistics?period=day:2026-12-01)`,
      ].join('\n'),
    );
  });

  it('a reading day after one without: "none then"', async () => {
    const e = await makeEnv();
    await e.at('2026-11-12T23:00:00Z');
    await e.at('2026-11-13T00:00:30Z');
    expect(sent(e)).toEqual([
      [
        'ッツ Reader: Thu 12 Nov 2026 (vs Wed 11 Nov)',
        'Characters: 15,000 (+15,000, none then)',
        'Reading time: 10 min (+10 min, none then)',
        'Speed: 18,000 / h (no tracked reading then)',
        'Lookups: 1 (+1, none then)',
        `[View Stats](${LINK}/statistics?period=day:2026-11-12)`,
      ].join('\n'),
    ]);
  });

  it('a missed period goes once when the server is back; older ones are skipped; a restart repeats nothing', async () => {
    const dbDir = testConfig().dbDir;
    const e = await makeEnv({ dbDir });
    await e.at('2026-11-10T12:00:00Z');
    // Off from then until 13 Nov 12:00: 10, 11 and 12 Nov ended meanwhile.
    await e.at('2026-11-13T12:00:00Z');
    expect(sent(e)).toHaveLength(1);
    expect(sent(e)[0]).toMatch(/^ッツ Reader: Thu 12 Nov 2026 /);
    await e.svc.stop();
    // A restart of the server on the same database.
    const svc2 = new NotificationService({
      db: e.db,
      dbDir,
      config: { ...DEFAULT_NOTIFICATIONS_CONFIG, allowAnyWebhook: true },
      now: () => Date.parse('2026-11-13T12:05:00Z'),
      log: () => undefined,
      logError: () => undefined,
    });
    await svc2.tick();
    await svc2.stop();
    expect(sent(e)).toHaveLength(1);
  });

  it('a change of week start never repeats a week', async () => {
    const e = await makeEnv();
    await e.at('2026-11-15T12:00:00Z');
    await e.at('2026-11-16T00:00:30Z');
    expect(sent(e).filter((m) => m.includes('week 9 – 15 Nov'))).toHaveLength(1);
    e.setGlobal('statsWeekStart', '0'); // Sunday: the ended week is now 8-14 Nov
    e.discord.messages.length = 0;
    await e.at('2026-11-16T12:00:00Z');
    expect(sent(e)).toEqual([]);
    await e.at('2026-11-22T00:00:30Z'); // Sun 22 Nov: the week 15-21 Nov ended
    expect(sent(e).filter((m) => m.startsWith('ッツ Reader: week'))).toEqual([
      expect.stringMatching(/^ッツ Reader: week 15 – 21 Nov 2026 \(vs 8 – 14 Nov\)\n/),
    ]);
  });

  it('nothing while the section is off, and nothing old when it is switched on', async () => {
    const e = await makeEnv({ statsOn: false });
    await e.at('2026-11-15T12:00:00Z');
    await e.at('2026-11-16T00:00:30Z');
    expect(sent(e)).toEqual([]);
    e.svc.updateSettings({ sections: { stats: true } });
    await e.at('2026-11-16T12:00:00Z');
    expect(sent(e)).toEqual([]);
    await e.at('2026-11-17T00:00:30Z');
    expect(sent(e)).toHaveLength(1);
    expect(sent(e)[0]).toMatch(/^ッツ Reader: Mon 16 Nov 2026 /);
  });

  it('per message and channel switches; the email subject is the first line', async () => {
    const smtp = await fakeSmtp('abcdefghijklmnop');
    closers.push(() => smtp.close());
    const e = await makeEnv({
      config: { smtp: { host: '127.0.0.1', port: smtp.port, secure: false } },
    });
    e.svc.putSecret('gmailAppPassword', 'abcd efgh ijkl mnop');
    e.svc.updateSettings({
      email: { from: 'me@gmail.com', to: 'me+reader@gmail.com' },
      events: { stats_daily: { email: false }, stats_weekly: { discord: false } },
    });
    await e.at('2026-11-15T12:00:00Z');
    await e.at('2026-11-16T00:00:30Z');
    expect(sent(e)).toHaveLength(1);
    expect(sent(e)[0]).toMatch(/^ッツ Reader: Sun 15 Nov 2026 /);
    expect(smtp.mails).toHaveLength(1);
    const body = quotedPrintable(smtp.mails[0].data);
    expect(body).toContain('ッツ Reader: week 9 – 15 Nov 2026 (vs 2 – 8 Nov)\nCharacters: 84,000');
    expect(subjectOf(smtp.mails[0].data)).toBe('ッツ Reader: week 9 – 15 Nov 2026 (vs 2 – 8 Nov)');
  });
});
