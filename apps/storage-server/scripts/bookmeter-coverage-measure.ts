/**
 * More Bookmeter coverage, step 1 (measuring only): each candidate rule change alone and
 * combined, on books.jsonl from bookmeter-coverage-extract.ts (stage 4's decided values and the
 * stored search answers, with the whole titles from the cached pages). For each candidate:
 * books gained library-wide, books whose accepted hit would change, the labeled books' new or
 * changed matches judged against their labels (flags listed for a look by eye), the store-list
 * requests the gained books need (an id already fetched needs none) and their time at
 * Bookmeter's pace. Reads only.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-measure.ts --in books.jsonl
 *     --gold gold800.json --db <copy/cleanup.db> --out report.json [--pace 5]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import {
  COMIC_LABEL,
  acceptWith,
  closestWith,
  groupName,
  judge,
  makeRules,
  type BookRow,
  type Gold,
  type Hit,
  type Options,
} from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const books = fs
  .readFileSync(arg('in')!, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BookRow);
const gold = JSON.parse(fs.readFileSync(arg('gold')!, 'utf8')) as Record<string, Gold>;
const pace = Number(arg('pace') ?? 5);

// Store lists already fetched (a newly accepted id among them needs no request).
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const fetched = new Set(
  (
    db
      .prepare(
        `SELECT key FROM fetch_requests WHERE site = 'bookmeter' AND key LIKE 'stores:%' AND state = 'done'`,
      )
      .all() as { key: string }[]
  ).map((r) => r.key.slice('stores:'.length)),
);

const F: Options = { full: true };
const FP: Options = { full: true, paren: true };
const candidates: [string, Options][] = [
  ['base (today)', {}],
  // One at a time on today's rule.
  ['full titles (cover alt text)', F],
  ['labels/brackets dropped', { paren: true }],
  ['subtitle-tolerant title', { sub: true }],
  ['series name in front', { front: true }],
  ['authors split, roles dropped', { authSplit: true }],
  ['・ = ignored in names', { authDot: true }],
  ['old/new kanji in names', { authKanji: true }],
  ['volume from cleaned titles', { volClean: true }],
  ['volume from series position too', { volIx: true }],
  // On top of the whole titles and dropped brackets (the parser fix the others need).
  ['F+P', FP],
  ['F+P + subtitle', { ...FP, sub: true }],
  ['F+P + series in front', { ...FP, front: true }],
  ['F+P + authors split', { ...FP, authSplit: true }],
  ['F+P + ・ in names', { ...FP, authDot: true }],
  ['F+P + kanji forms', { ...FP, authKanji: true }],
  ['F+P + volume cleaned', { ...FP, volClean: true }],
  ['F+P + series position', { ...FP, volIx: true }],
  [
    'F+P + names (split, ・, kanji) + volume cleaned',
    { ...FP, authSplit: true, authDot: true, authKanji: true, volClean: true },
  ],
  // Today's matches kept; only books without one gain (the rows below).
  ['KEEP F+P', { ...FP, keep: true }],
  ['KEEP F+P + names', { ...FP, authSplit: true, authDot: true, authKanji: true, keep: true }],
  [
    'KEEP F+P + names + volume cleaned',
    { ...FP, authSplit: true, authDot: true, authKanji: true, volClean: true, keep: true },
  ],
  [
    'KEEP F+P + names + volume cleaned + comic format guard',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      keep: true,
    },
  ],
  [
    'KEEP R = F+P + names + volume cleaned + comic format guard + volume guard',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      volGuard: true,
      keep: true,
    },
  ],
  [
    'KEEP R + series position',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      volGuard: true,
      volIx: true,
      keep: true,
    },
  ],
  [
    'KEEP R + series in front',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      volGuard: true,
      front: true,
      keep: true,
    },
  ],
  [
    'KEEP R + series after the title',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      volGuard: true,
      seriesTail: true,
      keep: true,
    },
  ],
  [
    'KEEP R + subtitle',
    {
      ...FP,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      comicFmt: true,
      volGuard: true,
      sub: true,
      keep: true,
    },
  ],
  [
    'all',
    {
      ...FP,
      sub: true,
      front: true,
      authSplit: true,
      authDot: true,
      authKanji: true,
      volClean: true,
      volIx: true,
    },
  ],
];
const extra = arg('only');

interface Row {
  name: string;
  options: Options;
  accepted: number;
  gained: number;
  changed: number;
  lost: number;
  labeled: { gained: number; changed: number; lost: number; ok: number; flagged: number };
  flags: unknown[];
  requests: number;
  hours: number;
  sample: unknown[];
  residual: Record<string, number>;
  residualLabeled: Record<string, number>;
  gainedByKind: Record<string, number>;
  gainedComic: number;
  changedRows: unknown[];
}

const show = (h: Hit | null) =>
  h ? `${h.id} ${h.full ?? h.title} / ${h.authors.join(', ')}` : null;
const report: Row[] = [];
for (const [name, o] of candidates) {
  if (extra && !name.includes(extra)) continue;
  const r = makeRules(o);
  const row: Row = {
    name,
    options: o,
    accepted: 0,
    gained: 0,
    changed: 0,
    lost: 0,
    labeled: { gained: 0, changed: 0, lost: 0, ok: 0, flagged: 0 },
    flags: [],
    requests: 0,
    hours: 0,
    sample: [],
    residual: {},
    residualLabeled: {},
    gainedByKind: {},
    gainedComic: 0,
    changedRows: [],
  };
  const ids = new Set<string>();
  const gainedRows: unknown[] = [];
  for (const b of books) {
    if (!b.hits.length) continue;
    // keep: a book that matches today keeps its match.
    const h = o.keep && b.base ? (b.hits.find((x) => x.id === b.base) ?? null) : acceptWith(r, b);
    if (h) row.accepted++;
    const before = b.base;
    const now = h?.id ?? null;
    if (!h) {
      const c = closestWith(r, b, o)!;
      const g = groupName(c.failed);
      row.residual[g] = (row.residual[g] ?? 0) + 1;
      if (b.gid) row.residualLabeled[g] = (row.residualLabeled[g] ?? 0) + 1;
    }
    if (before === now) continue;
    const kind = before === null ? 'gained' : now === null ? 'lost' : 'changed';
    row[kind]++;
    if (now && !fetched.has(now)) ids.add(now);
    const entry = {
      cid: b.cid,
      gid: b.gid,
      book: `${b.t} / ${b.au.join(', ')}${b.se ? ` [${b.se} ${b.ix ?? ''}]` : ''}`,
      before: show(b.hits.find((x) => x.id === before) ?? null),
      now: show(h),
    };
    if (kind === 'gained') {
      gainedRows.push(entry);
      row.gainedByKind[b.kind ?? '?'] = (row.gainedByKind[b.kind ?? '?'] ?? 0) + 1;
      if (h && COMIC_LABEL.test(h.full ?? h.title)) row.gainedComic++;
    }
    if (kind === 'changed') row.changedRows.push(entry);
    if (b.gid) {
      row.labeled[kind]++;
      if (h) {
        const j = judge(h, gold[b.gid]);
        if (j.ok) row.labeled.ok++;
        else {
          row.labeled.flagged++;
          row.flags.push({
            ...entry,
            kind,
            why: j.why.join('+'),
            label: `${gold[b.gid].t} / ${[gold[b.gid].au].flat().join(', ')} [${gold[b.gid].se ?? ''} ${gold[b.gid].ix ?? ''}]`,
          });
        }
      } else row.flags.push({ ...entry, kind, why: 'lost' });
    }
  }
  {
    const rc = mulberry32(7);
    const pc = [...row.changedRows];
    row.changedRows = [];
    for (let i = 0; i < Math.min(30, pc.length); i++)
      row.changedRows.push(pc.splice(Math.floor(rc() * pc.length), 1)[0]);
  }
  row.requests = ids.size;
  row.hours = Math.round(((ids.size * pace) / 3600) * 10) / 10;
  const rand = mulberry32(20261123);
  const pool = [...gainedRows];
  for (let i = 0; i < Math.min(20, pool.length); i++)
    row.sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  report.push(row);
  console.log(
    `${name.padEnd(48)} kinds ${JSON.stringify(row.gainedByKind)} comic ${row.gainedComic} accepted ${row.accepted}  +${row.gained}  changed ${row.changed}  lost ${row.lost}  | labeled +${row.labeled.gained} ~${row.labeled.changed} -${row.labeled.lost} ok ${row.labeled.ok} flagged ${row.labeled.flagged} | requests ${row.requests} (${row.hours} h)`,
  );
}
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
