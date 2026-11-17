/**
 * Audiobookshelf, read only (WP21a; design: "ABS settings are read, never changed"). This
 * client can only send GET requests: there is no method parameter and no body, and a test
 * fails if another method appears. Routes checked against ABS v2.37.1's source
 * (server/routers/ApiRouter.js, controllers/UserController.js).
 */

export class AbsError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface AbsClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class AbsClient {
  private readonly fetchImpl: typeof fetch;
  /** The ABS version seen in a response, if any. */
  version: string | null = null;

  constructor(private readonly opts: AbsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** GET <base>/status (ABS's own unauthenticated status: app, serverVersion). */
  async status(): Promise<{ app?: string; serverVersion?: string } | null> {
    return this.request('/status');
  }

  /** GET <base>/api<path>. 404 → null. Any other failure throws AbsError (message shortened). */
  async get<T>(apiPath: string): Promise<T | null> {
    return this.request<T>(`/api${apiPath}`);
  }

  private async request<T>(fullPath: string): Promise<T | null> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${fullPath}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const e = err as Error;
      throw new AbsError(
        e.name === 'TimeoutError'
          ? `Audiobookshelf did not answer within ${Math.round(this.opts.timeoutMs / 1000)} s`
          : `Audiobookshelf can't be reached: ${e.message}`.slice(0, 300),
        null,
      );
    }
    if (res.status === 404) return null;
    if (res.status === 401) throw new AbsError('Audiobookshelf refused the API key (401)', 401);
    if (res.status === 403) {
      throw new AbsError("Audiobookshelf refused (403): the API key's user is not an admin", 403);
    }
    if (!res.ok) throw new AbsError(`Audiobookshelf answered ${res.status}`, res.status);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AbsError('Audiobookshelf answered something that is not JSON', res.status);
    }
  }
}
