/**
 * Season 2 Phase 12 session 5: one speaker run over a book, as a plan of model requests.
 *
 * The server owns the prompts, the parsing and the merging; the PC only runs each request on
 * its local model (llama.cpp) and sends the answer back. A run is replayed from the answers it
 * has (`SpeakerRun.next`), so it continues after a pause, a restart or the PC yielding to
 * read-aloud, and a request always depends only on the answers before it.
 *
 * Stages:
 *  1. characters: per window of ~`charWindow` characters, the people who speak or are
 *     addressed, their other names, first-person words, gender, and whether the narration is
 *     first person (and by whom); merged as they come (speaker-merge.ts).
 *  2. groups: one request over the merged list: which entries are the same person.
 *  3. speakers: per window of ~`speakerWindow` characters (at most `maxQuotes` quotes), the
 *     speaker of each numbered quote, with the text before it (its quotes labelled with the
 *     speakers already found) for turn-taking.
 */
import { CharacterMerger, type MergedCharacter } from './speaker-merge';
import {
  parseCharacters,
  parseGroups,
  parseSpeakers,
  tokenProbs,
  type SpeakerAnswer,
} from './speaker-parse';
import type { SpeakerBook, SpeakerParagraph } from './speaker-text';

/** Bumped when the prompts or the windows change (recorded with each run). */
export const PROMPT_VERSION = 4;

export interface RunOptions {
  charWindow: number;
  speakerWindow: number;
  contextChars: number;
  maxQuotes: number;
  /** Characters in a speaker prompt at most. */
  maxListed: number;
  /** Mark the scene's point-of-view character in speaker prompts (prompt v2; off by default: it did worse on the 9B model). */
  markPov: boolean;
  /**
   * A second look, with the model thinking first, at the quotes whose speaker was less sure
   * than this (0..1); null: none.
   */
  secondLookBelow: number | null;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  charWindow: 8000,
  speakerWindow: 2500,
  contextChars: 1200,
  maxQuotes: 30,
  maxListed: 40,
  markPov: false,
  secondLookBelow: null,
};

export type Stage = 'characters' | 'groups' | 'speakers' | 'review';

/** Where a thinking model's thoughts end (Qwen-style templates). */
export const THINK_END = '</think>';

export interface LlmRequest {
  seq: number;
  stage: Stage;
  /** Index of the window within its stage. */
  window: number;
  messages: { role: 'system' | 'user'; content: string }[];
  grammar?: string;
  jsonSchema?: unknown;
  nPredict: number;
  /** Alternatives per token to report (0: none). */
  nProbs: number;
  /** Let the model think first (chat_template_kwargs.enable_thinking); the grammar allows it. */
  think?: boolean;
}

export interface LlmAnswer {
  content: string;
  /** llama-server's completion_probabilities, as it sent them. */
  probs?: unknown;
}

interface Window {
  paragraphs: SpeakerParagraph[];
  quotes: number[];
}

const SYSTEM =
  'あなたは日本語の小説を注意深く読み、登場人物と台詞の話者を正確に見分ける専門家です。';

function windows(book: SpeakerBook, size: number, maxQuotes: number): Window[] {
  const out: Window[] = [];
  let cur: Window = { paragraphs: [], quotes: [] };
  let chars = 0;
  const flush = () => {
    if (cur.quotes.length) out.push(cur);
    cur = { paragraphs: [], quotes: [] };
    chars = 0;
  };
  for (const p of book.paragraphs) {
    const last = cur.paragraphs[cur.paragraphs.length - 1];
    if (
      last &&
      (last.chapter !== p.chapter ||
        chars + p.text.length > size ||
        cur.quotes.length + p.quotes.length > maxQuotes)
    ) {
      flush();
    }
    cur.paragraphs.push(p);
    cur.quotes.push(...p.quotes.map((q) => q.quote));
    chars += p.text.length;
  }
  flush();
  return out;
}

const CHARACTER_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 30 },
          aliases: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 30 },
          },
          firstPerson: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 8 },
          },
          gender: { enum: ['男', '女', '不明'] },
        },
        required: ['name', 'aliases', 'firstPerson', 'gender'],
      },
    },
    narrator: {
      type: 'object',
      properties: {
        firstPerson: { type: 'boolean' },
        name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 30 }, { type: 'null' }] },
      },
      required: ['firstPerson', 'name'],
    },
  },
  required: ['characters', 'narrator'],
};

function gbnfString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** The grammar of a speaker answer: one line per quote, in order. */
export function speakerGrammar(quotes: number[], ids: number[]): string {
  const speaker = ['"?"', '"+" name', ...ids.map((id) => gbnfString(`C${id}`))].join(' | ');
  return [
    `root ::= ${quotes.map((q) => `${gbnfString(`Q${q}=`)} speaker "\\n"`).join(' ')}`,
    `speaker ::= ${speaker}`,
    'name ::= [^\\n=+?]{1,16}',
    '',
  ].join('\n');
}

function characterLine(c: MergedCharacter, note = ''): string {
  const aliases = c.aliases.slice(0, 6);
  return (
    `C${c.id} ${c.name}` +
    (aliases.length ? `（別名: ${aliases.join('、')}）` : '') +
    (c.firstPerson.length ? ` 一人称: ${c.firstPerson.slice(0, 3).join('、')}` : '') +
    (c.gender !== '不明' ? ` ${c.gender}` : '') +
    note
  );
}

/** A paragraph with its quotes marked (`［Q12］「…」`) or labelled (`「…」【C3】`). */
function marked(p: SpeakerParagraph, label?: (quote: number) => string): string {
  let out = '';
  let at = 0;
  for (const q of p.quotes) {
    out += p.text.slice(at, q.start);
    if (label) out += p.text.slice(q.start, q.end) + `【${label(q.quote)}】`;
    else out += `［Q${q.quote}］` + p.text.slice(q.start, q.end);
    at = q.end;
  }
  return out + p.text.slice(at);
}

export interface QuoteResult {
  quote: number;
  /** The character (an id of `characters`), or null: no speaker found. */
  character: number | null;
  /** How sure the model was (0..1), null when unknown. */
  p: number | null;
  /** The model answered "unknown / several / a crowd". */
  unknown: boolean;
}

export interface RunProgress {
  stage: Stage | 'done';
  done: number;
  total: number;
}

export interface RunResult {
  characters: MergedCharacter[];
  quotes: QuoteResult[];
  narrator: number | null;
}

/**
 * A run over a book. `seed`: the characters to start from (the user's list on a re-run), kept
 * with their ids and names.
 */
export class SpeakerRun {
  readonly charWindows: Window[];
  readonly speakerWindows: Window[];
  private readonly charWindowOf = new Map<number, number>(); // paragraph → stage-1 window
  readonly opts: RunOptions;

  constructor(
    readonly book: SpeakerBook,
    private readonly seed: MergedCharacter[] = [],
    opts: Partial<RunOptions> = {},
  ) {
    this.opts = { ...DEFAULT_RUN_OPTIONS, ...opts };
    this.charWindows = windows(book, this.opts.charWindow, Number.MAX_SAFE_INTEGER);
    this.speakerWindows = windows(book, this.opts.speakerWindow, this.opts.maxQuotes);
    this.charWindows.forEach((w, i) =>
      w.paragraphs.forEach((p) => this.charWindowOf.set(p.index, i)),
    );
  }

  /** Number of requests in the run. */
  get total(): number {
    return this.charWindows.length + 1 + this.speakerWindows.length;
  }

  /**
   * Replays the answers so far; returns the next request (null: the run is complete) with the
   * state reached.
   */
  next(answers: Map<number, LlmAnswer>): { request: LlmRequest | null; progress: RunProgress } {
    const state = this.replay(answers);
    return { request: state.request, progress: state.progress };
  }

  /** The result of a complete run (or of the answers so far). */
  result(answers: Map<number, LlmAnswer>): RunResult {
    const s = this.replay(answers);
    return { characters: s.merger.characters(), quotes: s.quotes, narrator: s.narrator };
  }

  private replay(answers: Map<number, LlmAnswer>) {
    const merger = new CharacterMerger(this.seed);
    const narration: { firstPerson: boolean; name: string | null }[] = [];
    let seq = 0;
    const progress = (stage: Stage | 'done'): RunProgress => ({
      stage,
      done: seq,
      total: this.total,
    });

    // Stage 1: characters.
    for (let w = 0; w < this.charWindows.length; w++, seq++) {
      const a = answers.get(seq);
      if (!a) {
        return {
          request: this.characterRequest(seq, w, merger),
          progress: progress('characters'),
          merger,
          quotes: [],
          narrator: null,
        };
      }
      const parsed = parseCharacters(a.content);
      for (const c of parsed.characters) merger.add({ ...c, window: w });
      narration[w] = parsed.narrator;
    }

    // The narrator: the name most windows with first-person narration give.
    const firstPersonWindows = narration.filter((n) => n?.firstPerson);
    let narrator: number | null = this.seed.find((c) => c.narrator)?.id ?? null;
    if (narrator === null && firstPersonWindows.length >= Math.max(1, narration.length * 0.2)) {
      const names = firstPersonWindows.map((n) => n.name).filter((n): n is string => !!n);
      const counts = new Map<string, number>();
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best) narrator = merger.setNarrator(best);
    }

    // Stage 2: groups.
    {
      const a = answers.get(seq);
      if (!a) {
        return {
          request: this.groupRequest(seq, merger),
          progress: progress('groups'),
          merger,
          quotes: [],
          narrator,
        };
      }
      const valid = new Set(merger.characters().map((c) => c.id));
      merger.applyGroups(parseGroups(a.content, valid));
      if (narrator !== null && !merger.byId(narrator)) {
        narrator = merger.characters().find((c) => c.narrator)?.id ?? null;
      }
      seq++;
    }

    // Stage 3: speakers.
    const found = new Map<number, QuoteResult>();
    for (let w = 0; w < this.speakerWindows.length; w++, seq++) {
      const win = this.speakerWindows[w];
      const listed = this.listed(win, merger, narrator);
      const a = answers.get(seq);
      if (!a) {
        return {
          request: this.speakerRequest(seq, w, win, listed, found, narration, merger),
          progress: progress('speakers'),
          merger,
          quotes: [...found.values()],
          narrator,
        };
      }
      const valid = new Set(listed.map((c) => c.id));
      const probs = a.probs === undefined ? null : tokenProbs(a.probs);
      const parsed = parseSpeakers(a.content, probs, win.quotes, valid);
      for (const q of win.quotes) {
        const ans: SpeakerAnswer | undefined = parsed.get(q);
        if (!ans) {
          found.set(q, { quote: q, character: null, p: null, unknown: false });
        } else if (ans.kind === 'character') {
          found.set(q, { quote: q, character: ans.id, p: ans.p, unknown: false });
        } else if (ans.kind === 'new') {
          const para = this.book.quotes.find((x) => x.quote === q)?.paragraph ?? 0;
          const id = merger.add({
            name: ans.name,
            aliases: [],
            firstPerson: [],
            gender: '不明',
            window: this.charWindowOf.get(para) ?? -1,
          });
          found.set(q, { quote: q, character: id, p: ans.p, unknown: false });
        } else {
          found.set(q, { quote: q, character: null, p: ans.p, unknown: true });
        }
      }
    }

    // Stage 4 (optional): a second look, thinking first, at the quotes the model was unsure of.
    const bar = this.opts.secondLookBelow;
    if (bar !== null) {
      const review = this.speakerWindows
        .map((win, w) => ({
          win,
          w,
          unsure: win.quotes.filter((q) => {
            const f = found.get(q);
            return !f || f.p === null || f.p < bar;
          }),
        }))
        .filter((r) => r.unsure.length);
      const total = this.total + review.length;
      for (const r of review) {
        const listed = this.listed(r.win, merger, narrator);
        const a = answers.get(seq);
        if (!a) {
          return {
            request: this.reviewRequest(seq, r.w, r.win, r.unsure, listed, found),
            progress: { stage: 'review' as const, done: seq, total },
            merger,
            quotes: [...found.values()],
            narrator,
          };
        }
        const end = a.content.lastIndexOf(THINK_END);
        if (end >= 0) {
          const valid = new Set(listed.map((c) => c.id));
          const probs = a.probs === undefined ? null : tokenProbs(a.probs);
          const parsed = parseSpeakers(a.content, probs, r.unsure, valid, end + THINK_END.length);
          for (const q of r.unsure) {
            const ans = parsed.get(q);
            if (ans?.kind === 'character')
              found.set(q, { quote: q, character: ans.id, p: ans.p, unknown: false });
            else if (ans?.kind === 'unknown')
              found.set(q, { quote: q, character: null, p: ans.p, unknown: true });
            else if (ans?.kind === 'new') {
              const para = this.book.quotes.find((x) => x.quote === q)?.paragraph ?? 0;
              const id = merger.add({
                name: ans.name,
                aliases: [],
                firstPerson: [],
                gender: '不明',
                window: this.charWindowOf.get(para) ?? -1,
              });
              found.set(q, { quote: q, character: id, p: ans.p, unknown: false });
            }
          }
        }
        seq++;
      }
    }
    return {
      request: null,
      progress: progress('done'),
      merger,
      quotes: [...found.values()],
      narrator,
    };
  }

  /** The characters named in a speaker prompt: those of the window's part of the book, the narrator, the main ones. */
  private listed(win: Window, merger: CharacterMerger, narrator: number | null): MergedCharacter[] {
    const all = merger.characters().filter((c) => !c.hidden);
    const near = new Set<number>();
    for (const p of [win.paragraphs[0], win.paragraphs[win.paragraphs.length - 1]]) {
      const w = this.charWindowOf.get(p.index);
      if (w !== undefined) near.add(w);
    }
    const main = [...all].sort((a, b) => b.windows.length - a.windows.length).slice(0, 8);
    const pick = new Map<number, MergedCharacter>();
    for (const c of all)
      if (c.windows.some((w) => near.has(w)) || c.id === narrator || c.fixed) pick.set(c.id, c);
    for (const c of main) pick.set(c.id, c);
    return [...pick.values()]
      .sort((a, b) => b.windows.length - a.windows.length)
      .slice(0, this.opts.maxListed)
      .sort((a, b) => a.id - b.id);
  }

  private reviewRequest(
    seq: number,
    w: number,
    win: Window,
    unsure: number[],
    listed: MergedCharacter[],
    found: Map<number, QuoteResult>,
  ): LlmRequest {
    const known = win.quotes
      .filter((q) => !unsure.includes(q))
      .map((q) => {
        const f = found.get(q);
        return `Q${q}=${f?.character != null ? `C${f.character}` : '?'}`;
      });
    const content = [
      '小説の一部を読んで、指定した［Q番号］の台詞を誰が話しているかを答えてください。',
      '',
      '登場人物:',
      ...listed.map((c) => characterLine(c)),
      '',
      '答え方: 指定した台詞ごとに1行で「Q番号=人物ID」。一覧にない人物なら「Q番号=+名前」。誰か分からない、複数人が同時に話している、群衆や動物の声なら「Q番号=?」。',
      '話者は台詞の前後の地の文（「〜と言った」「〜が答える」）、呼びかけ、口調、一人称、会話の順番から判断してください。会話の順番と、誰に向けた言葉かをよく考えてから答えてください。',
      ...(known.length ? ['', `他の台詞の話者（参考）: ${known.join('、')}`] : []),
      '',
      '本文:',
      ...win.paragraphs.map((p) => marked(p)),
      '',
      `答える台詞: ${unsure.map((q) => `Q${q}`).join('、')}`,
    ].join('\n');
    const lines = speakerGrammar(
      unsure,
      listed.map((c) => c.id),
    ).replace(/^root ::= /, 'answers ::= ');
    return {
      seq,
      stage: 'review',
      window: w,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      grammar: `root ::= [^<]* ${JSON.stringify(THINK_END)} [ \\n]* answers\n${lines}`,
      nPredict: 2048 + unsure.length * 24,
      nProbs: 10,
      think: true,
    };
  }

  private characterRequest(seq: number, w: number, merger: CharacterMerger): LlmRequest {
    const known = merger
      .characters()
      .sort((a, b) => b.windows.length - a.windows.length)
      .slice(0, 40)
      .map((c) => c.name);
    const text = this.charWindows[w].paragraphs.map((p) => p.text).join('\n');
    const content = [
      '次は小説の一部です。この部分で台詞を話す人物と、話しかけられている人物をすべて挙げてください。',
      '- name: 本文で最もよく使われる呼び名（「さん」「様」などの敬称は付けない）',
      '- aliases: 本文でこの人物だけを指す他の呼び名（フルネーム、名字、あだ名、偽名）。「旅の連れ」「少女」のような説明や、他の人物にも使える言葉は入れない',
      '- firstPerson: その人物が台詞で使う一人称（俺、僕、私、わっち など。分からなければ空）',
      '- gender: 男 / 女 / 不明',
      '名前の分からない人物は「受付嬢」「老人」「兵士」のような役割名で書いてください。',
      'narrator: 地の文（台詞以外）が誰の目線（考え・感覚）で書かれているか。name にその視点人物の名前（分からなければ null）。地の文が「僕は」「俺は」のような一人称なら firstPerson を true、三人称なら false。',
      ...(known.length
        ? [`既に分かっている人物（同じ人物にはこの名前を使ってください）: ${known.join('、')}`]
        : []),
      '',
      '本文:',
      text,
    ].join('\n');
    return {
      seq,
      stage: 'characters',
      window: w,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      jsonSchema: CHARACTER_SCHEMA,
      nPredict: 3000,
      nProbs: 0,
    };
  }

  private groupRequest(seq: number, merger: CharacterMerger): LlmRequest {
    const list = merger.characters();
    const ids = list.map((c) => `C${c.id}`);
    const content = [
      '次は小説の登場人物の一覧です。同じ人物が別の名前で複数回載っていれば、そのIDの組をすべて挙げてください。',
      'よくある例: 名字だけ・名前だけの項目とフルネームの項目（ナツキ と ナツキ・スバル）、本名と偽名や通り名、名前が分かる前の呼び名（「黒髪のメイド」と後で名乗った名前）。',
      '別人（兄弟、親子、同じ名字の別人）はまとめないでください。同じ人物がいなければ空の配列にしてください。',
      '',
      ...list.map((c) => characterLine(c, c.narrator ? ' ※一人称の語り手' : '')),
    ].join('\n');
    return {
      seq,
      stage: 'groups',
      window: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      jsonSchema: {
        type: 'object',
        properties: {
          same: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'array',
              minItems: 2,
              maxItems: 6,
              items: ids.length ? { enum: ids } : { type: 'string' },
            },
          },
        },
        required: ['same'],
      },
      nPredict: 1000,
      nProbs: 0,
    };
  }

  private speakerRequest(
    seq: number,
    w: number,
    win: Window,
    listed: MergedCharacter[],
    found: Map<number, QuoteResult>,
    narration: { firstPerson: boolean; name: string | null }[],
    merger: CharacterMerger,
  ): LlmRequest {
    // The text before the window in its chapter, with the speakers found so far.
    const first = win.paragraphs[0];
    const before: string[] = [];
    let chars = 0;
    for (let i = first.index - 1; i >= 0; i--) {
      const p = this.book.paragraphs[i];
      if (p.chapter !== first.chapter || chars + p.text.length > this.opts.contextChars) break;
      before.unshift(
        marked(p, (q) => {
          const f = found.get(q);
          return f?.character != null ? `C${f.character}` : '?';
        }),
      );
      chars += p.text.length;
    }
    const scene = narration[this.charWindowOf.get(first.index) ?? -1];
    const pov = scene?.name ? merger.idOf(scene.name) : null;
    const note = (c: MergedCharacter) =>
      this.opts.markPov && c.id === pov
        ? scene?.firstPerson
          ? ' ※視点人物（地の文はこの人物の一人称）'
          : ' ※視点人物（地の文はこの人物の目線）'
        : '';
    const content = [
      '小説の一部を読んで、［Q番号］の付いた各台詞を誰が話しているかを答えてください。',
      '',
      '登場人物:',
      ...listed.map((c) => characterLine(c, note(c))),
      '',
      '答え方: 台詞ごとに1行で「Q番号=人物ID」。一覧にない人物なら「Q番号=+名前」。誰か分からない、複数人が同時に話している、群衆や動物の声なら「Q番号=?」。',
      '話者は台詞の前後の地の文（「〜と言った」「〜が答える」）、呼びかけ、口調、一人称、会話の順番から判断してください。' +
        (this.opts.markPov ? '視点人物の台詞は、地の文で名前が書かれないことがよくあります。' : ''),
      ...(before.length ? ['', '直前の本文（参考。【】内はその台詞の話者）:', ...before] : []),
      '',
      '本文:',
      ...win.paragraphs.map((p) => marked(p)),
    ].join('\n');
    return {
      seq,
      stage: 'speakers',
      window: w,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      grammar: speakerGrammar(
        win.quotes,
        listed.map((c) => c.id),
      ),
      nPredict: win.quotes.length * 24 + 16,
      nProbs: 10,
    };
  }
}
