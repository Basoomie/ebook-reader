/**
 * WP20d: today's result-changing changes, checked against the labeled books (2026-11-19).
 *
 *   npx tsx scripts/verify-stage4-today.ts <cleanup-reference dir> [--bw-only|--bm-only]
 *
 * Asks BookWalker and Bookmeter directly (1 request a second each; neither is capped) for the
 * 800 labeled books, as the live run now asks them, and scores with today's rules:
 *
 * 1. BookWalker's simpler query (6f3b4e16): for every labeled book whose BookWalker search finds
 *    nothing and that has a simpler query, the new page is added and stage 4's rules decide again
 *    (with BookWalker standing in where it settles the book, as live). Every scored field,
 *    before and after, against the labels: share right when filled, share filled.
 * 2. Bookmeter's plain index (00fae91b): every labeled book's search with type=japanese, the
 *    match accepted by today's rule against the book's decided title and authors, and the
 *    accepted book checked against the labels (title, an author, volume). A wrong match would
 *    put a wrong ISBN and store links on the book.
 */
import fs from 'fs';
import path from 'path';
import { bookwalkerRetryQuery } from '../src/cleanup/stage4/analysis';
import { bwAsAmazon, bwSettles } from '../src/cleanup/stage4/bw-standin';
import { parseBwDetail, parseBwList } from '../src/cleanup/stage4/parse';
import { nums, pickByVolume, pyQuote, queryTitle } from '../src/cleanup/stage4/pick';
import { clean, type RefRecord } from '../src/cleanup/stage4/rules-v3';
import {
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  type ScoredField,
  type Stage4Gold,
} from '../src/cleanup/stage4/score';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import {
  acceptBookmeter,
  bookmeterSearchUrl,
  parseBookmeterSearch,
} from '../src/cleanup/stage4/store-links';
import { N, NA } from '../src/cleanup/title-rules';

const refDir = process.argv[2];
const bwOnly = process.argv.includes('--bw-only');
const bmOnly = process.argv.includes('--bm-only');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
type Rec = RefRecord & Record<string, any>;
const rec = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as Rec;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string): Promise<{ status: number; body: Buffer }> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.5' },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    } catch {
      await sleep(5000);
    }
  }
  return { status: 0, body: Buffer.alloc(0) };
}
/** Today's production decision for a record (BookWalker stands in where it settles the book). */
function decide(r: Rec) {
  const x = bwSettles(r) ? { ...r, amazon: bwAsAmazon(r) ?? {} } : r;
  return decideStage4(x as RefRecord);
}
const title = (r: Rec) => (r.file?.opf_title || r.calibre?.cal_title) as string;

async function bookwalkerPart() {
  const before = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  const after = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  let tried = 0;
  let found = 0;
  const changes: string[] = [];
  for (const [id, g] of Object.entries(gold)) {
    const r = rec(id);
    const grp = g.sample === 'D' ? 'D' : 'ABC';
    const d0 = decide(r);
    addScore(before[grp], id, d0.values as any, d0.auto, g);
    let d1 = d0;
    const q = queryTitle(title(r));
    const retry = !r.bookwalker?.detail?.title ? bookwalkerRetryQuery(q) : null;
    if (retry) {
      const first = await get(`https://bookwalker.jp/search/?word=${pyQuote(q)}`);
      await sleep(1000);
      if (first.status === 404) {
        tried++;
        const s = await get(`https://bookwalker.jp/search/?word=${pyQuote(retry)}`);
        await sleep(1000);
        const items = s.status === 200 ? parseBwList(s.body) : [];
        const pick = pickByVolume(q, items.slice(0, 8), (r.file?.chars ?? 0) >= 5000);
        let detailUrl: string | null = null;
        let series: [string, string][] = [];
        if (pick && pick[0].includes('/series/')) {
          const l = await get(pick[0]);
          await sleep(1000);
          const vols = parseBwList(l.body).filter((v) => v[0].includes('/de'));
          series = vols.slice(0, 40);
          detailUrl = pickByVolume(q, vols, (r.file?.chars ?? 0) >= 5000)?.[0] ?? null;
        } else if (pick && pick[0].includes('/de')) detailUrl = pick[0];
        if (detailUrl) {
          const dp = await get(detailUrl);
          await sleep(1000);
          if (dp.status === 200) {
            found++;
            const r2 = {
              ...r,
              bookwalker: {
                detail: { ...parseBwDetail(dp.body), url: detailUrl },
                series_candidates: series,
              },
            } as Rec;
            d1 = decide(r2);
            for (const f of SCORED_FIELDS) {
              const a = JSON.stringify((d0.values as any)[f]) + (d0.auto[f] ? '' : ' (review)');
              const b = JSON.stringify((d1.values as any)[f]) + (d1.auto[f] ? '' : ' (review)');
              if (a !== b)
                changes.push(
                  `${id} ${q} ${f}: ${a} -> ${b}  [label ${JSON.stringify((g as any)[f])}]`,
                );
            }
          }
        }
      }
    }
    addScore(after[grp], id, d1.values as any, d1.auto, g);
  }
  console.log(
    `\nBOOKWALKER: ${tried} labeled books whose search found nothing and that have a simpler query; ${found} got a BookWalker page from it.`,
  );
  for (const grp of ['ABC', 'D']) {
    console.log(
      `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
        SCORED_FIELDS.map((f: ScoredField) => {
          const b = before[grp][f];
          const a = after[grp][f];
          return `${f} ${percent(a.right, a.auto)?.toFixed(1)}% right (was ${percent(b.right, b.auto)?.toFixed(1)}), filled ${a.auto} (was ${b.auto})`;
        }).join(' | '),
    );
  }
  for (const c of changes) console.log('   changed:', c);
}

async function bookmeterPart() {
  let asked = 0;
  let accepted = 0;
  let right = 0;
  const wrong: string[] = [];
  // Three books in flight (about 1.5 requests a second): the user wanted the answer fast.
  const entries = Object.entries(gold);
  let next = 0;
  const one = async (): Promise<void> => {
    while (next < entries.length) {
      const [id, g] = entries[next++];
      const r = rec(id);
      const q = queryTitle(title(r));
      const s = await get(bookmeterSearchUrl(q));
      await sleep(1000);
      asked++;
      const hits = s.status === 200 ? parseBookmeterSearch(s.body) : [];
      const d = decide(r);
      const acc = acceptBookmeter(hits, {
        title: d.values.t as string,
        authors: d.values.au as string[],
      });
      if (!acc.hit) continue;
      accepted++;
      const h = acc.hit;
      const gAu = (Array.isArray(g.au) ? g.au : [g.au]).map((a) => NA(a));
      const titleOk = N(clean(h.title)) === N(clean(g.t));
      const authorOk = gAu.length === 0 || h.authors.some((a) => gAu.includes(NA(a)));
      const gv = g.ix === null || g.ix === '?' ? null : Number(g.ix);
      const hv = [...nums(h.title)];
      const volOk = gv === null ? true : hv.includes(gv);
      if (titleOk && authorOk && volOk) right++;
      else
        wrong.push(
          `${id} label "${g.t}" / ${JSON.stringify(g.au)} / vol ${g.ix}  <- Bookmeter ${h.id} "${h.title}" / ${h.authors.join(',')}  [${titleOk ? '' : 'title '}${authorOk ? '' : 'author '}${volOk ? '' : 'volume'}]`,
        );
      if (asked % 100 === 0)
        console.log(`  … ${asked} asked, ${accepted} accepted, ${right} right`);
    }
  };
  await Promise.all([one(), one(), one()]);
  console.log(
    `\nBOOKMETER (plain index): ${asked} labeled books asked, ${accepted} matched by today's rule, ${right} of those are the labeled book (title, an author, volume).`,
  );
  for (const w of wrong) console.log('   not the labeled book?', w);
}

(async () => {
  await Promise.all([bmOnly ? null : bookwalkerPart(), bwOnly ? null : bookmeterPart()]);
})();
