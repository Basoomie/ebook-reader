/**
 * The user's notification settings (Settings > Notifications), stored on the server (it
 * sends). One JSON value in ttsu.db notification_settings; defaults fill anything missing,
 * so an event added later starts with its defaults.
 */
import type Database from 'better-sqlite3';
import { listEvents, SECTIONS, SectionId } from './events';

export type Channel = 'discord' | 'email';
export const CHANNELS: Channel[] = ['discord', 'email'];
export type FinishedMode = 'now' | 'digest' | 'off';

export interface Waits {
  /** Jobs waiting while the PC is off or paused (hours). */
  pcWaitingHours: number;
  /** A Docker problem reported by the PC while it is on (minutes; user 2026-11-18). */
  pcProblemMinutes: number;
  /** The cleanup's apply helper offline (minutes). */
  applyHelperMinutes: number;
  /** The fetch helper offline or with a problem while stage 4 has work (minutes). */
  fetchHelperMinutes: number;
  /** A device's refused changes count as over after this long without another (hours). */
  refusalQuietHours: number;
}

export interface NotificationSettings {
  email: { from: string; to: string };
  /** Where links in messages point (the web app's address). */
  linkBase: string;
  /** Daily digest: "HH:MM" in timeZone (null: the server's zone). */
  digest: { time: string; timeZone: string | null };
  finishedJobs: FinishedMode;
  waits: Waits;
  sections: Record<SectionId, boolean>;
  /** Per event, per channel. Kept when its section is off, so switching it on restores them. */
  events: Record<string, Record<Channel, boolean>>;
}

export const WAIT_LIMITS: Record<keyof Waits, [number, number]> = {
  pcWaitingHours: [1, 168],
  pcProblemMinutes: [1, 1440],
  applyHelperMinutes: [1, 1440],
  fetchHelperMinutes: [1, 1440],
  refusalQuietHours: [1, 168],
};

export function defaultSettings(): NotificationSettings {
  const events: Record<string, Record<Channel, boolean>> = {};
  for (const e of listEvents()) events[e.id] = { discord: true, email: true };
  return {
    email: { from: '', to: '' },
    linkBase: 'http://192.168.1.5:3080',
    digest: { time: '08:00', timeZone: null },
    finishedJobs: 'digest',
    waits: {
      pcWaitingHours: 24,
      pcProblemMinutes: 10,
      applyHelperMinutes: 30,
      fetchHelperMinutes: 30,
      refusalQuietHours: 24,
    },
    sections: { jobs: true, cleanup: true, data: true },
    events,
  };
}

export class SettingsError extends Error {}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The server's own zone (the container's TZ). */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Merges `input` (a whole or partial settings object) over `base`. Throws SettingsError with
 * a plain message for a bad value; unknown keys are ignored.
 */
export function mergeSettings(base: NotificationSettings, input: unknown): NotificationSettings {
  const out: NotificationSettings = JSON.parse(JSON.stringify(base)) as NotificationSettings;
  const i = obj(input);

  if (i.email !== undefined) {
    const e = obj(i.email);
    for (const key of ['from', 'to'] as const) {
      if (e[key] === undefined) continue;
      if (typeof e[key] !== 'string') throw new SettingsError('An email address must be text');
      const v = (e[key] as string).trim();
      if (v && !EMAIL.test(v)) throw new SettingsError(`"${v}" is not an email address`);
      out.email[key] = v;
    }
  }
  if (i.linkBase !== undefined) {
    if (typeof i.linkBase !== 'string') throw new SettingsError('The link address must be text');
    const v = i.linkBase.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v)) {
      throw new SettingsError('The link address must start with http:// or https://');
    }
    out.linkBase = v;
  }
  if (i.digest !== undefined) {
    const d = obj(i.digest);
    if (d.time !== undefined) {
      if (typeof d.time !== 'string' || !TIME.test(d.time.trim())) {
        throw new SettingsError('The digest time must look like 08:00');
      }
      out.digest.time = d.time.trim();
    }
    if (d.timeZone !== undefined) {
      if (d.timeZone === null || d.timeZone === '') out.digest.timeZone = null;
      else if (typeof d.timeZone === 'string' && isTimeZone(d.timeZone.trim())) {
        out.digest.timeZone = d.timeZone.trim();
      } else throw new SettingsError('Unknown time zone');
    }
  }
  if (i.finishedJobs !== undefined) {
    if (!['now', 'digest', 'off'].includes(i.finishedJobs as string)) {
      throw new SettingsError('Finished jobs must be now, digest or off');
    }
    out.finishedJobs = i.finishedJobs as FinishedMode;
  }
  if (i.waits !== undefined) {
    const w = obj(i.waits);
    for (const key of Object.keys(WAIT_LIMITS) as (keyof Waits)[]) {
      if (w[key] === undefined) continue;
      const [min, max] = WAIT_LIMITS[key];
      const n = w[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
        throw new SettingsError(`A wait time must be a whole number from ${min} to ${max}`);
      }
      out.waits[key] = n;
    }
  }
  if (i.sections !== undefined) {
    const s = obj(i.sections);
    for (const { id } of SECTIONS) {
      if (s[id] === undefined) continue;
      if (typeof s[id] !== 'boolean') throw new SettingsError('A section switch must be on or off');
      out.sections[id] = s[id] as boolean;
    }
  }
  if (i.events !== undefined) {
    const ev = obj(i.events);
    for (const { id } of listEvents()) {
      if (ev[id] === undefined) continue;
      const c = obj(ev[id]);
      for (const ch of CHANNELS) {
        if (c[ch] === undefined) continue;
        if (typeof c[ch] !== 'boolean') throw new SettingsError('A switch must be on or off');
        out.events[id] = { ...(out.events[id] ?? { discord: true, email: true }), [ch]: c[ch] };
      }
    }
  }
  return out;
}

const KEY = 'settings';

export function readSettings(db: Database.Database): NotificationSettings {
  const row = db.prepare('SELECT value_json FROM notification_settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
  const defaults = defaultSettings();
  if (!row) return defaults;
  try {
    return mergeSettings(defaults, JSON.parse(row.value_json));
  } catch {
    // A stored value that no longer validates (a removed time zone): its defaults.
    return defaults;
  }
}

export function writeSettings(
  db: Database.Database,
  settings: NotificationSettings,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO notification_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(settings), now);
}
