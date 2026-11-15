/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbFontCache, openFontCacheDb, type CachedFont, type FontCache } from './font-cache-db';
import {
  customFontNames,
  fontNameProblem,
  formatFontSize,
  googleCategory,
  isFontFileName,
  licenseName,
  weightsLabel
} from './font-names';
import {
  GooglePreviews,
  previewCssUrl,
  previewFamilyName,
  previewFontUrl,
  type PreviewDeps
} from './google-preview';
import { oldFontNames, planOldFontCleanup } from './old-browser-fonts';
import {
  FONT_KIND,
  fontRecordData,
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
  /** The other weights each font was registered with, and their bytes. */
  weights = new Map<string, Record<number, string>>();
  refuse = new Set<string>();
  async register(
    id: string,
    name: string,
    blob: Blob,
    faces: readonly { weight: number; blob: Blob }[] = []
  ) {
    if (this.refuse.has(name)) throw new Error('bad font');
    await blob.text();
    const weights: Record<number, string> = {};
    for (const f of faces) weights[f.weight] = await f.blob.text();
    this.registered.set(id, name);
    this.weights.set(id, weights);
  }
  unregister(id: string) {
    this.registered.delete(id);
    this.weights.delete(id);
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
    async download(id, weight) {
      if (!connected) return null;
      const key = weight === undefined ? id : `${id}:${weight}`;
      downloads.push(key);
      if (!(key in files)) throw new Error('404');
      return new Blob([files[key]]);
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

/** A Google font's record data: regular `bytes`, bold `bold` (Phase 10). */
function googleData(name: string, bytes: string, bold: string | null, boldSha = `sha-${bold}`) {
  return {
    ...data(name, bytes),
    source: 'google' as const,
    copyright: 'Copyright 2021 The Zen Old Mincho Project Authors',
    licenseUrl: 'https://scripts.sil.org/OFL',
    faces:
      bold === null ? [] : [{ weight: 700, format: 'woff2', size: bold.length, sha256: boldSha }]
  };
}

describe('ServerFonts with Google fonts (Phase 10)', () => {
  it('downloads the regular and bold files, saves both and registers bold with its weight', async () => {
    const t = make({ files: { [ID_A]: 'reg', [`${ID_A}:700`]: 'bold!' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    const arrived: string[] = [];
    t.fonts.arrived$.subscribe((n) => arrived.push(n));
    await t.fonts.applyRecords([record(ID_A, googleData('Zen Old Mincho', 'reg', 'bold!'))]);
    expect(t.downloads).toEqual([ID_A, `${ID_A}:700`]);
    expect(t.faces.registered.get(ID_A)).toBe('Zen Old Mincho');
    expect(t.faces.weights.get(ID_A)).toEqual({ 700: 'bold!' });
    const saved = t.cache.files.get(ID_A);
    expect(await saved?.blob.text()).toBe('reg');
    expect(saved?.faces?.map((f) => [f.weight, f.sha256])).toEqual([[700, 'sha-bold!']]);
    expect(arrived).toEqual(['Zen Old Mincho']);
    expect(t.fonts.fonts$.getValue()).toEqual([
      expect.objectContaining({
        name: 'Zen Old Mincho',
        status: 'saved',
        source: 'google',
        size: 8,
        weights: [400, 700],
        licenseUrl: 'https://scripts.sil.org/OFL',
        copyright: 'Copyright 2021 The Zen Old Mincho Project Authors'
      })
    ]);
    // Registered again at the next start, bold included, without downloading.
    const again = make();
    again.cache.files = t.cache.files;
    await again.fonts.start();
    expect(again.faces.weights.get(ID_A)).toEqual({ 700: 'bold!' });
    await again.fonts.applyRecords([record(ID_A, googleData('Zen Old Mincho', 'reg', 'bold!'))], {
      initial: true
    });
    expect(again.downloads).toEqual([]);
    expect(again.fonts.fonts$.getValue()[0].status).toBe('saved');
  });

  it('saves nothing when the bold file fails, and tries again later', async () => {
    const t = make({ files: { [ID_A]: 'reg' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, googleData('Zen', 'reg', 'bold!'))]);
    expect(t.fonts.fonts$.getValue()[0].status).toBe('failed');
    expect(t.cache.files.size).toBe(0);
    expect(t.faces.registered.size).toBe(0);
    expect(t.fonts.isPending('Zen')).toBe(false);
    t.files[`${ID_A}:700`] = 'bold!';
    await t.fonts.retry();
    expect(t.fonts.fonts$.getValue()[0].status).toBe('saved');
    expect(t.faces.weights.get(ID_A)).toEqual({ 700: 'bold!' });
  });

  it('refuses a damaged bold file', async () => {
    const t = make({ files: { [ID_A]: 'reg', [`${ID_A}:700`]: 'bold!' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, googleData('Zen', 'reg', 'bold!', 'sha-other'))]);
    expect(t.fonts.fonts$.getValue()[0].status).toBe('failed');
    expect(t.warnings.join('\n')).toMatch(/damaged \(weight 700\)/);
  });

  it('keeps a saved regular file and downloads only the missing bold', async () => {
    const t = make({ files: { [`${ID_A}:700`]: 'bold!' } });
    // Saved by an app version that took only the regular file.
    await t.cache.put({
      id: ID_A,
      name: 'Zen',
      format: 'woff2',
      size: 3,
      sha256: 'sha-reg',
      blob: new Blob(['reg']),
      savedAt: 1
    });
    await t.fonts.start();
    expect(t.faces.weights.get(ID_A)).toEqual({});
    await t.fonts.applyRecords([record(ID_A, googleData('Zen', 'reg', 'bold!'))], {
      initial: true
    });
    expect(t.downloads).toEqual([`${ID_A}:700`]);
    expect(t.faces.weights.get(ID_A)).toEqual({ 700: 'bold!' });
    expect(t.fonts.fonts$.getValue()[0].status).toBe('saved');
  });

  it('stores a regular-only Google font as one file', async () => {
    const t = make({ files: { [ID_A]: 'reg' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, googleData('Hina', 'reg', null))]);
    expect(t.downloads).toEqual([ID_A]);
    expect(t.cache.files.get(ID_A)?.faces).toBeUndefined();
    expect(t.fonts.fonts$.getValue()[0]).toMatchObject({ status: 'saved', weights: [400] });
  });

  it('reads Google records and leaves uploaded ones as they were', () => {
    const base = data('Mine', 'abc');
    expect(fontRecordData({ ...base })).toEqual(base);
    // Faces on a record that isn't a Google font are not read.
    expect(fontRecordData({ ...base, faces: [{ weight: 700 }] })).toEqual(base);
    expect(
      fontRecordData({
        ...base,
        source: 'google',
        copyright: 7,
        faces: [
          { weight: 900, format: 'woff2', size: 1, sha256: 'b' },
          { weight: 700, format: 'woff2', size: 1, sha256: 'a' },
          { weight: 700, format: 'woff2', size: 2, sha256: 'dup' },
          { weight: 400, format: 'woff2', size: 1, sha256: 'regular' },
          { weight: 'bold', format: 'woff2', size: 1, sha256: 'x' },
          null
        ]
      })
    ).toEqual({
      ...base,
      source: 'google',
      copyright: null,
      licenseUrl: null,
      faces: [
        { weight: 700, format: 'woff2', size: 1, sha256: 'a' },
        { weight: 900, format: 'woff2', size: 1, sha256: 'b' }
      ]
    });
  });

  it('shows an uploaded font as one regular file', async () => {
    const t = make({ files: { [ID_A]: 'abc' } });
    await t.fonts.start();
    await t.fonts.applyRecords([], { initial: true });
    await t.fonts.applyRecords([record(ID_A, data('Mine', 'abc'))]);
    expect(t.fonts.fonts$.getValue()[0]).toMatchObject({
      source: 'upload',
      weights: [400],
      copyright: null,
      licenseUrl: null
    });
    expect(t.faces.weights.get(ID_A)).toEqual({});
  });
});

describe('Google Fonts wording (Phase 10)', () => {
  it('names the license, the category and the weights in plain words', () => {
    expect(licenseName('https://scripts.sil.org/OFL')).toBe('SIL Open Font License');
    expect(licenseName('http://scripts.sil.org/OFL')).toBe('SIL Open Font License');
    expect(licenseName('https://openfontlicense.org')).toBe('SIL Open Font License');
    expect(licenseName('https://www.apache.org/licenses/LICENSE-2.0')).toBe('Apache License 2.0');
    expect(licenseName('https://example.com/license')).toBe('https://example.com/license');
    expect(licenseName(null)).toBeNull();
    expect(googleCategory('Serif')).toBe('Mincho (serif)');
    expect(googleCategory('Sans Serif')).toBe('Gothic (sans-serif)');
    expect(googleCategory('Handwriting')).toBe('Handwriting');
    expect(googleCategory('')).toBe('Other');
    expect(weightsLabel([400, 700])).toBe('Regular and bold');
    expect(weightsLabel([400])).toBe('Regular only');
  });
});

describe('Google Fonts samples (Phase 10)', () => {
  it('asks Google for just the sample text and takes only fonts.gstatic.com files', () => {
    expect(previewCssUrl('Zen Old Mincho', 'ab')).toBe(
      'https://fonts.googleapis.com/css2?family=Zen+Old+Mincho&text=ab'
    );
    expect(previewFamilyName('M PLUS 1p')).toBe('ttu-preview-m-plus-1p');
    expect(
      previewFontUrl("src: url(https://fonts.gstatic.com/l/font?kit=x&v=v14) format('truetype');")
    ).toBe('https://fonts.gstatic.com/l/font?kit=x&v=v14');
    expect(previewFontUrl('src: url(https://evil.example/a.woff2)')).toBeNull();
    expect(previewFontUrl('nothing')).toBeNull();
  });

  it('loads each sample once, a few at a time, and removes them all on close', async () => {
    const css: string[] = [];
    const removed: string[] = [];
    let open = 0;
    let most = 0;
    const deps: PreviewDeps = {
      async fetchCss(url) {
        css.push(url);
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        if (url.includes('Broken')) throw new Error('offline');
        return `src: url(https://fonts.gstatic.com/l/${css.length})`;
      },
      async addFace(name) {
        return { remove: () => removed.push(name) };
      }
    };
    const previews = new GooglePreviews(deps, 2);
    const names = ['A', 'B', 'C', 'Broken', 'A'];
    const results = await Promise.all(names.map((n) => previews.load(n)));
    expect(results).toEqual([
      'ttu-preview-a',
      'ttu-preview-b',
      'ttu-preview-c',
      null,
      'ttu-preview-a'
    ]);
    expect(css).toHaveLength(4);
    expect(most).toBe(2);
    previews.close();
    expect(removed.sort()).toEqual(['ttu-preview-a', 'ttu-preview-b', 'ttu-preview-c']);
    expect(await previews.load('D')).toBeNull();
  });

  it('shows no samples where the browser has no FontFace', async () => {
    expect(await new GooglePreviews(null).load('A')).toBeNull();
  });
});
