/**
 * Server-side settings of the notifications (environment, with defaults). The user's own
 * choices (channels, switches, wait times, digest time) are in Settings > Notifications and
 * stored in ttsu.db; these are only the mechanics.
 */
import { parseBoolean, parseNumber } from '../config';

type Env = Record<string, string | undefined>;

export interface NotificationsConfig {
  /** How often the watcher looks for problems and sends what is waiting (NOTIFY_CHECK_SECONDS). */
  checkSeconds: number;
  /** Tries per message before it counts as failed (NOTIFY_SEND_ATTEMPTS). */
  sendAttempts: number;
  /** Wait after the first and later failed tries (NOTIFY_RETRY_MINUTES, e.g. "1,5"). */
  retryMinutes: number[];
  /** Each send gives up after this (NOTIFY_SEND_TIMEOUT_SECONDS). */
  sendTimeoutSeconds: number;
  /** Messages kept in the log (NOTIFY_LOG_KEEP). */
  logKeep: number;
  /** Gmail's SMTP server; changed only by tests (NOTIFY_SMTP_HOST/PORT/SECURE). */
  smtp: { host: string; port: number; secure: boolean };
  /** Tests only: a webhook address that is not Discord's (NOTIFY_ALLOW_ANY_WEBHOOK). */
  allowAnyWebhook: boolean;
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  checkSeconds: 30,
  sendAttempts: 3,
  retryMinutes: [1, 5],
  sendTimeoutSeconds: 30,
  logKeep: 500,
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  allowAnyWebhook: false,
};

export function parseNotificationsConfig(env: Env, warnings: string[]): NotificationsConfig {
  const d = DEFAULT_NOTIFICATIONS_CONFIG;
  const num = (name: string, fallback: number, min: number, max: number) =>
    parseNumber(name, env[name], fallback, min, max, true, warnings);
  let retryMinutes = d.retryMinutes;
  const raw = (env.NOTIFY_RETRY_MINUTES ?? '').trim();
  if (raw) {
    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1440)) {
      retryMinutes = parts;
    } else {
      warnings.push(`NOTIFY_RETRY_MINUTES: "${raw}" is not a list of minutes; using 1,5.`);
    }
  }
  return {
    checkSeconds: num('NOTIFY_CHECK_SECONDS', d.checkSeconds, 1, 3600),
    sendAttempts: num('NOTIFY_SEND_ATTEMPTS', d.sendAttempts, 1, 10),
    retryMinutes,
    sendTimeoutSeconds: num('NOTIFY_SEND_TIMEOUT_SECONDS', d.sendTimeoutSeconds, 1, 600),
    logKeep: num('NOTIFY_LOG_KEEP', d.logKeep, 10, 100000),
    smtp: {
      host: (env.NOTIFY_SMTP_HOST ?? '').trim() || d.smtp.host,
      port: num('NOTIFY_SMTP_PORT', d.smtp.port, 1, 65535),
      secure: parseBoolean('NOTIFY_SMTP_SECURE', env.NOTIFY_SMTP_SECURE, d.smtp.secure, warnings),
    },
    allowAnyWebhook: parseBoolean(
      'NOTIFY_ALLOW_ANY_WEBHOOK',
      env.NOTIFY_ALLOW_ANY_WEBHOOK,
      false,
      warnings,
    ),
  };
}
