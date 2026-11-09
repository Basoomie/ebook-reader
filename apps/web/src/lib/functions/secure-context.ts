/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Browser features that only exist in a secure context (https or localhost).
 * The app is served over plain http for now (decided 2026-11-09), so every
 * caller must check here and degrade gracefully. All checks read the live
 * environment: served over https, the features switch on with no setting.
 */

type Env = typeof globalThis;

function env(): Env | undefined {
  return typeof globalThis === 'undefined' ? undefined : globalThis;
}

export function isSecureContext(g: Env | undefined = env()): boolean {
  return !!g && (g as { isSecureContext?: boolean }).isSecureContext === true;
}

export function canUseServiceWorker(g: Env | undefined = env()): boolean {
  return isSecureContext(g) && !!g?.navigator && 'serviceWorker' in g.navigator;
}

export function canPersistStorage(g: Env | undefined = env()): boolean {
  return typeof g?.navigator?.storage?.persist === 'function';
}

export function canEstimateStorage(g: Env | undefined = env()): boolean {
  return typeof g?.navigator?.storage?.estimate === 'function';
}

export function canUseWebLocks(g: Env | undefined = env()): boolean {
  return typeof (g?.navigator as Navigator | undefined)?.locks?.request === 'function';
}

/**
 * A random v4 UUID. Uses crypto.randomUUID when the page is a secure context,
 * otherwise builds one from crypto.getRandomValues (available on http).
 */
export function randomId(g: Env | undefined = env()): string {
  const c = g?.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No secure random number source available');
  }
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
