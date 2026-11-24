/**
 * The level on a Natively book page (`https://learnnatively.com/book/<id>/`; read 2026-11-24).
 * The page carries the item's Next.js data (`self.__next_f.push([1,"…"])`) with
 * `"rating":{"lvl":31,"temporary":false,"alwaysTemporary":false,…}` (null while nobody has graded
 * the book). Natively shows a temporary level as "Level 25??". The data also holds the series'
 * rating (惡の華 (6): the book is Level 19, its series L23), so only the item's own counts.
 * When the data can't be read, the page's title ("… | L19", "… | L24??") and then its meta
 * description ("Difficulty: Level 31 (…)", without the temporary mark) give the level.
 * Checked on 15 real pages (scripts/natively-parse-check.ts: each matches its own title).
 */

export type ParsedLevel =
  | { kind: 'level'; level: number; temporary: boolean }
  /** A book page without a level (nobody graded it yet). */
  | { kind: 'none' }
  /** Not a book page we can read (changed format, an error page). */
  | { kind: 'unreadable' };

const PUSH_RE = /<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first `{ item: { rating, … } }` in the data (bounded walk). */
function findItem(root: unknown): Obj | null {
  const stack: unknown[] = [root];
  let seen = 0;
  while (stack.length && seen < 200_000) {
    const v = stack.pop();
    seen += 1;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isObj(v)) {
      const item = v.item;
      if (isObj(item) && 'rating' in item && ('isbn13' in item || 'gradingUrl' in item)) {
        return item;
      }
      for (const k of Object.keys(v)) stack.push(v[k]);
    }
  }
  return null;
}

function fromRating(rating: unknown): ParsedLevel | null {
  if (rating === null) return { kind: 'none' };
  if (!isObj(rating)) return null;
  const lvl = rating.lvl;
  if (lvl === null || lvl === undefined) return { kind: 'none' };
  if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 0 || lvl > 1000) return null;
  return { kind: 'level', level: lvl, temporary: rating.temporary === true };
}

export function parseNativelyLevel(html: string): ParsedLevel {
  for (const m of html.matchAll(PUSH_RE)) {
    let s: string;
    try {
      s = JSON.parse(m[1]) as string;
    } catch {
      continue;
    }
    if (!s.includes('"item":{') || !s.includes('"rating":')) continue;
    const colon = s.indexOf(':');
    let data: unknown;
    try {
      data = JSON.parse(s.slice(colon + 1));
    } catch {
      continue;
    }
    const item = findItem(data);
    if (!item) continue;
    const parsed = fromRating(item.rating);
    if (parsed) return parsed;
  }
  // The page's title ends with "| L19" ("| L24??" when temporary).
  const title = /\| L(\d+)(\?\?)?<\/title>/.exec(html);
  if (title) return { kind: 'level', level: Number(title[1]), temporary: !!title[2] };
  // The meta description, without the temporary mark.
  const meta = /<meta name="description" content="[^"]*?Difficulty: Level (\d+)/.exec(html);
  if (meta) return { kind: 'level', level: Number(meta[1]), temporary: false };
  if (/<meta name="description" content="Book, Difficulty: (?!Level)/.test(html)) {
    return { kind: 'none' };
  }
  return { kind: 'unreadable' };
}

/** A Natively id as the book page's links take it (lib/book-links/links.ts idPattern). */
export const NATIVELY_ID_RE = /^[0-9a-z]+$/i;
