/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { skip } from 'rxjs';
import type { localStorage } from '../window/local-storage';
import { writableSubject } from '$lib/functions/svelte/store';

type Storage = typeof localStorage;

/** A live setting as its subject was created: what "Copy settings from another device" writes. */
export interface LiveStorageSetting {
  subject: { next(value: unknown): void; getValue(): unknown };
  defaultValue: unknown;
  /** The subject's own reading of a stored string (as on page load). */
  mapFromString: (s: string) => unknown;
}

const liveSettings = new Map<string, LiveStorageSetting[]>();

/** The subjects created for a localStorage key (normally exactly one). */
export function liveStorageSettings(key: string): readonly LiveStorageSetting[] {
  return liveSettings.get(key) ?? [];
}

export function writableStorageSubject<T>(
  storage: Storage,
  mapFromString: (s: string) => T,
  mapToString: (t: T) => string
) {
  return (key: string, defaultValue: T) => {
    const initValue = getStoredOrDefault(storage)(key, defaultValue, mapFromString);
    const subject = writableSubject(initValue);
    subject.pipe(skip(1)).subscribe((updatedValue) => {
      storage.setItem(key, mapToString(updatedValue ?? defaultValue));
    });
    const live = liveSettings.get(key) ?? [];
    live.push({
      subject: subject as unknown as LiveStorageSetting['subject'],
      defaultValue,
      mapFromString
    });
    liveSettings.set(key, live);
    return subject;
  };
}

function getStoredOrDefault(storage: Storage) {
  return <T>(key: string, defaultVal: T, mapFn: (s: string) => T) => {
    const stored = storage.getItem(key);
    return stored ? mapFn(stored) : defaultVal;
  };
}
