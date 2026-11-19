/**
 * Stage 4's match acceptance (WP21c, decided; the reference sample showed why). Pure.
 *
 * A store record matches a recording automatically only when all four agree:
 *   - the title (store prefixes, markers, imprints and kikubon's narrator brackets removed on
 *     both sides; then one contains the other or the character-pair share reaches the setting),
 *   - the author, when the recording's names or tags give one,
 *   - the printed volume (a drama CD needs its CD number on both sides unless the ASIN in the
 *     file name chose the record: the runtime never decides between CD1 and CD2),
 *   - the length, within the tolerance; a recording in several files may also match half or a
 *     third of its total (then its files may be copies: review, never automatic).
 * A narrator who differs from the file's tags sends the record to review (another edition or
 * translation, e.g. 源氏物語 若紫). The runtime alone picked 5 wrong books of 200 in the sample.
 */
import { norm, sim } from '../stage4/pick';
import { printedVolume } from './dup-names';
import type { StoreRecord } from './online-pages';
import { personKey, searchTitle } from './online-names';

export interface UnitFacts {
  /** The title searched for (from the torrent names). */
  title: string;
  /** Other names of the recording (the folder's, other copies'): a title may agree with any. */
  otherTitles: string[];
  authors: string[];
  narrators: string[];
  /** The printed volume from the names (`[4巻]`, `上`, a trailing number), or null. */
  volume: string | null;
  /** A drama CD and its number ("CD3", "ドラマCD3"), or null. */
  drama: { number: string | null } | null;
  seconds: number | null;
  /** Number of files (half and third lengths are tried only for several). */
  files: number;
}

export interface MatchSettings {
  runtimeMinutes: number;
  titleScore: number;
}

export type CheckName = 'title' | 'author' | 'volume' | 'runtime' | 'narrator';

export interface Check {
  ok: boolean;
  /** No value on one side: the check says nothing (passes). */
  unknown?: boolean;
  file: unknown;
  store: unknown;
  detail?: string;
}

export interface Evaluation {
  checks: Record<CheckName, Check>;
  /** Checks that failed, in the order above. */
  failed: CheckName[];
  /** The length matched only at a half or a third of a multi-file recording. */
  fraction: 1 | 2 | 3 | null;
  pass: boolean;
}

// ---------------------------------------------------------------------------------------------
// titles

/** Audible's title prefixes (`[17巻] `, `[5.5巻] `, `[CD9]`), store markers, brackets. */
export function storeTitle(t: string): string {
  let s = t.normalize('NFKC');
  s = s.replace(/^\s*\[[^\]]*\]\s*/, '');
  s = s.replace(/【[^】]*】/g, ' ');
  // kikubon: the narrators in brackets at the end, a series in ＜ ＞.
  s = s.replace(/[<＜][^>＞]*[>＞]/g, ' ');
  s = s.replace(/[（(][^()（）]*[)）]\s*$/, (m) => (/\d/.test(m) ? m : ' '));
  return s.replace(/\s+/g, ' ').trim();
}

/** The two titles name the same book (either contains the other, or the pair share is high). */
export function titlesAgree(
  file: string[],
  store: string,
  score: number,
): { ok: boolean; best: number } {
  const st = storeTitle(store);
  const sn = norm(st);
  let best = 0;
  for (const f of file) {
    // The same cleaning on both sides (a series in ＜ ＞, a reading in brackets: 卍（まんじ）).
    const ft = storeTitle(searchTitle(f));
    const fn = norm(ft);
    if (!fn || !sn) continue;
    if (fn === sn) return { ok: true, best: 1 };
    if (fn.length >= 2 && sn.length >= 2 && (sn.includes(fn) || fn.includes(sn))) {
      return { ok: true, best: 1 };
    }
    best = Math.max(best, sim(ft, st), sim(st, ft));
  }
  return { ok: best >= score, best: Math.round(best * 1000) / 1000 };
}

// ---------------------------------------------------------------------------------------------
// volumes

/** A drama CD's number in a name ("[CD7]", "ドラマCD3", "CD 2"), or null. */
export function dramaNumber(name: string): string | null {
  const s = name.normalize('NFKC');
  const m = /ドラマ\s*CD\s*(\d+)|\[CD\s*(\d+)\]|CD\s*(\d+)/i.exec(s);
  return m ? String(Number(m[1] ?? m[2] ?? m[3])) : null;
}

export function isDrama(name: string): boolean {
  return /ドラマ\s*CD|\[CD\d*\]/i.test(name.normalize('NFKC'));
}

/**
 * The volume marks a title prints: its numbers and 上/中/下 (full-width digits and kanji
 * numerals of a trailing volume as numbers).
 */
export function volumeMarks(t: string): Set<string> {
  const s = t.normalize('NFKC');
  const out = new Set<string>();
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  for (const m of s.matchAll(
    /(?:^|[\s・:：(（[\]【「『])(上|中|下)(?=$|[\s・:：)）[\]】」』巻]|編)/gu,
  ))
    out.add(m[1]);
  return out;
}

function sameVolume(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/** The store's printed volume: from its title, else from a series label ("5.5", "上"). */
export function storeVolumes(r: StoreRecord): string[] {
  const out: string[] = [];
  const t = printedVolume(storeTitle(r.title));
  if (t) out.push(t);
  // Audible's own prefix "[17巻]" / "[5.5巻]" says the printed volume too.
  const pre = /^\s*\[([\d.]+)巻/.exec(r.title.normalize('NFKC'));
  if (pre) out.push(String(Number(pre[1])));
  for (const s of r.series) {
    if (s.sequence) {
      const n = /^\s*([\d.]+)/.exec(s.sequence.normalize('NFKC'));
      out.push(n ? String(Number(n[1])) : s.sequence.trim());
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------
// people

/** Some name is the same on both sides (a one-character pen name like 岬 only exactly). */
function peopleAgree(file: string[], store: string[]): boolean {
  const fk = file.map(personKey).filter((x) => x !== '');
  const sk = store.map(personKey).filter((x) => x !== '');
  return fk.some((f) =>
    sk.some((s) => f === s || (f.length >= 2 && s.length >= 2 && (f.includes(s) || s.includes(f)))),
  );
}

// ---------------------------------------------------------------------------------------------

export function evaluate(
  unit: UnitFacts,
  r: StoreRecord,
  s: MatchSettings,
  opts: { viaNameAsin?: boolean } = {},
): Evaluation {
  const titles = [unit.title, ...unit.otherTitles];
  const t = titlesAgree(titles, r.title, s.titleScore);
  const checks = {} as Record<CheckName, Check>;
  checks.title = {
    ok: t.ok,
    file: unit.title,
    store: r.title,
    detail: t.ok ? undefined : `score ${t.best}`,
  };

  // Author: only when the recording names one (and the store lists any). Names written in
  // different scripts (Arthur Conan Doyle / アーサー・コナン・ドイル) can't be compared.
  const latin = (xs: string[]) =>
    xs.length > 0 &&
    xs.every((x) => !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(x));
  if (
    unit.authors.length === 0 ||
    r.authors.length === 0 ||
    latin(unit.authors) !== latin(r.authors)
  ) {
    checks.author = { ok: true, unknown: true, file: unit.authors, store: r.authors };
  } else {
    checks.author = {
      ok: peopleAgree(unit.authors, r.authors),
      file: unit.authors,
      store: r.authors,
    };
  }

  // Volume.
  const sv = storeVolumes(r);
  const titleVol = printedVolume(storeTitle(r.title));
  if (unit.drama) {
    const storeCd = dramaNumber(r.title) ?? r.series.find((x) => x.sequence)?.sequence ?? null;
    if (opts.viaNameAsin) {
      // The ASIN in the file's name chose this record: it decides (user, 2026-11-19).
      checks.volume = {
        ok: !(unit.drama.number && storeCd && !sameVolume(unit.drama.number, storeCd)),
        file: unit.drama.number,
        store: storeCd,
        detail: 'drama CD: the ASIN in the name decides',
      };
    } else {
      const ok = !!unit.drama.number && !!storeCd && sameVolume(unit.drama.number, storeCd);
      checks.volume = {
        ok,
        file: unit.drama.number,
        store: storeCd,
        detail: ok ? 'drama CD number' : 'drama CD: the number must be on both sides',
      };
    }
  } else if (unit.volume === null) {
    // Nothing printed in the file's name: the store's title must not print one either.
    checks.volume = {
      ok: titleVol === null,
      unknown: titleVol === null,
      file: null,
      store: titleVol,
      detail: titleVol === null ? undefined : 'the store title prints a volume the file name lacks',
    };
  } else {
    // The printed volume itself, or every mark the file's title prints is printed by the store
    // (title or series label) and the store's title prints nothing the file's lacks
    // ("ペテロの葬列 上： 杉村三郎シリーズ３" and "ペテロの葬列 上" in 杉村三郎シリーズ "3 上").
    let ok = sv.some((v) => sameVolume(v, unit.volume!));
    if (!ok) {
      const fileMarks = volumeMarks(unit.title);
      const titleMarks = volumeMarks(storeTitle(r.title));
      const allStore = new Set<string>([...titleMarks, ...sv.flatMap((v) => [...volumeMarks(v)])]);
      ok =
        fileMarks.size > 0 &&
        [...fileMarks].every((m) => allStore.has(m)) &&
        [...titleMarks].every((m) => fileMarks.has(m));
    }
    checks.volume = {
      ok,
      file: unit.volume,
      store: sv,
      detail: ok ? undefined : sv.length ? 'other volume' : 'the store prints no volume',
    };
  }

  // Runtime.
  let fraction: Evaluation['fraction'] = null;
  if (unit.seconds === null || r.seconds === null) {
    checks.runtime = { ok: false, file: unit.seconds, store: r.seconds, detail: 'length unknown' };
  } else {
    const tol = s.runtimeMinutes * 60;
    const tries: (1 | 2 | 3)[] = unit.files > 1 ? [1, 2, 3] : [1];
    for (const k of tries) {
      if (Math.abs(unit.seconds / k - r.seconds) <= tol) {
        fraction = k;
        break;
      }
    }
    const diffMin = Math.round(((r.seconds - unit.seconds) / 60) * 10) / 10;
    checks.runtime = {
      ok: fraction === 1,
      file: Math.round(unit.seconds),
      store: r.seconds,
      detail:
        fraction === 1
          ? `${diffMin >= 0 ? '+' : ''}${diffMin} min`
          : fraction
            ? `matches 1/${fraction} of the files' total length`
            : `store ${diffMin >= 0 ? '+' : ''}${diffMin} min`,
    };
  }

  // Narrator: only when the file's tags name one.
  if (unit.narrators.length === 0 || r.narrators.length === 0) {
    checks.narrator = { ok: true, unknown: true, file: unit.narrators, store: r.narrators };
  } else {
    checks.narrator = {
      ok: peopleAgree(unit.narrators, r.narrators),
      file: unit.narrators,
      store: r.narrators,
    };
  }

  const order: CheckName[] = ['title', 'author', 'volume', 'runtime', 'narrator'];
  const failed = order.filter((c) => !checks[c].ok);
  return { checks, failed, fraction, pass: failed.length === 0 };
}

/** Pre-check of a search hit (before its full record is read): title and length. */
export function hitWorthReading(
  unit: UnitFacts,
  hit: { title: string; seconds: number | null },
  s: MatchSettings,
): boolean {
  if (!titlesAgree([unit.title, ...unit.otherTitles], hit.title, s.titleScore).ok) return false;
  if (hit.seconds === null || unit.seconds === null) return true;
  const tol = s.runtimeMinutes * 60;
  const tries = unit.files > 1 ? [1, 2, 3] : [1];
  return tries.some((k) => Math.abs(unit.seconds! / k - hit.seconds!) <= tol);
}

/** The review reason a failed evaluation gives (the first failed check). */
export function reviewReason(e: Evaluation): string {
  if (e.fraction && e.fraction > 1 && e.failed.length === 1 && e.failed[0] === 'runtime')
    return 'fraction';
  return e.failed[0] ?? 'none';
}

/** Fewer failed checks first; a title that agrees counts most. */
export function rankEvaluation(e: Evaluation): number {
  return e.failed.length * 10 + (e.checks.title.ok ? 0 : 5) + (e.checks.runtime.ok ? 0 : 2);
}
