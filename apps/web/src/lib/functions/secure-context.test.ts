/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canEstimateStorage,
  canPersistStorage,
  canUseServiceWorker,
  canUseWebLocks,
  isSecureContext,
  randomId
} from './secure-context';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What a browser exposes on plain http: no secure-context APIs, getRandomValues only. */
const httpPage = {
  isSecureContext: false,
  navigator: {},
  crypto: { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) }
} as unknown as typeof globalThis;

/** The same browser over https. */
const httpsPage = {
  isSecureContext: true,
  navigator: {
    serviceWorker: {},
    storage: { persist: async () => true, estimate: async () => ({}) },
    locks: { request: async () => null }
  },
  crypto: webcrypto
} as unknown as typeof globalThis;

describe('secure-context capabilities', () => {
  it('reports everything as missing on plain http', () => {
    expect(isSecureContext(httpPage)).toBe(false);
    expect(canUseServiceWorker(httpPage)).toBe(false);
    expect(canPersistStorage(httpPage)).toBe(false);
    expect(canEstimateStorage(httpPage)).toBe(false);
    expect(canUseWebLocks(httpPage)).toBe(false);
  });

  it('switches everything on over https without any setting', () => {
    expect(isSecureContext(httpsPage)).toBe(true);
    expect(canUseServiceWorker(httpsPage)).toBe(true);
    expect(canPersistStorage(httpsPage)).toBe(true);
    expect(canEstimateStorage(httpsPage)).toBe(true);
    expect(canUseWebLocks(httpsPage)).toBe(true);
  });

  it('does not report a service worker outside a secure context even if the object exists', () => {
    const odd = { ...httpPage, navigator: { serviceWorker: {} } } as unknown as typeof globalThis;
    expect(canUseServiceWorker(odd)).toBe(false);
  });

  it('makes v4 UUIDs on http (getRandomValues) and https (randomUUID)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) ids.add(randomId(httpPage));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(randomId(httpsPage)).toMatch(UUID_V4);
  });

  it('refuses to make an id without a random source', () => {
    expect(() => randomId({} as typeof globalThis)).toThrow();
  });
});
