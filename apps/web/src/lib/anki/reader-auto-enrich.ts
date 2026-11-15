/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { AnkiConnect } from './anki-connect';
import { AutoEnricher, type NewCard } from './auto-enrich';
import { hasMapping, parseMapping } from './mapping';
import {
  ankiAutoEnrich$,
  ankiConnectKey$,
  ankiConnectTimeoutSeconds$,
  ankiConnectUrl$,
  ankiFieldMapping$
} from './settings';

/**
 * Phase 8: the reader's automatic enrichment, wired to this device's settings. One
 * AnkiConnect client is kept for the checks (made again when its address, key or timeout
 * changes), so the permission request isn't repeated on every lookup.
 */

export interface ReaderAutoEnrichOptions {
  exclusive(task: () => Promise<void>): Promise<void>;
  enrich(cards: NewCard[]): Promise<void>;
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
  const mapping = () => parseMapping(ankiFieldMapping$.getValue());

  return new AutoEnricher({
    enabled: () => {
      if (!ankiAutoEnrich$.getValue()) return false;
      const current = mapping();
      return Object.keys(current).some((type) => hasMapping(current, type));
    },
    isMapped: (noteType) => hasMapping(mapping(), noteType),
    recentNoteIds: (days) => anki().recentNoteIds(days),
    notesInfo: (ids) => anki().notesInfo(ids),
    enrich: options.enrich,
    exclusive: options.exclusive,
    log: options.log
  });
}
