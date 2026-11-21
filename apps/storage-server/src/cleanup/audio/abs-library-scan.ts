/**
 * WP21f-2: asks Audiobookshelf to scan one library, after stage 7 changed books in it (metadata,
 * a moved book folder, renamed links). Proven at B0 (2026-11-21) on a scratch ABS 2.37.1 on the
 * NAS: ABS's watcher doesn't see the sidecar's writes through /mnt/disk1, the watcher nudge
 * didn't move a renamed folder and an item scan marked it missing, while a library scan
 * (`POST /api/libraries/:id/scan`, LibraryController.scan: admin key) found every change and kept
 * every item, its progress, bookmarks and finished flag (Unraid's FUSE layer keeps the inode). It
 * changes no ABS setting and writes nothing; ABS reads the folders as on its own scans.
 *
 * Exactly one route and one method: a test reads this file and fails if another request
 * appears, and no module but library-changes.ts may import it. Reading Audiobookshelf stays with
 * the GET-only client.
 */
import { AbsError } from './abs-client';

export interface AbsLibraryScanOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const LIBRARY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AbsLibraryScan {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AbsLibraryScanOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Starts ABS's scan of the library (it runs on in ABS; read the items to see it done). */
  async scan(libraryId: string): Promise<void> {
    if (!LIBRARY_ID.test(libraryId)) throw new AbsError('Not an Audiobookshelf library id', null);
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/libraries/${libraryId}/scan`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
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
    if (res.status === 401) throw new AbsError('Audiobookshelf refused the API key (401)', 401);
    if (res.status === 403)
      throw new AbsError("Audiobookshelf refused (403): a library scan needs an admin's key", 403);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new AbsError(
        `Audiobookshelf answered ${res.status}${text ? `: ${text}` : ''}`,
        res.status,
      );
    }
  }
}
