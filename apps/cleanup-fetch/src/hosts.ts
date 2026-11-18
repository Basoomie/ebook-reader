/**
 * The only hosts the fetch container ever talks to (https only). The server hands out the
 * requests; anything outside this list is refused here, whatever the server asks.
 * WP21c (the audiobook cleanup) adds Audible's, kikubon's and audiobook.jp's hosts.
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
  'learnnatively.com'
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
  return ALLOWED_HOSTS.includes(u.hostname) ? u : null;
}
