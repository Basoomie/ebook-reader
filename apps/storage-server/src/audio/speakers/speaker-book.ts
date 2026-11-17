/**
 * Season 2 Phase 12 session 5: what the book page and the review page show of a book's
 * speakers, and the user's edits.
 *
 * - The review page (decided: a separate page) lists quotes with their paragraph and the
 *   ones around it. Filters: "To check" (default: the model was unsure, or the speaker's
 *   name isn't near the quote: in step A the model's misses were mostly quotes whose speaker
 *   the text doesn't name, and gemma's "how sure" is high even on many of its misses),
 *   unsure only, one character, no speaker, corrected by you, no longer in the book, all.
 * - A book whose EPUB changed (or whose quotes the dialogue rule now numbers differently)
 *   has its stored quotes renumbered by their text first (speaker-store.ts `rekey`).
 */
import type { ScriptChapter } from '../book-script';
import { DIALOGUE_RULE } from '../voice-map';
import type { SubtitleJobService, WorkerJob } from '../subtitle-jobs';
import type { TtsJobService } from '../tts-jobs';
import { normalizeName } from './speaker-merge';
import type { SpeakerJobService } from './speaker-jobs';
import type { SpeakerModel, SpeakerModelService } from './speaker-models';
import type { SpeakerStore, StoredCharacter, StoredQuote } from './speaker-store';
import { speakerBook, type SpeakerBook, type SpeakerParagraph } from './speaker-text';
import type { SpeakerVoices, VoiceLookup } from './speaker-voices';

export type QuoteFilter = 'check' | 'unsure' | 'character' | 'none' | 'corrected' | 'lost' | 'all';
const FILTERS: QuoteFilter[] = ['check', 'unsure', 'character', 'none', 'corrected', 'lost', 'all'];

export interface QuoteItem {
  quote: number;
  text: string;
  character: number | null;
  modelCharacter: number | null;
  p: number | null;
  unknown: boolean;
  corrected: boolean;
  lost: boolean;
  /** A name of the speaker is in the quote's paragraph or the ones next to it (outside quotes). */
  nameNearby: boolean;
  /** The quote's paragraph (with the quote's offsets in it) and the ones around it. */
  paragraph: { text: string; start: number; end: number } | null;
  before: string | null;
  after: string | null;
}

export interface SpeakerOverview {
  job: WorkerJob | null;
  /** The PC's program runs speaker jobs (null: no PC seen yet). */
  pcCanRun: boolean | null;
  models: SpeakerModel[];
  run: {
    finishedAt: number;
    model: string | null;
    quotes: number;
    /** The EPUB changed since; the quotes were found again by their text. */
    renumbered: boolean;
  } | null;
  narrationBy: 'narration' | 'narrator';
  characters: (StoredCharacter & { voiceName: string | null })[];
  counts: {
    quotes: number;
    check: number;
    unsure: number;
    none: number;
    corrected: number;
    lost: number;
  };
}

export interface SpeakerBookOptions {
  store: SpeakerStore;
  jobs: SubtitleJobService;
  speakerJobs: SpeakerJobService;
  tts: TtsJobService;
  models: SpeakerModelService;
  voices: VoiceLookup | null;
  speakerVoices: SpeakerVoices;
}

/** Text of a paragraph outside its quotes (where a speaker is named). */
function narrationOf(p: SpeakerParagraph | undefined): string {
  if (!p) return '';
  let out = '';
  let at = 0;
  for (const q of p.quotes) {
    out += p.text.slice(at, q.start) + ' ';
    at = q.end;
  }
  return (out + p.text.slice(at)).normalize('NFKC');
}

export class SpeakerBookService {
  constructor(private readonly o: SpeakerBookOptions) {}

  /** The book as the reader reads it now, the stored quotes renumbered if it changed. */
  private async current(
    userId: string,
    bookId: string,
  ): Promise<{ book: SpeakerBook; renumbered: boolean }> {
    const script = await this.o.tts.bookScript(userId, bookId);
    const book = speakerBook(
      script as { version: number; characters: number; chapters: ScriptChapter[] },
    );
    const row = this.o.store.book(userId, bookId);
    let renumbered = false;
    if (row?.finishedAt) {
      const fileKey = (await this.o.tts.fileKey(userId, bookId)) ?? '';
      if (
        row.fileKey !== fileKey ||
        row.scriptVersion !== script.version ||
        row.dialogueRule !== DIALOGUE_RULE
      ) {
        this.o.store.rekey(userId, bookId, book.quotes, {
          fileKey,
          scriptVersion: script.version,
          dialogueRule: DIALOGUE_RULE,
        });
        this.o.speakerVoices.changed(userId, bookId);
        renumbered = true;
      }
    }
    return { book, renumbered };
  }

  private nameNearby(
    book: SpeakerBook,
    q: StoredQuote,
    chars: Map<number, StoredCharacter>,
  ): boolean {
    const c = q.character != null ? chars.get(q.character) : undefined;
    if (!c || q.paragraph == null) return false;
    const around = [-1, 0, 1].map((d) => narrationOf(book.paragraphs[q.paragraph! + d])).join(' ');
    const squeezed = around.replace(/[\s・]/gu, '');
    return [c.name, ...c.aliases]
      .map((n) => normalizeName(n))
      .filter((n) => Array.from(n).length >= 2)
      .some((n) => squeezed.includes(n));
  }

  private toCheck(q: StoredQuote, below: number, nearby: boolean): boolean {
    if (q.lost || q.corrected) return false;
    if (q.character == null) return true;
    return (q.modelP !== null && q.modelP < below) || !nearby;
  }

  async overview(userId: string, bookId: string, below: number): Promise<SpeakerOverview> {
    const job = this.o.speakerJobs.latest(userId, bookId);
    const row = this.o.store.book(userId, bookId);
    let renumbered = false;
    let book: SpeakerBook | null = null;
    if (row?.finishedAt) ({ book, renumbered } = await this.current(userId, bookId));
    const chars = this.o.store.characters(userId, bookId);
    const byId = new Map(chars.map((c) => [c.id, c]));
    const quotes = this.o.store.quotes(userId, bookId);
    const live = quotes.filter((q) => !q.lost);
    const counts = {
      quotes: live.length,
      check: book
        ? live.filter((q) => this.toCheck(q, below, this.nameNearby(book!, q, byId))).length
        : 0,
      unsure: live.filter((q) => !q.corrected && q.modelP !== null && q.modelP < below).length,
      none: live.filter((q) => q.character == null || byId.get(q.character)?.hidden).length,
      corrected: live.filter((q) => q.corrected).length,
      lost: quotes.length - live.length,
    };
    const model = row?.modelId ? this.o.models.get(row.modelId) : null;
    return {
      job,
      pcCanRun: this.o.speakerJobs.pcCanRun(),
      models: this.o.models.list(),
      run: row?.finishedAt
        ? {
            finishedAt: row.finishedAt,
            model: model?.label ?? null,
            quotes: row.quotes ?? live.length,
            renumbered,
          }
        : null,
      narrationBy: row?.narrationBy ?? 'narration',
      characters: chars.map((c) => ({
        ...c,
        voiceName: c.voiceId ? (this.o.voices?.byId(c.voiceId)?.name ?? null) : null,
      })),
      counts,
    };
  }

  async quotes(
    userId: string,
    bookId: string,
    q: {
      filter?: unknown;
      character?: unknown;
      below?: unknown;
      offset?: unknown;
      limit?: unknown;
    },
  ): Promise<{ items: QuoteItem[]; total: number }> {
    const filter = FILTERS.includes(q.filter as QuoteFilter) ? (q.filter as QuoteFilter) : 'check';
    const below = parseBelow(q.below);
    const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit) || 50)));
    const { book } = await this.current(userId, bookId);
    const chars = new Map(this.o.store.characters(userId, bookId).map((c) => [c.id, c]));
    const all = this.o.store.quotes(userId, bookId);
    const nearby = new Map(all.map((x) => [x.key, this.nameNearby(book, x, chars)]));
    const character = Number(q.character);
    let list = all.filter((x) => {
      switch (filter) {
        case 'check':
          return this.toCheck(x, below, nearby.get(x.key)!);
        case 'unsure':
          return !x.lost && !x.corrected && x.modelP !== null && x.modelP < below;
        case 'character':
          return !x.lost && x.character === character;
        case 'none':
          return !x.lost && (x.character == null || !!chars.get(x.character)?.hidden);
        case 'corrected':
          return !x.lost && x.corrected;
        case 'lost':
          return x.lost;
        default:
          return !x.lost;
      }
    });
    list =
      filter === 'unsure'
        ? list.sort((a, b) => (a.modelP ?? 0) - (b.modelP ?? 0) || a.quote - b.quote)
        : list.sort((a, b) => Number(a.lost) - Number(b.lost) || a.quote - b.quote);
    const items = list.slice(offset, offset + limit).map((x): QuoteItem => {
      const p = x.lost || x.paragraph == null ? undefined : book.paragraphs[x.paragraph];
      const span = p?.quotes.find((s) => s.quote === x.quote);
      const near = (d: number) => {
        const other = p ? book.paragraphs[p.index + d] : undefined;
        return other && other.chapter === p!.chapter ? other.text : null;
      };
      return {
        quote: x.quote,
        text: x.text,
        character: x.character,
        modelCharacter: x.modelCharacter,
        p: x.modelP,
        unknown: x.modelUnknown,
        corrected: x.corrected,
        lost: x.lost,
        nameNearby: nearby.get(x.key)!,
        paragraph: p && span ? { text: p.text, start: span.start, end: span.end } : null,
        before: near(-1),
        after: near(1),
      };
    });
    return { items, total: list.length };
  }
}

/** The "unsure below" bar from the device's setting (0..1; default 0.9). */
export function parseBelow(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.9;
}
