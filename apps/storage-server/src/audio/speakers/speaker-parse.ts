/**
 * Season 2 Phase 12 session 5: reading the speaker model's answers.
 *
 * The model answers through a grammar (llama.cpp GBNF / JSON schema), so the shape is fixed;
 * a broken answer still only loses that window's quotes (they stay without a speaker).
 *
 * "How sure" is not the model's own claim but the probability of the speaker it wrote: for
 * each token of a speaker id, its probability among the alternatives the grammar allowed at
 * that point (from llama.cpp's `n_probs` list), multiplied over the id's tokens.
 */
import type { Gender } from './speaker-merge';

export interface ParsedCharacters {
  characters: { name: string; aliases: string[]; firstPerson: string[]; gender: Gender }[];
  /**
   * `firstPerson`: the narration is in the first person; `name`: whose point of view the
   * narration follows (first or third person), null when unknown.
   */
  narrator: { firstPerson: boolean; name: string | null };
}

/** Names the model uses for "the narrator" itself: never a character's name. */
const NOT_A_NAME = new Set([
  '語り手',
  '主人公',
  'ナレーター',
  '視点人物',
  '私',
  '僕',
  '俺',
  'わたし',
  'ぼく',
  'おれ',
  '不明',
  'なし',
  'ナレーション',
  '地の文',
  // "We" and "someone": never one character (seen in the live run, 2026-11-17).
  '私たち',
  'わたしたち',
  '私達',
  '僕たち',
  '僕達',
  '僕ら',
  'ぼくら',
  '俺たち',
  '俺達',
  '俺ら',
  'おれたち',
  '我々',
  'われわれ',
  'あたしたち',
  'うちら',
  '名前不明',
  '誰か',
  '謎の人物',
]);

/**
 * A name as the model wrote it, without the notes it sometimes adds: "ピアスキー（手紙の
 * 差出人）※文脈" -> "ピアスキー", "兵士of_the_army (※" -> "兵士" (live run, 2026-11-17).
 * Null when nothing is left or it is not a name (the narrator, "we", "unknown").
 */
export function cleanName(raw: string): string | null {
  const s = raw
    .split(/[（(［[【〔＜<｛{※,，、:：;；\n]/u)[0]
    .replace(/[A-Za-z0-9]*_[\x20-\x7E]*$/u, '')
    .trim();
  if (!s || NOT_A_NAME.has(s.normalize('NFKC'))) return null;
  return s;
}

const GENDERS = new Set(['男', '女', '不明']);

function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => cleanName(x))
    .filter((x): x is string => !!x && x.length <= 40)
    .slice(0, max);
}

/** Stage 1: the characters of a window (an unreadable answer: none). */
export function parseCharacters(content: string): ParsedCharacters {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { characters: [], narrator: { firstPerson: false, name: null } };
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const characters = (Array.isArray(o.characters) ? o.characters : [])
    .map((c) => (c ?? {}) as Record<string, unknown>)
    .filter((c) => typeof c.name === 'string' && c.name.trim().length <= 60)
    .map((c) => ({ raw: c, name: cleanName(c.name as string) }))
    .filter(
      (c): c is { raw: Record<string, unknown>; name: string } => !!c.name && c.name.length <= 40,
    )
    .slice(0, 60)
    .map(({ raw: c, name }) => ({
      name,
      aliases: strings(c.aliases, 12),
      firstPerson: strings(c.firstPerson, 6),
      gender: (GENDERS.has(c.gender as string) ? c.gender : '不明') as Gender,
    }));
  const n = (o.narrator ?? {}) as Record<string, unknown>;
  const name = typeof n.name === 'string' ? cleanName(n.name.slice(0, 60)) : null;
  return {
    characters,
    narrator: { firstPerson: n.firstPerson === true, name },
  };
}

/** Stage 2: groups of ids that are the same person. */
export function parseGroups(content: string, valid: Set<number>): number[][] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  const groups = ((raw ?? {}) as Record<string, unknown>).same;
  if (!Array.isArray(groups)) return [];
  const used = new Set<number>();
  const out: number[][] = [];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const ids = [
      ...new Set(
        g
          .map((x) => (typeof x === 'string' ? Number(/^C(\d+)$/.exec(x)?.[1]) : NaN))
          .filter((id) => valid.has(id) && !used.has(id)),
      ),
    ];
    if (ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    out.push(ids);
  }
  return out;
}

/** One generated token with the alternatives llama.cpp listed (natural-log probabilities). */
export interface TokenProb {
  token: string;
  logprob: number;
  top: { token: string; logprob: number }[];
}

/**
 * llama-server's `completion_probabilities`, in any of its forms: `{token, logprob,
 * top_logprobs}` (current), `{token, prob, top_probs}` (post_sampling_probs) and the older
 * `{content, probs: [{tok_str, prob}]}`.
 */
export function tokenProbs(raw: unknown): TokenProb[] {
  if (!Array.isArray(raw)) return [];
  const lp = (p: unknown) => (typeof p === 'number' && p > 0 ? Math.log(p) : -Infinity);
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (Array.isArray(o.top_logprobs) || typeof o.logprob === 'number') {
      return {
        token: String(o.token ?? ''),
        logprob: typeof o.logprob === 'number' ? o.logprob : -Infinity,
        top: ((o.top_logprobs as Record<string, unknown>[]) ?? []).map((t) => ({
          token: String(t.token ?? ''),
          logprob: typeof t.logprob === 'number' ? t.logprob : -Infinity,
        })),
      };
    }
    if (Array.isArray(o.top_probs) || typeof o.prob === 'number') {
      return {
        token: String(o.token ?? ''),
        logprob: lp(o.prob),
        top: ((o.top_probs as Record<string, unknown>[]) ?? []).map((t) => ({
          token: String(t.token ?? ''),
          logprob: lp(t.prob),
        })),
      };
    }
    const top = ((o.probs as Record<string, unknown>[]) ?? []).map((t) => ({
      token: String(t.tok_str ?? ''),
      logprob: lp(t.prob),
    }));
    const token = String(o.content ?? '');
    return { token, logprob: top.find((t) => t.token === token)?.logprob ?? -Infinity, top };
  });
}

export type SpeakerAnswer =
  | { kind: 'character'; id: number; p: number | null }
  | { kind: 'new'; name: string; p: number | null }
  | { kind: 'unknown'; p: number | null };

/**
 * Stage 3: one line per quote, `Q<n>=C<id>`, `Q<n>=+<name>` or `Q<n>=?`. Lines for quotes
 * not asked about, or ids not in the list, are ignored. `p` is null when the answer came
 * without token probabilities.
 */
export function parseSpeakers(
  content: string,
  probs: TokenProb[] | null,
  quotes: number[],
  valid: Set<number>,
  /** Only lines from here on (a second look: after the model's thinking). */
  from = 0,
): Map<number, SpeakerAnswer> {
  const asked = new Set(quotes);
  const out = new Map<number, SpeakerAnswer>();
  const validSpeakers = ['?', ...[...valid].map((id) => `C${id}`)];
  // Token boundaries in the content (the probabilities follow the generated text).
  const starts: number[] = [];
  if (probs?.length) {
    let at = 0;
    for (const t of probs) {
      starts.push(at);
      at += t.token.length;
    }
    // Not the same text (or tokens cut inside a character): no probabilities.
    if (probs.map((t) => t.token).join('') !== content) probs = null;
  }
  const re = /Q(\d+)=([^\n]*)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const quote = Number(m[1]);
    if (m.index < from || !asked.has(quote) || out.has(quote)) continue;
    const value = m[2].trim();
    const at = m.index + m[0].length - m[2].length;
    const to = m.index + m[0].length;
    const p = probs ? sureness(probs, starts, content, at, to, validSpeakers) : null;
    const id = /^C(\d+)$/.exec(value);
    if (id && valid.has(Number(id[1]))) out.set(quote, { kind: 'character', id: Number(id[1]), p });
    else if (value.startsWith('+')) {
      // A name that is only a note (or "we", "unknown") counts as unknown.
      const name = cleanName(value.slice(1));
      out.set(quote, name ? { kind: 'new', name: name.slice(0, 40), p } : { kind: 'unknown', p });
    } else if (value === '?') out.set(quote, { kind: 'unknown', p });
  }
  return out;
}

/**
 * The probability of the speaker written in [from, to) of `content`: per token, its share
 * among the listed alternatives that keep the answer a valid speaker so far.
 */
function sureness(
  probs: TokenProb[],
  starts: number[],
  content: string,
  from: number,
  to: number,
  valid: string[],
): number | null {
  const isName = content[from] === '+';
  const ok = (text: string) => {
    const nl = text.indexOf('\n');
    const head = nl >= 0 ? text.slice(0, nl) : text;
    if (head.startsWith('+')) return !head.includes('=');
    return nl >= 0 ? valid.includes(head) : valid.some((v) => v.startsWith(head));
  };
  let logp = 0;
  let seen = false;
  for (let i = 0; i < probs.length; i++) {
    const a = starts[i];
    const b = a + probs[i].token.length;
    if (b <= from || a >= to) continue;
    if (isName && a > from) break; // a new name: only the '+' choice counts
    seen = true;
    const before = content.slice(from, Math.max(from, a));
    const chosen = probs[i];
    let total = 0;
    let chosenIn = false;
    for (const alt of chosen.top) {
      if (!Number.isFinite(alt.logprob)) continue;
      if (ok(before + alt.token)) total += Math.exp(alt.logprob);
      if (alt.token === chosen.token) chosenIn = true;
    }
    const pc = Math.exp(chosen.logprob);
    if (!chosenIn && Number.isFinite(chosen.logprob)) total += pc;
    if (!(total > 0) || !Number.isFinite(chosen.logprob)) continue;
    logp += Math.log(Math.min(1, pc / total));
  }
  return seen ? Math.exp(logp) : null;
}
