/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbFontCache, openFontCacheDb, type CachedFont, type FontCache } from './font-cache-db';
import { customFontNames, fontNameProblem, formatFontSize, isFontFileName } from './font-names';
import { oldFontNames, planOldFontCleanup } from './old-browser-fonts';
import {
  FONT_KIND,
  ServerFonts,
  type FaceRegistry,
  type FontRecordData,
  type FontRecordLike
} from './server-fonts';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function data(name: string, bytes: string, sha256 = `sha-${bytes}`): FontRecordData {
  return {
    name,
    fileName: `${name}.woff2`,
    format: 'woff2',
    size: bytes.length,
    sha256,
    createdAt: 1
  };
}

function record(id: string, d: FontRecordData | null): FontRecordLike {
  return { kind: FONT_KIND, id, deletedAt: d ? null : 5, data: d ? { ...d } : {} };
}

class MemoryCache implements FontCache {
  files = new Map<string, CachedFont>();
  failGet = false;
  async getAll() {
    if (this.failGet) throw new Error('broken');
    return [...this.files.values()];
  }
  async put(font: CachedFont) {
    this.files.set(font.id, font);
  }
  async delete(id: string) {
    this.files.delete(id);
  }
}

class Faces implements FaceRegistry {
  registered = new Map<string, string>();
  refuse = new Set<string>();
  async register(id: string, name: string, blob: Blob) {
    if (this.refuse.has(name)) throw new Error('bad font');
    await blob.text();
    this.registered.set(id, name);
  }
  unregister(id: string) {
    this.registered.delete(id);
  }
}

function make(
  options: {
    files?: Record<string, string>;
    hash?: (blob: Blob) => Promise<string | null>;
    connected?: boolean;
  } = {}
) {
  const cache = new MemoryCache();
  const faces = new Faces();
  const downloads: string[] = [];
  const deletedNames: string[] = [];
  const warnings: string[] = [];
  const files = { ...(options.files ?? {}) };
  let connected = options.connected ?? true;
  const fonts = new ServerFonts({
    cache,
    faces,
    async download(id) {
      if (!connected) return null;
      downloads.push(id);
      if (!(id in files)) throw new Error('404');
      return new Blob([files[id]]);
    },
    hash: options.hash ?? (async (blob) => `sha-${await blob.text()}`),
    onFontDeleted: (name) => deletedNames.push(name),
    now: () => 100,
    warn: (m) => warnings.push(m)
  });
  return {
    fonts,
    cache,
    faces,
    downloads,
    deletedNames,
    warnings,
    files,
    connect: () => {
      connected = true;
    }
  };
}

describe('font names', () => {
  it('checks names like the server, plus names taken on this device', () => {
    expect(fontNameProblem('My Font')).toBeNull();
    expect(fontNameProblem('源ノ明朝')).toBeNull();
    expect(fontNameProblem('')).toMatch(/Enter a name/);
    expect(fontNameProblem('9pt')).toMatch(/starting with a letter/);
    expect(fontNameProblem('a,b')).toMatch(/letters, digits/);
    expect(fontNameProblem('Klee One')).toMatch(/built-in/);
    expect(fontNameProblem('cursive')).toMatch(/built-in/);
    expect(fontNameProblem('mine', ['Mine'])).toMatch(/already a font/);
  });

  it('lists the server fonts for the pickers once each', () => {
    expect(customFontNames(['A', 'B', 'A'])).toEqual(['A', 'B']);
  });

  it('plans the removal of the per-browser fonts (WP18)', () => {
    const raw = JSON.stringify([
      { name: 'Old', path: '/userfonts/Old', fileName: 'old.ttf' },
      { name: 'Both', path: '/userfonts/Both', fileName: 'both.ttf' }
    ]);
    const defaults = { groupOne: 'Noto Serif JP', groupTwo: 'Noto Sans JP' };
    expect(
      planOldFontCleanup(raw, { groupOne: 'Old', groupTwo: 'Both' }, defaults, ['Both'])
    ).toEqual({ groupOne: 'Noto Serif JP', removed: ['Old'] });
    expect(
      planOldFontCleanup(raw, { groupOne: 'Klee One', groupTwo: 'Old' }, defaults, [])
    ).toEqual({ groupTwo: 'Noto Sans JP', removed: ['Old', 'Both'] });
    expect(planOldFontCleanup(null, { groupOne: 'Old', groupTwo: 'Old' }, defaults, [])).toEqual({
      removed: []
    });
    expect(oldFontNames('not json')).toEqual([]);
    expect(oldFontNames('{"name":"x"}')).toEqual([]);
    expect(oldFontNames('[{"name":1},null,{"name":"A"}]')).toEqual(['A']);
  });

  it('knows font files and formats sizes', () => {
    expect(isFontFileName('x.WOFF2')).toBe(true);
    expect(isFontFileName('x.otf')).toBe(true);
    expect(isFontFileName('x.ttc')).toBe(false);
    expect(formatFontSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatFontSize(2048)).toBe('2 KB');
  });
});

describe('ServerFonts', () => {
  it('registers saved fonts at start and treats unknown names as pending until then', async () => {
    const t = make();
    await t.cache.put({
      id: ID_A,
      name: 'Saved',
      format: 'woff2',
      size: 3,
      sha256: 'sha-abc',
      blob: new Blob(['abc']),
      savedAt: 1
    });
    expect(t.fonts.isPending('Saved')).toBe(false); // not started: nothing to wait for
    const started = t.fonts.start();
    expect(t.fonts.isPending('Saved')).toBe(true);
    expect(t.fonts.isPending('Noto Serif JP')).toBe(false);
    await started;
    // Still waiting for the synced records (a server font may not be saved here yet).
    expect(t.fonts.isPending('Saved')).toBe(true);
    await t.fonts.applyRecords([], { initial: true });
    expect(t.fonts.isPending('Saved')).toBe(false);
    expect(t.faces.registered.get(ID_A)).toBe('Saved');
    expect(t.fonts.names$.getValue()).toEqual(['Saved']);
  });

  it('downloads new fonts, saves and registers them, and announces them', async () => {
    const t = make({ files: { [ID_A]: 'abc' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    const arrived: string[] = [];
    t.fonts.arrived$.subscribe((n) => arrived.push(n));
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    expect(t.downloads).toEqual([ID_A]);
    expect(t.cache.files.get(ID_A)?.sha256).toBe('sha-abc');
    expect(t.faces.registered.get(ID_A)).toBe('Mine');
    expect(arrived).toEqual(['Mine']);
    expect(t.fonts.fonts$.getValue().map((f) => [f.name, f.status])).toEqual([['Mine', 'saved']]);
    // Already saved: no second download.
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    expect(t.downloads).toEqual([ID_A]);
  });

  it('is pending while a font downloads, and wakes waiting readers', async () => {
    const t = make({ files: { [ID_A]: 'abc' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    const ready: string[] = [];
    const applying = t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    expect(t.fonts.isPending('Mine')).toBe(true);
    t.fonts.whenReady('Mine', () => ready.push('Mine'));
    t.fonts.whenReady('Other', () => ready.push('Other'));
    expect(ready).toEqual(['Other']);
    await applying;
    expect(ready).toEqual(['Other', 'Mine']);
  });

  it('re-downloads a saved file whose bytes differ from the record', async () => {
    const t = make({ files: { [ID_A]: 'new' } });
    await t.cache.put({
      id: ID_A,
      name: 'Mine',
      format: 'woff2',
      size: 3,
      sha256: 'sha-old',
      blob: new Blob(['old']),
      savedAt: 1
    });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'new'))]);
    expect(t.downloads).toEqual([ID_A]);
    expect(t.cache.files.get(ID_A)?.sha256).toBe('sha-new');
  });

  it('refuses damaged downloads, and checks only the size where it cannot hash', async () => {
    const t = make({ files: { [ID_A]: 'abc', [ID_B]: 'xyz' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([
      record(ID_A, data('Short', 'abcd')),
      record(ID_B, data('Bad', 'xyz', 'sha-other'))
    ]);
    expect(t.cache.files.size).toBe(0);
    expect(t.fonts.fonts$.getValue().map((f) => f.status)).toEqual(['failed', 'failed']);
    expect(t.warnings.join('\n')).toMatch(/instead of 4/);
    expect(t.warnings.join('\n')).toMatch(/damaged/);
    // Failed fonts don't keep the reader waiting.
    expect(t.fonts.isPending('Bad')).toBe(false);

    const plain = make({ files: { [ID_B]: 'xyz' }, hash: async () => null });
    await plain.fonts.start();
    await plain.fonts.applyRecords([], { initial: true });
    await plain.fonts.applyRecords([record(ID_B, data('Plain', 'xyz', 'sha-unchecked'))]);
    expect(plain.faces.registered.get(ID_B)).toBe('Plain');
  });

  it('waits without a server connection and fetches after connecting', async () => {
    const t = make({ files: { [ID_A]: 'abc' }, connected: false });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    expect(t.fonts.fonts$.getValue()[0].status).toBe('waiting');
    expect(t.fonts.isPending('Mine')).toBe(false);
    // Listed for the pickers even before it is here.
    expect(t.fonts.names$.getValue()).toEqual(['Mine']);
    t.connect();
    await t.fonts.retry();
    expect(t.fonts.fonts$.getValue()[0].status).toBe('saved');
  });

  it('removes deleted fonts everywhere on this device and reports the name', async () => {
    const t = make({ files: { [ID_A]: 'abc' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    await t.fonts.applyRecords([record(ID_A, null)]);
    expect(t.cache.files.size).toBe(0);
    expect(t.faces.registered.size).toBe(0);
    expect(t.fonts.fonts$.getValue()).toEqual([]);
    expect(t.fonts.names$.getValue()).toEqual([]);
    expect(t.deletedNames).toEqual(['Mine']);
    // Deleting a font this device never had changes nothing.
    await t.fonts.applyRecords([record(ID_B, null)]);
    expect(t.deletedNames).toEqual(['Mine']);
  });

  it('keeps the name when another live font has it (deleted and uploaded again)', async () => {
    const t = make({ files: { [ID_A]: 'abc', [ID_B]: 'xyz' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([
      record(ID_A, data('Mine', 'abc')),
      record(ID_B, data('Mine', 'xyz'))
    ]);
    await t.fonts.applyRecords([record(ID_A, null)]);
    expect(t.deletedNames).toEqual([]);
    expect(t.fonts.names$.getValue()).toEqual(['Mine']);
  });

  it('saves an upload from this device without downloading it', async () => {
    const t = make();
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.addUploaded(ID_A, data('Up', 'abc'), new Blob(['abc']));
    await t.fonts.applyRecords([record(ID_A, data('Up', 'abc'))]);
    expect(t.downloads).toEqual([]);
    expect(t.fonts.fonts$.getValue()[0].status).toBe('saved');
  });

  it('never throws: a broken cache or a font the browser refuses only warns', async () => {
    const t = make({ files: { [ID_A]: 'abc' } });
    t.cache.failGet = true;
    t.faces.refuse.add('Refused');
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    expect(t.fonts.isPending('Anything')).toBe(false);
    await t.fonts.applyRecords([
      record(ID_A, data('Refused', 'abc')),
      { kind: FONT_KIND, id: ID_B, deletedAt: null, data: { name: 1 } }
    ]);
    expect(t.fonts.fonts$.getValue().map((f) => f.status)).toEqual(['failed']);
    expect(t.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ServerFonts without a sync engine', () => {
  it('stops waiting for records that can never be read', async () => {
    const t = make();
    await t.fonts.start();
    expect(t.fonts.isPending('Mine')).toBe(true);
    const ready: string[] = [];
    t.fonts.whenReady('Mine', () => ready.push('Mine'));
    t.fonts.noRecords();
    expect(t.fonts.isPending('Mine')).toBe(false);
    expect(ready).toEqual(['Mine']);
  });
});

describe('IdbFontCache', () => {
  it('stores, lists and deletes font files', async () => {
    const cache = new IdbFontCache(() => openFontCacheDb('font-cache-test'));
    const font: CachedFont = {
      id: ID_A,
      name: 'Mine',
      format: 'woff2',
      size: 3,
      sha256: 'x',
      blob: new Blob(['abc']),
      savedAt: 1
    };
    await cache.put(font);
    const all = await cache.getAll();
    expect(all.map((f) => f.id)).toEqual([ID_A]);
    await cache.delete(ID_A);
    expect(await cache.getAll()).toEqual([]);
  });
});
