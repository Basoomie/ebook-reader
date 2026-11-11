/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { combineLatest, map, type Observable } from 'rxjs';
import { APPEARANCE_SETTINGS } from '$lib/components/book-reader/appearance-settings';
import { IdbFontCache } from '$lib/fonts/font-cache-db';
import { customFontNames } from '$lib/fonts/font-names';
import {
  FONT_KIND,
  ServerFonts,
  type FaceRegistry,
  type FontRecordLike
} from '$lib/fonts/server-fonts';
import { fontFamilyGroupOne$, fontFamilyGroupTwo$, userFonts$ } from '$lib/data/store';
import { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { logger } from '$lib/data/logger';

/**
 * The browser side of server-synced fonts (WP13): the FontFace registry, downloads with
 * this device's token, and the one ServerFonts instance of the app. Started from the
 * root layout; every failure is only logged.
 */

/**
 * Registers fonts with the FontFace API (works over plain http, unlike the Cache API
 * and service worker the per-browser fonts use). Without FontFace, an @font-face rule
 * with a blob: URL does the same.
 */
export class BrowserFaceRegistry implements FaceRegistry {
  private readonly faces = new Map<
    string,
    { face: FontFace } | { style: HTMLStyleElement; url: string }
  >();

  async register(id: string, name: string, blob: Blob): Promise<void> {
    this.unregister(id);
    if (typeof FontFace === 'function' && typeof document.fonts?.add === 'function') {
      const face = new FontFace(name, await blob.arrayBuffer(), { display: 'swap' });
      await face.load();
      document.fonts.add(face);
      this.faces.set(id, { face });
      return;
    }
    const url = URL.createObjectURL(blob);
    const style = document.createElement('style');
    style.dataset.ttuServerFont = id;
    // Names are letters, digits, spaces, - and _ only (checked by the server).
    style.textContent = `@font-face{font-family:'${name}';font-display:swap;src:url('${url}')}`;
    document.head.appendChild(style);
    this.faces.set(id, { style, url });
  }

  unregister(id: string): void {
    const entry = this.faces.get(id);
    if (!entry) return;
    this.faces.delete(id);
    if ('face' in entry) {
      document.fonts.delete(entry.face);
    } else {
      entry.style.remove();
      URL.revokeObjectURL(entry.url);
    }
  }
}

/** SHA-256 needs crypto.subtle, which browsers offer only in a secure context. */
async function sha256(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The API client for this device's server connection, or null when not connected. */
export async function fontApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  if (!connection) return null;
  return new LibraryApi(
    connection.serverUrl,
    connection.token,
    libraryRequestTimeoutSeconds$.getValue()
  );
}

/** A deleted font this device uses: back to the bundled default, as the old dialog did. */
function resetDeletedFont(name: string): void {
  for (const [subject, fallback] of [
    [fontFamilyGroupOne$, APPEARANCE_SETTINGS.fontFamilyGroupOne.defaultValue as string],
    [fontFamilyGroupTwo$, APPEARANCE_SETTINGS.fontFamilyGroupTwo.defaultValue as string]
  ] as const) {
    if (subject.getValue() === name) {
      logger.warn(`Fonts: "${name}" was deleted; this device uses ${fallback} again`);
      subject.next(fallback);
    }
  }
}

export const serverFonts = new ServerFonts({
  cache: new IdbFontCache(),
  faces: browser
    ? new BrowserFaceRegistry()
    : { register: () => Promise.reject(new Error('no browser')), unregister: () => {} },
  async download(id) {
    const api = await fontApi();
    return api ? api.downloadFont(id) : null;
  },
  hash: sha256,
  onFontDeleted: resetDeletedFont,
  warn: (m) => logger.warn(m)
});

/** Custom fonts for the pickers: server fonts, then this browser's own fonts. */
export const customFontNames$: Observable<string[]> = combineLatest([
  serverFonts.names$,
  userFonts$
]).pipe(map(([server, local]) => customFontNames(server, local)));

let started = false;

/** Starts the font service for this tab (root layout). Never throws. */
export function startServerFonts(): void {
  if (!browser || started) return;
  started = true;
  const onRecords = (records: readonly FontRecordLike[]) => {
    const fonts = records.filter((r) => r.kind === FONT_KIND);
    if (fonts.length) void serverFonts.applyRecords(fonts);
  };
  void serverFonts
    .start()
    .then(() => import('$lib/sync/sync-service'))
    .then(({ getSyncEngine }) => getSyncEngine())
    .then(async (engine) => {
      engine.onRemoteChange(onRecords);
      engine.onLocalWrite((record) => onRecords([record]));
      void serverFonts.applyRecords(await engine.getAll(FONT_KIND), { initial: true });
    })
    .catch((error) => {
      serverFonts.noRecords();
      logger.warn(`Fonts: not started: ${(error as Error)?.message ?? error}`);
    });
  window.addEventListener('online', () => void serverFonts.retry());
}

/** For the readers: wait for this family before measuring the page. */
export function isServerFontPending(name: string): boolean {
  try {
    return browser && serverFonts.isPending(name);
  } catch {
    return false;
  }
}

/** For the readers: calls `ready` once the family is no longer pending. */
export function whenServerFontReady(name: string, ready: () => void): () => void {
  try {
    return serverFonts.whenReady(name, ready);
  } catch {
    ready();
    return () => {};
  }
}
