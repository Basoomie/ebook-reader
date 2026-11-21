/**
 * WP21f-1: the "nudge" (decided with the user 2026-11-20: built, switched off until stop 3 shows
 * it is needed). When Audiobookshelf hasn't shown a new book some time after stage 7 added it,
 * this tells ABS's own watcher about the book's files through ABS 2.37.1's
 * `POST /api/watcher/update {libraryId, path, type: 'add'}` (MiscController.updateWatchedPath:
 * admin key; it queues just those paths for ABS's watcher, as if ABS had seen them appear). It
 * changes no ABS setting and scans nothing else.
 *
 * Exactly one route and one method: a test reads this file and fails if another request
 * appears, and no module but stage7-arrivals.ts may import it. Reading Audiobookshelf stays with
 * the GET-only client; setting covers with the covers' own writer (WP21e-2).
 */
import { AbsError } from './abs-client';

export interface AbsWatchNotifierOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const LIBRARY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AbsWatchNotifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AbsWatchNotifierOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Tells ABS's watcher that `absPath` (a file inside the library's folder, as ABS sees it) was added. */
  async fileAdded(libraryId: string, absPath: string): Promise<void> {
    if (!LIBRARY_ID.test(libraryId)) throw new AbsError('Not an Audiobookshelf library id', null);
    if (!absPath.startsWith('/') || absPath.includes('\0'))
      throw new AbsError('Not an absolute path', null);
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/watcher/update`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ libraryId, path: absPath, type: 'add' }),
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
    if (res.status === 401) throw new AbsError('Audiobookshelf refused the API key (401)', 401);
    if (res.status === 403)
      throw new AbsError(
        "Audiobookshelf refused (403): telling its watcher needs an admin's key",
        403,
      );
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new AbsError(
        `Audiobookshelf answered ${res.status}${text ? `: ${text}` : ''}`,
        res.status,
      );
    }
  }
}
