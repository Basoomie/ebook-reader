/**
 * Audiobook cleanup leftovers, item 6: sets in Audiobookshelf the fields where its scan kept an
 * older value and you chose "Use the cleanup's" (ST 黄: we wrote `STシリーズ`, ABS kept
 * `STシリーズ #6`). Rewriting metadata.json alone doesn't change them: ABS's library scan keeps
 * a series' number its metadata file leaves out. Its edit call (`PATCH /api/items/:id/media`,
 * what its edit dialog sends) with the series' sequence null dropped the number in its database
 * and in metadata.json, kept every other field, the progress and the bookmark, and a later
 * library scan kept it dropped (proven on a scratch ABS 2.37.1, 2026-11-21:
 * `.tmp-e2e/leftovers-abs/proof.mjs`).
 *
 * Exactly one route and one method, only our fields, and only the values of the metadata.json
 * just written (the caller passes those bytes; nothing else is sent); a test reads this file and
 * fails if another request appears, and no module but library-changes.ts may import it. It
 * changes no ABS setting.
 */
import { AbsError } from './abs-client';

export interface AbsSetFieldsOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** The fields a change may set (metadata.json's names, which are ABS's). */
export const SETTABLE = [
  'title',
  'authors',
  'narrators',
  'series',
  'publishedYear',
  'publisher',
  'description',
  'asin',
  'language',
  'tags',
  'genres',
] as const;
export type Settable = (typeof SETTABLE)[number];

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** metadata.json's series entry (`Name #6` or `Name`) as ABS's edit call takes it. */
export function seriesEntry(s: string): { name: string; sequence: string | null } {
  const m = /^(.*\S)\s+#(\S+)$/.exec(s);
  return m ? { name: m[1], sequence: m[2] } : { name: s, sequence: null };
}

/** The edit call's body for `fields`, from the metadata.json bytes just written. */
export function setBody(
  written: Buffer,
  fields: Settable[],
): { metadata: Record<string, unknown>; tags?: string[] } {
  if (fields.some((f) => !SETTABLE.includes(f))) throw new AbsError('Not a field to set', null);
  const m = JSON.parse(written.toString('utf8')) as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  let tags: string[] | undefined;
  for (const f of fields) {
    const v = m[f];
    if (f === 'tags') tags = strings(v);
    else if (f === 'series') metadata.series = strings(v).map(seriesEntry);
    else if (f === 'authors') metadata.authors = strings(v).map((name) => ({ name }));
    else if (f === 'narrators') metadata.narrators = strings(v);
    else if (f === 'genres') metadata.genres = strings(v);
    else metadata[f] = typeof v === 'string' && v !== '' ? v : null;
  }
  return tags === undefined ? { metadata } : { metadata, tags };
}

export class AbsSetFields {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AbsSetFieldsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Sets `fields` of the item to their values in `written` (the metadata.json just written). */
  async set(itemId: string, written: Buffer, fields: Settable[]): Promise<void> {
    if (!ITEM_ID.test(itemId)) throw new AbsError('Not an Audiobookshelf item id', null);
    if (fields.length === 0) return;
    const body = setBody(written, fields);
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
        'Audiobookshelf refused (403): setting a field needs the update permission',
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
