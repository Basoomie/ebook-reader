/**
 * The story order of a multi-file book (WP21f-2, decided with the user at stop A): the order its
 * files are meant to be played in, which stages 3-5 compare and read in and the build numbers the
 * library's link names by. Pure.
 *
 * Sources, the first that applies wins:
 *  1. `tags`  every file has a track number (and disc, when given), unique per disc;
 *  2. `twin`  the chapter names of a twin recording (a single file of the same book with
 *             chapters) name every file (負けヒロイン's mp3 folder after its m4b's chapters);
 *  3. `words` section words in the names: front matter (タイトル, オープニング, プロローグ, 序章…)
 *             first, back matter (エピローグ, 終章, 結章, あとがき, 解説, 奥付, 感想コメント) last,
 *             the rest in name order (美しく、強く…: 結章 sorts first by name);
 *  4. `name`  the file names (natural order, Disc folders first: stage 2's order).
 *
 * Measured on every multi-file book of the live library (stop A): 13 books, 2 out of order by
 * name. `storyOrders` returns every source's order so the section-word rule can be checked
 * against the others.
 */

export interface OrderFile {
  /** The file's name without its folder and extension. */
  name: string;
  /** Its Disc/CD folder (stage 2's), or null. */
  disc: string | null;
  /** The file's track and disc tags, as ffprobe gave them ("3", "3/18"), or null. */
  track: string | null;
  discTag: string | null;
}

export interface TwinChapters {
  /** The twin's copy key (for the report). */
  key: string;
  /** Its chapter titles in playing order. */
  titles: string[];
}

export type OrderSource = 'tags' | 'twin' | 'words' | 'name';

export interface StoryOrders {
  /** The chosen order (indexes into the files as given, which are in name order). */
  order: number[];
  source: OrderSource;
  /** Every source that applied, with its order (`name` always). */
  all: Partial<Record<OrderSource, number[]>>;
  /** The twin whose chapters gave `all.twin`. */
  twin: string | null;
}

const FW_DIGITS = /[０-９]/g;
const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /^\s*(\d+)/.exec(
    s.replace(FW_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)),
  );
  return m ? Number(m[1]) : null;
};

/** A part number at the end of a name (`…【2】`, `…(2)`, `…（2）`), and the name without it. */
function splitPart(name: string): { base: string; part: number } {
  const m = /\s*[【[(（]\s*([0-9０-９]+)\s*[】\])）]\s*$/.exec(name);
  if (!m) return { base: name, part: 0 };
  return { base: name.slice(0, m.index), part: num(m[1]) ?? 0 };
}

/** How names and chapter titles are compared: NFKC, lower case, no spaces or separators. */
export function orderKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      /[\s\u3000・･/／\\\-‐―−_~～〜.,、。:：;；!！?？「」『』【】[\]()（）<>＜＞〈〉《》"'’“”]/gu,
      '',
    );
}

function byTags(files: OrderFile[]): number[] | null {
  if (files.length < 2) return null;
  const discs = [...new Set(files.map((f) => f.disc ?? ''))];
  const keyed = files.map((f, i) => ({
    i,
    disc: num(f.discTag) ?? discs.indexOf(f.disc ?? ''),
    track: num(f.track),
  }));
  if (keyed.some((k) => k.track === null)) return null;
  const seen = new Set(keyed.map((k) => `${k.disc}|${k.track}`));
  if (seen.size !== keyed.length) return null;
  return keyed.sort((a, b) => a.disc - b.disc || a.track! - b.track!).map((k) => k.i);
}

function byTwin(files: OrderFile[], twin: TwinChapters): number[] | null {
  const chapters = twin.titles.map(orderKey);
  if (chapters.length < 2) return null;
  const placed: { i: number; chapter: number; part: number }[] = [];
  for (const [i, f] of files.entries()) {
    const { base, part } = splitPart(f.name);
    const k = orderKey(base);
    if (k.length < 2) return null;
    let c = chapters.indexOf(k);
    if (c < 0) {
      // A file named after the start of its chapter, or a chapter after the start of its file.
      const near = chapters
        .map((t, j) => ({ t, j }))
        .filter(({ t }) => t.length >= 2 && (t.startsWith(k) || k.startsWith(t)));
      if (near.length !== 1) return null;
      c = near[0].j;
    }
    placed.push({ i, chapter: c, part });
  }
  if (new Set(placed.map((p) => p.chapter)).size < 2) return null;
  return placed
    .sort((a, b) => a.chapter - b.chapter || a.part - b.part || a.i - b.i)
    .map((p) => p.i);
}

/** Front matter, in the order it is read. */
const FRONT = [
  /^(タイトル|title|オープニング|opening)/,
  /^(プロローグ|prologue|序章|序幕|はじめに|まえがき|前書き)/,
];
/** Back matter, in the order it is read. */
const BACK = [
  /^(エピローグ|epilogue|終章|結章|終幕|最終章)/,
  /^(あとがき|後書き|afterword|解説|奥付)/,
  // Not おまけ/特典/bonus: a radio show's bonus folder holds only bonuses (ざこラジ's
  // `パッケージ振り返りおまけ` beside a corner talk), and they would be moved for nothing.
  /(感想コメント|コメント)$/,
];

function sectionOf(name: string): number {
  const k = orderKey(name.replace(/^[0-9０-９]+\s+/, ''));
  for (const [j, re] of FRONT.entries()) if (re.test(k)) return -FRONT.length + j;
  for (const [j, re] of BACK.entries()) if (re.test(k)) return 1 + j;
  return 0;
}

function byWords(files: OrderFile[]): number[] | null {
  const sections = files.map((f) => sectionOf(f.name));
  if (sections.every((s) => s === 0)) return null;
  return files
    .map((f, i) => ({ i, s: sections[i] }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.i);
}

/**
 * Every source's order for one multi-file book whose files are given in name order (stage 2's),
 * and the chosen one. `twins` are single-file recordings of the same book with chapters.
 */
export function storyOrders(files: OrderFile[], twins: TwinChapters[] = []): StoryOrders {
  const name = files.map((_, i) => i);
  const all: StoryOrders['all'] = { name };
  const tags = byTags(files);
  if (tags) all.tags = tags;
  let twinKey: string | null = null;
  for (const t of twins) {
    const o = byTwin(files, t);
    if (o) {
      all.twin = o;
      twinKey = t.key;
      break;
    }
  }
  const words = byWords(files);
  if (words) all.words = words;
  const source: OrderSource = all.tags ? 'tags' : all.twin ? 'twin' : all.words ? 'words' : 'name';
  return { order: all[source]!, source, all, twin: twinKey };
}

/** Whether an order is not the name order (the files are given in name order). */
export function differsFromNames(order: number[]): boolean {
  return order.some((x, i) => x !== i);
}

/** What `orderParts` needs of a stage-3 copy. */
export interface CopyForOrder {
  key: string;
  kind: string;
  fileIds: number[];
  titleKey: string | null;
  volume: string | null;
  asins: string[];
  absAsins: string[];
}

/** What `orderParts` needs of a file. */
export interface OrderLookup {
  name(fileId: number): string;
  disc(fileId: number): string | null;
  tags(fileId: number): { track: string | null; disc: string | null } | null;
  /** The file's chapter titles in order (null or fewer than 2: no chapters). */
  chapters(fileId: number): string[] | null;
}

/**
 * The story order of every multi-file copy (`parts`), its files given in name order. Twins are
 * the single-file copies stage 3 pairs with it as candidates: the same title key and printed
 * volume, or an ASIN in common (sorted by key, so the choice is stable).
 */
export function orderParts(copies: CopyForOrder[], look: OrderLookup): Map<string, StoryOrders> {
  const single = copies.filter((c) => c.kind !== 'parts' && c.fileIds.length === 1);
  const out = new Map<string, StoryOrders>();
  for (const c of copies) {
    if (c.kind !== 'parts' || c.fileIds.length < 2) continue;
    const ids = new Set([...c.asins, ...c.absAsins]);
    const title = c.titleKey && c.titleKey.length >= 2 ? `${c.titleKey}|${c.volume ?? ''}` : null;
    const twins: TwinChapters[] = single
      .filter(
        (s) =>
          (title !== null && `${s.titleKey}|${s.volume ?? ''}` === title) ||
          [...s.asins, ...s.absAsins].some((a) => ids.has(a)),
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((s) => ({ key: s.key, titles: look.chapters(s.fileIds[0]) ?? [] }))
      .filter((t) => t.titles.length >= 2);
    const files = c.fileIds.map((id) => {
      const t = look.tags(id);
      return {
        name: look.name(id),
        disc: look.disc(id),
        track: t?.track ?? null,
        discTag: t?.disc ?? null,
      };
    });
    out.set(c.key, storyOrders(files, twins));
  }
  return out;
}

/** Stage 2's name order: natural (numbers as numbers), as `book-units.ts` sorts. */
const NAME_ORDER = new Intl.Collator('ja', { numeric: true, sensitivity: 'variant' });

/**
 * The numbers the library's link names get (`01 `, `02 `, …), given a book's files in story
 * order by their paths inside the book: null when that is already their name order (nothing to
 * number). Two digits at least, more for a book of 100 files or more (decided with the user at
 * stop A: only books whose story order differs from name order).
 */
export function linkNumbers(relsInStoryOrder: string[]): string[] | null {
  if (relsInStoryOrder.length < 2) return null;
  const sorted = [...relsInStoryOrder].sort((a, b) => NAME_ORDER.compare(a, b));
  if (sorted.every((r, i) => r === relsInStoryOrder[i])) return null;
  const width = Math.max(2, String(relsInStoryOrder.length).length);
  return relsInStoryOrder.map((_, i) => `${String(i + 1).padStart(width, '0')} `);
}
