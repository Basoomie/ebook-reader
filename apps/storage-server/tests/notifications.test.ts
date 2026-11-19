/**
 * Notifications N1: channels (a fake Discord and a fake SMTP server only, never the real
 * ones), write-only secrets with the key outside ttsu.db, the anti-fatigue rules, the digest,
 * every alert's detection, and the hooks (stage pauses, snapshots, refused changes).
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { onStagePaused, pauseStage, resumeStage } from '../src/cleanup/stages';
import { pauseAudioStage } from '../src/cleanup/audio/audio-stages';
import { initDatabase } from '../src/db/database';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { DEFAULT_NOTIFICATIONS_CONFIG, NotificationsConfig } from '../src/notifications/config';
import { checkWebhookUrl } from '../src/notifications/channels';
import { NotificationService, zonedClock } from '../src/notifications/service';
import { defaultSettings, mergeSettings } from '../src/notifications/settings';
import { NOTIFICATION_KEY_FILE } from '../src/notifications/secrets';
import { NotificationWatcher } from '../src/notifications/watcher';
import { scheduleSnapshots } from '../src/snapshot';
import { fakeDiscord, FakeDiscord, fakeSmtp, quotedPrintable } from './helpers/notify-fakes';
import { testConfig } from './helpers/test-app';

// ---- the setup ----

const HOUR = 3_600_000;
const MIN = 60_000;

interface Env {
  db: Database.Database;
  cdb: Database.Database;
  dbDir: string;
  clock: { t: number };
  svc: NotificationService;
  watcher: NotificationWatcher;
  discord: FakeDiscord;
  sidecar: { online: boolean; lastSeenAt: number | null };
  fetcher: { online: boolean; lastSeenAt: number | null; problem: string | null };
  expired: number;
  /** One round, and wait for the sending it starts. */
  round(): Promise<void>;
}

const envs: Env[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (envs.length) {
    const e = envs.pop()!;
    await e.svc.stop();
    await e.discord.close();
    e.cdb.close();
    e.db.close();
  }
  while (closers.length) await closers.pop()!();
});

function notifyConfig(over: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return { ...DEFAULT_NOTIFICATIONS_CONFIG, allowAnyWebhook: true, retryMinutes: [0, 0], ...over };
}

async function makeEnv(over: Partial<NotificationsConfig> = {}, dbDir?: string): Promise<Env> {
  const dir = dbDir ?? testConfig().dbDir;
  const database = initDatabase(dir, testConfig().dataRoot);
  if (!database.ok) throw new Error('no database');
  const cleanup = initCleanupDatabase(dir);
  if (!cleanup.ok) throw new Error('no cleanup.db');
  const clock = { t: Date.UTC(2026, 10, 18, 12, 0, 0) };
  const discord = await fakeDiscord();
  const svc = new NotificationService({
    db: database.db,
    dbDir: dir,
    config: notifyConfig(over),
    now: () => clock.t,
    log: () => undefined,
    logError: () => undefined,
  });
  const env = {
    db: database.db,
    cdb: cleanup.db,
    dbDir: dir,
    clock,
    svc,
    discord,
    sidecar: { online: true, lastSeenAt: clock.t },
    fetcher: { online: true, lastSeenAt: clock.t, problem: null },
    expired: 0,
  } as Env;
  env.watcher = new NotificationWatcher(svc, {
    db: database.db,
    cleanupDb: cleanup.db,
    cleanup: { sidecar: () => ({ ...env.sidecar }), fetcher: () => ({ ...env.fetcher }) },
    jobs: { expireLeases: () => void env.expired++ },
    workerOfflineSeconds: 120,
    now: () => clock.t,
    logError: (m, err) => {
      throw new Error(`${m} ${String(err)}`);
    },
  });
  svc.attachWatcher(env.watcher);
  env.round = () => svc.tick();
  envs.push(env);
  return env;
}

async function withDiscord(e: Env): Promise<void> {
  e.svc.putSecret('discordWebhookUrl', e.discord.url);
  await e.round(); // first look: watermarks only
}

function seedBook(db: Database.Database, id = 'b1', title = '最後は臼が笑う'): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'japanese-library', 'ja', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', ?, ?, ?, ?)`,
  ).run(id, title, now, now, now);
}

function owner(db: Database.Database): string {
  return listUsers(db)[0].id;
}

let jobId = 100;
function addJob(
  e: Env,
  kind: string,
  state: string,
  { book = 'b1', error = null as string | null, finishedAt = e.clock.t } = {},
): number {
  const id = ++jobId;
  e.db
    .prepare(
      `INSERT INTO worker_jobs (id, user_id, book_id, kind, library_id, audio_folder_rel_path,
         audio_file_name, state, error, created_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, 'lib1', 'f', 'a.m4b', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      owner(e.db),
      book,
      kind,
      state,
      error,
      e.clock.t,
      state === 'queued' ? null : finishedAt,
      e.clock.t,
    );
  return id;
}

function heartbeat(e: Env, { problem = null as string | null, paused = 0, at = e.clock.t } = {}) {
  e.db
    .prepare(
      `INSERT INTO worker_status (id, paused, last_seen_at, problem, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, last_seen_at = excluded.last_seen_at,
         problem = excluded.problem, updated_at = excluded.updated_at`,
    )
    .run(paused, at, problem, at);
}

// ---- tests ----

describe('secrets', () => {
  it('are write-only, keep their key outside ttsu.db, and copies of ttsu.db reveal nothing', async () => {
    const e = await makeEnv();
    const url = e.discord.url;
    e.svc.putSecret('discordWebhookUrl', url);
    expect(e.svc.secrets.read('discordWebhookUrl')).toBe(url);
    expect(JSON.stringify(e.svc.view())).not.toContain(url);
    expect(JSON.stringify(e.svc.view())).not.toContain('abc');
    const keyFile = path.join(e.dbDir, NOTIFICATION_KEY_FILE);
    expect(fs.statSync(keyFile).size).toBe(32);
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    // The database file holds no plain value.
    e.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(fs.readFileSync(path.join(e.dbDir, 'ttsu.db')).includes(Buffer.from(url))).toBe(false);

    // A copy of ttsu.db somewhere else (a rollback copy, a snapshot): no key, nothing readable.
    const copyDir = testConfig().dbDir;
    await e.db.backup(path.join(copyDir, 'ttsu.db'));
    const copy = await makeEnv({}, copyDir);
    expect(copy.svc.secrets.read('discordWebhookUrl')).toBeNull();
    expect(copy.svc.view().secrets.discordWebhookUrl).toEqual({
      set: false,
      updatedAt: null,
      unreadable: true,
    });
    expect(copy.svc.diagnostics().secretsUnreadable).toBe(true);
  });

  it('accepts only Discord webhook addresses outside tests', () => {
    expect(checkWebhookUrl('https://discord.com/api/webhooks/123/abc-DEF_1', false)).toBeNull();
    expect(checkWebhookUrl('http://discord.com/api/webhooks/123/abc', false)).toMatch(/https/);
    expect(checkWebhookUrl('https://example.com/api/webhooks/1/a', false)).toMatch(/Discord/);
    expect(checkWebhookUrl('not a url', false)).toMatch(/not a web address/);
    expect(checkWebhookUrl('http://127.0.0.1:9/api/webhooks/1/a', true)).toBeNull();
  });
});

describe('settings', () => {
  it('has the decided defaults', () => {
    const d = defaultSettings();
    expect(d.linkBase).toBe('http://192.168.1.5:3080');
    expect(d.digest).toEqual({ time: '08:00', timeZone: null });
    expect(d.finishedJobs).toBe('digest');
    expect(d.waits).toEqual({
      pcWaitingHours: 24,
      pcProblemMinutes: 10,
      applyHelperMinutes: 30,
      fetchHelperMinutes: 30,
      refusalQuietHours: 24,
    });
    // N2 added Stats, off by default.
    expect(d.sections).toEqual({ jobs: true, cleanup: true, data: true, stats: false });
    expect(d.events.job_failed).toEqual({ discord: true, email: true });
  });

  it('validates, and a section switched off keeps its items', () => {
    const d = defaultSettings();
    expect(() => mergeSettings(d, { digest: { time: '25:00' } })).toThrow(/08:00/);
    expect(() => mergeSettings(d, { digest: { timeZone: 'Mars/Base' } })).toThrow(/time zone/);
    expect(() => mergeSettings(d, { waits: { pcWaitingHours: 0 } })).toThrow(/from 1/);
    expect(() => mergeSettings(d, { email: { to: 'nope' } })).toThrow(/email/);
    expect(() => mergeSettings(d, { linkBase: 'ftp://x' })).toThrow(/http/);
    const s1 = mergeSettings(d, { events: { job_failed: { email: false } } });
    const s2 = mergeSettings(s1, { sections: { jobs: false } });
    const s3 = mergeSettings(s2, { sections: { jobs: true } });
    expect(s3.events.job_failed).toEqual({ discord: true, email: false });
    expect(mergeSettings(d, { digest: { timeZone: 'America/Phoenix' } }).digest.timeZone).toBe(
      'America/Phoenix',
    );
  });
});

describe('channels', () => {
  it('Send test reaches the fake Discord and the fake Gmail (UTF-8 subject, app password without spaces)', async () => {
    const e = await makeEnv();
    const smtp = await fakeSmtp('abcdefghijklmnop');
    closers.push(() => smtp.close());
    const e2 = await makeEnv({ smtp: { host: '127.0.0.1', port: smtp.port, secure: false } });
    e2.svc.putSecret('gmailAppPassword', 'abcd efgh ijkl mnop');
    expect(await e2.svc.test('email')).toEqual({
      ok: false,
      error: 'Save the Gmail address, the app password and the address to send to first',
    });
    e2.svc.updateSettings({ email: { from: 'me@gmail.com', to: 'me+reader@gmail.com' } });
    expect(await e2.svc.test('email')).toEqual({ ok: true });
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].auth).toBe('me@gmail.com');
    expect(smtp.mails[0].to).toContain('me+reader@gmail.com');
    expect(smtp.mails[0].data).toMatch(/Subject: =\?UTF-8\?/);
    expect(quotedPrintable(smtp.mails[0].data)).toContain(
      'Test message from ッツ Reader: notifications on this channel work.\nhttp://192.168.1.5:3080/settings?tab=notifications',
    );

    smtp.password = 'something else';
    const bad = await e2.svc.test('email');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Gmail refused the sign-in/);
    expect(bad.error).not.toContain('abcd');

    e.svc.putSecret('discordWebhookUrl', e.discord.url);
    expect(await e.svc.test('discord')).toEqual({ ok: true });
    expect(e.discord.messages[0]).toMatch(/^Test message from ッツ Reader/);
    const log = e.svc.diagnostics().log;
    expect(log[0]).toMatchObject({ kind: 'test', channel: 'discord', status: 'sent' });
  });

  it('retries a failed send, then records it as failed after the last try', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.discord.replies.push(500, 429, 500);
    e.svc.notify({ event: 'snapshot_failed', lines: ['x'], link: null });
    for (let i = 0; i < 3; i++) {
      e.clock.t += MIN;
      await e.svc.sendDue();
    }
    const [row] = e.svc.diagnostics().log;
    expect(row).toMatchObject({ status: 'failed', attempts: 3, error: 'Discord answered 500' });
    // A later message goes through.
    e.svc.notify({ event: 'snapshot_failed', lines: ['y'], link: null });
    await e.svc.sendDue();
    expect(e.discord.messages).toEqual(['y']);
  });
});

describe('PC jobs and merges', () => {
  beforeEach(() => undefined);

  it('alerts a final failure once, groups one cause, and skips stops, requeues, previews and samples', async () => {
    const e = await makeEnv();
    seedBook(e.db);
    seedBook(e.db, 'b2', '星を継ぐもの');
    const before = addJob(e, 'sync_subtitles', 'failed', { error: 'old' });
    await withDiscord(e);
    expect(e.discord.messages).toEqual([]); // failures from before the first look are not news
    expect(before).toBeGreaterThan(0);

    e.clock.t += MIN;
    addJob(e, 'sync_subtitles', 'failed', {
      error: 'SubPlz ran longer than 8 hours and was stopped',
    });
    addJob(e, 'sync_subtitles', 'cancelled'); // the user's Stop
    addJob(e, 'sync_subtitles', 'queued'); // a retry still to come
    addJob(e, 'preview_audiobook', 'failed', { error: 'x' });
    addJob(e, 'voice_sample', 'failed', { error: 'x', book: null as unknown as string });
    await e.round();
    expect(e.expired).toBeGreaterThan(0);
    expect(e.discord.messages).toEqual([
      'Subtitles failed on the PC: SubPlz ran longer than 8 hours and was stopped\n' +
        '最後は臼が笑う\nhttp://192.168.1.5:3080/library/book?id=b1',
    ]);

    // Nothing again for the same rows.
    e.clock.t += MIN;
    await e.round();
    expect(e.discord.messages).toHaveLength(1);

    // Two failing for one cause: one message.
    e.clock.t += MIN;
    addJob(e, 'generate_audiobook', 'failed', { error: 'Docker Desktop is not running on the PC' });
    addJob(e, 'sentence_audio', 'failed', {
      error: 'Docker Desktop is not running on the PC',
      book: 'b2',
    });
    await e.round();
    expect(e.discord.messages[1]).toBe(
      '2 PC jobs failed (Audiobook, Sentence audio): Docker Desktop is not running on the PC\n' +
        '最後は臼が笑う and 星を継ぐもの\nhttp://192.168.1.5:3080/settings?tab=audiobooks',
    );
  });

  it('finds a row written up to 10 minutes after its finish time', async () => {
    const e = await makeEnv();
    seedBook(e.db);
    await withDiscord(e);
    e.clock.t += 5 * MIN;
    addJob(e, 'sync_subtitles', 'failed', { error: 'late', finishedAt: e.clock.t - 8 * MIN });
    await e.round();
    expect(e.discord.messages).toHaveLength(1);
  });

  it('alerts a merge interrupted by a restart, not a cancelled one; finished jobs go to the digest', async () => {
    const e = await makeEnv();
    seedBook(e.db);
    await withDiscord(e);
    const merge = (state: string, error: string | null) =>
      e.db
        .prepare(
          `INSERT INTO audio_merge_jobs (user_id, book_id, library_id, folder_rel_path, file_names,
             state, error, created_at, finished_at, updated_at)
           VALUES (?, 'b1', 'lib1', 'Author/Book', '[]', ?, ?, ?, ?, ?)`,
        )
        .run(owner(e.db), state, error, e.clock.t, e.clock.t, e.clock.t);
    e.clock.t += MIN;
    merge('failed', 'Interrupted: the server restarted during the merge. Start it again.');
    merge('cancelled', null);
    merge('done', null);
    addJob(e, 'sync_subtitles', 'done');
    addJob(e, 'preview_audiobook', 'done');
    await e.round();
    expect(e.discord.messages).toEqual([
      'Audiobook merge failed: Interrupted: the server restarted during the merge. Start it again.\n' +
        '最後は臼が笑う\nhttp://192.168.1.5:3080/library/book?id=b1',
    ]);
    e.svc.sendDigest();
    await e.svc.sendDue();
    expect(e.discord.messages[1]).toBe(
      'ッツ Reader: daily summary\n' +
        '• Subtitles finished: 最後は臼が笑う http://192.168.1.5:3080/library/book?id=b1\n' +
        '• Audiobook merge finished: 最後は臼が笑う http://192.168.1.5:3080/library/book?id=b1',
    );

    // Now: a message each; Off: nothing.
    e.svc.updateSettings({ finishedJobs: 'now' });
    e.clock.t += MIN;
    addJob(e, 'generate_audiobook', 'done');
    await e.round();
    expect(e.discord.messages[2]).toBe(
      'Audiobook finished\n最後は臼が笑う\nhttp://192.168.1.5:3080/library/book?id=b1',
    );
    e.svc.updateSettings({ finishedJobs: 'off' });
    e.clock.t += MIN;
    addJob(e, 'generate_audiobook', 'done');
    await e.round();
    e.svc.sendDigest();
    await e.svc.sendDue();
    expect(e.discord.messages).toHaveLength(3);
  });
});

describe('the PC', () => {
  it('waits 10 minutes for a Docker problem while the PC is on (sign-in), and says when it is resolved', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    // At sign-in Docker isn't up for a minute: gone before the wait, nothing at all.
    heartbeat(e, { problem: 'Docker Desktop is not running on the PC' });
    await e.round();
    e.clock.t += 2 * MIN;
    heartbeat(e);
    await e.round();
    expect(e.discord.messages).toEqual([]);
    expect(e.svc.store.getProblem('pc_problem')).toBeUndefined();

    heartbeat(e, { problem: 'Docker Desktop is not running on the PC' });
    await e.round();
    e.clock.t += 9 * MIN;
    heartbeat(e, { problem: 'Docker Desktop is not running on the PC' });
    await e.round();
    expect(e.discord.messages).toEqual([]);
    e.clock.t += MIN;
    heartbeat(e, { problem: 'Docker Desktop is not running on the PC' });
    await e.round();
    expect(e.discord.messages).toEqual([
      'Problem on the PC: Docker Desktop is not running on the PC\n' +
        'Jobs that need it wait until it is fixed.\nhttp://192.168.1.5:3080/settings?tab=audiobooks',
    ]);
    e.clock.t += 30 * MIN;
    heartbeat(e, { problem: 'Docker Desktop is not running on the PC' });
    await e.round();
    expect(e.discord.messages).toHaveLength(1); // one alert per problem

    heartbeat(e);
    await e.round();
    e.svc.sendDigest();
    await e.svc.sendDue();
    expect(e.discord.messages[1]).toBe(
      'ッツ Reader: daily summary\n• Resolved: Problem on the PC: Docker Desktop is not running on the PC',
    );
    // The PC off with a stale problem: not a Docker problem.
    heartbeat(e, { problem: 'x', at: e.clock.t - HOUR });
    await e.round();
    expect(e.svc.store.getProblem('pc_problem')).toBeUndefined();
  });

  it('alerts jobs waiting 24 hours while the PC is off', async () => {
    const e = await makeEnv();
    seedBook(e.db);
    await withDiscord(e);
    heartbeat(e, { at: e.clock.t - 3 * HOUR });
    addJob(e, 'sync_subtitles', 'queued');
    await e.round();
    e.clock.t += 23 * HOUR;
    await e.round();
    expect(e.discord.messages).toEqual([]);
    e.clock.t += HOUR;
    await e.round();
    expect(e.discord.messages).toEqual([
      '1 PC job has waited 24 h: the PC is off\n最後は臼が笑う\nhttp://192.168.1.5:3080/settings?tab=audiobooks',
    ]);
    // Back on: resolved.
    heartbeat(e);
    await e.round();
    expect(e.svc.store.getProblem('pc_waiting')?.resolved_at).toBe(e.clock.t);
  });
});

describe('the cleanup', () => {
  it('a paused stage alerts at once through the hook; two stages for the indexer refusal make one message', async () => {
    const e = await makeEnv({ checkSeconds: 3600 });
    seedBook(e.db);
    await withDiscord(e);
    closers.push(onStagePaused(() => e.svc.poke()));
    e.svc.start();
    await new Promise((r) => setTimeout(r, 50));
    e.db
      .prepare(
        `INSERT INTO library_index_state (library_id, last_warning, last_warning_at) VALUES ('lib1', ?, ?)`,
      )
      .run(
        '3700 of 65000 books (5.7%) are no longer in metadata.db, more than CALIBRE_MAX_MISSING_PERCENT=5. They were NOT flagged missing.',
        e.clock.t,
      );
    pauseStage(e.cdb, 1, 'mass_missing', 'The reader index reported: …');
    pauseStage(e.cdb, 3, 'mass_missing', 'The reader index reported: …');
    await new Promise((r) => setTimeout(r, 800));
    await e.svc.sendDue();
    expect(e.discord.messages).toEqual([
      'The Calibre index of "ja" was not updated: 3700 of 65000 books (5.7%) are no longer in metadata.db\n' +
        "The Calibre cleanup's stages 1 and 3 paused because of it. No book was marked missing.\n" +
        'http://192.168.1.5:3080/settings?tab=diagnostics',
    ]);
    const open = e.svc
      .diagnostics()
      .openProblems.map((p) => p.event)
      .sort();
    expect(open).toEqual(['index_refused', 'stage_paused', 'stage_paused']);

    // A pause repeated with the same reason: nothing new.
    pauseStage(e.cdb, 1, 'mass_missing', 'The reader index reported: …');
    await new Promise((r) => setTimeout(r, 800));
    await e.svc.sendDue();
    expect(e.discord.messages).toHaveLength(1);

    // Another reason later: its own message.
    pauseStage(e.cdb, 2, 'library_changed', '3 of the next 40 books changed in Calibre.');
    await new Promise((r) => setTimeout(r, 800));
    await e.svc.sendDue();
    expect(e.discord.messages[1]).toBe(
      'Calibre cleanup stage 2 (Metadata and covers from the files) paused: books changed in Calibre since the analysis\n' +
        '3 of the next 40 books changed in Calibre.\nhttp://192.168.1.5:3080/cleanup',
    );

    // Resumed by the user: one "Resolved" line in the next digest.
    resumeStage(e.cdb, 2);
    await e.round();
    e.svc.sendDigest();
    await e.svc.sendDue();
    expect(e.discord.messages[2]).toContain(
      '• Resolved: Calibre cleanup stage 2 (Metadata and covers from the files) paused',
    );
  });

  it('an audiobook stage pause links to the Audiobooks tab', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    pauseAudioStage(e.cdb, 3, 'disk_busy', 'Calibre used the disk.');
    await e.round();
    expect(e.discord.messages).toEqual([
      'Audiobook cleanup stage 3 (Duplicates (same recording)) paused: disk busy\n' +
        'Calibre used the disk.\nhttp://192.168.1.5:3080/cleanup?tab=audiobooks',
    ]);
  });

  it('the apply helper offline 30 minutes; the fetch helper only while stage 4 has requests', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.sidecar = { online: false, lastSeenAt: e.clock.t - 29 * MIN };
    await e.round();
    expect(e.discord.messages).toEqual([]);
    e.clock.t += MIN;
    await e.round();
    expect(e.discord.messages).toEqual([
      "The cleanup's apply helper is offline (last seen 30 min ago)\n" +
        'Calibre cleanup batches wait until it is back.\nhttp://192.168.1.5:3080/cleanup',
    ]);
    // Never seen (not set up): no alert.
    e.sidecar = { online: false, lastSeenAt: null };
    await e.round();

    e.fetcher = { online: false, lastSeenAt: e.clock.t - 2 * HOUR, problem: null };
    await e.round();
    expect(e.svc.store.getProblem('fetch_offline')).toBeUndefined(); // stage 4 off, no work
    e.cdb.prepare("UPDATE stages SET mode = 'analyse' WHERE stage = 4").run();
    e.cdb
      .prepare(
        `INSERT INTO fetch_requests (site, key, url, created_at, updated_at) VALUES ('amazon', 'k', 'https://x', ?, ?)`,
      )
      .run(e.clock.t, e.clock.t);
    await e.round();
    expect(e.discord.messages[1]).toBe(
      "The cleanup's fetch helper is offline while stage 4 has requests waiting\n" +
        'Online sources (stage 4) wait until it is back.\nhttp://192.168.1.5:3080/cleanup',
    );
  });

  it('the fetch helper also matters while the audiobook stage 4 has requests (WP21c)', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.fetcher = { online: false, lastSeenAt: e.clock.t - 2 * HOUR, problem: null };
    e.cdb
      .prepare(
        `INSERT INTO fetch_requests (site, key, url, created_at, updated_at) VALUES ('audible', 'k', 'https://x', ?, ?)`,
      )
      .run(e.clock.t, e.clock.t);
    await e.round();
    expect(e.svc.store.getProblem('fetch_offline')).toBeUndefined(); // both stages 4 off
    e.cdb.prepare("UPDATE audio_stages SET mode = 'analyse' WHERE stage = 4").run();
    await e.round();
    expect(e.discord.messages[0]).toMatch(/fetch helper is offline/);
  });

  it('automatic field pauses and resumes are digest lines', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.cdb
      .prepare(
        "INSERT INTO stage_field_pauses (stage, field, reason, detail, paused_at) VALUES (2, 'title', 'gate', 'x', ?)",
      )
      .run(e.clock.t);
    await e.round();
    e.cdb.prepare('DELETE FROM stage_field_pauses').run();
    await e.round();
    expect(e.discord.messages).toEqual([]);
    e.svc.sendDigest();
    await e.svc.sendDue();
    expect(e.discord.messages).toEqual([
      'ッツ Reader: daily summary\n' +
        '• Calibre cleanup stage 2: "title" paused (below its accuracy bar on the labeled books) http://192.168.1.5:3080/cleanup\n' +
        '• Calibre cleanup stage 2: "title" resumed http://192.168.1.5:3080/cleanup',
    ]);
  });
});

describe('library and data', () => {
  it('the nightly snapshot reports success and failure (hook in snapshot.ts)', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    const results: boolean[] = [];
    const notADir = path.join(e.dbDir, 'a-file');
    fs.writeFileSync(notADir, 'x');
    const bad = scheduleSnapshots({
      db: e.db,
      dir: path.join(notADir, 'snapshots'),
      time: { hour: 3, minute: 0 },
      keep: 2,
      log: () => undefined,
      logError: () => undefined,
      onResult: (ok, err) => {
        results.push(ok);
        e.svc.snapshotResult('ttsu', ok, err);
      },
    });
    await bad.ready;
    bad.stop();
    expect(results).toEqual([false]);
    await e.svc.sendDue();
    expect(e.discord.messages[0]).toMatch(/^The nightly copy of ttsu.db failed: /);
    expect(e.discord.messages[0]).toMatch(/settings\?tab=diagnostics$/);
    e.svc.snapshotResult('ttsu', false, new Error('again'));
    await e.svc.sendDue();
    expect(e.discord.messages).toHaveLength(1);

    const good = scheduleSnapshots({
      db: e.db,
      dir: path.join(e.dbDir, 'snapshots'),
      time: { hour: 3, minute: 0 },
      keep: 2,
      log: () => undefined,
      onResult: (ok, err) => {
        results.push(ok);
        e.svc.snapshotResult('ttsu', ok, err);
      },
    });
    await good.ready;
    good.stop();
    expect(results).toEqual([false, true]);
    expect(e.svc.store.getProblem('snapshot_failed:ttsu')?.resolved_at).not.toBeNull();
  });

  it('a refused change alerts once per device and reason; 24 h without another = resolved', async () => {
    const config = testConfig();
    const database = initDatabase(config.dbDir, config.dataRoot);
    if (!database.ok) throw new Error('no database');
    const discord = await fakeDiscord();
    closers.push(() => discord.close());
    const clock = { t: Date.now() };
    const svc = new NotificationService({
      db: database.db,
      dbDir: config.dbDir,
      config: notifyConfig(),
      now: () => clock.t,
      log: () => undefined,
    });
    closers.push(() => svc.stop());
    svc.attachWatcher(new NotificationWatcher(svc, { db: database.db, now: () => clock.t }));
    svc.putSecret('discordWebhookUrl', discord.url);
    const app = createApp({ config, database, version: 't', notifications: svc });
    const token = createToken(database.db, owner(database.db), 'Boox').token;
    const auth = { Authorization: `Bearer ${token}` };
    await request(app)
      .post('/api/v1/devices/register')
      .set(auth)
      .send({ name: 'Boox' })
      .expect(200);
    const statDay = (id: string) => ({
      kind: 'stat-day',
      id,
      data: { day: '2026-11-18' },
      updatedAt: Date.now(),
      baseRev: null,
    });
    const push = async (changes: unknown[]) =>
      (await request(app).post('/api/v1/sync').set(auth).send({ changes }).expect(200)).body as {
        results: { status: string; error?: { code: string } }[];
      };
    const r1 = await push([statDay('a'), statDay('b')]);
    expect(r1.results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await svc.sendDue();
    expect(discord.messages).toHaveLength(1);
    expect(discord.messages[0]).toMatch(/^2 changes from Boox refused by the server: /);
    expect(discord.messages[0]).toMatch(/Kind: stat-day\./);
    expect(discord.messages[0]).toMatch(/settings\?tab=data$/);

    clock.t += HOUR;
    await push([statDay('c')]);
    await svc.sendDue();
    expect(discord.messages).toHaveLength(1);

    clock.t += 23 * HOUR + MIN;
    await svc.tick();
    expect(svc.store.problemsOf('sync_refused')[0].resolved_at).toBeNull(); // 23 h since the last one
    clock.t += HOUR;
    await svc.tick();
    svc.sendDigest();
    await svc.sendDue();
    expect(discord.messages[1]).toMatch(
      /• Resolved: Changes from Boox refused by the server \(stat_day_frozen\)/,
    );
    // Later again: a new alert.
    await push([statDay('d')]);
    await svc.sendDue();
    expect(discord.messages).toHaveLength(3);
    database.db.close();
  });
});

describe('switches, digest time, restarts', () => {
  it('a section or event switched off sends nothing and does not burst later', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.svc.updateSettings({ sections: { data: false } });
    e.svc.snapshotResult('ttsu', false, new Error('disk full'));
    await e.svc.sendDue();
    expect(e.discord.messages).toEqual([]);
    e.svc.updateSettings({ sections: { data: true } });
    e.svc.snapshotResult('ttsu', false, new Error('disk full'));
    await e.svc.sendDue();
    expect(e.discord.messages).toEqual([]);
    e.svc.updateSettings({ events: { apply_offline: { discord: false } } });
    e.sidecar = { online: false, lastSeenAt: e.clock.t - HOUR };
    await e.round();
    expect(e.discord.messages).toEqual([]);
  });

  it('the digest goes once a day at its time in its zone, and not on an empty day', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    e.svc.updateSettings({ digest: { time: '08:00', timeZone: 'America/Phoenix' } });
    // 2026-11-19 07:59 in Phoenix (UTC-7) = 14:59Z.
    e.clock.t = Date.UTC(2026, 10, 19, 14, 59);
    expect(zonedClock(e.clock.t, 'America/Phoenix')).toEqual({ day: '2026-11-19', minutes: 479 });
    e.svc.addDigestLine('jobs_finished', 'Subtitles finished: A');
    await e.round();
    expect(e.discord.messages).toEqual([]);
    e.clock.t += MIN;
    await e.round();
    expect(e.discord.messages).toEqual(['ッツ Reader: daily summary\n• Subtitles finished: A']);
    e.svc.addDigestLine('jobs_finished', 'Subtitles finished: B');
    e.clock.t += HOUR;
    await e.round();
    expect(e.discord.messages).toHaveLength(1); // once a day
    e.clock.t += 24 * HOUR;
    await e.round();
    expect(e.discord.messages[1]).toBe('ッツ Reader: daily summary\n• Subtitles finished: B');
    e.clock.t += 24 * HOUR;
    await e.round();
    expect(e.discord.messages).toHaveLength(2); // nothing to say
  });

  it('a restart repeats no alert (problems are kept in ttsu.db)', async () => {
    const e = await makeEnv();
    await withDiscord(e);
    pauseStage(e.cdb, 1, 'batch_failed', '2 of 40 items failed.');
    await e.round();
    expect(e.discord.messages).toHaveLength(1);
    const again = new NotificationService({
      db: e.db,
      dbDir: e.dbDir,
      config: notifyConfig(),
      now: () => e.clock.t,
      log: () => undefined,
    });
    again.attachWatcher(
      new NotificationWatcher(again, { db: e.db, cleanupDb: e.cdb, now: () => e.clock.t }),
    );
    await again.tick();
    expect(e.discord.messages).toHaveLength(1);
  });

  it('GET /diagnostics carries open problems and the log; the routes need a user token and never echo secrets', async () => {
    const config = testConfig();
    const database = initDatabase(config.dbDir, config.dataRoot);
    if (!database.ok) throw new Error('no database');
    const discord = await fakeDiscord();
    closers.push(() => discord.close());
    const svc = new NotificationService({
      db: database.db,
      dbDir: config.dbDir,
      config: notifyConfig(),
      log: () => undefined,
    });
    const app = createApp({ config, database, version: 't', notifications: svc });
    const token = createToken(database.db, owner(database.db), 'PC').token;
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).get('/api/v1/notifications/settings').expect(401);
    const worker = createToken(database.db, owner(database.db), 'PC', Date.now(), 'worker').token;
    await request(app)
      .get('/api/v1/notifications/settings')
      .set({ Authorization: `Bearer ${worker}` })
      .expect(403);

    const put = await request(app)
      .put('/api/v1/notifications/secrets/discordWebhookUrl')
      .set(auth)
      .send({ value: discord.url })
      .expect(200);
    expect(JSON.stringify(put.body)).not.toContain(discord.url);
    expect(put.body.secrets.discordWebhookUrl.set).toBe(true);
    expect(put.body.channels).toEqual({ discord: true, email: false });
    await request(app)
      .put('/api/v1/notifications/secrets/nope')
      .set(auth)
      .send({ value: 'x' })
      .expect(404);
    await request(app)
      .put('/api/v1/notifications/settings')
      .set(auth)
      .send({ digest: { time: '7am' } })
      .expect(400);
    const test = await request(app)
      .post('/api/v1/notifications/test/discord')
      .set(auth)
      .expect(200);
    expect(test.body).toEqual({ ok: true });
    svc.snapshotResult('cleanup', false, new Error('disk full'));

    const diag = await request(app).get('/api/v1/diagnostics').set(auth).expect(200);
    expect(diag.body.notifications.available).toBe(true);
    expect(diag.body.notifications.openProblems).toMatchObject([
      {
        event: 'snapshot_failed',
        summary: 'The nightly copy of cleanup.db failed',
        detail: 'disk full',
      },
    ]);
    expect(diag.body.notifications.log.map((l: { kind: string }) => l.kind)).toEqual([
      'now',
      'test',
    ]);
    expect(JSON.stringify(diag.body)).not.toContain(discord.url);

    // A server without notifications: 503 on its routes, unavailable on Diagnostics.
    const off = createApp({ config, database, version: 't' });
    await request(off).get('/api/v1/notifications/settings').set(auth).expect(503);
    const d2 = await request(off).get('/api/v1/diagnostics').set(auth).expect(200);
    expect(d2.body.notifications).toEqual({ available: false });
    await svc.stop();
    database.db.close();
  });
});
