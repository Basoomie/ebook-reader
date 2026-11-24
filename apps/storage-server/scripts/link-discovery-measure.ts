/**
 * Link discovery, measuring only: two candidate ways to save more direct links, run on the rows
 * of link-discovery-extract.ts and judged on the labeled books. Nothing is fetched or written.
 *
 * Option 1, "held-back records": the Amazon / RanobeDB / BOOK☆WALKER record stage 4 picked for the
 * book, accepted when its title, an author and the volume agree with the book (the rules the
 * user chose for Bookmeter, CHOSEN_RULES), against stage 4's decided values (D), Calibre's
 * current values (C), or both (CD).
 * Option 2, "series neighbours": an entry of a stored list (RanobeDB's series list, BOOK☆WALKER's
 * series list, Amazon's search results) that holds the saved id of another book of the same
 * Calibre series, accepted when exactly one entry has the book's title and volume.
 *
 *   npx ts-node --transpile-only scripts/link-discovery-measure.ts --books <books.jsonl>
 *     --gold <gold800.json> --out <folder>
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadGold } from '../src/cleanup/stage2-gate';
import {
  CHOSEN_RULES,
  failedWith,
  judge,
  makeRules,
  type BookRow,
  type Check,
  type Gold,
  type Hit,
} from '../src/cleanup/stage4/bookmeter-rules';
import { amazonSaysManga } from '../src/cleanup/stage4/stage4-rules';
import { editionNotes } from '../src/cleanup/stage4/store-links';
import { N, NA, nfkc } from '../src/cleanup/title-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

type Site = 'amazon' | 'ranobedb' | 'bookwalker';
const SITES: Site[] = ['amazon', 'ranobedb', 'bookwalker'];
const KEY: Record<Site, string> = {
  amazon: 'amazon_jp',
  ranobedb: 'ranobedb',
  bookwalker: 'bookwalker',
};
const LINK_KEYS = [
  'amazon_jp',
  'bookwalker',
  'bookmeter',
  'ranobedb',
  'natively',
  'rakuten',
  'honto',
  'ebookjapan',
  'unext',
];

interface Row {
  uuid: string;
  cid: number;
  gid: string | null;
  t: string;
  au: string[];
  se: string | null;
  ix: number | null;
  kind: string | null;
  fmt: string | null;
  auto: Record<string, boolean>;
  accepted: boolean;
  amazonIdentified: boolean;
  ranobedbIdentified: boolean;
  amazonRejected: string | null;
  bwTitleAgrees: boolean;
  cal: {
    title: string;
    authors: string[];
    series: string | null;
    index: number | null;
    ids: Record<string, string>;
  };
  opfTitle: string | null;
  own: string[];
  amazon: {
    id: string;
    title: string;
    authors: string[];
    roles: string[];
    breadcrumbs: string[];
  } | null;
  amazonList: [string, string][];
  ranobedb: { id: string; title: string; authors: string[]; isbn13: string[] } | null;
  ranobedbList: [string, string, string][];
  bookwalker: { id: string; title: string; keywords: string } | null;
  bookwalkerList: [string, string][];
}

const rules = makeRules(CHOSEN_RULES);
const ILLUSTRATOR = /イラスト|絵|画|illust/iu;

function bookRow(r: Row, which: 'D' | 'C'): BookRow {
  const base = {
    uuid: r.uuid,
    cid: r.cid,
    gid: r.gid,
    kind: r.kind,
    fmt: r.fmt,
    opfTitle: r.opfTitle,
    hits: [],
    searched: true,
    stored: null,
    base: null,
    stores: null,
    searchFile: null,
  };
  return which === 'D'
    ? { ...base, t: r.t, au: r.au, se: r.se, ix: r.ix, calTitle: r.cal.title }
    : {
        ...base,
        t: r.cal.title,
        au: r.cal.authors,
        se: r.cal.series,
        ix: r.cal.index,
        // The volume guard for Calibre's values: the file's own title, where it has one.
        calTitle: r.cal.title,
      };
}

/**
 * An edition word anywhere in a store title (＜特別版＞, [改版], 新装版: not only in 【…】) that none
 * of the book's own texts has = another edition (found on the labeled books: 29243, 60667).
 */
const EDITION_WORD =
  /特別版|新装版|特装版|完全版|増補|改訂|改版|大活字|合本|総集編|愛蔵版|復刻|決定版|無料|試し読み|お試し|分冊|単話/gu;
const TIGHT = !process.argv.includes('--loose');
const edOk = (r: Row, title: string) =>
  !editionNotes(title).some((x) => !r.own.some((t) => t.includes(x))) &&
  (!TIGHT ||
    ![...nfkc(title).matchAll(EDITION_WORD)].some((m) => !r.own.some((t) => t.includes(m[0]))));
const BW_MANGA = /マンガ|コミック|COMIC/iu;

/** The picked record of a site as a search result. */
function hitOf(r: Row, site: Site): Hit | null {
  if (site === 'amazon' && r.amazon) {
    const authors = r.amazon.authors.filter((_, i) => !ILLUSTRATOR.test(r.amazon!.roles[i] ?? ''));
    return {
      id: r.amazon.id,
      title: r.amazon.title,
      authors: authors.length ? authors : r.amazon.authors,
      pages: null,
      edOk: edOk(r, r.amazon.title),
    };
  }
  if (site === 'ranobedb' && r.ranobedb)
    return {
      id: r.ranobedb.id,
      title: r.ranobedb.title,
      authors: r.ranobedb.authors,
      pages: null,
      edOk: edOk(r, r.ranobedb.title),
    };
  if (site === 'bookwalker' && r.bookwalker)
    return {
      id: r.bookwalker.id,
      title: r.bookwalker.title,
      authors: r.bookwalker.keywords.split(/[,、]/u).map((s) => s.trim()),
      pages: null,
      edOk: edOk(r, r.bookwalker.title),
    };
  return null;
}

/** The checks the picked record fails against the book (option 1). */
function failed1(r: Row, site: Site, which: 'D' | 'C'): Check[] | null {
  const h = hitOf(r, site);
  if (!h) return null;
  const b = bookRow(r, which);
  if (!(N(b.t) ?? '')) return ['title'];
  const f = failedWith(rules, b, h);
  if (
    site === 'amazon' &&
    r.fmt !== 'manga' &&
    r.fmt !== 'image-only' &&
    (r.amazonRejected || amazonSaysManga(r.amazon!.breadcrumbs)) &&
    !f.includes('edition')
  )
    f.push('edition');
  if (TIGHT && !f.includes('edition')) {
    // Amazon: only the Kindle page (a print page's id is its ISBN-10).
    if (site === 'amazon' && !/^B0/.test(h.id)) f.push('edition');
    // BOOK☆WALKER: a page filed under manga only for a book decided as manga or image-only.
    if (
      site === 'bookwalker' &&
      r.fmt !== 'manga' &&
      r.fmt !== 'image-only' &&
      BW_MANGA.test(r.bookwalker!.keywords)
    )
      f.push('edition');
  }
  return f;
}

/** What today's code saves for the site. */
function today(r: Row, site: Site): boolean {
  if (site === 'amazon') return r.amazonIdentified && r.accepted;
  if (site === 'ranobedb') return r.ranobedbIdentified && r.accepted;
  return r.accepted && r.bwTitleAgrees;
}

async function main() {
  const outDir = arg('out')!;
  fs.mkdirSync(outDir, { recursive: true });
  const { gold } = loadGold(arg('gold')!);
  const rows: Row[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(arg('books')!) });
  for await (const line of rl) if (line) rows.push(JSON.parse(line) as Row);
  console.error(`${rows.length} books`);

  // Every id Calibre holds, per key: an id is never given to a second book.
  const taken: Record<string, Map<string, string>> = {};
  for (const site of SITES) taken[KEY[site]] = new Map();
  for (const r of rows)
    for (const site of SITES) {
      const v = r.cal.ids[KEY[site]];
      if (v) taken[KEY[site]].set(v, r.uuid);
    }

  const bySeries = new Map<string, Row[]>();
  for (const r of rows) {
    const k = N(r.cal.series) ?? '';
    if (!k) continue;
    let g = bySeries.get(k);
    if (!g) bySeries.set(k, (g = []));
    g.push(r);
  }

  const report: Record<string, unknown> = {};
  const examples: string[] = [];
  const flaggedOut: unknown[] = [];
  const gains = new Map<string, Record<string, { id: string; how: string }>>();
  const addGain = (uuid: string, key: string, id: string, how: string) => {
    let g = gains.get(uuid);
    if (!g) gains.set(uuid, (g = {}));
    g[key] ??= { id, how };
  };

  // ------------------------------------------------------------ option 1
  for (const site of SITES) {
    const key = KEY[site];
    const s = {
      withRecord: 0,
      saved: 0,
      savedSame: 0,
      savedOther: 0,
      missing: 0,
      todayWouldSave: 0,
      heldBackWhy: {} as Record<string, number>,
      failedChecks: { D: {} as Record<string, number>, C: {} as Record<string, number> },
      variants: {} as Record<
        string,
        {
          gained: number;
          takenElsewhere: number;
          twoBooksOneRecord: number;
          labeledGained: number;
          labeledOk: number;
          labeledFlagged: number;
          // Every labeled book with a record the variant accepts (saved or not).
          labeledAll: number;
          labeledAllOk: number;
          labeledAllFlagged: number;
          // Among books with another saved id for the key: would the variant have chosen it?
          agreesWithSaved: number;
          differsFromSaved: number;
        }
      >,
    };
    const variants: Record<string, (r: Row) => boolean> = {
      D: (r) => failed1(r, site, 'D')!.length === 0,
      C: (r) => failed1(r, site, 'C')!.length === 0,
      CD: (r) => failed1(r, site, 'C')!.length === 0 && failed1(r, site, 'D')!.length === 0,
    };
    for (const v of Object.keys(variants))
      s.variants[v] = {
        gained: 0,
        takenElsewhere: 0,
        twoBooksOneRecord: 0,
        labeledGained: 0,
        labeledOk: 0,
        labeledFlagged: 0,
        labeledAll: 0,
        labeledAllOk: 0,
        labeledAllFlagged: 0,
        agreesWithSaved: 0,
        differsFromSaved: 0,
      };
    const claimed: Record<string, Map<string, number>> = {
      D: new Map(),
      C: new Map(),
      CD: new Map(),
    };
    for (const r of rows) {
      const h = hitOf(r, site);
      if (!h) continue;
      s.withRecord++;
      const have = r.cal.ids[key];
      if (have) {
        s.saved++;
        if (have === h.id) s.savedSame++;
        else s.savedOther++;
      } else {
        s.missing++;
        if (today(r, site)) s.todayWouldSave++;
        else {
          const why =
            site === 'bookwalker'
              ? !r.bwTitleAgrees
                ? 'title differs from the decided title'
                : 'rules not sure'
              : (site === 'amazon' ? !r.amazonIdentified : !r.ranobedbIdentified)
                ? 'record not identified by the rules'
                : 'rules not sure';
          const detail =
            why === 'rules not sure'
              ? 'rules not sure of: ' +
                ['t', 'au', 'fmt', 'ix']
                  .filter((k) => !r.auto[k] && !(k === 'ix' && r.se === null))
                  .join('+')
              : why;
          s.heldBackWhy[detail] = (s.heldBackWhy[detail] ?? 0) + 1;
        }
        for (const w of ['D', 'C'] as const) {
          const f = failed1(r, site, w)!;
          const k = f.length ? f.join('+') : 'passes';
          s.failedChecks[w][k] = (s.failedChecks[w][k] ?? 0) + 1;
        }
      }
      for (const [name, pass] of Object.entries(variants)) {
        if (!pass(r)) continue;
        const st = s.variants[name];
        const g = r.gid ? (gold?.[r.gid] as Gold | undefined) : undefined;
        const j = g ? judge(h, g) : null;
        // BOOK☆WALKER's author is only in its keywords: the label's author is looked for there.
        if (j && site === 'bookwalker' && j.why.includes('author')) {
          const kw = NA(r.bookwalker!.keywords);
          const gau = (Array.isArray(g!.au) ? g!.au : [g!.au]).filter(
            (x): x is string => typeof x === 'string',
          );
          if (gau.some((x) => x !== '?' && kw.includes(NA(x)))) {
            j.why = j.why.filter((x) => x !== 'author');
            j.ok = j.why.length === 0;
          }
        }
        if (j) {
          st.labeledAll++;
          if (j.ok) st.labeledAllOk++;
          else {
            st.labeledAllFlagged++;
            if (name === 'CD' && have)
              flaggedOut.push({
                option: 1,
                site,
                variant: 'CD(saved)',
                gid: r.gid,
                why: j.why,
                gold: { t: g!.t, au: g!.au, se: g!.se, ix: g!.ix, alt_t: g!.alt_t },
                calibre: r.cal.title,
                decided: r.t,
                record: { id: h.id, title: h.title, authors: h.authors.slice(0, 6) },
              });
          }
        }
        if (have) {
          if (have === h.id) st.agreesWithSaved++;
          else {
            st.differsFromSaved++;
            if (name === 'CD')
              examples.push(
                `- option 1 vs saved (${site}): ${r.cal.title} | saved ${have} | record ${h.id} ${h.title}`,
              );
          }
          continue;
        }
        if (taken[key].has(h.id)) {
          st.takenElsewhere++;
          continue;
        }
        claimed[name].set(h.id, (claimed[name].get(h.id) ?? 0) + 1);
        st.gained++;
        if (name === 'CD') addGain(r.uuid, key, h.id, 'record');
        if (j) {
          st.labeledGained++;
          if (j.ok) st.labeledOk++;
          else {
            st.labeledFlagged++;
            flaggedOut.push({
              option: 1,
              site,
              variant: name,
              gid: r.gid,
              why: j.why,
              gold: { t: g!.t, au: g!.au, se: g!.se, ix: g!.ix, alt_t: g!.alt_t },
              calibre: r.cal.title,
              decided: r.t,
              record: { id: h.id, title: h.title, authors: h.authors.slice(0, 6) },
            });
          }
        }
      }
    }
    for (const name of Object.keys(variants))
      s.variants[name].twoBooksOneRecord = [...claimed[name].values()].filter((n) => n > 1).length;
    report[`option1:${site}`] = s;
  }

  // ------------------------------------------------------------ option 2
  const listOf = (r: Row, site: Site): [string, string][] =>
    site === 'amazon'
      ? r.amazonList
      : site === 'ranobedb'
        ? r.ranobedbList.map((x) => [x[0], x[1]] as [string, string])
        : r.bookwalkerList;
  const authorKeys = (r: Row) => new Set(r.cal.authors.map((x) => NA(x)));
  for (const site of SITES) {
    const key = KEY[site];
    const s = {
      missingInSeries: 0,
      seriesHasAnchor: 0,
      gained: 0,
      severalEntries: 0,
      noEntry: 0,
      twoBooksOneEntry: 0,
      agreesWithOption1: 0,
      differsFromOption1: 0,
      newBeyondOption1: 0,
      labeledGained: 0,
      labeledOk: 0,
      labeledFlagged: 0,
      // The same rule run for books that have a saved id: does it find that id?
      checkSaved: 0,
      checkSame: 0,
      checkOther: 0,
      checkNone: 0,
    };
    const claims = new Map<string, string[]>();
    const picks: { r: Row; id: string; title: string }[] = [];
    for (const group of bySeries.values()) {
      if (group.length < 2) continue;
      // The lists of the series' books that hold a saved id of one of its books.
      const anchors = new Map<string, Row>();
      for (const r of group) if (r.cal.ids[key]) anchors.set(r.cal.ids[key], r);
      if (!anchors.size) {
        for (const r of group) if (!r.cal.ids[key]) s.missingInSeries++;
        continue;
      }
      const entries = new Map<string, { title: string; anchorAuthors: Set<string> }>();
      for (const r of group) {
        const list = listOf(r, site).filter(
          ([id]) => !TIGHT || site !== 'amazon' || /^B0/.test(id),
        );
        const hit = list.find(([id]) => anchors.has(id));
        if (!hit) continue;
        // The list must hold the saved ids of at least half of the series' books that have one
        // (a list of the manga or of another edition holds few of them).
        const held = new Set(list.map(([id]) => id).filter((id) => anchors.has(id))).size;
        if (TIGHT && site !== 'amazon' && held * 2 < anchors.size) continue;
        const anchorAuthors = authorKeys(anchors.get(hit[0])!);
        for (const [id, title] of list)
          if (!entries.has(id)) entries.set(id, { title, anchorAuthors });
      }
      for (const r of group) {
        const have = r.cal.ids[key];
        if (!have) {
          s.missingInSeries++;
          s.seriesHasAnchor++;
        }
        const b = bookRow(r, 'C');
        if (!(N(b.t) ?? '')) continue;
        const mine = authorKeys(r);
        const pass: { id: string; title: string }[] = [];
        for (const [id, e] of entries) {
          // For the check on saved ids the book's own id must not be the anchor's free pass.
          if (![...e.anchorAuthors].some((x) => mine.has(x))) continue;
          if (!have && taken[key].has(id)) continue;
          if (have && taken[key].get(id) !== undefined && taken[key].get(id) !== r.uuid) continue;
          const h: Hit = { id, title: e.title, authors: [], pages: null, edOk: edOk(r, e.title) };
          const f = failedWith(rules, b, h).filter((x) => x !== 'author');
          if (f.length === 0) pass.push({ id, title: e.title });
        }
        if (have) {
          // Only where another book's id is the anchor (the book's own id proves nothing).
          if (![...anchors.keys()].some((id) => id !== have)) continue;
          s.checkSaved++;
          if (pass.length !== 1) s.checkNone++;
          else if (pass[0].id === have) s.checkSame++;
          else {
            s.checkOther++;
            const savedTitle =
              [...entries].find(([id]) => id === have)?.[1].title ?? '(not in the lists)';
            examples.push(
              `- option 2 vs saved (${site}): ${r.cal.title} | saved ${have} ${savedTitle} | picked ${pass[0].id} ${pass[0].title}`,
            );
          }
          continue;
        }
        if (pass.length === 0) {
          s.noEntry++;
          continue;
        }
        if (pass.length > 1) {
          s.severalEntries++;
          continue;
        }
        picks.push({ r, id: pass[0].id, title: pass[0].title });
        const c = claims.get(pass[0].id) ?? [];
        c.push(r.uuid);
        claims.set(pass[0].id, c);
      }
    }
    for (const pk of picks) {
      if ((claims.get(pk.id) ?? []).length > 1) {
        s.twoBooksOneEntry++;
        continue;
      }
      s.gained++;
      const o1 = gains.get(pk.r.uuid)?.[key];
      if (o1?.how === 'record') {
        if (o1.id === pk.id) s.agreesWithOption1++;
        else {
          s.differsFromOption1++;
          examples.push(
            `- option 1 and 2 differ (${site}): ${pk.r.cal.title} | 1: ${o1.id} | 2: ${pk.id} ${pk.title}`,
          );
        }
      } else {
        s.newBeyondOption1++;
        addGain(pk.r.uuid, key, pk.id, 'series');
      }
      const g = pk.r.gid ? (gold?.[pk.r.gid] as Gold | undefined) : undefined;
      if (g) {
        const j = judge({ id: pk.id, title: pk.title, authors: [], pages: null, edOk: true }, g);
        const why = j.why.filter((x) => x !== 'author');
        s.labeledGained++;
        if (why.length === 0) s.labeledOk++;
        else {
          s.labeledFlagged++;
          flaggedOut.push({
            option: 2,
            site,
            gid: pk.r.gid,
            why,
            gold: { t: g.t, au: g.au, se: g.se, ix: g.ix, alt_t: g.alt_t },
            calibre: pk.r.cal.title,
            record: { id: pk.id, title: pk.title },
          });
        }
      }
    }
    report[`option2:${site}`] = s;
  }

  // ------------------------------------------------------------ together
  const noLink = rows.filter((r) => !LINK_KEYS.some((k) => r.cal.ids[k]));
  const total = {
    books: rows.length,
    labeled: rows.filter((r) => r.gid).length,
    noDirectLink: noLink.length,
    noDirectLinkGainingOne: noLink.filter((r) => gains.has(r.uuid)).length,
    booksGainingAny: gains.size,
    idsGained: { amazon_jp: 0, ranobedb: 0, bookwalker: 0 } as Record<string, number>,
    idsGainedBy: { record: 0, series: 0 } as Record<string, number>,
  };
  for (const g of gains.values())
    for (const [k, v] of Object.entries(g)) {
      total.idsGained[k]++;
      total.idsGainedBy[v.how]++;
    }
  report.together = total;

  // A blind sample of unlabeled gains for a look by eye (a fixed order: by uuid hash-like sort).
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  const sample: unknown[] = [];
  const unl = [...gains.entries()]
    .filter(([u]) => !byUuid.get(u)!.gid)
    .sort((x, y) => x[0].slice(-12).localeCompare(y[0].slice(-12)));
  const per: Record<string, number> = {};
  for (const [u, g] of unl) {
    const r = byUuid.get(u)!;
    for (const [k, v] of Object.entries(g)) {
      const slot = `${k}:${v.how}`;
      if ((per[slot] ?? 0) >= 25) continue;
      per[slot] = (per[slot] ?? 0) + 1;
      const site = SITES.find((x) => KEY[x] === k)!;
      const title =
        v.how === 'record'
          ? hitOf(r, site)!.title
          : (() => {
              for (const o of bySeries.get(N(r.cal.series) ?? '') ?? [])
                for (const [id, t] of listOf(o, site)) if (id === v.id) return t;
              return '';
            })();
      sample.push({
        slot,
        cid: r.cid,
        calibre: `${r.cal.title} / ${r.cal.authors.join(', ')} / ${r.cal.series ?? '-'} #${r.cal.index ?? '-'}`,
        file: r.opfTitle,
        id: v.id,
        record: title,
        recordAuthors: v.how === 'record' ? hitOf(r, site)!.authors.slice(0, 5) : undefined,
      });
    }
  }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'flagged.json'), JSON.stringify(flaggedOut, null, 1));
  fs.writeFileSync(path.join(outDir, 'sample.json'), JSON.stringify(sample, null, 1));
  fs.writeFileSync(path.join(outDir, 'notes.md'), examples.join('\n'));
  fs.writeFileSync(
    path.join(outDir, 'gains.jsonl'),
    [...gains.entries()]
      .map(([u, g]) => JSON.stringify({ uuid: u, cid: byUuid.get(u)!.cid, g }))
      .join('\n'),
  );
  console.log(JSON.stringify(report, null, 1));
  void nfkc;
}

void main();
