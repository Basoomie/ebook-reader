/**
 * WP21f-2: clears the fields a library change emptied (a series dropped, an ASIN gone) in
 * Audiobookshelf. Found at stop B1 (the e2e, ABS 2.37.1): after we write metadata.json with an
 * empty field and ABS scans the library, ABS keeps the value it had and writes it back into
 * metadata.json (an empty field in its metadata file doesn't clear its own); a new value is taken
 * as written. ABS's edit call (`PATCH /api/items/:id/media`, what its edit dialog sends) with only
 * the emptied fields cleared them in the database and in metadata.json, kept every other field,
 * the progress and the bookmark (proven on that ABS before this was built).
 *
 * Exactly one route and one method, only empty values (null or []), only our fields; a test
 * reads this file and fails if another request appears, and no module but library-changes.ts
 * may import it. It changes no ABS setting.
 */
import { AbsError } from './abs-client';

export interface AbsClearFieldsOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** The metadata fields a change may clear (ABS's own names). */
export const CLEARABLE = [
  'authors',
  'narrators',
  'series',
  'publishedYear',
  'publisher',
  'description',
  'asin',
  'language',
  'genres',
] as const;
export type Clearable = (typeof CLEARABLE)[number];

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AbsClearFields {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AbsClearFieldsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Clears `fields` of the item (each to null, or [] for a list); `tags` [] clears the tags. */
  async clear(itemId: string, fields: Clearable[], tags = false): Promise<void> {
    if (!ITEM_ID.test(itemId)) throw new AbsError('Not an Audiobookshelf item id', null);
    if (fields.some((f) => !CLEARABLE.includes(f)))
      throw new AbsError('Not a field to clear', null);
    if (fields.length === 0 && !tags) return;
    const list = new Set<Clearable>(['authors', 'narrators', 'series', 'genres']);
    const metadata: Record<string, null | []> = {};
    for (const f of fields) metadata[f] = list.has(f) ? [] : null;
    const body: { metadata: Record<string, null | []>; tags?: [] } = { metadata };
    if (tags) body.tags = [];
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/items/${itemId}/media`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
        'Audiobookshelf refused (403): clearing a field needs the update permission',
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
