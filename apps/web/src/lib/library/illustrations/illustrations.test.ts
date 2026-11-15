/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { resolveObjectURL } from 'node:buffer';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { BlurMode } from '$lib/data/blur-mode';
import extractEpub from '$lib/functions/file-loaders/epub/extract-epub';
import generateEpubHtml from '$lib/functions/file-loaders/epub/generate-epub-html';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import formatBookDataHtml from '$lib/functions/book-data-loader/format-book-data-html';
import type { BooksDbBookData } from '$lib/data/database/books-db/versions/books-db';
import {
  EXPECTED,
  PICTURES,
  buildIllustratedEpub,
  solidPng
} from '../../../../tests/fixtures/illustrated-epub';
import { collectIllustrations, opfCoverKey, storedCoverKey } from './collect';
import { anyHidden, isHidden } from './hidden';
import { blobImageSize, imageSize, needsMoreBytes } from './image-size';
import { illustrationCandidates, imageKeyOf, pickIllustrations } from './pick-illustrations';

let document: Document;

beforeAll(() => {
  document = installNodeDom();
});

const dummy = (key: string) =>
  `data:image/gif;ttu:${key};base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==`;
const part = (id: string, body: string) => `<div id="ttu-${id}">${body}</div>`;
const img = (key: string, cls = '') => `<img class="${cls}" src="${dummy(key)}">`;
const svg = (key: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="${dummy(key)}"></image></svg>`;
const toc = `<p><a href="#ttu-a">1</a><a href="#ttu-b">2</a></p>`;

function root(html: string) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const big = () => ({ width: 800, height: 1200 });

describe('imageKeyOf', () => {
  it('reads the dummy URL and the ttu: form, nothing else', () => {
    expect(imageKeyOf(dummy('OEBPS/a b.png'))).toBe('OEBPS/a b.png');
    expect(imageKeyOf('ttu:images/x.jpg')).toBe('images/x.jpg');
    expect(imageKeyOf('../images/x.jpg')).toBeNull();
    expect(imageKeyOf(null)).toBeNull();
  });
});

describe('pickIllustrations', () => {
  it('keeps book order, marks the parts up to the TOC page, leaves out cover/gaiji/repeats/missing/small', () => {
    const r = root(
      part('cover', svg('cover.png')) +
        part('k1', img('k1.png', 'fit')) +
        part('toc', toc + img('deco.png')) +
        part(
          'c1',
          img('a.png') +
            img('g.png', 'gaiji') +
            img('gl.png', 'gaiji-line') +
            img('a.png') +
            img('none.png')
        ) +
        part('c2', svg('b.png') + '<svg><circle r="3"></circle></svg>' + img('logo.png'))
    );
    const sizes: Record<string, { width: number; height: number }> = {
      'deco.png': { width: 200, height: 60 },
      'logo.png': { width: 128, height: 128 }
    };
    const keys = new Set([
      'cover.png',
      'k1.png',
      'deco.png',
      'a.png',
      'g.png',
      'gl.png',
      'b.png',
      'logo.png'
    ]);
    const out = pickIllustrations(r, {
      keys,
      coverKey: 'cover.png',
      sizeOf: (k) => sizes[k] ?? big()
    });
    expect(out.map((i) => [i.key, i.beforeToc])).toEqual([
      ['k1.png', true],
      ['a.png', false],
      ['b.png', false]
    ]);
  });

  it('a picture of exactly 300 px on its shorter side stays; an unknown size stays', () => {
    const r = root(part('a', img('x.png') + img('y.png')));
    const out = pickIllustrations(r, {
      keys: new Set(['x.png', 'y.png']),
      sizeOf: (k) => (k === 'x.png' ? { width: 300, height: 2000 } : null)
    });
    expect(out.map((i) => [i.key, i.width])).toEqual([
      ['x.png', 300],
      ['y.png', null]
    ]);
  });

  it('no TOC page, or the TOC as the last part: nothing is before it', () => {
    const noToc = root(part('a', img('x.png')) + part('b', img('y.png')));
    expect(illustrationCandidates(noToc).map((c) => c?.beforeToc)).toEqual([false, false]);
    const tocLast = root(part('a', img('x.png')) + part('toc', toc));
    expect(illustrationCandidates(tocLast).map((c) => c?.beforeToc)).toEqual([false]);
  });
});

describe('isHidden', () => {
  const state = (o: Partial<Parameters<typeof isHidden>[2]> = {}) => ({
    hideSpoilerImage: true,
    mode: BlurMode.AFTER_TOC,
    revealed: new Set<number>(),
    allShown: false,
    ...o
  });
  const before = { beforeToc: true };
  const after = { beforeToc: false };

  it('afterToc hides only pictures after the TOC; all hides every one; off hides none', () => {
    expect([isHidden(before, 0, state()), isHidden(after, 1, state())]).toEqual([false, true]);
    expect(isHidden(before, 0, state({ mode: BlurMode.ALL }))).toBe(true);
    expect(isHidden(before, 0, state({ mode: 'something else' }))).toBe(true);
    expect(isHidden(after, 1, state({ hideSpoilerImage: false }))).toBe(false);
  });

  it('a tap reveals one; Show all reveals all', () => {
    expect(isHidden(after, 1, state({ revealed: new Set([1]) }))).toBe(false);
    expect(isHidden(after, 2, state({ revealed: new Set([1]) }))).toBe(true);
    expect(anyHidden([before, after], state({ allShown: true }))).toBe(false);
    expect(anyHidden([before, after], state())).toBe(true);
  });
});

describe('imageSize', () => {
  it('reads PNG, GIF, WebP (VP8, VP8L, VP8X) and JPEG headers', () => {
    expect(imageSize(solidPng(640, 960, [1, 2, 3]))).toEqual({ width: 640, height: 960 });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(imageSize(gif)).toEqual({ width: 800, height: 600 });

    const riff = (fourcc: string, body: number[]) =>
      Uint8Array.from([
        ...Buffer.from('RIFF'),
        0,
        0,
        0,
        0,
        ...Buffer.from('WEBP'),
        ...Buffer.from(fourcc),
        ...body
      ]);
    // VP8: frame tag (3) + start code (3) at 20, then 14-bit width/height at 26/28.
    const vp8 = riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02, 0, 0]);
    expect(imageSize(vp8)).toEqual({ width: 800, height: 600 });
    // VP8L: signature 0x2f at 20, then (width-1) and (height-1) in 14 bits each.
    const w = 799;
    const h = 599;
    const bits = w | (h << 14);
    const vp8l = riff('VP8L', [
      0,
      0,
      0,
      0,
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
      0,
      0,
      0,
      0,
      0
    ]);
    expect(imageSize(vp8l)).toEqual({ width: 800, height: 600 });
    // VP8X: (width-1) and (height-1) as 24-bit little-endian at 24 and 27.
    const vp8x = riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0x57, 0x02, 0, 0, 0]);
    expect(imageSize(vp8x)).toEqual({ width: 800, height: 600 });

    // JPEG: SOI, an APP0 segment, then SOF0 with height 1200 and width 800.
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof0 = [
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x04,
      0xb0,
      0x03,
      0x20,
      0x03,
      ...new Array(9).fill(0)
    ];
    expect(imageSize(Uint8Array.from([0xff, 0xd8, ...app0, ...sof0]))).toEqual({
      width: 800,
      height: 1200
    });
    // Cut before the frame marker: unknown yet, read more.
    const cut = Uint8Array.from([0xff, 0xd8, ...app0]);
    expect(imageSize(cut)).toBeNull();
    expect(needsMoreBytes(cut)).toBe(true);
    expect(imageSize(Uint8Array.from(Buffer.from('<svg/>')))).toBeNull();
  });

  it('reads a JPEG in full when its frame comes after 64 KB of metadata', async () => {
    const big = new Uint8Array(70 * 1024).fill(0);
    const app1 = [0xff, 0xe1, 0xff, 0xff]; // a 65,535-byte segment
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03];
    big.set([0xff, 0xd8, ...app1]);
    big.set(sof0, 2 + 2 + 0xffff);
    expect(await blobImageSize(new Blob([big]))).toEqual({ width: 800, height: 600 });
  });
});

async function importFixture(options: { withCoverMeta?: boolean } = {}) {
  const bytes = await buildIllustratedEpub(options);
  const { contents, result, contentsDirectory } = await extractEpub(new Blob([bytes]));
  const { element } = generateEpubHtml(result, contents, document, contentsDirectory, {
    importHTMLFixMode: ImportHTMLFixMode.OFF,
    restrictImportFixToAnchor: true
  });
  const blobs = Object.fromEntries(
    Object.entries(result).filter((e): e is [string, Blob] => e[1] instanceof Blob)
  );
  return { contents, element, blobs };
}

describe('the real import of an illustrated EPUB', () => {
  it('keeps the frontispieces and the inline illustrations, in order, with sizes', async () => {
    const { contents, element, blobs } = await importFixture();
    const coverKey = opfCoverKey(contents, new Set(Object.keys(blobs)));
    expect(coverKey).toBe('images/cover.png');
    expect(await collectIllustrations(element, blobs, coverKey)).toEqual(EXPECTED);
  });

  it('finds the cover by <meta name="cover"> too, and by the stored cover Blob', async () => {
    const { contents, blobs } = await importFixture({ withCoverMeta: true });
    expect(opfCoverKey(contents, new Set(Object.keys(blobs)))).toBe('images/cover.png');
    const p = PICTURES['images/cover.png'];
    expect(await storedCoverKey(blobs, new Blob([solidPng(p.w, p.h, p.rgb)]))).toBe(
      'images/cover.png'
    );
    expect(await storedCoverKey(blobs, undefined)).toBeNull();
    expect(await storedCoverKey(blobs, new Blob([new Uint8Array(3)]))).toBeNull();
  });
});

/**
 * Parity with the reader: for every image the reader can blur, the book page hides it
 * exactly when the reader wraps it in data-ttu-spoiler-img (format-book-data-html.ts).
 */
describe('parity with the reader spoiler marking', () => {
  async function readerMarks(element: Element, blobs: Record<string, Blob>, mode: BlurMode) {
    const bookData = { elementHtml: element.innerHTML, blobs } as unknown as BooksDbBookData;
    // Kept subscribed while reading: unsubscribing revokes the reader's object URLs.
    let html = '';
    const subscription = formatBookDataHtml(bookData, document, true, mode).subscribe((h) => {
      html = h;
    });
    const byBytes = new Map<string, string>();
    for (const [key, blob] of Object.entries(blobs)) {
      byBytes.set(Buffer.from(await blob.arrayBuffer()).toString('base64'), key);
    }
    const out = root(html);
    const marks: { key: string | null; hidden: boolean }[] = [];
    for (const el of Array.from(out.querySelectorAll('img, image'))) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img' && /gaiji/.test(el.getAttribute('class') ?? '')) continue;
      if (tag === 'image' && !el.closest('svg')) continue;
      const url = el
        .getAttributeNames()
        .filter((n) => n === 'src' || n.endsWith('href'))
        .map((n) => el.getAttribute(n))[0];
      const blob = url?.startsWith('blob:') ? resolveObjectURL(url) : undefined;
      const key = blob
        ? (byBytes.get(Buffer.from(await blob.arrayBuffer()).toString('base64')) ?? null)
        : null;
      marks.push({ key, hidden: !!el.closest('[data-ttu-spoiler-img]') });
    }
    subscription.unsubscribe();
    return marks;
  }

  for (const mode of [BlurMode.AFTER_TOC, BlurMode.ALL]) {
    it(`hides the same images as the reader (${mode})`, async () => {
      const { element, blobs } = await importFixture();
      const ours = illustrationCandidates(element).map((c, i) => ({
        key: c?.key ?? null,
        hidden: c
          ? isHidden(c, i, { hideSpoilerImage: true, mode, revealed: new Set(), allShown: false })
          : mode === BlurMode.ALL
      }));
      const reader = await readerMarks(element, blobs, mode);
      // Images the EPUB lacks: the reader still wraps them by position; ours has no key.
      expect(ours.filter((o) => o.key)).toEqual(reader.filter((r) => r.key));
      expect(ours.length).toBe(reader.length);
      // Not vacuous: 10 keyed images (cover, frontispieces, TOC ornament, illustrations,
      // logos, the repeat), some hidden; in afterToc some shown too.
      expect(reader.filter((r) => r.key)).toHaveLength(10);
      expect(reader.filter((r) => r.hidden).length).toBeGreaterThan(0);
      if (mode === BlurMode.AFTER_TOC) expect(reader.some((r) => r.key && !r.hidden)).toBe(true);
    });
  }
});
