/**
 * The fetch loop (WP20d). Stateless: the server owns the queue, the pace and the back-offs.
 *
 * Every 30 s a heartbeat (only one fetcher is active at a time); then claims: the server answers
 * with at most one due request per site and how long to wait. Each request is fetched (or, for
 * the local 'sudachi' site, read by Sudachi), compressed with brotli and posted back with its
 * lease token. While the server is away (its nightly stop) the answer is kept and posted again,
 * 2 s growing to 60 s apart; a lease that ran out meanwhile is refused and the server asks again.
 *
 * Challenge pages are never answered or worked around: the page is passed back as it came, and
 * the server backs the site off.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { brotliCompressSync, constants as zc } from 'zlib';
import type { FetchConfig } from './config';
import { allowedUrl } from './hosts';

export const VERSION = '1.0.0';
/** The reference run's browser headers (ref4.py); RanobeDB refuses Python's default user agent. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DEFAULT_ACCEPT = 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8';
const MAX_REDIRECTS = 5;

interface Claimed {
  id: number;
  leaseToken: string;
  site: string;
  method: string;
  url: string;
  body: string | null;
  accept: string | null;
}

export interface FetchResult {
  status: number | null;
  ms: number;
  error: string | null;
  body: Buffer | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Fetcher {
  /**
   * The container's hostname (kept across restarts of the same container, so a restarted fetcher
   * takes over at once); a second container has its own and stays inactive while this one runs.
   */
  readonly id =
    `${hostname()}-${process.env.FETCHER_ID_SUFFIX ?? ''}`.replace(/-$/, '') || randomUUID();
  private active = false;
  private stopped = false;
  private requestTimeoutMs = 30_000;
  private maxPageBytes = 16 * 1024 * 1024;
  private sudachiVersion: string | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: FetchConfig,
    private readonly log: (m: string) => void = (m) => console.log(m),
    private readonly httpFetch: typeof fetch = fetch
  ) {}

  stop(): void {
    this.stopped = true;
  }

  private async server(
    path: string,
    init: { method: string; body?: Buffer | string; headers?: Record<string, string> }
  ) {
    const res = await this.httpFetch(`${this.config.serverUrl}/api/v1${path}`, {
      method: init.method,
      body:
        typeof init.body === 'string' || init.body === undefined
          ? init.body
          : new Uint8Array(init.body),
      headers: { Authorization: `Bearer ${this.config.token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.config.serverTimeoutSeconds * 1000)
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(`server answered ${res.status}: ${text.slice(0, 200)}`);
    return json as Record<string, unknown>;
  }

  async heartbeat(problem: string | null = null): Promise<void> {
    const r = await this.server('/cleanup-fetch/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fetcherId: this.id,
        version: VERSION,
        problem,
        sudachi: this.sudachiVersion
      })
    });
    this.active = r.active === true;
    if (typeof r.requestTimeoutSeconds === 'number')
      this.requestTimeoutMs = r.requestTimeoutSeconds * 1000;
    if (typeof r.maxPageBytes === 'number') this.maxPageBytes = r.maxPageBytes;
  }

  /** Fetches one https request from an allowed host, following redirects only within the list. */
  async fetchHttp(c: Claimed): Promise<FetchResult> {
    const t0 = Date.now();
    let url = allowedUrl(c.url);
    if (!url)
      return {
        status: null,
        ms: 0,
        error: `refused: not an allowed https host (${c.url.slice(0, 100)})`,
        body: null
      };
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Accept-Language': 'ja,en;q=0.5',
      Accept: c.accept ?? DEFAULT_ACCEPT,
      'Accept-Encoding': 'gzip, deflate, br'
    };
    if (c.method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (c.url.includes('/api/v1/books/') && c.url.endsWith('external_book_stores.json')) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await this.httpFetch(url.toString(), {
          method: c.method === 'POST' ? 'POST' : 'GET',
          headers,
          body: c.method === 'POST' ? (c.body ?? '') : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = allowedUrl(new URL(res.headers.get('location')!, url).toString());
          await res.arrayBuffer().catch(() => null);
          if (!next) {
            return {
              status: res.status,
              ms: Date.now() - t0,
              error: 'redirect to a host that is not allowed',
              body: null
            };
          }
          url = next;
          continue;
        }
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > this.maxPageBytes) {
          return {
            status: null,
            ms: Date.now() - t0,
            error: `answer larger than ${this.maxPageBytes} bytes`,
            body: null
          };
        }
        return { status: res.status, ms: Date.now() - t0, error: null, body };
      }
      return { status: null, ms: Date.now() - t0, error: 'too many redirects', body: null };
    } catch (err) {
      return {
        status: null,
        ms: Date.now() - t0,
        error: String((err as Error).message ?? err).slice(0, 300),
        body: null
      };
    }
  }

  /** The local 'sudachi' site: generated readings for names NDL doesn't know. */
  async runSudachi(c: Claimed): Promise<FetchResult> {
    const t0 = Date.now();
    if (!this.config.sudachiPython)
      return { status: null, ms: 0, error: 'Sudachi is not installed here', body: null };
    return new Promise((resolve) => {
      const child = spawn(this.config.sudachiPython, ['-I', '-B', this.config.sudachiScript], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ status: null, ms: Date.now() - t0, error: `sudachi: ${e.message}`, body: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0)
          resolve({ status: 200, ms: Date.now() - t0, error: null, body: Buffer.concat(out) });
        else
          resolve({
            status: null,
            ms: Date.now() - t0,
            error: `sudachi exited ${code}: ${Buffer.concat(err).toString().slice(-200)}`,
            body: null
          });
      });
      child.stdin.end(c.body ?? '{"names":[]}');
    });
  }

  /** Posts an answer until the server takes it (or says no); keeps trying while it is away. */
  async report(c: Claimed, r: FetchResult): Promise<void> {
    const body = r.body
      ? brotliCompressSync(r.body, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } })
      : Buffer.alloc(0);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'x-lease-token': c.leaseToken,
      'x-ms': String(r.ms),
      'x-encoding': 'br'
    };
    if (r.status !== null) headers['x-status'] = String(r.status);
    if (r.error) headers['x-error'] = encodeURIComponent(r.error.slice(0, 300));
    let wait = 2000;
    for (;;) {
      try {
        const a = await this.server(`/cleanup-fetch/answers/${c.id}`, {
          method: 'POST',
          body,
          headers
        });
        if (a.accepted !== true)
          this.log(`answer ${c.id} (${c.site}) not taken: ${String(a.reason)}`);
        return;
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        if (/server answered 4\d\d/.test(msg)) {
          this.log(`answer ${c.id} (${c.site}) refused: ${msg}`);
          return;
        }
        if (this.stopped) return;
        await sleep(wait);
        wait = Math.min(60_000, wait * 2);
      }
    }
  }

  private async handle(c: Claimed): Promise<void> {
    this.inFlight.add(c.site);
    try {
      const r = c.method === 'LOCAL' ? await this.runSudachi(c) : await this.fetchHttp(c);
      this.log(
        `${c.site} ${r.status ?? 'ERR'} ${r.body?.length ?? 0} B ${r.ms} ms ${r.error ?? ''}`.trim()
      );
      await this.report(c, r);
    } finally {
      this.inFlight.delete(c.site);
    }
  }

  async sudachiCheck(): Promise<void> {
    if (!this.config.sudachiPython) return;
    const r = await this.runSudachi({
      id: 0,
      leaseToken: '',
      site: 'sudachi',
      method: 'LOCAL',
      url: '',
      body: '{"names":[],"version":true}',
      accept: null
    });
    try {
      this.sudachiVersion = r.body
        ? String((JSON.parse(r.body.toString()) as { version?: string }).version ?? '') || null
        : null;
    } catch {
      this.sudachiVersion = null;
    }
    if (!this.sudachiVersion) this.log(`Sudachi check failed: ${r.error ?? 'no version'}`);
  }

  /** Runs until stopped. */
  async run(): Promise<void> {
    await this.sudachiCheck();
    let lastBeat = 0;
    let backoff = 2000;
    while (!this.stopped) {
      try {
        if (Date.now() - lastBeat > 30_000) {
          await this.heartbeat();
          lastBeat = Date.now();
          if (!this.active) this.log('Another fetcher is active; waiting.');
        }
        if (!this.active) {
          await sleep(30_000);
          continue;
        }
        const r = await this.server('/cleanup-fetch/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fetcherId: this.id })
        });
        backoff = 2000;
        const requests = (Array.isArray(r.requests) ? r.requests : []) as Claimed[];
        for (const c of requests) {
          if (this.inFlight.has(c.site)) continue;
          void this.handle(c);
        }
        const wait = typeof r.waitSeconds === 'number' ? r.waitSeconds : 5;
        // Come back soon: a site whose request finishes may be due again before the wait ends.
        await sleep(Math.min(wait, 1) * 1000);
      } catch (err) {
        this.log(`server not reachable: ${String((err as Error).message ?? err).slice(0, 200)}`);
        await sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
        lastBeat = 0;
      }
    }
  }
}
