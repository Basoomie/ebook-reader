/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { NoteInfo } from './anki-connect';
import type { LookupRecord } from './lookup-capture';

/**
 * Season 2 §4 (Phase 8): a card made with Yomitan while reading is enriched by itself, as
 * the Enrich button would do it. A lookup alone (checking a word, no card) changes nothing.
 *
 * Decided with the user (2026-11-14/15):
 * - After each lookup ends (the popup is hidden or moves on to another word), Anki is asked
 *   for new notes, plus one re-check RECHECK_MS after the last lookup ended, for a card
 *   still being saved. Yomitan stores the card's media (e.g. downloads the word audio)
 *   before it adds the note, so the note can appear after the popup closed. No setting.
 * - A card qualifies when it was added after the start of a lookup that is still open (not
 *   yet re-checked), its note type is mapped, and this reader hasn't handled it (by itself
 *   or by the button). Every new card from one lookup qualifies.
 * - The sentence is the lookup's with the latest start before the card was added (a note id
 *   is the time it was added, in milliseconds).
 *
 * Anki not answering a check shows nothing: no card can have been made through it then.
 * Never throws into the reader.
 */

/** The re-check after the last lookup ended (fixed, decided with the user). */
export const RECHECK_MS = 2000;

/** `added:2`: a lookup across Anki's day change (4 am) still finds its card. */
export const LOOKBACK_DAYS = 2;

/** Lookups kept open at most (continuous hovering on a desktop never lets one re-check run). */
const MAX_OPEN = 200;

export interface NewCard {
  note: NoteInfo;
  lookup: LookupRecord;
}

export interface AutoEnrichDeps {
  /** The setting is on and some note type is mapped. */
  enabled(): boolean;
  isMapped(noteType: string): boolean;
  recentNoteIds(days: number): Promise<number[]>;
  notesInfo(ids: number[]): Promise<NoteInfo[]>;
  /** Enriches the cards (oldest first); called inside `exclusive`. */
  enrich(cards: NewCard[]): Promise<void>;
  /** Runs `task` after any running Enrich (manual or automatic) and before the next one. */
  exclusive(task: () => Promise<void>): Promise<void>;
  log(message: string): void;
}

export class AutoEnricher {
  /** Lookups from their start until a re-check after their end has run, oldest first. */
  private open: LookupRecord[] = [];
  /** Cards this reader has handled (enriched by itself or by hand, or not of a mapped type). */
  private readonly handled = new Set<number>();
  private running: Promise<void> | null = null;
  private again = false;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEndedAt = 0;
  private stopped = false;

  constructor(private readonly deps: AutoEnrichDeps) {}

  /** For LookupCapture.onLookup. */
  readonly onLookup = (lookup: LookupRecord, change: 'start' | 'end'): void => {
    if (this.stopped) return;

    try {
      if (!this.deps.enabled()) {
        this.open = [];
        return;
      }

      if (change === 'start') {
        this.open.push(lookup);
        if (this.open.length > MAX_OPEN) this.open.splice(0, this.open.length - MAX_OPEN);
        return;
      }

      this.lastEndedAt = Math.max(this.lastEndedAt, lookup.endedAt ?? Date.now());
      void this.check();

      if (this.recheckTimer) clearTimeout(this.recheckTimer);
      this.recheckTimer = setTimeout(() => {
        this.recheckTimer = null;
        void this.recheck();
      }, RECHECK_MS);
    } catch (error) {
      this.fail(error);
    }
  };

  /** A card enriched by hand: never enriched by itself afterwards. */
  markHandled(noteId: number | undefined): void {
    if (typeof noteId === 'number') this.handled.add(noteId);
  }

  /** Another book was opened: its lookups no longer give a card its sentence. */
  reset(): void {
    this.open = [];
  }

  stop(): void {
    this.stopped = true;
    this.open = [];
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  /** One check now; checks never overlap (one more runs after the current one). */
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

  private async recheck() {
    const cutoff = this.lastEndedAt;
    await this.check();
    // These lookups had their re-check; one that ended since keeps its own.
    this.open = this.open.filter((l) => l.endedAt === null || l.endedAt > cutoff);
  }

  private async findAndEnrich() {
    if (this.stopped || !this.open.length) return;

    if (!this.deps.enabled()) {
      this.open = [];
      return;
    }

    const since = Math.min(...this.open.map((l) => l.startedAt));
    let ids: number[];

    try {
      ids = await this.deps.recentNoteIds(LOOKBACK_DAYS);
    } catch (error) {
      this.deps.log(`Anki auto-enrich: no check: ${(error as Error)?.message ?? error}`);
      return;
    }

    const candidates = ids
      .filter((id) => id >= since && !this.handled.has(id))
      .sort((a, b) => a - b);

    if (!candidates.length) return;

    let infos: NoteInfo[];

    try {
      infos = await this.deps.notesInfo(candidates);
    } catch (error) {
      this.deps.log(`Anki auto-enrich: no check: ${(error as Error)?.message ?? error}`);
      return;
    }

    const cards: NewCard[] = [];
    const byId = new Map(infos.map((info) => [info.noteId, info]));

    for (const id of candidates) {
      const note = byId.get(id);
      // Deleted since, or not of a mapped note type: never asked about again.
      this.handled.add(id);

      if (!note || !this.deps.isMapped(note.modelName)) continue;

      const lookup = this.lookupFor(id);

      if (!lookup) continue;

      // Measures how long Yomitan takes to save a card (the reason for the re-check).
      const after =
        lookup.endedAt === null || id <= lookup.endedAt
          ? 'while its lookup was shown'
          : `${id - lookup.endedAt} ms after its lookup ended`;
      this.deps.log(`Anki auto-enrich: card ${id} (${note.modelName}) added ${after}`);
      cards.push({ note, lookup });
    }

    if (cards.length) await this.deps.enrich(cards);
  }

  /** The open lookup with the latest start at or before the card was added. */
  private lookupFor(noteId: number): LookupRecord | null {
    let found: LookupRecord | null = null;

    for (const lookup of this.open) {
      if (lookup.startedAt <= noteId && (!found || lookup.startedAt >= found.startedAt)) {
        found = lookup;
      }
    }

    return found;
  }

  private fail(error: unknown) {
    this.deps.log(`Anki auto-enrich: ${(error as Error)?.message ?? error}`);
  }
}
