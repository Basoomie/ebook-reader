/**
 * Stage 4's requests (WP21c), built exactly as the reference sample's fetcher built them
 * (`refsample.py`: Python's urlencode / quote), so the same request is the same URL and the
 * sample's answers can stand in for the internet in tests. Pure.
 *
 * Only these pages are ever asked for (user, 2026-11-19: "we are not crawling these sites"):
 * Audible's catalog API (a product, a search, a product's sample address) and the sample audio
 * it names; kikubon's and audiobook.jp's search page and the product page of a book being
 * looked up, and audiobook.jp's sample audio its product page names.
 */
import type { AudioFetchSite } from '../settings';

/** The product's response groups (audiobook plan section 6, probe 1; refsample's AUD_RG). */
export const AUDIBLE_PRODUCT_GROUPS =
  'contributors,product_desc,product_attrs,product_extended_attrs,series,relationships,media,category_ladders';
/** The search's groups (refsample's SEARCH_RG): without product_desc titles come back empty. */
export const AUDIBLE_SEARCH_GROUPS =
  'contributors,product_desc,product_attrs,product_extended_attrs,series,relationships,category_ladders';

const AUDIBLE = 'https://api.audible.co.jp/1.0/catalog/products';

export interface OnlineRequest {
  site: AudioFetchSite;
  url: string;
  accept: string;
}

/** Python's urllib.parse.quote (safe '/'). */
export function pyQuote(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, '/');
}

/** Python's urllib.parse.quote_plus (urlencode's): nothing safe, spaces as "+". */
export function pyQuotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/** Python's urlencode of an ordered list of pairs. */
export function pyUrlencode(pairs: [string, string | number][]): string {
  return pairs.map(([k, v]) => `${pyQuotePlus(k)}=${pyQuotePlus(String(v))}`).join('&');
}

const JSON_ACCEPT = 'application/json';
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
const AUDIO_ACCEPT = 'audio/mpeg,audio/*;q=0.9,*/*;q=0.5';

export const ASIN_RE = /^B0[0-9A-Z]{8}$/;

export function audibleProduct(asin: string): OnlineRequest {
  if (!ASIN_RE.test(asin)) throw new Error(`Not an ASIN: ${asin}`);
  return {
    site: 'audible',
    url: `${AUDIBLE}/${asin}?response_groups=${AUDIBLE_PRODUCT_GROUPS}`,
    accept: JSON_ACCEPT,
  };
}

/** A title search (or a keyword search, the last try), 10 results by relevance. */
export function audibleSearch(q: string, keywords = false): OnlineRequest {
  const qs = pyUrlencode([
    ['num_results', 10],
    ['products_sort_by', 'Relevance'],
    ['response_groups', AUDIBLE_SEARCH_GROUPS],
    [keywords ? 'keywords' : 'title', q],
  ]);
  return { site: 'audible', url: `${AUDIBLE}?${qs}`, accept: JSON_ACCEPT };
}

/** The product's sample address (response group `sample`; checked live 2026-11-19). */
export function audibleSampleInfo(asin: string): OnlineRequest {
  if (!ASIN_RE.test(asin)) throw new Error(`Not an ASIN: ${asin}`);
  return { site: 'audible', url: `${AUDIBLE}/${asin}?response_groups=sample`, accept: JSON_ACCEPT };
}

/** Audible's sample audio, only on its own sample host. */
export function audibleSampleAudio(url: string): OnlineRequest | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'samples.audible.com') return null;
  } catch {
    return null;
  }
  return { site: 'audible-sample', url, accept: AUDIO_ACCEPT };
}

export function kikubonSearch(q: string): OnlineRequest {
  return {
    site: 'kikubon',
    url: `https://kikubon.jp/searchAudiobookList.php?search=${pyQuote(q)}`,
    accept: HTML_ACCEPT,
  };
}

export function kikubonProduct(id: string): OnlineRequest {
  if (!/^\d{1,9}$/.test(id)) throw new Error(`Not a kikubon id: ${id}`);
  return { site: 'kikubon', url: `https://kikubon.jp/product.php?aKey=${id}`, accept: HTML_ACCEPT };
}

export function abjpSearch(q: string): OnlineRequest {
  return {
    site: 'audiobookjp',
    url: `https://audiobook.jp/search?q=${pyQuote(q)}`,
    accept: HTML_ACCEPT,
  };
}

export function abjpProduct(id: string): OnlineRequest {
  if (!/^\d{1,9}$/.test(id)) throw new Error(`Not an audiobook.jp id: ${id}`);
  return { site: 'audiobookjp', url: `https://audiobook.jp/product/${id}`, accept: HTML_ACCEPT };
}

/** audiobook.jp's sample audio, only in its own folder on Google's storage host. */
export function abjpSampleAudio(url: string): OnlineRequest | null {
  try {
    const u = new URL(url);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'storage.googleapis.com' ||
      !u.pathname.startsWith('/otobank-abjp-core-prod.appspot.com/audios/sample/')
    )
      return null;
  } catch {
    return null;
  }
  return { site: 'audiobookjp-sample', url, accept: AUDIO_ACCEPT };
}
