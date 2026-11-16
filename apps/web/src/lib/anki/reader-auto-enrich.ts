/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { AnkiConnect } from './anki-connect';
import { AutoEnricher, type NewCard } from './auto-enrich';
import type { LookupSentence } from './lookup-capture';
import { parseMapping } from './mapping';
import {
  ankiAutoEnrich$,
  ankiAutoEnrichSeconds$,
  ankiConnectKey$,
  ankiConnectTimeoutSeconds$,
  ankiConnectUrl$,
  ankiFieldMapping$
} from './settings';

/**
 * Phase 8: the reader's automatic enrichment, wired to this device's settings. One
 * AnkiConnect client is kept for the checks (made again when its address, key or timeout
 * changes), so the permission request isn't repeated on every check.
 */

export interface ReaderAutoEnrichOptions {
  exclusive(task: () => Promise<void>): Promise<void>;
  enrich(cards: NewCard[]): Promise<void>;
  /** A card's sentence placed in the open book's loaded text, or null. */
  place(text: string): LookupSentence | null;
  log(message: string): void;
}

export function createReaderAutoEnricher(options: ReaderAutoEnrichOptions): AutoEnricher {
  let client: { key: string; anki: AnkiConnect } | null = null;

  const anki = () => {
    const url = ankiConnectUrl$.getValue();
    const key = ankiConnectKey$.getValue();
    const timeoutSeconds = Number(ankiConnectTimeoutSeconds$.getValue()) || 10;
    const id = `${url}\n${key}\n${timeoutSeconds}`;

    if (client?.key !== id) {
      client = { key: id, anki: new AnkiConnect({ url, key, timeoutSeconds }) };
    }

    return client.anki;
  };

  return new AutoEnricher({
    enabled: () => !!ankiAutoEnrich$.getValue(),
    sentenceField: (noteType) =>
      parseMapping(ankiFieldMapping$.getValue())[noteType]?.sentence?.field ?? null,
    intervalMs: () => (Number(ankiAutoEnrichSeconds$.getValue()) || 3) * 1000,
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    place: options.place,
    recentNoteIds: (days) => anki().recentNoteIds(days),
    notesInfo: (ids) => anki().notesInfo(ids),
    enrich: options.enrich,
    exclusive: options.exclusive,
    log: options.log
  });
}
