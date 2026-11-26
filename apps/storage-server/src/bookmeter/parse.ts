/**
 * Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md): the user's public 読書メーター pages.
 *
 * - A list page (`/users/<id>/books/{read,reading,stacked,wish}?page=N`): 20 entries a page,
 *   newest first, in the search list's HTML (`<li class="group__book">`), so stage 4's
 *   parseBookmeterSearch reads each entry; the read list adds `<div class="detail__date">
 *   YYYY/MM/DD</div>` (empty or 日付不明 on the other lists). The list's size is
 *   `<div class="content__count">N</div>` in its header.
 * - The profile page (`/users/<id>`): the name (`userdata-side__name`) and the four counts
 *   (`/users/<id>/books/<list>` … `userdata-nav__count">N`).
 * Pure.
 */
import { parseBookmeterSearch, type BookmeterHit } from '../cleanup/stage4/store-links';
import { unescapeHtml } from '../cleanup/stage4/ref-text';

export const BOOKMETER_LISTS = ['read', 'reading', 'stacked', 'wish'] as const;
export type BookmeterList = (typeof BOOKMETER_LISTS)[number];
export const PAGE_SIZE = 20;

export interface ListEntry extends BookmeterHit {
  /** The read date as YYYY-MM-DD (read list only; null when unknown). */
  date: string | null;
  /** The cover picture's URL as Bookmeter shows it. */
  cover: string | null;
}

export interface ListPage {
  entries: ListEntry[];
  /** The list's size from its header; null when the page doesn't show it. */
  total: number | null;
}

const BASE = 'https://bookmeter.com';

export function listUrl(userId: string, list: BookmeterList, page: number): string {
  return `${BASE}/users/${userId}/books/${list}${page > 1 ? `?page=${page}` : ''}`;
}
export function profileUrl(userId: string): string {
  return `${BASE}/users/${userId}`;
}
export function bookUrl(listingId: string): string {
  return `${BASE}/books/${listingId}`;
}

/** A Bookmeter user id from what the user typed: the number or a profile URL. */
export function userIdFrom(input: string): string | null {
  const t = input.trim();
  if (/^\d{1,12}$/.test(t)) return t;
  const m = /bookmeter\.com\/users\/(\d{1,12})(?:[/?#]|$)/.exec(t);
  return m ? m[1] : null;
}

/** True when the page is a Bookmeter page at all (not an error page or a bot check). */
function looksLikeBookmeter(html: string): boolean {
  return /読書メーター/.test(html) && /userdata-side|content-with-header/.test(html);
}

export function parseListPage(html: string): ListPage | null {
  if (!looksLikeBookmeter(html)) return null;
  const items = html.split('<li class="group__book">').slice(1);
  const hits = parseBookmeterSearch(html);
  // Every item must parse: a page that changed shape is refused, never read as a short list.
  if (hits.length !== items.length) return null;
  const entries = items.map((li, i): ListEntry => {
    const d = /<div class="detail__date">([^<]*)<\/div>/.exec(li)?.[1].trim() ?? '';
    const date = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(d);
    const cover = /<img alt="[^"]*" class="cover__image" src="([^"]+)"/.exec(li)?.[1] ?? null;
    return {
      ...hits[i],
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      cover: cover ? unescapeHtml(cover) : null,
    };
  });
  const count = /<div class="content__count">(\d+)<\/div>/.exec(html);
  return { entries, total: count ? parseInt(count[1], 10) : null };
}

export interface Profile {
  name: string;
  counts: Record<BookmeterList, number | null>;
}

export function parseProfile(html: string, userId: string): Profile | null {
  if (!looksLikeBookmeter(html)) return null;
  const name = /<div class="userdata-side__name">([^<]*)<\/div>/.exec(html)?.[1];
  if (name === undefined) return null;
  const counts = {} as Record<BookmeterList, number | null>;
  for (const list of BOOKMETER_LISTS) {
    const re = new RegExp(
      `href="/users/${userId}/books/${list}"[\\s\\S]{0,300}?userdata-nav__count">(\\d+)`,
    );
    const m = re.exec(html);
    counts[list] = m ? parseInt(m[1], 10) : null;
  }
  return { name: unescapeHtml(name).trim(), counts };
}
