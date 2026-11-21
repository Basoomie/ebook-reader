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
 *
 * Title guards (WP21c follow-up (2), measured on the live run's 196 partial agreements):
 *   - one title inside the other (or the pair share) counts only when the shorter title has at
 *     least `titleMinChars` characters and `titleMinShare` of the longer one ("audio" inside
 *     "Académie de trading : Leçons audio", 暗殺 inside "QED 龍馬暗殺" don't); records the id in
 *     the file name chose keep the plain comparison (the id chose them; 武士道 vs its subtitle),
 *   - a folder title that the file's own, longer title contains names the series, not the book
 *     (十津川警部/十津川警部 高山本線の秘密): it is left out of `otherTitles` (`seriesTitles`),
 *   - a file without a title of its own (`[B09YY1LQRS].m4b`) has no title to compare: when the
 *     ASIN in its name chose the record, the other checks decide.
 */
import { norm, sim } from '../stage4/pick';
import { printedVolume } from './dup-names';
import type { StoreRecord } from './online-pages';
import {
  hasOwnTitle,
  personKey,
  searchTitle,
  titleBracket,
  titleWithoutLabel,
} from './online-names';

export interface UnitFacts {
  /** The title searched for (from the torrent names). */
  title: string;
  /** Other names of the recording (the folder's, other copies'): a title may agree with any. */
  otherTitles: string[];
  /**
   * Folder titles the file's own title contains (a series folder): searched, but never what a
   * record's title may agree with. Missing in units built before follow-up (2).
   */
  seriesTitles?: string[];
  authors: string[];
  narrators: string[];
  /**
   * The narrators came from audiobook.jp's bare tag form (the artist tag, no composer): a few
   * files of that form name the author there (鬼物語: 西尾維新), so when they agree with the
   * record's authors the narrator is unknown (WP21f-2). Missing in units built before.
   */
  narratorsFromArtist?: boolean;
  /** The printed volume from the names (`[4巻]`, `上`, a trailing number), or null. */
  volume: string | null;
  /** A drama CD and its number ("CD3", "ドラマCD3"), or null. */
  drama: { number: string | null } | null;
  seconds: number | null;
  /** Number of files (half and third lengths are tried only for several). */
  files: number;
  /**
   * The subtitle in a bracket attached to the end of the file's own title (`(妄想)`), which
   * `title` has lost (`searchTitle` drops trailing brackets): a record whose title carries
   * another one is another book (WP21c follow-up (3)). Missing in units built before.
   */
  titleBracket?: string | null;
  /** The file's own title with that bracket (`fullTitle`), for the exact-title tie-break. */
  fullTitle?: string;
}

export interface MatchSettings {
  runtimeMinutes: number;
  titleScore: number;
  /** One title inside the other counts from this many characters (cleaned)... */
  titleMinChars: number;
  /** ...and this share of the longer title. */
  titleMinShare: number;
}

/** The short-title guard; null = the plain comparison (a record the name's id chose). */
export interface TitleGuard {
  minChars: number;
  minShare: number;
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
  /** The title agreed only partly (a short title inside a longer one): review at most. */
  titlePartial?: boolean;
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

/**
 * The two titles name the same book (either contains the other, or the pair share is high).
 * With a guard, containment and the pair share count only when the shorter title is long
 * enough; a pair that would have agreed without it is reported as `partial` ("5 of 47
 * characters").
 */
export function titlesAgree(
  file: string[],
  store: string,
  score: number,
  guard: TitleGuard | null = null,
): { ok: boolean; best: number; partial: string | null } {
  const st = storeTitle(store);
  const sn = norm(st);
  let best = 0;
  let partial: string | null = null;
  for (const f of file) {
    // The same cleaning on both sides (a series in ＜ ＞, a reading in brackets: 卍（まんじ）).
    const ft = storeTitle(searchTitle(f));
    const fn = norm(ft);
    if (!fn || !sn) continue;
    if (fn === sn) return { ok: true, best: 1, partial: null };
    const a = [...fn].length;
    const b = [...sn].length;
    const short = Math.min(a, b);
    const long = Math.max(a, b);
    const enough = !guard || (short >= guard.minChars && short / long >= guard.minShare);
    const why = `${short} of ${long} characters`;
    if (fn.length >= 2 && sn.length >= 2 && (sn.includes(fn) || fn.includes(sn))) {
      if (enough) return { ok: true, best: 1, partial: null };
      partial ??= why;
      continue;
    }
    const s = Math.max(sim(ft, st), sim(st, ft));
    if (enough) best = Math.max(best, s);
    else if (s >= score) partial ??= why;
  }
  const ok = best >= score;
  return { ok, best: Math.round(best * 1000) / 1000, partial: ok ? null : partial };
}

/**
 * Folder titles that the file's own, longer title contains: the series' name, not the book's
 * (十津川警部/十津川警部 高山本線の秘密, 朗読執事/朗読執事～まだらの紐～).
 */
export function seriesFolderTitles(own: string, folders: string[]): string[] {
  const on = norm(storeTitle(searchTitle(own)));
  if (!on) return [];
  return folders.filter((f) => {
    const fn = norm(storeTitle(searchTitle(f)));
    return fn !== '' && fn !== on && on.includes(fn);
  });
}

/**
 * The file's subtitle and the store title's differ (`(妄想)` / `(入門)`): another book, whatever
 * the rest of the title says (WP21c follow-up (3)). Null when they don't, or one side has none.
 */
export function subtitlesDiffer(unit: UnitFacts, store: string): string | null {
  const f = unit.titleBracket ?? null;
  const s = titleBracket(store);
  if (!f || !s || norm(f) === norm(s)) return null;
  return `different subtitle: (${f}) / (${s})`;
}

/**
 * The file's own title, with its subtitle, is the store's title exactly (no containment, no
 * pair share; an imprint, publisher or reader in a last bracket doesn't count on either side):
 * the tie-break of the one-record rule (WP21c follow-up (3)).
 */
export function exactTitle(unit: UnitFacts, store: string): boolean {
  const f = norm(titleWithoutLabel(unit.fullTitle ?? unit.title));
  return f !== '' && f === norm(titleWithoutLabel(store));
}

/** The file's own title says nothing once cleaned (`[B09YY1LQRS].m4b`, `【ア】【イ】`). */
export function noOwnTitle(title: string): boolean {
  return !hasOwnTitle(norm(storeTitle(searchTitle(title))));
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
  opts: { viaNameAsin?: boolean; viaNameId?: boolean } = {},
): Evaluation {
  const titles = [unit.title, ...unit.otherTitles];
  const checks = {} as Record<CheckName, Check>;
  let titlePartial = false;
  if (opts.viaNameAsin && noOwnTitle(unit.title)) {
    // Nothing to compare: the ASIN in the name chose the record; the other checks decide.
    checks.title = {
      ok: true,
      unknown: true,
      file: unit.title || null,
      store: r.title,
      detail: 'the file has no title; the ASIN in its name chose the record',
    };
  } else {
    // A record the id in the file name chose keeps the plain comparison.
    const guard =
      opts.viaNameAsin || opts.viaNameId
        ? null
        : { minChars: s.titleMinChars, minShare: s.titleMinShare };
    const t = titlesAgree(titles, r.title, s.titleScore, guard);
    // Even a record the id in the name chose: the id doesn't make (妄想) into (入門).
    const sub = subtitlesDiffer(unit, r.title);
    titlePartial = !sub && !t.ok && t.partial !== null;
    checks.title = {
      ok: t.ok && !sub,
      file: unit.title,
      store: r.title,
      detail: sub
        ? sub
        : t.ok
          ? undefined
          : t.partial
            ? `only inside a longer title: ${t.partial}`
            : `score ${t.best}`,
    };
  }

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

  // Narrator: only when the file's tags name one. An artist tag of audiobook.jp's bare form that
  // names the record's author named the author, not a narrator (鬼物語).
  const artistIsAuthor =
    unit.narratorsFromArtist === true &&
    r.authors.length > 0 &&
    peopleAgree(unit.narrators, r.authors);
  if (unit.narrators.length === 0 || r.narrators.length === 0 || artistIsAuthor) {
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
  return { checks, failed, fraction, titlePartial, pass: failed.length === 0 };
}

/** The guard for records found by a search (never chosen by an id in the name). */
export function searchGuard(s: MatchSettings): TitleGuard {
  return { minChars: s.titleMinChars, minShare: s.titleMinShare };
}

/** Pre-check of a search hit (before its full record is read): title and length. */
export function hitWorthReading(
  unit: UnitFacts,
  hit: { title: string; seconds: number | null },
  s: MatchSettings,
): boolean {
  if (!titlesAgree([unit.title, ...unit.otherTitles], hit.title, s.titleScore, searchGuard(s)).ok)
    return false;
  if (subtitlesDiffer(unit, hit.title)) return false;
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
