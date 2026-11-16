/**
 * WP20c test helpers: EPUB3 books with real chapters (a nav TOC the reader's import finds),
 * Japanese text with ruby, pictures of a chosen size and JPEG quality, and a writing
 * direction, so stage 3 can be tested with the reader's own import code.
 * Only tests write these files.
 */
import sharp from 'sharp';
import { makeZip } from './epub-fixture';

/** Deterministic "Japanese" text: kana and kanji from a pool, seeded. */
export function fakeText(seed: number, length: number): string {
  const pool =
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん' +
    'アイウエオカキクケコサシスセソタチツテトナニヌネノ日月火水木金土山川田人大小中上下左右本学生';
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += pool[s % pool.length];
  }
  return out;
}

/**
 * A picture: seeded shapes at relative positions on a gradient, so the same seed is the same
 * picture at any size (like an illustration scanned at two resolutions).
 */
export async function picture(seed: number, width: number, quality: number): Promise<Buffer> {
  const height = Math.round(width * 1.4);
  const raw = Buffer.alloc(width * height * 3);
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const rects = Array.from({ length: 24 }, () => ({
    x: rnd(),
    y: rnd(),
    w: 0.05 + rnd() * 0.3,
    h: 0.05 + rnd() * 0.3,
    g: Math.round(rnd() * 255),
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let val = 90 + 80 * v;
      for (const r of rects) if (u >= r.x && u < r.x + r.w && v >= r.y && v < r.y + r.h) val = r.g;
      const i = (y * width + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = val;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}

export interface Stage3EpubSpec {
  title: string;
  /** The text of each chapter (plain characters; split into paragraphs). */
  chapters: string[];
  /** Wrap the first two characters of every paragraph in ruby. */
  ruby?: boolean;
  /** Pictures shown at the start of the first chapter. */
  images?: Buffer[];
  cover?: Buffer;
  direction?: 'rtl' | 'ltr';
  /** Leave the TOC out (no nav document). */
  noToc?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function paragraphs(text: string, ruby: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 300) {
    const part = text.slice(i, i + 300);
    out.push(
      ruby && part.length > 2
        ? `<p><ruby>${part.slice(0, 2)}<rt class="r">よみ</rt></ruby>${part.slice(2)}。</p>`
        : `<p>${part}。</p>`,
    );
  }
  return out.join('\n');
}

export function makeTextEpub(spec: Stage3EpubSpec): Buffer {
  const images = spec.images ?? [];
  const chapterFiles = spec.chapters.map((text, i) => {
    const pics =
      i === 0 ? images.map((_, n) => `<p><img src="images/i${n}.jpg" alt=""/></p>`).join('') : '';
    return {
      name: `OEBPS/c${i}.xhtml`,
      data: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(spec.title)}</title><link rel="stylesheet" href="style.css"/></head><body><h1>第${i + 1}章</h1>${pics}${paragraphs(text, !!spec.ruby)}</body></html>`,
      deflate: true,
    };
  });
  const nav = spec.noToc
    ? []
    : [
        {
          name: 'OEBPS/nav.xhtml',
          data: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc" id="toc"><ol>${spec.chapters.map((_, i) => `<li><a href="c${i}.xhtml">第${i + 1}章</a></li>`).join('')}</ol></nav></body></html>`,
          deflate: true,
        },
      ];
  const css =
    spec.direction === 'ltr'
      ? 'html { writing-mode: horizontal-tb; }'
      : 'html { -epub-writing-mode: vertical-rl; writing-mode: vertical-rl; }';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${esc(spec.title)}</dc:title>
<dc:creator>作者</dc:creator>
<dc:language>ja</dc:language>
<dc:identifier id="uid">urn:uuid:${Buffer.from(spec.title).toString('hex').slice(0, 32)}</dc:identifier>
</metadata>
<manifest>
${spec.noToc ? '' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
<item id="css" href="style.css" media-type="text/css"/>
${spec.chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
${images.map((_, n) => `<item id="i${n}" href="images/i${n}.jpg" media-type="image/jpeg"/>`).join('\n')}
${spec.cover ? '<item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}
</manifest>
<spine page-progression-direction="${spec.direction ?? 'rtl'}">
${spec.chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n')}
</spine>
</package>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    { name: 'OEBPS/style.css', data: css },
    ...nav,
    ...chapterFiles,
    ...images.map((data, n) => ({ name: `OEBPS/images/i${n}.jpg`, data })),
    ...(spec.cover ? [{ name: 'OEBPS/images/cover.jpg', data: spec.cover }] : []),
  ]);
}

/** A book's chapters from one seed: `count` chapters of `size` characters. */
export function chaptersOf(seed: number, count = 6, size = 6000): string[] {
  return Array.from({ length: count }, (_, i) => fakeText(seed * 100 + i, size));
}
