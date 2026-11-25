/**
 * Book covers: the stores' pictures offered in the edit form's cover section (docs/design/
 * book-covers.md, part 2). Only stores with a saved direct id (Calibre's `amazon_jp` /
 * `amazon` and `bookwalker` identifiers), never a search.
 *
 * Everything goes through the cleanup's fetch queue (the fetch container behind the VPN, each
 * site's pace), never from the browser: the store's page (the same request stage 4 makes, so an
 * answer it already has is used at once), then the picture the page names (Amazon's full-size
 * `hiRes` picture; BOOK☆WALKER's product image). The request rows are the state: the form asks
 * again every few seconds while a store is still waiting.
 */
import type Database from 'better-sqlite3';
import { imageFacts } from '../file-metadata';
import { getSettings } from '../settings';
import { parseBwDetail } from '../stage4/parse';
import type { FetchQueue, RequestSpec } from '../stage4/queue';
import { samePicture } from './cover-archive';
import { EditError } from './fields';

export type CoverStore = 'amazon' | 'bookwalker';

/** Above every cleanup request (stage 4's labeled books are 10): the user is waiting. */
export const STORE_COVER_PRIORITY = 100;

export interface StoreCoverView {
  store: CoverStore;
  id: string;
  state: 'waiting' | 'ready' | 'none' | 'failed';
  /** Why there is no picture (none / failed), in plain words. */
  reason: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** Looks like the cover Calibre has now (stage 4's picture rule and setting). */
  same: boolean;
}

interface Deps {
  cleanup: Database.Database;
  main: Database.Database;
  queue: FetchQueue;
  /** The book's current cover (read only), for "Same as current". */
  currentCover: (bookId: string) => Buffer | null;
}

const NAMES: Record<CoverStore, string> = { amazon: 'Amazon', bookwalker: 'BOOK☆WALKER' };

/** An Amazon picture address (never a script or style file of the same folder). */
const AMAZON_PICTURE =
  /^https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/I\/[A-Za-z0-9+%-]+(?:\.[^/"'\s]*)?\.(?:jpe?g|png)$/i;

const unescapeAttr = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/gi, '/');

/**
 * The cover's address on an Amazon product page, in the order the page states it most
 * surely: the image block's "hiRes", `data-old-hires`, the front cover element's largest
 * listed size (Kindle pages: `ebooksImgBlkFront`; printed books: `landingImage`) or its src.
 * Only picture addresses count (stage 4's parser can take a script file's address from a page
 * without these: the trimmed test pages have one).
 */
export function amazonCoverUrl(html: string): string | null {
  const ok = (u: string | undefined | null) => {
    const v = u ? unescapeAttr(u) : null;
    return v && AMAZON_PICTURE.test(v) ? v : null;
  };
  const hi = /"hiRes":"(https:[^"]+)"/.exec(html);
  if (ok(hi?.[1])) return ok(hi?.[1]);
  const old = /data-old-hires="(https:[^"]+)"/.exec(html);
  if (ok(old?.[1])) return ok(old?.[1]);
  for (const id of ['ebooksImgBlkFront', 'landingImage', 'imgBlkFront']) {
    const tag = new RegExp(`<img[^>]*\\bid="${id}"[^>]*>`, 'i').exec(html)?.[0];
    if (!tag) continue;
    const dyn = /data-a-dynamic-image="([^"]+)"/.exec(tag)?.[1];
    if (dyn) {
      try {
        const sizes = JSON.parse(unescapeAttr(dyn)) as Record<string, [number, number]>;
        const best = Object.entries(sizes)
          .filter(([u]) => ok(u))
          .sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0];
        if (best) return ok(best[0]);
      } catch {
        // Not the list Amazon usually writes: the src below.
      }
    }
    const src = ok(/\bsrc="([^"]+)"/.exec(tag)?.[1]);
    if (src) return src;
  }
  // Never any other picture of the page (an advert or another book's cover would be offered
  // as this book's).
  return null;
}

export class StoreCovers {
  constructor(private readonly deps: Deps) {}

  /** The book's stores with a saved direct id. */
  stores(bookId: string): { store: CoverStore; id: string }[] {
    const ids = new Map(
      (
        this.deps.main
          .prepare('SELECT type, value FROM book_identifiers WHERE book_id = ?')
          .all(bookId) as { type: string; value: string }[]
      ).map((r) => [r.type.toLowerCase(), r.value.trim()]),
    );
    const out: { store: CoverStore; id: string }[] = [];
    const asin = [ids.get('amazon_jp'), ids.get('amazon')].find(
      (v) => v && /^[A-Z0-9]{10}$/.test(v),
    );
    if (asin) out.push({ store: 'amazon', id: asin });
    const bw = ids.get('bookwalker');
    if (bw && /^[0-9a-f-]{20,}$/i.test(bw)) out.push({ store: 'bookwalker', id: bw.toLowerCase() });
    return out;
  }

  /** Whether the fetch container has been heard from lately. */
  fetcherOnline(now = Date.now()): boolean {
    const r = this.deps.cleanup
      .prepare('SELECT last_seen_at FROM fetcher_status WHERE id = 1')
      .get() as { last_seen_at: number | null } | undefined;
    const s = getSettings(this.deps.cleanup).fetch;
    return !!r?.last_seen_at && now - r.last_seen_at < s.offlineSeconds * 1000;
  }

  private pageSpec(store: CoverStore, id: string): RequestSpec {
    // The same site and key stage 4 uses, so its answers are shared.
    return store === 'amazon'
      ? {
          site: 'amazon-dp',
          key: id,
          url: `https://www.amazon.co.jp/dp/${id}`,
          priority: STORE_COVER_PRIORITY,
        }
      : {
          site: 'bookwalker',
          key: `https://bookwalker.jp/de${id}/`,
          url: `https://bookwalker.jp/de${id}/`,
          priority: STORE_COVER_PRIORITY,
        };
  }

  private pictureSpec(store: CoverStore, url: string): RequestSpec {
    return {
      site: store === 'amazon' ? 'amazon-img' : 'bookwalker',
      key: url,
      url,
      accept: 'image/*',
      priority: STORE_COVER_PRIORITY,
    };
  }

  /** The picture's address on the store's page (null when the page names none). */
  static pictureUrl(store: CoverStore, page: Buffer): string | null {
    if (store === 'amazon') {
      const url = amazonCoverUrl(page.toString('utf8'));
      // The original upload: a size suffix (._SX300_ and the like) asks for a smaller copy.
      return url ? url.replace(/\._[^/]*_(\.[a-z]+)$/i, '$1') : null;
    }
    const img = parseBwDetail(page).image;
    const url = Array.isArray(img) ? img[0] : img;
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  }

  /**
   * One step for one request: its answer when it has one, else it is asked (again) at the
   * highest priority. 'gone' and 'failed' are final for this look.
   */
  private step(
    spec: RequestSpec,
    again = false,
  ): { state: 'waiting' } | { state: 'done'; body: Buffer } | { state: 'gone' | 'failed' } {
    const q = this.deps.queue;
    const row = q.enqueue(spec, null);
    if (again && (row.state === 'failed' || row.state === 'gone')) {
      // "Ask again": a store that didn't answer, or had no page, is asked once more.
      q.requeue(row.id, STORE_COVER_PRIORITY);
      return { state: 'waiting' };
    }
    if (row.state === 'done') {
      const body = q.readAnswer(row.id);
      if (body) return { state: 'done', body };
      // The cached answer was cleared: asked again.
      q.requeue(row.id, STORE_COVER_PRIORITY);
      return { state: 'waiting' };
    }
    if (row.state === 'gone') return { state: 'gone' };
    if (row.state === 'failed') return { state: 'failed' };
    q.requeue(row.id, STORE_COVER_PRIORITY);
    return { state: 'waiting' };
  }

  /** Where one store stands, and its picture's bytes when it has one. */
  private look(
    store: CoverStore,
    id: string,
    again = false,
  ): { view: StoreCoverView; picture: Buffer | null } {
    const view: StoreCoverView = {
      store,
      id,
      state: 'waiting',
      reason: null,
      width: null,
      height: null,
      bytes: null,
      same: false,
    };
    const name = NAMES[store];
    const page = this.step(this.pageSpec(store, id), again);
    if (page.state === 'waiting') return { view, picture: null };
    if (page.state !== 'done') {
      view.state = page.state === 'gone' ? 'none' : 'failed';
      view.reason =
        page.state === 'gone' ? `${name} has no page for this id` : `${name} didn't answer`;
      return { view, picture: null };
    }
    const url = StoreCovers.pictureUrl(store, page.body);
    if (!url) {
      view.state = 'none';
      view.reason = `${name}'s page shows no cover`;
      return { view, picture: null };
    }
    const pic = this.step(this.pictureSpec(store, url), again);
    if (pic.state === 'waiting') return { view, picture: null };
    if (pic.state !== 'done') {
      view.state = 'failed';
      view.reason = `${name}'s picture couldn't be fetched`;
      return { view, picture: null };
    }
    return { view: { ...view, state: 'ready', bytes: pic.body.length }, picture: pic.body };
  }

  /** Every store's state (asking the queue where needed), with sizes and "Same as current". */
  async view(
    bookId: string,
    again = false,
  ): Promise<{ stores: StoreCoverView[]; fetcher: boolean }> {
    const current = this.deps.currentCover(bookId);
    const currentFacts = current ? await imageFacts(current) : null;
    const max = getSettings(this.deps.cleanup).covers.sameDistance;
    const out: StoreCoverView[] = [];
    for (const s of this.stores(bookId)) {
      const { view, picture } = this.look(s.store, s.id, again);
      if (picture) {
        const facts = await imageFacts(picture);
        if (!facts) {
          view.state = 'failed';
          view.reason = `${NAMES[s.store]}'s picture isn't a readable picture`;
        } else {
          view.width = facts.width;
          view.height = facts.height;
          view.same = samePicture(facts.dhash, currentFacts?.dhash ?? null, max);
        }
      }
      out.push(view);
    }
    return { stores: out, fetcher: this.fetcherOnline() };
  }

  /** The store's picture when it has been fetched (for the thumbnail and for the save). */
  picture(bookId: string, store: string): Buffer {
    const s = this.stores(bookId).find((x) => x.store === store);
    if (!s) throw new EditError(404, 'no_store', 'This book has no saved id for that store');
    const { picture } = this.look(s.store, s.id);
    if (!picture) throw new EditError(409, 'not_ready', "The store's picture isn't here yet");
    return picture;
  }
}
