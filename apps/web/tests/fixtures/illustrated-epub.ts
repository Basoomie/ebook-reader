/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/* eslint-disable no-irregular-whitespace -- the Japanese fixture text uses U+3000 on purpose */

/**
 * Season 2 §6: an EPUB with every kind of image the illustrations rule has to sort out.
 * Spine: cover page (SVG, the OPF cover) · two colour frontispieces (an <img> and an SVG
 * landscape) · the table of contents (several links, a small ornament) · chapters with
 * illustrations, gaiji (`gaiji`, `gaiji-line`), a publisher logo, a repeated illustration,
 * a missing file and an SVG without an image · a colophon with a small logo.
 * Every picture is a real PNG of its size in its own solid colour (the tests tell them
 * apart by colour). All text is original and written for these tests.
 */

import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter, configure } from '@zip.js/zip.js';
import { deflateSync } from 'node:zlib';

configure({ useWebWorkers: false });

/** The pictures: key (relative to the OPF folder) → size and colour. */
export const PICTURES = {
  'images/cover.png': { w: 600, h: 900, rgb: [20, 30, 70] },
  'images/kuchie1.png': { w: 800, h: 1200, rgb: [220, 120, 60] },
  'images/kuchie2.png': { w: 1200, h: 800, rgb: [60, 160, 90] },
  'images/toc-deco.png': { w: 200, h: 60, rgb: [128, 128, 128] },
  'images/ill1.png': { w: 700, h: 1000, rgb: [200, 40, 40] },
  'images/ill2.png': { w: 640, h: 960, rgb: [40, 40, 200] },
  'images/ill3.png': { w: 720, h: 1080, rgb: [200, 200, 40] },
  'images/gaiji.png': { w: 32, h: 32, rgb: [0, 0, 0] },
  'images/gaiji-line.png': { w: 300, h: 40, rgb: [10, 10, 10] },
  'images/logo.png': { w: 128, h: 128, rgb: [90, 0, 90] },
  'images/colophon-logo.png': { w: 50, h: 50, rgb: [0, 90, 90] }
} as const;

/** The illustrations the rule keeps, in book order, and whether each is before the TOC. */
export const EXPECTED = [
  { key: 'images/kuchie1.png', beforeToc: true, width: 800, height: 1200 },
  { key: 'images/kuchie2.png', beforeToc: true, width: 1200, height: 800 },
  { key: 'images/ill1.png', beforeToc: false, width: 700, height: 1000 },
  { key: 'images/ill2.png', beforeToc: false, width: 640, height: 960 },
  { key: 'images/ill3.png', beforeToc: false, width: 720, height: 1080 }
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A valid RGB PNG of one colour (compresses to a few hundred bytes). */
export function solidPng(w: number, h: number, rgb: readonly number[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array())
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const xhtml = (id: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head><title>${id}</title></head>
<body class="p-text">
${body}
</body>
</html>`;

const svgPage = (href: string, w: number, h: number) =>
  `<div class="main"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="${href}"/></svg></div>`;

const TEXT = {
  cover: svgPage('../images/cover.png', 600, 900),
  kuchie1: `<p><img class="fit" src="../images/kuchie1.png" alt=""/></p>`,
  kuchie2: svgPage('../images/kuchie2.png', 1200, 800),
  toc: `<h1>目次</h1><p><img class="deco" src="../images/toc-deco.png" alt=""/></p>
<p><a href="ch1.xhtml">第一章　港の灯り</a></p>
<p><a href="ch2.xhtml">第二章　冬の図書塔</a></p>
<p><a href="ch3.xhtml">第三章　約束の夜</a></p>`,
  ch1: `<h2>第一章　港の灯り</h2>
<p>坂の上から見下ろすと、港の灯りが一つずつともっていった。</p>
<p><img class="fit" src="../images/ill1.png" alt=""/></p>
<p>古い字は<img class="gaiji" src="../images/gaiji.png" alt=""/>と書かれていた。<img class="gaiji-line" src="../images/gaiji-line.png" alt=""/></p>`,
  ch2: `<h2>第二章　冬の図書塔</h2>
<p>図書塔の最上階には、誰も読んだことのない本が並んでいる。</p>
${svgPage('../images/ill2.png', 640, 960)}
<p><img src="../images/logo.png" alt=""/></p>
<p>もう一度あの絵を見た。<img class="fit" src="../images/ill1.png" alt=""/></p>
<p><img class="fit" src="../images/nothere.png" alt=""/></p>`,
  ch3: `<h2>第三章　約束の夜</h2>
<p>夜が明けるまで、二人は灯台の下で話し続けた。</p>
<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="10"/></svg></p>
<p><img class="fit" src="../images/ill3.png" alt=""/></p>`,
  colophon: `<p>灯火文庫</p><p><img src="../images/colophon-logo.png" alt=""/></p>`
};

const SPINE = ['cover', 'kuchie1', 'kuchie2', 'toc', 'ch1', 'ch2', 'ch3', 'colophon'] as const;

/** Builds the EPUB in memory (`withCoverMeta`: the EPUB 2 `<meta name="cover">` form). */
export async function buildIllustratedEpub(
  options: { withCoverMeta?: boolean; title?: string } = {}
): Promise<Uint8Array> {
  const title = options.title ?? '挿絵の本';
  const manifestText = SPINE.map(
    (id) =>
      `<item id="${id}" href="text/${id}.xhtml" media-type="application/xhtml+xml"${id === 'toc' ? ' properties="nav"' : ''}/>`
  ).join('\n    ');
  const manifestImages = Object.keys(PICTURES)
    .map((key, i) => {
      const cover = key === 'images/cover.png';
      const props = cover && !options.withCoverMeta ? ' properties="cover-image"' : '';
      return `<item id="${cover ? 'cover-img' : `img${i}`}" href="${key}" media-type="image/png"${props}/>`;
    })
    .join('\n    ');
  const coverMeta = options.withCoverMeta ? '<meta name="cover" content="cover-img"/>' : '';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">ttu-fixture-illustrated</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>ja</dc:language>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifestText}
    ${manifestImages}
  </manifest>
  <spine>
    ${SPINE.map((id) => `<itemref idref="${id}"/>`).join('\n    ')}
  </spine>
</package>`;
  const tocNav =
    TEXT.toc.replace('<h1>目次</h1>', '<nav epub:type="toc" id="toc"><h1>目次</h1>') + '</nav>';

  const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
  await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await writer.add(
    'META-INF/container.xml',
    new TextReader(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  );
  await writer.add('OEBPS/content.opf', new TextReader(opf));
  for (const id of SPINE) {
    await writer.add(
      `OEBPS/text/${id}.xhtml`,
      new TextReader(xhtml(id, id === 'toc' ? tocNav : TEXT[id]))
    );
  }
  for (const [key, p] of Object.entries(PICTURES)) {
    await writer.add(`OEBPS/${key}`, new Uint8ArrayReader(solidPng(p.w, p.h, p.rgb)), { level: 0 });
  }
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}
