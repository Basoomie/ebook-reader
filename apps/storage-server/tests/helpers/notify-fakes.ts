/**
 * Notifications tests: a fake Discord webhook and a fake SMTP server (never the real ones).
 * Shared by notifications.test.ts (N1) and notifications-stats.test.ts (N2).
 */
import http from 'http';
import net from 'net';
import { expect } from 'vitest';

// ---- fake Discord ----

export interface FakeDiscord {
  url: string;
  messages: string[];
  /** Status codes to answer, one per request; 204 when empty. */
  replies: number[];
  close(): Promise<void>;
}

export async function fakeDiscord(): Promise<FakeDiscord> {
  const fake = { messages: [] as string[], replies: [] as number[] } as FakeDiscord;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const status = fake.replies.shift() ?? 204;
      if (status === 204) {
        const parsed = JSON.parse(body) as { content: string; allowed_mentions: unknown };
        expect(parsed.allowed_mentions).toEqual({ parse: [] });
        fake.messages.push(parsed.content);
        res.writeHead(204).end();
      } else if (status === 429) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ retry_after: 0.01 }));
      } else res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  fake.url = `http://127.0.0.1:${port}/api/webhooks/123/abc`;
  fake.close = () => new Promise((r) => srv.close(() => r()));
  return fake;
}

// ---- fake SMTP (plain, AUTH PLAIN) ----

export interface FakeSmtp {
  port: number;
  mails: { from: string; to: string; data: string; auth: string }[];
  password: string;
  close(): Promise<void>;
}

export async function fakeSmtp(password: string): Promise<FakeSmtp> {
  const fake = { mails: [], password } as unknown as FakeSmtp;
  const srv = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let mail = { from: '', to: '', data: '', auth: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          fake.mails.push(mail);
          mail = { from: '', to: '', data: '', auth: mail.auth };
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO')
          sock.write('250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (cmd === 'AUTH') {
          const plain = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          const [, user, pass] = plain.split('\0');
          if (pass === fake.password) {
            mail.auth = user;
            sock.write('235 ok\r\n');
          } else sock.write('535 5.7.8 bad credentials\r\n');
        } else if (cmd === 'MAIL') {
          mail.from = line;
          sock.write('250 ok\r\n');
        } else if (cmd === 'RCPT') {
          mail.to = line;
          sock.write('250 ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') {
          sock.end('221 bye\r\n');
        } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  fake.port = (srv.address() as net.AddressInfo).port;
  fake.close = () => new Promise((r) => srv.close(() => r()));
  return fake;
}

/** The mail body as text (nodemailer sends non-ASCII text quoted-printable). */
export function quotedPrintable(data: string): string {
  const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '=' && /^[0-9A-F]{2}$/.test(body.slice(i + 1, i + 3))) {
      bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(body.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');
}
