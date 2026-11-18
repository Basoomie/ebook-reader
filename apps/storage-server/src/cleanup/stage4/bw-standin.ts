/**
 * BookWalker in Amazon's place for light novels (WP20d, "Amazon where needed", 2026-11-18).
 *
 * Amazon caps a VPN address at about 200-300 requests an hour (measured live 2026-11-17/18:
 * 200, 202, 204, 202 answers at the 8 s pace, then 45-60 minutes of refusals), about 3,600-4,000
 * a day, while the library needed ~79,000 Amazon requests. Measured on the 800 labeled books
 * (scripts/measure-stage4-bw.ts): when BookWalker identifies a book it files as a light novel
 * (ライトノベル or 新文芸) with a series list or no volume number, and stage 4's unchanged rules
 * settle every field with BookWalker's page in Amazon's place, the result equals today's on
 * every field (share right and share filled, the 600 and check D); every other book asks
 * Amazon as before. Amazon requests per book 1.49 -> 0.93.
 *
 * BookWalker's page becomes the shape rules v3 reads from Amazon: its title, its people (a light
 * novel's author(s) first and illustrator last), its series (the book's own title stem shared
 * by most of the series' volumes, else their common start), the volume number from its kana
 * reading, its category as breadcrumbs and its label as an imprint. Outside light novels it is
 * never used: there BookWalker lists translators and supervisors among the people, and has no
 * cover illustrators or series (measured), which Amazon has.
 */
import { clean, type RefRecord } from './rules-v3';
import { decideStage4 } from './stage4-rules';
import { N, NA, nfkc } from '../title-rules';

/** Marks the record's Amazon part as BookWalker standing in (proposals name BookWalker). */
export const STANDIN = 'bookwalker';

type BwDetail = { title?: string; keywords?: string; description?: string; image?: string };
type Rec = Omit<RefRecord, 'bookwalker'> & {
  bookwalker?: { detail?: BwDetail | null; series_candidates?: [string, string][] };
};

const CATEGORY: Record<string, string[]> = {
  ライトノベル: ['本', 'ライトノベル'],
  新文芸: ['本', 'ライトノベル'],
  '文芸・小説': ['本', '小説・文芸'],
  マンガ: ['本', 'マンガ'],
  実用: ['本', '実用'],
  新書: ['本', '新書'],
};

function fileAuthors(r: Rec): string[] {
  return [
    ...(r.file.creators || [])
      .filter((x) => x.role === 'aut' || x.role === null || x.role === undefined)
      .map((x) => x.name),
    ...(r.calibre.cal_authors || '').split('&').filter((a) => a && a !== 'Unknown'),
  ];
}

/** BookWalker's keywords: title, kana reading, people..., label, category, 電子書籍. */
function keywords(d: BwDetail): {
  kw: string[];
  people: string[];
  label: string;
  category: string;
} {
  const kw = (d.keywords || '').split(',');
  return {
    kw,
    people: kw.length >= 5 ? kw.slice(2, -3) : [],
    label: kw.length >= 5 ? kw[kw.length - 3] : '',
    category: kw.length >= 3 ? kw[kw.length - 2] : '',
  };
}

/** The volume number in BookWalker's kana reading (…01…, …013…). */
export function kanaNumber(kana: string): number | null {
  const m = /(\d{2,3})/.exec(nfkc(kana));
  return m ? Number(m[1]) : null;
}

const OPEN = '(（[［【〈《「『<＜';
const CLOSE = ')）]］】〉》」』>＞';
/** Cuts a name back to before an unclosed bracket and drops trailing 第 / の / vol. and spaces. */
function tidy(p: string): string {
  let s = p;
  for (;;) {
    let cut = -1;
    for (let i = 0; i < OPEN.length; i++) {
      const o = s.lastIndexOf(OPEN[i]);
      if (o >= 0 && s.indexOf(CLOSE[i], o) < 0) cut = Math.max(cut, o);
    }
    if (cut < 0) break;
    s = s.slice(0, cut);
  }
  return s.replace(/(?:[\s・\-‐―~～:：]|第|の|vol\.?|Vol\.?)+$/u, '').trim();
}

/** The book's title up to its volume number (or the whole title when it has none). */
export function titleStem(title: string): string {
  const t = nfkc(title).replace(/【[^】]*】/gu, '');
  const m =
    /^(.*?)[\s\u3000]*(?:第?\d+(?:巻|部)?|[IVX]+|[Ⅰ-Ⅻ]|[上中下]|\(\d+\))(?:[\s\u3000~～\-―(（【].*)?$/u.exec(
      t,
    );
  return tidy(m ? m[1] : t);
}

/**
 * The series name: the book's own title up to its volume number when most of the series'
 * volumes start with it, else the volumes' common start (cut back to a whole word).
 */
export function commonSeries(titles: string[], fileTitle: string): string | null {
  if (titles.length < 2) return null;
  const vols = titles.map(nfkc);
  const stem = titleStem(fileTitle);
  if (stem.length >= 2 && vols.filter((v) => v.startsWith(stem)).length * 2 >= vols.length)
    return stem;
  let p = vols[0];
  for (const t of vols.slice(1)) {
    let i = 0;
    while (i < p.length && i < t.length && p[i] === t[i]) i++;
    p = p.slice(0, i);
  }
  p = tidy(p.replace(/[\s\d０-９]+$/u, ''));
  return p.length >= 2 ? p : null;
}

/**
 * BookWalker's page in the shape rules v3 reads from Amazon, or null when it has none. The
 * description and cover are left out: the rules read neither, and the proposals take the
 * description from BookWalker itself and replace covers only from Amazon.
 */
export function bwAsAmazon(rr: RefRecord): RefRecord['amazon'] | null {
  const r = rr as unknown as Rec;
  const d = r.bookwalker?.detail;
  if (!d?.title) return null;
  const { kw, people, label, category } = keywords(d);
  const fa = new Set(fileAuthors(r).map((x) => NA(x)));
  // BookWalker lists the author(s) first and a light novel's illustrator last; EPUB files often
  // list the illustrator as an author too, so the file can't tell them apart.
  const ln = category === 'ライトノベル' || category === '新文芸';
  const authors = people.map((name, i) => ({
    name,
    role:
      ln && people.length >= 2
        ? i === people.length - 1
          ? 'イラスト'
          : '著'
        : fa.size
          ? fa.has(NA(name))
            ? '著'
            : 'イラスト'
          : i === 0
            ? '著'
            : 'イラスト',
  }));
  const vols = (r.bookwalker?.series_candidates || []).map((c) => c[1]);
  const se = commonSeries(vols, (r.file.opf_title || r.calibre.cal_title) as string);
  const ix = kanaNumber(kw[1] || '');
  // Without a volume number in the kana reading, the series alone (rules v3 reads no number).
  const series = se
    ? ix !== null
      ? `全${vols.length}冊中${ix}番目の本   ${se}`
      : `シリーズ: ${se}  `
    : null;
  return {
    picked_from_search: true,
    standin: STANDIN,
    product: {
      title: d.title,
      asin: null,
      authors,
      description: null,
      series,
      breadcrumbs: CATEGORY[category] || [],
      rank_categories: label ? [label] : [],
      cover_url: null,
      publisher: null,
    },
  } as unknown as RefRecord['amazon'];
}

/** BookWalker identified the book: its title is the file's, and it names a file author. */
export function bwIdentified(rr: RefRecord): boolean {
  const r = rr as unknown as Rec;
  const d = r.bookwalker?.detail;
  if (!d?.title) return false;
  const { kw, label } = keywords(d);
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  const a = clean(ft, label ? [label] : [], [ft, d.title], [null]);
  const b = clean(d.title, label ? [label] : [], [ft, d.title], [null]);
  if (N(a) !== N(b)) return false;
  const fa = fileAuthors(r);
  return fa.length === 0 || kw.some((x) => fa.some((y) => NA(x) === NA(y)));
}

/** BookWalker files the book as a light novel, and its series is known or it has no number. */
export function bwLightNovel(rr: RefRecord): boolean {
  const r = rr as unknown as Rec;
  const d = r.bookwalker?.detail;
  if (!d) return false;
  const { category } = keywords(d);
  if (category !== 'ライトノベル' && category !== '新文芸') return false;
  const vols = r.bookwalker?.series_candidates || [];
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  return vols.length >= 2 || !/[0-9０-９Ⅰ-Ⅻ]|[上中下]$/u.test(nfkc(ft));
}

/**
 * True when BookWalker settles the book without Amazon: a light novel BookWalker identified,
 * and stage 4's rules with BookWalker in Amazon's place fill every scored field automatically.
 * `r.amazon` is ignored (the decision is made before Amazon is asked).
 */
export function bwSettles(rr: RefRecord): boolean {
  const r = rr as unknown as Rec;
  if (!bwLightNovel(r) || !bwIdentified(r)) return false;
  const x = { ...r, amazon: bwAsAmazon(r) ?? {} } as RefRecord;
  const d = decideStage4(x);
  return (['t', 'au', 'il', 'se', 'ix', 'fmt'] as const).every((f) => d.auto[f]);
}
