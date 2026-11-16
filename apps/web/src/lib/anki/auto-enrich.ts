/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { NoteInfo } from './anki-connect';
import type { LookupSentence } from './lookup-capture';

/**
 * Season 2 §4 (Phase 8): a card made with Yomitan while reading is enriched by itself, as
 * the Enrich button would do it.
 *
 * Fix of 2026-11-15 (decided with the user): the first version started a check when the
 * reader saw Yomitan's popup close. Yomitan by default keeps its popup in a closed shadow
 * root, which the page can't see, so no check ever ran. Now the reader asks Anki itself,
 * every few seconds (a setting) while a book is open and the page is visible:
 *
 * - A card qualifies when it was added after auto-enrich started for this book (a note id
 *   is the time it was added), its note type maps a Sentence field, and this reader hasn't
 *   handled it (by itself or by the button).
 * - Its sentence is the card's own (what Yomitan put in its Sentence field), placed in the
 *   book's loaded text. A card whose sentence isn't there wasn't made from this page: it is
 *   left alone, and tried again on later checks (without asking Anki again) in case the
 *   page changed, until another book is opened.
 * - Yomitan adds a note with all its fields at once (after storing its media), so a note
 *   that exists is complete.
 *
 * Anki not answering a check shows nothing. Checks never overlap. Never throws into the
 * reader.
 */

/** `added:2`: a card made just before Anki's day change (4 am) is still found. */
export const LOOKBACK_DAYS = 2;

/** The shortest time between checks, whatever the setting says. */
export const MIN_INTERVAL_MS = 1000;

export interface NewCard {
  note: NoteInfo;
  /** The card's own sentence, placed in the book. */
  sentence: LookupSentence;
}

export interface AutoEnrichDeps {
  /** The setting is on. */
  enabled(): boolean;
  /** The note type's mapped Sentence field, or null (not mapped). */
  sentenceField(noteType: string): string | null;
  /** Time between checks (ms), from the setting. */
  intervalMs(): number;
  /** The page is shown (no checks while it is hidden). */
  visible(): boolean;
  /** A card's sentence placed in the open book's loaded text, or null. */
  place(text: string): LookupSentence | null;
  recentNoteIds(days: number): Promise<number[]>;
  notesInfo(ids: number[]): Promise<NoteInfo[]>;
  /** Enriches the cards (oldest first); called inside `exclusive`. */
  enrich(cards: NewCard[]): Promise<void>;
  /** Runs `task` after any running Enrich (manual or automatic) and before the next one. */
  exclusive(task: () => Promise<void>): Promise<void>;
  log(message: string): void;
  now?(): number;
}

/** A field's text (Yomitan's sentence may hold <b>, <br> and entities). */
export function fieldText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\[sound:[^\]]*\]/g, '')
    .trim();
}

export class AutoEnricher {
  /** Cards added at or after this time qualify (when auto-enrich started for this book). */
  private since = 0;
  /** Cards this reader has handled (enriched, by hand too, or not of a mapped type). */
  private readonly handled = new Set<number>();
  /** Cards whose sentence wasn't in the loaded text yet, tried again on each check. */
  private unplaced = new Map<number, { note: NoteInfo; text: string }>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private failing = false;

  constructor(private readonly deps: AutoEnrichDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Starts checking (cards added from now on qualify). Calling it again changes nothing. */
  start(): void {
    if (this.stopped || this.started) return;

    this.started = true;
    this.since = this.now();
    this.schedule();
  }

  /** Another book was opened: only cards added from now on, placed in that book, qualify. */
  reset(): void {
    this.since = this.now();
    this.unplaced = new Map();
  }

  /** A card enriched by hand: never enriched by itself afterwards. */
  markHandled(noteId: number | undefined): void {
    if (typeof noteId === 'number') {
      this.handled.add(noteId);
      this.unplaced.delete(noteId);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One check now (e.g. the page was shown again); checks never overlap. */
  check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }

    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.deps.exclusive(() => this.findAndEnrich());
        } while (this.again && !this.stopped);
      } catch (error) {
        this.fail(error);
      } finally {
        this.running = null;
      }
    })();

    return this.running;
  }

  private schedule() {
    if (this.stopped) return;

    let interval = MIN_INTERVAL_MS;

    try {
      interval = Math.max(MIN_INTERVAL_MS, Number(this.deps.intervalMs()) || 0);
    } catch {
      // The shortest interval.
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, interval);
  }

  private async tick() {
    try {
      if (this.deps.enabled() && this.deps.visible()) await this.check();
    } catch (error) {
      this.fail(error);
    } finally {
      this.schedule();
    }
  }

  private async findAndEnrich() {
    if (this.stopped || !this.deps.enabled()) return;

    const cards: NewCard[] = [];
    let ids: number[];

    try {
      ids = await this.deps.recentNoteIds(LOOKBACK_DAYS);
    } catch (error) {
      this.noAnswer(error);
      return;
    }

    const candidates = ids
      .filter((id) => id >= this.since && !this.handled.has(id) && !this.unplaced.has(id))
      .sort((a, b) => a - b);
    let infos: NoteInfo[] = [];

    if (candidates.length) {
      try {
        infos = await this.deps.notesInfo(candidates);
      } catch (error) {
        this.noAnswer(error);
        return;
      }
    }

    if (this.failing) {
      this.failing = false;
      this.deps.log('Anki auto-enrich: Anki answers again');
    }

    const byId = new Map(infos.map((info) => [info.noteId, info]));

    for (const id of candidates) {
      const note = byId.get(id);
      const field = note ? this.deps.sentenceField(note.modelName) : null;
      const text = note && field ? fieldText(note.fields[field]?.value ?? '') : '';

      if (!note || !field || !text) {
        // Deleted since, not of a mapped note type, or no sentence: never asked about again.
        this.handled.add(id);
        continue;
      }

      this.unplaced.set(id, { note, text });
    }

    // New cards and the ones not placed before (the page may have changed), oldest first.
    for (const [id, { note, text }] of [...this.unplaced].sort((a, b) => a[0] - b[0])) {
      const sentence = this.deps.place(text);

      if (!sentence) {
        if (candidates.includes(id)) {
          this.deps.log(`Anki auto-enrich: card ${id}: its sentence isn't on this page (yet)`);
        }
        continue;
      }

      this.unplaced.delete(id);
      this.handled.add(id);
      this.deps.log(`Anki auto-enrich: card ${id} (${note.modelName})`);
      cards.push({ note, sentence });
    }

    if (cards.length) await this.deps.enrich(cards);
  }

  private noAnswer(error: unknown) {
    if (!this.failing) {
      this.failing = true;
      this.deps.log(`Anki auto-enrich: no check: ${(error as Error)?.message ?? error}`);
    }
  }

  private fail(error: unknown) {
    this.deps.log(`Anki auto-enrich: ${(error as Error)?.message ?? error}`);
  }
}
