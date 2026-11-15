/**
 * A stand-in Google Fonts for tests that run the real storage server (Phase 10). Loaded
 * into the server process with NODE_OPTIONS="--require <this file>"; it answers the
 * server's requests to fonts.google.com, fonts.googleapis.com and fonts.gstatic.com from
 * local files and passes every other request to the real fetch.
 *
 * GOOGLE_FONTS_STUB = JSON { "<family>": { "category": "...", "files": { "400": "<path>",
 * "700": "<path>" } } }. The list holds these families (with the japanese subset) plus
 * Noto Sans JP (built into the reader). css2 answers one whole woff2 per weight for the old
 * Firefox User-Agent, as Google does.
 */
/* global require, process */
// A plain CommonJS preload (no TypeScript in a --require), so require is the way in.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');

const families = JSON.parse(process.env.GOOGLE_FONTS_STUB || '{}');
const realFetch = globalThis.fetch;
const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]/g, '');
const log = [];
globalThis.__googleFontsStubLog = log;

function respond(body, init) {
  return Promise.resolve(new Response(body, init));
}

globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  let u;
  try {
    u = new URL(url);
  } catch {
    return realFetch(input, init);
  }
  if (!['fonts.google.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) {
    return realFetch(input, init);
  }
  log.push(url);
  if (process.env.GOOGLE_FONTS_STUB_DOWN === '1') {
    return Promise.reject(new TypeError('fetch failed'));
  }
  if (u.hostname === 'fonts.google.com' && u.pathname === '/metadata/fonts') {
    const list = Object.entries(families).map(([family, f]) => ({
      family,
      category: f.category || 'Sans Serif',
      subsets: ['menu', 'japanese', 'latin'],
      fonts: Object.fromEntries(Object.keys(f.files).map((w) => [w, {}]))
    }));
    list.push({
      family: 'Noto Sans JP',
      category: 'Sans Serif',
      subsets: ['japanese'],
      fonts: { 400: {}, 700: {} }
    });
    return respond(`)]}'\n${JSON.stringify({ familyMetadataList: list })}`, {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (u.hostname === 'fonts.googleapis.com' && u.pathname === '/css2') {
    const [family, spec = '400'] = (u.searchParams.get('family') || '').split(':wght@');
    const f = families[family];
    if (!f) return respond('<html>', { status: 400 });
    const css = spec
      .split(';')
      .filter((w) => f.files[w])
      .map(
        (w) =>
          `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${w};\n` +
          `  src: url(https://fonts.gstatic.com/s/${slug(family)}/v1/${w}.woff2) format('woff2');\n}`
      )
      .join('\n');
    return respond(css, { headers: { 'Content-Type': 'text/css' } });
  }
  if (u.hostname === 'fonts.gstatic.com') {
    const m = /^\/s\/([a-z0-9]+)\/v1\/(\d+)\.woff2$/.exec(u.pathname);
    const entry = m && Object.entries(families).find(([family]) => slug(family) === m[1]);
    const file = entry && entry[1].files[m[2]];
    if (!file) return respond('not found', { status: 404 });
    return respond(fs.readFileSync(file), { headers: { 'Content-Type': 'font/woff2' } });
  }
  return respond('not found', { status: 404 });
};
