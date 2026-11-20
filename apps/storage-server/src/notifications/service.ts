/**
 * Notifications N1 (notifications-design.md): the server tells the user, through Discord and
 * Gmail, when something stops and waits for them or data is at risk.
 *
 * Three kinds of message: alerts (now), one daily digest, and (N2) stats reports. Everything
 * here is isolated: a failure is logged and never reaches reading, sync or the cleanup.
 *
 * One timer (checkSeconds) runs a round: the watcher looks for problems (watcher.ts), the
 * digest goes out once a day at its time, then waiting messages are sent with retries. Hooks
 * (a stage paused, a refused change, a snapshot) only add to this or ask for a round now.
 */
import type Database from 'better-sqlite3';
import { getEvent, listEvents, SECTIONS } from './events';
import {
  DISCORD_MAX,
  FetchLike,
  SendError,
  checkWebhookUrl,
  sendDiscord,
  sendEmail,
} from './channels';
import type { NotificationsConfig } from './config';
import { clip, LINKS, Message, plural, render } from './messages';
import {
  CHANNELS,
  Channel,
  mergeSettings,
  NotificationSettings,
  readSettings,
  serverTimeZone,
  writeSettings,
} from './settings';
import {
  isNotificationSecretName,
  NotificationSecretName,
  NotificationSecretStore,
} from './secrets';
import { NotificationStore, Observation } from './store';
import type { NotificationWatcher } from './watcher';
import {
  buildReport,
  lastEnded,
  loadStatsInput,
  ownerId,
  readCalendar,
  REPORT_KINDS,
  STATS_EVENT,
  StatsInput,
  statsToday,
} from './stats-report';

export type { Message } from './messages';

export interface NotificationServiceOptions {
  db: Database.Database;
  dbDir: string;
  config: NotificationsConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

export interface RefusedChange {
  code: string;
  message: string;
  kind: string;
}

/** Wall-clock day and minute in a time zone. */
export function zonedClock(now: number, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export class NotificationService {
  readonly store: NotificationStore;
  readonly secrets: NotificationSecretStore;
  private readonly config: NotificationsConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private watcher: NotificationWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;
  private stopped = false;

  constructor(o: NotificationServiceOptions) {
    this.store = new NotificationStore(o.db);
    this.secrets = new NotificationSecretStore(o.db, o.dbDir);
    this.config = o.config;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(m));
    this.logError = o.logError ?? ((m, err) => console.error(m, err ?? ''));
  }

  attachWatcher(watcher: NotificationWatcher): void {
    this.watcher = watcher;
  }

  // ---- settings ----

  settings(): NotificationSettings {
    return readSettings(this.store.db);
  }

  updateSettings(input: unknown): NotificationSettings {
    const next = mergeSettings(this.settings(), input);
    writeSettings(this.store.db, next, this.now());
    return next;
  }

  /** The browser's view: settings, which channels are set up, the events, never a secret. */
  view() {
    const settings = this.settings();
    return {
      settings,
      secrets: this.secrets.info(),
      channels: {
        discord: this.channelReady('discord', settings),
        email: this.channelReady('email', settings),
      },
      sections: SECTIONS,
      events: listEvents(),
      serverTimeZone: serverTimeZone(),
    };
  }

  putSecret(name: string, value: unknown) {
    if (!isNotificationSecretName(name)) throw new SendError('Unknown secret');
    if (typeof value !== 'string' || !value.trim()) throw new SendError('Type a value first');
    if (name === 'discordWebhookUrl') {
      const problem = checkWebhookUrl(value, this.config.allowAnyWebhook);
      if (problem) throw new SendError(problem);
    }
    return this.secrets.put(name, value.trim(), this.now());
  }

  removeSecret(name: string): void {
    if (!isNotificationSecretName(name)) throw new SendError('Unknown secret');
    this.secrets.remove(name as NotificationSecretName);
  }

  channelReady(channel: Channel, settings = this.settings()): boolean {
    if (channel === 'discord') return this.secrets.read('discordWebhookUrl') !== null;
    return (
      this.secrets.read('gmailAppPassword') !== null && !!settings.email.from && !!settings.email.to
    );
  }

  /** The channels an event goes to now: set up, its section on, its switch on. */
  channelsFor(event: string, settings = this.settings()): Channel[] {
    const def = getEvent(event);
    if (!def || !settings.sections[def.section]) return [];
    const sw = settings.events[event] ?? { discord: true, email: true };
    return CHANNELS.filter((c) => sw[c] && this.channelReady(c, settings));
  }

  // ---- messages ----

  /** Queues an alert on every channel it is switched on for. */
  notify(m: Message, settings = this.settings()): void {
    const now = this.now();
    const text = render(m, settings.linkBase);
    for (const ch of this.channelsFor(m.event, settings)) {
      this.store.queue(m.event, 'now', ch, text, now);
    }
    this.log(`Notifications: ${m.lines[0] ?? m.event}`);
  }

  /** A line for the next daily digest (the public way for other server code to add one). */
  addDigestLine(event: string, text: string, link: string | null = null): void {
    try {
      this.store.addDigestLine(event, clip(text, 300), link, this.now());
    } catch (err) {
      this.logError('Notifications: could not add a digest line:', err);
    }
  }

  /** A finished job, by the user's Now / Digest / Off. */
  finishedJob(text: string, item: string, link: string | null, settings = this.settings()): void {
    if (settings.finishedJobs === 'off') return;
    if (settings.finishedJobs === 'now') {
      this.notify({ event: 'jobs_finished', lines: [text, item], link }, settings);
    } else {
      this.addDigestLine('jobs_finished', item ? `${text}: ${item}` : text, link);
    }
  }

  observe(key: string, event: string, o: Observation): boolean {
    return this.store.observe(key, event, o, this.now());
  }

  clear(key: string): void {
    this.store.clear(key, this.now());
  }

  clearOthers(event: string, active: Set<string>): void {
    this.store.clearOthers(event, active, this.now());
  }

  // ---- hooks ----

  /** The nightly snapshot of a database finished (snapshot.ts onResult). */
  snapshotResult(prefix: string, ok: boolean, error?: unknown): void {
    this.guard('snapshot', () => {
      const key = `snapshot_failed:${prefix}`;
      if (ok) {
        this.clear(key);
        return;
      }
      const file = prefix === 'cleanup' ? 'cleanup.db' : 'ttsu.db';
      const why = clip((error as Error)?.message ?? String(error ?? ''), 160);
      const summary = `The nightly copy of ${file} failed`;
      if (this.observe(key, 'snapshot_failed', { waitMs: 0, summary, detail: why })) {
        this.notify({
          event: 'snapshot_failed',
          lines: [`${summary}: ${why}`, 'The previous copies are kept.'],
          link: LINKS.diagnostics,
        });
        this.poke();
      }
    });
  }

  /**
   * A device's push had refused changes (sync/routes.ts). One alert per device and reason;
   * more of the same stay quiet until a quiet time without any (user, 2026-11-18).
   */
  syncRefused(deviceId: string, deviceName: string | null, refused: RefusedChange[]): void {
    this.guard('refused changes', () => {
      const byCode = new Map<string, RefusedChange[]>();
      for (const r of refused) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
      const settings = this.settings();
      const name = deviceName || 'a device';
      for (const [code, list] of byCode) {
        const key = `sync_refused:${deviceId}:${code}`;
        const summary = `Changes from ${name} refused by the server (${code})`;
        const detail = clip(list[0].message, 300);
        if (this.observe(key, 'sync_refused', { waitMs: 0, summary, detail })) {
          const kinds = [...new Set(list.map((r) => r.kind))].join(', ');
          this.notify(
            {
              event: 'sync_refused',
              lines: [
                `${list.length} ${plural(list.length, 'change', 'changes')} from ${name} refused by the server: ${clip(list[0].message, 160)}`,
                kinds
                  ? `Kind: ${kinds}. They are not synced; the device keeps them for the bug report.`
                  : '',
              ],
              link: LINKS.data,
            },
            settings,
          );
          this.poke();
        }
      }
    });
  }

  // ---- sending ----

  /** Sends one test message now (no retries) and reports the result. */
  async test(channel: Channel): Promise<{ ok: boolean; error?: string }> {
    const settings = this.settings();
    if (!this.channelReady(channel, settings)) {
      return {
        ok: false,
        error:
          channel === 'discord'
            ? 'Save the webhook address first'
            : 'Save the Gmail address, the app password and the address to send to first',
      };
    }
    const text = render(
      {
        event: 'test',
        lines: ['Test message from ッツ Reader: notifications on this channel work.'],
        link: LINKS.notifications,
      },
      settings.linkBase,
    );
    // Not picked up by the sender (no next_at): it is tried once, right here.
    const id = this.store.queue('test', 'test', channel, text, this.now(), null);
    try {
      await this.deliver(channel, text, settings);
      this.store.markSent(id, 1, this.now());
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.store.markFailed(id, 1, message);
      return { ok: false, error: message };
    }
  }

  private async deliver(channel: Channel, text: string, settings: NotificationSettings) {
    const timeoutMs = this.config.sendTimeoutSeconds * 1000;
    if (channel === 'discord') {
      const url = this.secrets.read('discordWebhookUrl');
      if (!url) throw new SendError('Discord is no longer set up');
      await sendDiscord(url, text, { timeoutMs, fetchImpl: this.fetchImpl });
      return;
    }
    const pass = this.secrets.read('gmailAppPassword');
    if (!pass || !settings.email.from || !settings.email.to) {
      throw new SendError('Email is no longer set up');
    }
    const [subject, ...rest] = text.split('\n');
    await sendEmail({
      ...this.config.smtp,
      user: settings.email.from,
      pass,
      to: settings.email.to,
      subject: clip(subject, 150),
      text: [subject, ...rest].join('\n'),
      timeoutMs,
    });
  }

  /** Sends what is due; one run at a time. */
  sendDue(): Promise<void> {
    if (this.sending) return this.sending;
    const run = (async () => {
      // Let the caller see this run as the current one before it can end (with nothing to
      // send it would otherwise finish before `sending` is set, and stay set for good).
      await Promise.resolve();
      try {
        const settings = this.settings();
        for (let round = 0; round < 5; round++) {
          const rows = this.store.due(this.now());
          if (rows.length === 0) break;
          for (const row of rows) {
            if (this.stopped) return;
            const attempts = row.attempts + 1;
            try {
              await this.deliver(row.channel, row.text, settings);
              this.store.markSent(row.id, attempts, this.now());
            } catch (err) {
              const e = err as SendError;
              const message = e.message || String(err);
              if (attempts >= this.config.sendAttempts) {
                this.store.markFailed(row.id, attempts, message);
                this.logError(
                  `Notifications: ${row.channel} message failed after ${attempts} tries: ${message}`,
                );
              } else {
                const backoff =
                  (this.config.retryMinutes[
                    Math.min(attempts - 1, this.config.retryMinutes.length - 1)
                  ] ?? 1) * 60_000;
                const wait = Math.max(backoff, e.retryAfterMs ?? 0);
                this.store.markRetry(row.id, attempts, this.now() + wait, message);
              }
            }
          }
        }
        this.store.prune(this.config.logKeep);
      } catch (err) {
        this.logError('Notifications: sending failed:', err);
      }
    })();
    const current: Promise<void> = run.finally(() => {
      if (this.sending === current) this.sending = null;
    });
    this.sending = current;
    return current;
  }

  // ---- digest ----

  /** Sends the daily digest when its time has come today (in its zone) and it hasn't gone yet. */
  digestIfDue(settings = this.settings()): boolean {
    const zone = settings.digest.timeZone ?? serverTimeZone();
    const { day, minutes } = zonedClock(this.now(), zone);
    const [h, m] = settings.digest.time.split(':').map(Number);
    const at = h * 60 + m;
    const last = this.store.getState<string>('digest_day');
    if (last === undefined) {
      // First run: the first digest is the next one to come, not one at start-up.
      this.store.setState('digest_day', minutes >= at ? day : '');
      return false;
    }
    if (minutes < at || last === day) return false;
    this.store.setState('digest_day', day);
    this.sendDigest(settings);
    return true;
  }

  /** Builds and queues the digest (one per channel); nothing on a day with nothing to say. */
  sendDigest(settings = this.settings()): void {
    const lines = this.store.digestLines();
    const resolved = this.store.resolvedProblems();
    const perChannel = new Map<Channel, string[]>();
    const add = (event: string, text: string) => {
      for (const ch of this.channelsFor(event, settings)) {
        perChannel.set(ch, [...(perChannel.get(ch) ?? []), text]);
      }
    };
    for (const l of lines)
      add(l.event, l.link ? `${l.text} [Open](${settings.linkBase}${l.link})` : l.text);
    for (const p of resolved)
      add(p.event, `Resolved: ${p.summary ?? getEvent(p.event)?.label ?? p.event}`);
    const now = this.now();
    for (const [ch, items] of perChannel) {
      const head = 'ッツ Reader: daily summary';
      for (const text of this.chunks(
        head,
        items.map((t) => `• ${t}`),
        ch,
      )) {
        this.store.queue('digest', 'digest', ch, text, now);
      }
    }
    if (lines.length) this.store.deleteDigestLines(lines[lines.length - 1].id);
    for (const p of resolved) this.store.deleteProblem(p.key);
    if (perChannel.size)
      this.log(`Notifications: daily digest with ${lines.length + resolved.length} lines`);
  }

  /** Splits a long digest so a Discord message stays under its limit. */
  private chunks(head: string, items: string[], channel: Channel): string[] {
    if (channel !== 'discord') return [[head, ...items].join('\n')];
    const out: string[] = [];
    let cur = head;
    for (const item of items) {
      const line = item.slice(0, DISCORD_MAX - head.length - 2);
      if (cur.length + 1 + line.length > DISCORD_MAX) {
        out.push(cur);
        cur = `${head} (continued)`;
      }
      cur += `\n${line}`;
    }
    out.push(cur);
    return out;
  }

  // ---- stats (N2) ----

  /**
   * Queues the stats message of each day, week or month that has ended since the last
   * round (stats-report.ts). Each kind remembers the last day of the last period it
   * handled; only a later period is sent, so a missed one goes once when the server is back
   * and older ones are skipped. The first run only remembers. The mark moves on even while
   * the Stats section or the event is off, so switching it on never sends an old period.
   * Returns the number of messages queued.
   */
  statsIfDue(settings = this.settings()): number {
    const db = this.store.db;
    const userId = ownerId(db);
    if (!userId) return 0;
    const zone = settings.digest.timeZone ?? serverTimeZone();
    const calendar = readCalendar(db, userId);
    const today = statsToday(zonedClock(this.now(), zone), calendar.dayStartHour);
    let input: StatsInput | null = null;
    let queued = 0;
    for (const kind of REPORT_KINDS) {
      this.guard(`the ${kind} stats message`, () => {
        const ended = lastEnded(kind, today, calendar.weekStart);
        const key = `stats_last:${kind}`;
        const last = this.store.getState<string>(key);
        if (!ended.to || (last !== undefined && ended.to <= last)) return;
        this.store.setState(key, ended.to);
        if (last === undefined) return;
        const event = STATS_EVENT[kind];
        const channels = this.channelsFor(event, settings);
        if (channels.length === 0) return;
        input ??= loadStatsInput(db, userId);
        const text = buildReport(
          input,
          kind,
          ended,
          calendar.weekStart,
          settings.linkBase,
          settings.stats.noReading,
        );
        if (text === null) {
          this.log(`Notifications: no reading ${ended.from}–${ended.to}, ${kind} stats skipped`);
          return;
        }
        const now = this.now();
        for (const ch of channels) this.store.queue(event, 'report', ch, text, now);
        queued += channels.length;
        this.log(`Notifications: ${kind} stats for ${ended.from}–${ended.to}`);
      });
    }
    return queued;
  }

  // ---- the round ----

  /** One round: look for problems, the digest, the stats messages, then send. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let settings: NotificationSettings | null = null;
    try {
      settings = this.settings();
      if (this.watcher) this.watcher.check(settings);
      this.digestIfDue(settings);
    } catch (err) {
      this.logError('Notifications: the check failed:', err);
    }
    if (settings) {
      try {
        this.statsIfDue(settings);
      } catch (err) {
        this.logError('Notifications: the stats messages failed:', err);
      }
    }
    await this.sendDue();
  }

  /** A hook saw something: run a round soon (several pokes make one round). */
  poke(): void {
    if (this.stopped || this.pokeTimer || !this.timer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.tick();
    }, 500);
    this.pokeTimer.unref();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.checkSeconds * 1000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.timer = null;
    this.pokeTimer = null;
    await this.sending?.catch(() => undefined);
  }

  // ---- diagnostics ----

  diagnostics(limit = 50) {
    const label = (event: string) =>
      event === 'test'
        ? 'Test message'
        : event === 'digest'
          ? 'Daily summary'
          : (getEvent(event)?.label ?? event);
    const info = this.secrets.info();
    return {
      available: true as const,
      channels: {
        discord: this.channelReady('discord'),
        email: this.channelReady('email'),
      },
      secretsUnreadable: Object.values(info).some((i) => i.unreadable),
      openProblems: this.store.openProblems().map((p) => ({
        event: p.event,
        label: label(p.event),
        summary: p.summary,
        detail: p.detail,
        since: p.first_seen_at,
        noticedAt: p.noticed_at,
      })),
      log: this.store.recentLog(limit).map((r) => ({
        id: r.id,
        at: r.sent_at ?? r.created_at,
        createdAt: r.created_at,
        channel: r.channel,
        kind: r.kind,
        event: r.event,
        label: label(r.event),
        text: r.text,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
      })),
    };
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logError(`Notifications: ${what}:`, err);
    }
  }
}
