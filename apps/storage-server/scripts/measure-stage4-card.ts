/**
 * WP20d: Amazon's search result card in place of its product page, on the 800 labeled books.
 *
 *   npx tsx scripts/measure-stage4-card.ts <cleanup-reference dir> <reference raw pages dir>
 *
 * A book without an ASIN in its file asks Amazon's Kindle search and then the product page it
 * picked: two requests in Amazon's capped slot. The search page's card for the picked book
 * already has its title, series and volume ("全15巻の第1巻: 忘却探偵"), people (no roles) and
 * format; the product page adds the people's roles, the category path and ranking categories.
 * Here the card stands in for the product page where stage 4's unchanged rules settle every
 * scored field with it, on top of today's production choice (BookWalker for the light novels it
 * settles, bw-standin.ts). Per field: share right when filled and share filled, the 600 and
 * check D, beside production. Reads only.
 *
 * Result (2026-11-18): of the 262 labeled books that search Amazon, the card stands in for 12
 * at equal accuracy and filled share on every field (0.911 -> 0.896 Amazon requests per book).
 * The format needs Amazon's category path (on the product page only; BookWalker's category
 * helps only where it identified the book) and the illustrators need the people's roles. Not
 * built.
 */
import fs from 'fs';
import path from 'path';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import { clean } from '../src/cleanup/stage4/rules-v3';
import * as prod from '../src/cleanup/stage4/bw-standin';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import {
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  type ScoredField,
  type Stage4Gold,
} from '../src/cleanup/stage4/score';
import { unescapeHtml } from '../src/cleanup/stage4/ref-text';
import { N, NA, nfkc } from '../src/cleanup/title-rules';

const [refDir, rawDir] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
type Product = {
  title?: string | null;
  asin?: string | null;
  authors?: { name: string; role: string }[];
  series?: string | null;
  breadcrumbs?: string[] | null;
  rank_categories?: string[] | null;
  [k: string]: unknown;
};
type Rec = RefRecord & {
  amazon?: { product?: Product | null; picked_from_search?: boolean; [k: string]: unknown } | null;
};
const records = Object.fromEntries(
  Object.keys(gold).map((id) => [
    id,
    JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as Rec,
  ]),
);

type Card = {
  asin: string;
  title: string;
  series: string | null;
  people: string[];
  more: boolean;
  seller: string | null;
};
const text = (h: string) =>
  unescapeHtml(h.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** Every result card of a Kindle search page. */
function cards(html: string): Card[] {
  const out: Card[] = [];
  const starts = [
    ...html.matchAll(/data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"/g),
  ];
  for (let k = 0; k < starts.length; k++) {
    const seg = html.slice(starts[k].index!, starts[k + 1]?.index ?? starts[k].index! + 60000);
    const t = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(seg);
    const row =
      /<div class="a-row a-size-base a-color-secondary">(?:<div class="a-row">)?([\s\S]*?)<\/div>/.exec(
        seg,
      );
    let series: string | null = null;
    let people: string[] = [];
    let more = false;
    let seller: string | null = null;
    if (row) {
      const parts = row[1].split(/<span class="a-size-base a-color-secondary"> \| <\/span>/);
      for (const p of parts) {
        const s = text(p);
        const m = /^全(\d+)巻の第(\d+)巻:\s*(.+)$/u.exec(s);
        if (m) series = `全${m[1]}冊中${m[2]}番目の本   ${m[3]}`;
        else if (/^販売者:/.test(s)) seller = s.replace(/^販売者:\s*/, '');
        else if (s && people.length === 0 && !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
          people = s
            .split(/\s*、\s*/u)
            .map((x) => x.trim())
            .filter(Boolean);
          if (people.length && /(他|ほか)$/u.test(people[people.length - 1])) more = true;
        }
      }
    }
    out.push({ asin: starts[k][1], title: t ? text(t[1]) : '', series, people, more, seller });
  }
  return out;
}

function fileAuthors(r: Rec): string[] {
  return [
    ...(r.file.creators || [])
      .filter((x) => x.role === 'aut' || x.role === null || x.role === undefined)
      .map((x) => x.name),
    ...(r.calibre.cal_authors || '').split('&').filter((a) => a && a !== 'Unknown'),
  ];
}

type Roles =
  | 'others-illustrate'
  | 'only-file-authors'
  | 'others-illustrate+bw'
  | 'only-file-authors+bw';
const BW_CATEGORY: Record<string, string[]> = {
  ライトノベル: ['本', 'ライトノベル'],
  新文芸: ['本', 'ライトノベル'],
  '文芸・小説': ['本', '小説・文芸'],
  マンガ: ['本', 'マンガ'],
  実用: ['本', '実用'],
  新書: ['本', '新書'],
};
/** BookWalker's category as a category path, when BookWalker identified the book. */
function bwPath(r: Rec): string[] {
  if (!prod.bwIdentified(r as RefRecord)) return [];
  const kw = (
    (r as { bookwalker?: { detail?: { keywords?: string } } }).bookwalker?.detail?.keywords || ''
  ).split(',');
  return kw.length >= 3 ? (BW_CATEGORY[kw[kw.length - 2]] ?? []) : [];
}
/** The card in the product page's shape; null when it can't stand in under the role rule. */
function cardAsProduct(r: Rec, c: Card, roles: Roles): Product | null {
  if (c.more || c.people.length === 0) return null;
  const fa = new Set(fileAuthors(r).map((x) => NA(x)));
  const isAuthor = (n: string) => fa.has(NA(n));
  if (roles.startsWith('only-file-authors') && !c.people.every(isAuthor)) return null;
  const label = /[(（]([^()（）]+)[)）]\s*$/u.exec(c.title);
  return {
    title: c.title,
    asin: c.asin,
    authors: c.people.map((name) => ({ name, role: isAuthor(name) ? '著' : 'イラスト' })),
    series: c.series ?? '',
    breadcrumbs: roles.endsWith('+bw') ? bwPath(r) : [],
    rank_categories: label ? [label[1]] : [],
    description: null,
    cover_url: null,
    publisher: null,
  };
}

/** The card names the picked book: its title is the file's (as bwIdentified). */
function cardIdentified(r: Rec, p: Product): boolean {
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  const lab = p.rank_categories || [];
  return (
    N(clean(ft, lab, [ft, p.title!], [null])) === N(clean(p.title!, lab, [ft, p.title!], [null]))
  );
}

function cardSettles(r: Rec, p: Product): boolean {
  if (!cardIdentified(r, p)) return false;
  const x = { ...r, amazon: { ...r.amazon, product: p, picked_from_search: true } } as RefRecord;
  const d = decideStage4(x);
  const ft = nfkc((r.file.opf_title || r.calibre.cal_title) as string);
  if (d.values.se === null && /[0-9Ⅰ-Ⅻ]/u.test(ft)) return false;
  return SCORED_FIELDS.every((f) => d.auto[f]);
}

const rawCache = new Map<string, Card[] | null>();
function searchCards(id: string): Card[] | null {
  if (!rawCache.has(id)) {
    const f = path.join(rawDir, `${id}_amazon_search.txt`);
    rawCache.set(id, fs.existsSync(f) ? cards(fs.readFileSync(f, 'utf8')) : null);
  }
  return rawCache.get(id)!;
}

type Stats = {
  groups: Record<string, ReturnType<typeof emptyScores>>;
  requests: number;
  searchBooks: number;
  cardUsed: number;
  noRaw: number;
  noCard: number;
  changed: string[];
};
function run(roles: Roles | null): Stats {
  const st: Stats = {
    groups: { ABC: emptyScores(), D: emptyScores() },
    requests: 0,
    searchBooks: 0,
    cardUsed: 0,
    noRaw: 0,
    noCard: 0,
    changed: [],
  };
  for (const [id, g] of Object.entries(gold)) {
    const r = structuredClone(records[id]);
    if (prod.bwSettles(r as RefRecord)) {
      r.amazon = prod.bwAsAmazon(r as RefRecord) as Rec['amazon'];
    } else {
      const fromSearch = !r.file?.asin;
      const product = r.amazon?.product;
      if (fromSearch) st.searchBooks++;
      st.requests += (fromSearch ? 1 : 0) + (product ? 1 : 0);
      if (roles && fromSearch && product?.asin) {
        const cs = searchCards(id);
        const c = cs?.find((x) => x.asin === product.asin);
        if (!cs) st.noRaw++;
        else if (!c) st.noCard++;
        const p = c ? cardAsProduct(r, c, roles) : null;
        const why = !c
          ? 'no card'
          : !p
            ? c.more
              ? 'more people'
              : c.people.length === 0
                ? 'no people'
                : 'a person is not a file author'
            : !cardIdentified(r, p)
              ? 'title differs'
              : !cardSettles(r, p)
                ? 'not every field settled'
                : 'used';
        reasons[roles][why] = (reasons[roles][why] ?? 0) + 1;
        if (why !== 'used' && process.argv.includes('--why'))
          whyLines.push(
            `${roles} ${id} ${why}: ${c?.title} | ${c?.people.join('、')} | ${c?.series}`,
          );
        if (p && cardSettles(r, p)) {
          st.cardUsed++;
          st.requests -= 1;
          const before = decideStage4(r as RefRecord).values as unknown as Record<string, unknown>;
          r.amazon = { ...r.amazon, product: p, picked_from_search: true };
          const after = decideStage4(r as RefRecord).values as unknown as Record<string, unknown>;
          for (const f of SCORED_FIELDS)
            if (JSON.stringify(before[f]) !== JSON.stringify(after[f]))
              st.changed.push(
                `${id} ${f}: ${JSON.stringify(before[f])} -> ${JSON.stringify(after[f])}`,
              );
        }
      }
    }
    const d = decideStage4(r as RefRecord);
    addScore(
      st.groups[g.sample === 'D' ? 'D' : 'ABC'],
      id,
      d.values as unknown as Record<ScoredField, unknown>,
      d.auto,
      g,
    );
  }
  return st;
}

const reasons: Record<string, Record<string, number>> = {
  'others-illustrate': {},
  'only-file-authors': {},
  'others-illustrate+bw': {},
  'only-file-authors+bw': {},
};
const whyLines: string[] = [];
const base = run(null);
const n = Object.keys(gold).length;
console.log(
  `PRODUCTION: Amazon requests per book ${(base.requests / n).toFixed(3)}; ${base.searchBooks} books search Amazon`,
);
for (const roles of [
  'others-illustrate',
  'only-file-authors',
  'others-illustrate+bw',
  'only-file-authors+bw',
] as Roles[]) {
  const s = run(roles);
  console.log(
    `\nCARD (${roles}): Amazon requests per book ${(s.requests / n).toFixed(3)} (production ${(base.requests / n).toFixed(3)}); card stood in for ${s.cardUsed} of ${s.searchBooks}; no raw page ${s.noRaw}, picked book not on the page ${s.noCard}`,
  );
  for (const grp of ['ABC', 'D'] as const) {
    const a = s.groups[grp];
    const b = base.groups[grp];
    console.log(
      `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
        SCORED_FIELDS.map((f) => {
          const p = percent(a[f].right, a[f].auto);
          const fl = percent(a[f].auto, a[f].scored);
          const pb = percent(b[f].right, b[f].auto);
          const fb = percent(b[f].auto, b[f].scored);
          const same = a[f].right === b[f].right && a[f].auto === b[f].auto ? '=' : '≠';
          return `${f} ${same} ${p?.toFixed(1)}% right (${pb?.toFixed(1)}), ${fl?.toFixed(0)}% filled (${fb?.toFixed(0)})`;
        }).join(' | '),
    );
  }
  console.log('  why:', JSON.stringify(reasons[roles]));
  if (process.argv.includes('--changed')) for (const c of s.changed) console.log('    ' + c);
}
for (const l of whyLines.slice(0, 400)) console.log(l);

// Which fields the card leaves unsettled, and whether the product page settled them.
if (process.argv.includes('--fields')) {
  const tally: Record<string, { card: number; dpToo: number }> = {};
  let dpAll = 0;
  let books = 0;
  for (const id of Object.keys(gold)) {
    const r = structuredClone(records[id]);
    if (prod.bwSettles(r as RefRecord) || r.file?.asin || !r.amazon?.product?.asin) continue;
    const c = searchCards(id)?.find((x) => x.asin === r.amazon!.product!.asin);
    const p = c ? cardAsProduct(r, c, 'others-illustrate') : null;
    if (!p || !cardIdentified(r, p)) continue;
    books++;
    const dp = decideStage4(r as RefRecord);
    if (SCORED_FIELDS.every((f) => dp.auto[f])) dpAll++;
    const d = decideStage4({ ...r, amazon: { ...r.amazon, product: p } } as RefRecord);
    for (const f of SCORED_FIELDS)
      if (!d.auto[f]) {
        tally[f] ??= { card: 0, dpToo: 0 };
        tally[f].card++;
        if (!dp.auto[f]) tally[f].dpToo++;
      }
  }
  console.log(
    `\nFIELDS on ${books} identified cards (product page settles every field on ${dpAll}):`,
  );
  for (const [f, t] of Object.entries(tally))
    console.log(`  ${f}: unsettled with the card ${t.card}, also with the product page ${t.dpToo}`);
}
