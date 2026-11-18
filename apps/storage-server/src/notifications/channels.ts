/**
 * Sending one message on one channel. Errors never carry a secret (the webhook address or
 * the app password): they are written into the log the Diagnostics page shows.
 */
import nodemailer from 'nodemailer';

export type FetchLike = typeof fetch;

export class SendError extends Error {
  constructor(
    message: string,
    /** Discord's 429: try again after this many ms (not before). */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

/** A Discord webhook address, or a plain message why not. */
export function checkWebhookUrl(value: string, allowAny: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'That is not a web address';
  }
  if (allowAny && (url.protocol === 'http:' || url.protocol === 'https:')) return null;
  if (url.protocol !== 'https:' || !DISCORD_HOSTS.includes(url.hostname)) {
    return 'A Discord webhook address starts with https://discord.com/api/webhooks/';
  }
  if (!/^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) {
    return 'A Discord webhook address looks like https://discord.com/api/webhooks/<number>/<token>';
  }
  return null;
}

/** Discord allows 2000 characters per message. */
export const DISCORD_MAX = 2000;

export async function sendDiscord(
  webhookUrl: string,
  text: string,
  { timeoutMs, fetchImpl = fetch }: { timeoutMs: number; fetchImpl?: FetchLike },
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No @everyone or role pings, whatever the text holds (a book title, an error).
      body: JSON.stringify({
        content: text.slice(0, DISCORD_MAX),
        allowed_mentions: { parse: [] },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SendError(`Discord did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new SendError('Discord could not be reached (no connection, or the address is wrong)');
  }
  if (res.ok) return;
  if (res.status === 429) {
    let wait = 5000;
    try {
      const body = (await res.json()) as { retry_after?: unknown };
      if (typeof body.retry_after === 'number') wait = Math.ceil(body.retry_after * 1000);
    } catch {
      // keep the default
    }
    throw new SendError('Discord asked to slow down', wait);
  }
  if (res.status === 401 || res.status === 404) {
    throw new SendError(`Discord refused the webhook (${res.status}): it was deleted or is wrong`);
  }
  throw new SendError(`Discord answered ${res.status}`);
}

export interface EmailOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  to: string;
  subject: string;
  text: string;
  timeoutMs: number;
}

/** Removes the password (and its spaced form) from a library's error text. */
function scrub(message: string, pass: string): string {
  let out = message;
  for (const s of [pass, pass.replace(/\s+/g, '')]) {
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

export async function sendEmail(o: EmailOptions): Promise<void> {
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it.
  const pass = o.pass.replace(/\s+/g, '');
  const transport = nodemailer.createTransport({
    host: o.host,
    port: o.port,
    secure: o.secure,
    auth: { user: o.user, pass },
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
  });
  try {
    await transport.sendMail({
      from: o.user,
      to: o.to,
      subject: o.subject,
      text: o.text,
    });
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    if (e.code === 'EAUTH' || e.responseCode === 535) {
      throw new SendError('Gmail refused the sign-in: check the address and the app password');
    }
    if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
      throw new SendError(`Gmail could not be reached (${e.code})`);
    }
    throw new SendError(`Gmail: ${scrub(e.message ?? String(err), o.pass).slice(0, 300)}`);
  } finally {
    transport.close();
  }
}
