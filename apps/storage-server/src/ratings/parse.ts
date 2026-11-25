/**
 * Store ratings (2026-11-25, docs/design/store-ratings.md): the rating on a book's store page.
 * Each parser reads only the book's own figures (a store page also shows other products' stars).
 * Checked on the cleanup's cached pages (2,000 random books, 2026-11-24) and live pages.
 *
 * - Amazon (`/dp/<ASIN>`): `#acrPopover title="5つ星のうち4.7"` and `#acrCustomerReviewText
 *   aria-label="217 レビュー"` (the other "5つ星のうち" on the page belong to other products). A
 *   product page without them has no ratings yet.
 * - BOOK☆WALKER (`/de<id>/`): the JSON-LD `Product` whose `url` is the book's own page, with
 *   `aggregateRating {ratingValue, reviewCount}` when it has reviews.
 * - 読書メーター (`/books/<id>`): no stars; 登録数 (`.bm-details-side__pickup` after "登録数") and
 *   the 感想・レビュー count (`.content__count`).
 */

export type ParsedRating =
  /** The page's figures. `avg` is null on 読書メーター (no stars). */
  | { kind: 'rating'; avg: number | null; count: number; reviews: number | null }
  /** The book's page, with no ratings yet. */
  | { kind: 'none' }
  /** Not a page we can read (an error page, a changed format). */
  | { kind: 'unreadable' };

const num = (s: string): number => Number(s.replace(/[,，]/g, ''));

export function parseAmazonRating(html: string): ParsedRating {
  const avg = /id="acrPopover"[^>]*?title="5つ星のうち\s*([0-9]+(?:\.[0-9]+)?)"/.exec(html);
  const count =
    /id="acrCustomerReviewText"[^>]*?aria-label="([\d,]+)\s*(?:レビュー|個の評価|件の評価|件のレビュー)"/.exec(
      html,
    ) ??
    /id="acrCustomerReviewText"[^>]*>\s*\(?([\d,]+)\)?\s*(?:個の評価|件の評価)?\s*</.exec(html);
  if (avg && count) {
    const a = Number(avg[1]);
    const n = num(count[1]);
    if (a >= 1 && a <= 5 && Number.isSafeInteger(n) && n > 0) {
      return { kind: 'rating', avg: a, count: n, reviews: null };
    }
    return { kind: 'unreadable' };
  }
  // A product page (its title block) without the rating block: nobody rated it yet.
  if (/id="productTitle"/.test(html) || /id="ebooksProductTitle"/.test(html))
    return { kind: 'none' };
  return { kind: 'unreadable' };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `id` is the saved BOOK☆WALKER id (the uuid after /de). */
export function parseBookwalkerRating(html: string, id: string): ParsedRating {
  const want = id.toLowerCase();
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const o of Array.isArray(data) ? data : [data]) {
      if (!isObj(o) || o['@type'] !== 'Product') continue;
      if (typeof o.url === 'string' && !o.url.toLowerCase().includes(want)) continue;
      const r = o.aggregateRating;
      if (!isObj(r)) return { kind: 'none' };
      const avg = Number(r.ratingValue);
      const count = Number(r.reviewCount ?? r.ratingCount);
      if (avg >= 1 && avg <= 5 && Number.isSafeInteger(count) && count > 0) {
        return { kind: 'rating', avg, count, reviews: null };
      }
      return { kind: 'none' };
    }
  }
  return { kind: 'unreadable' };
}

export function parseBookmeterCounts(html: string): ParsedRating {
  const reg =
    /登録数<\/dt>\s*<dd[^>]*>\s*<span[^>]*bm-details-side__pickup[^>]*>\s*([\d,]+)\s*</.exec(html);
  if (!reg) return { kind: 'unreadable' };
  const reviews = /感想・レビュー\s*<div class="content__count">\s*([\d,]+)\s*</.exec(html);
  return {
    kind: 'rating',
    avg: null,
    count: num(reg[1]),
    reviews: reviews ? num(reviews[1]) : null,
  };
}
