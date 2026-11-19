/**
 * The only hosts the fetch container ever talks to (https only). The server hands out the
 * requests; anything outside this list is refused here, whatever the server asks.
 * WP21c (the audiobook cleanup) added Audible's catalog API and its sample audio, kikubon and
 * audiobook.jp, and audiobook.jp's sample audio, which lives on Google's shared storage host:
 * that host is allowed only under audiobook.jp's own sample folder (found on its product pages
 * 2026-11-19: `<audio id="sample-audio" src="https://storage.googleapis.com/otobank-abjp-core-prod.appspot.com/audios/sample/<id>.mp3">`).
 */
export const ALLOWED_HOSTS: readonly string[] = [
  'www.amazon.co.jp',
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'bookwalker.jp',
  'rimg.bookwalker.jp',
  'ranobedb.org',
  'id.ndl.go.jp',
  'bookmeter.com',
  'learnnatively.com',
  'api.audible.co.jp',
  'samples.audible.com',
  'kikubon.jp',
  'audiobook.jp'
];

/** Hosts allowed only under one path (a shared host: only this site's folder on it). */
export const ALLOWED_PREFIXES: readonly { host: string; path: string }[] = [
  { host: 'storage.googleapis.com', path: '/otobank-abjp-core-prod.appspot.com/audios/sample/' }
];

/** The request goes to an allowed host over https (no login part, default port). */
export function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    return null;
  if (ALLOWED_HOSTS.includes(u.hostname)) return u;
  // The path as the server will see it (URL normalises "..", so it can't climb out).
  return ALLOWED_PREFIXES.some((p) => p.host === u.hostname && u.pathname.startsWith(p.path))
    ? u
    : null;
}
