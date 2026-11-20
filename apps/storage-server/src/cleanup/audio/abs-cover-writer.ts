/**
 * The ONLY code that changes anything in Audiobookshelf (WP21e-2, the switch's covers; allowed
 * by the user only for this, 2026-11-20). It can do exactly one thing: set one library item's
 * cover, from a URL (ABS downloads it) or from an image file's bytes, through ABS 2.37.1's
 * `POST /api/items/:id/cover` (LibraryItemController.uploadCover; the key's user needs the
 * upload permission). No other route, no other method, no settings: a test reads this file and
 * fails if another request appears, and no other module may import it but stage6-covers.ts.
 * Reading Audiobookshelf stays with the GET-only abs-client.ts.
 */
import { AbsError } from './abs-client';

export interface AbsCoverWriterOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AbsCoverWriter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AbsCoverWriterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Sets the item's cover from an http(s) image URL (Audiobookshelf fetches it). */
  async setCoverFromUrl(itemId: string, url: string): Promise<void> {
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new AbsError('Not an http(s) image address', null);
    await this.send(itemId, JSON.stringify({ url }), 'application/json');
  }

  /** Sets the item's cover from an image file's bytes (a jpg, png or webp). */
  async setCoverFromFile(itemId: string, bytes: Buffer, name: string): Promise<void> {
    const type = /\.png$/i.test(name)
      ? 'image/png'
      : /\.webp$/i.test(name)
        ? 'image/webp'
        : 'image/jpeg';
    const form = new FormData();
    form.append('cover', new Blob([bytes], { type }), name.replace(/[^\w.-]/g, '_'));
    await this.send(itemId, form, null);
  }

  private async send(
    itemId: string,
    body: string | FormData,
    contentType: string | null,
  ): Promise<void> {
    if (!ITEM_ID.test(itemId)) throw new AbsError('Not an Audiobookshelf item id', null);
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/items/${itemId}/cover`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
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
        "Audiobookshelf refused (403): the API key's user may not upload (covers need that permission)",
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
