/**
 * Season 2 Phase 10: fonts from Google Fonts, fetched by the storage server (decided by the
 * user, 2026-11-15). Verified 2026-11-15:
 *
 * - The list: `fonts.google.com/metadata/fonts`, the list the Google Fonts site itself uses
 *   (no key; the official list API needs one). It sends no CORS header, so only a server
 *   can read it. 1,961 families, 68 with the `japanese` subset.
 * - The files: the CSS API answers by User-Agent. A current browser gets ~122 slices per
 *   weight; an old Firefox User-Agent gets one whole woff2 per weight (same glyphs,
 *   characters and vertical tables as Google's TTF, about 37 % of its size); a request
 *   with Node's own User-Agent gets one whole TTF. Only whole files are taken: one file
 *   per weight, never `unicode-range` slices.
 * - Files come only from `https://fonts.gstatic.com/`.
 */
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';

export const GOOGLE_LIST_URL = 'https://fonts.google.com/metadata/fonts';
export const GOOGLE_CSS_URL = 'https://fonts.googleapis.com/css2';
export const GOOGLE_FILE_ORIGIN = 'https://fonts.gstatic.com';

/** A User-Agent Google answers with one whole woff2 per weight. */
export const WHOLE_WOFF2_USER_AGENT =
  'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:40.0) Gecko/20100101 Firefox/40.0';

/** The weights stored: regular, and bold where the family has it (decided 2026-11-15). */
export const REGULAR_WEIGHT = 400;
export const BOLD_WEIGHT = 700;

export class GoogleFontsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleFamily {
  family: string;
  /** Google's category: Serif, Sans Serif, Display, Handwriting, Monospace. */
  category: string;
  /** The weights the reader stores, regular first. */
  weights: number[];
}

export interface GoogleFace {
  weight: number;
  url: string;
  /** woff2 or truetype, as the CSS names it. */
  format: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleFontsOptions {
  /** Each request to Google gives up after this (GOOGLE_FONTS_TIMEOUT_SECONDS). */
  timeoutSeconds: number;
  /** Tests pass a stand-in; defaults to the global fetch. */
  fetch?: FetchLike;
}

const unreachable = (detail: string) =>
  new GoogleFontsError(502, 'google_unreachable', `Google Fonts can't be reached: ${detail}`);

const unexpected = (detail: string) =>
  new GoogleFontsError(
    502,
    'google_unexpected',
    `Google Fonts answered in a way the reader doesn't know: ${detail}`,
  );

/**
 * The stored weights of a family from its listed weights (keys like "400", "700"; italic
 * keys like "400i" are left out): 400, or the weight nearest it, plus 700 when listed.
 */
export function storedWeights(listed: readonly number[]): number[] {
  if (!listed.length) return [];
  const regular = listed.includes(REGULAR_WEIGHT)
    ? REGULAR_WEIGHT
    : [...listed].sort(
        (a, b) => Math.abs(a - REGULAR_WEIGHT) - Math.abs(b - REGULAR_WEIGHT) || a - b,
      )[0];
  return regular !== BOLD_WEIGHT && listed.includes(BOLD_WEIGHT)
    ? [regular, BOLD_WEIGHT]
    : [regular];
}

/** The Japanese families from Google's site list (which may start with `)]}'`). */
export function parseFamilyList(text: string): GoogleFamily[] {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  } catch {
    throw unexpected('the font list is not JSON');
  }
  const list = (json as { familyMetadataList?: unknown })?.familyMetadataList;
  if (!Array.isArray(list)) throw unexpected('the font list has no families');
  const out: GoogleFamily[] = [];
  for (const entry of list) {
    const { family, category, subsets, fonts } = (entry ?? {}) as Record<string, unknown>;
    if (typeof family !== 'string' || !family) continue;
    if (!Array.isArray(subsets) || !subsets.includes('japanese')) continue;
    const listed =
      fonts && typeof fonts === 'object'
        ? Object.keys(fonts)
            .filter((k) => /^\d{1,4}$/.test(k))
            .map(Number)
            .filter((w) => w >= 1 && w <= 1000)
        : [];
    const weights = storedWeights(listed);
    if (!weights.length) continue;
    out.push({ family, category: typeof category === 'string' ? category : '', weights });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family));
}

/** The css2 address for a family's weights (spaces as `+`, as Google writes them). */
export function cssUrl(family: string, weights: readonly number[]): string {
  return `${GOOGLE_CSS_URL}?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights.join(';')}`;
}

interface CssFace {
  weight: number;
  style: string;
  url: string;
  format: string;
  ranged: boolean;
}

/** The @font-face rules of a css2 answer. */
export function parseCss(css: string): CssFace[] {
  const faces: CssFace[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
    const style = /font-style:\s*([a-z]+)/.exec(body)?.[1] ?? 'normal';
    const src = /src:\s*url\(([^)\s]+)\)\s*format\('([^']+)'\)/.exec(body);
    if (!src || !Number.isFinite(weight)) continue;
    faces.push({
      weight,
      style,
      url: src[1].replace(/^['"]|['"]$/g, ''),
      format: src[2],
      ranged: /unicode-range:/.test(body),
    });
  }
  return faces;
}

/** Only files on fonts.gstatic.com over https are ever fetched. */
export function isGoogleFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === GOOGLE_FILE_ORIGIN && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * One whole file per wanted weight, or null when the answer is in slices (or a weight is
 * missing or doubled). Throws when a file would come from anywhere but fonts.gstatic.com.
 */
export function wholeFaces(css: string, weights: readonly number[]): GoogleFace[] | null {
  const normal = parseCss(css).filter((f) => f.style === 'normal');
  const out: GoogleFace[] = [];
  for (const weight of weights) {
    const matching = normal.filter((f) => f.weight === weight);
    if (matching.length !== 1 || matching[0].ranged) return null;
    const face = matching[0];
    if (!['woff2', 'truetype'].includes(face.format)) return null;
    if (!isGoogleFileUrl(face.url)) throw unexpected(`a font file outside ${GOOGLE_FILE_ORIGIN}`);
    out.push({ weight, url: face.url, format: face.format });
  }
  return out;
}

export class GoogleFonts {
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: GoogleFontsOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  private async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutSeconds * 1000),
      });
    } catch (err) {
      const e = err as Error;
      throw unreachable(
        e?.name === 'TimeoutError'
          ? `no answer within ${this.opts.timeoutSeconds} s`
          : ((e?.cause as Error)?.message ?? e?.message ?? String(err)),
      );
    }
    return res;
  }

  /** The Japanese families Google lists now. */
  async list(): Promise<GoogleFamily[]> {
    const res = await this.get(GOOGLE_LIST_URL);
    if (!res.ok) throw unreachable(`the font list answered ${res.status}`);
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw unreachable((err as Error)?.message ?? String(err));
    }
    return parseFamilyList(text);
  }

  /**
   * The whole files of a family's weights: woff2 first; when Google answers that in
   * slices, a second request with Node's own User-Agent (whole TTF files).
   */
  async faces(family: string, weights: readonly number[]): Promise<GoogleFace[]> {
    const attempts: Record<string, string>[] = [{ 'User-Agent': WHOLE_WOFF2_USER_AGENT }, {}];
    for (const headers of attempts) {
      const res = await this.get(cssUrl(family, weights), headers);
      if (!res.ok) {
        throw res.status === 400
          ? new GoogleFontsError(404, 'not_a_google_font', `Google Fonts has no font "${family}"`)
          : unreachable(`the font's CSS answered ${res.status}`);
      }
      const faces = wholeFaces(await res.text(), weights);
      if (faces) return faces;
    }
    throw unexpected('no whole font files offered');
  }

  /** A font file as a stream (the caller limits its size and checks its format). */
  async download(face: GoogleFace): Promise<NodeJS.ReadableStream> {
    if (!isGoogleFileUrl(face.url)) throw unexpected(`a font file outside ${GOOGLE_FILE_ORIGIN}`);
    const res = await this.get(face.url);
    if (!res.ok || !res.body) throw unreachable(`a font file answered ${res.status}`);
    return Readable.fromWeb(res.body as WebReadableStream);
  }
}
