/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send } from '$lib/library/api';

/**
 * Settings > Notifications (N1): the server's /api/v1/notifications routes. The server
 * sends the messages, so the settings live there; the secrets can only be written.
 */

export type NotificationChannel = 'discord' | 'email';
export type NotificationSectionId = 'jobs' | 'cleanup' | 'data' | 'stats';
export type FinishedMode = 'now' | 'digest' | 'off';
/** N2: a period with no reading: skip its stats message, or send "No reading". */
export type NoReadingMode = 'skip' | 'send';
/** N2: the three stats messages (daily, weekly, monthly). */
export type StatsReportKind = 'day' | 'week' | 'month';

export interface NotificationWaits {
  pcWaitingHours: number;
  pcProblemMinutes: number;
  applyHelperMinutes: number;
  fetchHelperMinutes: number;
  refusalQuietHours: number;
  seriesArrivalWaitHours: number;
  /** The Calibre index behind this long alerts (minutes). */
  indexBehindMinutes: number;
}

export interface NotificationSettings {
  email: { from: string; to: string };
  linkBase: string;
  digest: { time: string; timeZone: string | null };
  finishedJobs: FinishedMode;
  waits: NotificationWaits;
  sections: Record<NotificationSectionId, boolean>;
  stats: {
    noReading: NoReadingMode;
    /** Per message: show each number's change from the previous period. */
    compare: Record<StatsReportKind, boolean>;
  };
  events: Record<string, Record<NotificationChannel, boolean>>;
}

export interface NotificationSecretInfo {
  set: boolean;
  updatedAt: number | null;
  unreadable?: boolean;
}

export type NotificationSecretName = 'discordWebhookUrl' | 'gmailAppPassword';

export interface NotificationEvent {
  id: string;
  section: NotificationSectionId;
  label: string;
  /** now: an alert; digest: a digest line; finished: Now / Digest / Off; report: stats (N2). */
  kind: 'now' | 'digest' | 'finished' | 'report';
}

export interface NotificationsView {
  settings: NotificationSettings;
  secrets: Record<NotificationSecretName, NotificationSecretInfo>;
  /** Set up: the column of switches shows only then. */
  channels: Record<NotificationChannel, boolean>;
  sections: { id: NotificationSectionId; label: string }[];
  events: NotificationEvent[];
  serverTimeZone: string;
}

export type SettingsPatch = {
  [K in keyof NotificationSettings]?: NotificationSettings[K] extends object
    ? Partial<NotificationSettings[K]>
    : NotificationSettings[K];
};

export class NotificationsApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutSeconds = this.timeoutSeconds
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.json();
  }

  get(): Promise<NotificationsView> {
    return this.request('GET', '/notifications/settings') as Promise<NotificationsView>;
  }

  update(patch: SettingsPatch): Promise<NotificationsView> {
    return this.request('PUT', '/notifications/settings', patch) as Promise<NotificationsView>;
  }

  putSecret(name: NotificationSecretName, value: string): Promise<NotificationsView> {
    return this.request('PUT', `/notifications/secrets/${name}`, {
      value
    }) as Promise<NotificationsView>;
  }

  removeSecret(name: NotificationSecretName): Promise<NotificationsView> {
    return this.request('DELETE', `/notifications/secrets/${name}`) as Promise<NotificationsView>;
  }

  /** Sends one test message; the server answers when it went or failed (up to its own timeout). */
  test(channel: NotificationChannel): Promise<{ ok: boolean; error?: string }> {
    return this.request('POST', `/notifications/test/${channel}`, undefined, 0) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }
}
