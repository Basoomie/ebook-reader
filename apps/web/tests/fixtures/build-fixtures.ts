/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/* eslint-disable no-irregular-whitespace -- the Japanese fixture text uses U+3000 on purpose */

/**
 * Builds the synthetic EPUB fixtures used by the loader/counter tests.
 * All text is original and written for these tests.
 *
 * Run from apps/web: `pnpm exec vite-node tests/fixtures/build-fixtures.ts`
 */

import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter, configure } from '@zip.js/zip.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

configure({ useWebWorkers: false });

const outDir = path.dirname(fileURLToPath(import.meta.url));

// 1x1 transparent PNG
const pngBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const xhtml = (title: string, body: string, head = `<title>${title}</title>`) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" class="vrtl">
<head>${head}</head>
<body class="p-text" id="b-${title}">
${body}
</body>
</html>`;

/**
 * EPUB 3, nav TOC. The first spine item (cover) is not in the TOC, which triggers
 * the "Preface" section. Covers counter edge cases and import-fix-mode differences.
 */
async function buildEpub3() {
  const files: Record<string, string | Uint8Array> = {
    'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">ttu-fixture-epub3</dc:identifier>
    <dc:title>テスト用の本　その一</dc:title>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/第二章.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2b" href="text/ch2b.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3-alt" href="text/ch3.dtb" media-type="application/x-dtbook+xml" fallback="ch3"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch4" href="text/ch4.xhtml" media-type="application/xhtml+xml"/>
    <item id="img-cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="img-gaiji" href="images/gaiji.png" media-type="image/png"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch2b"/>
    <itemref idref="ch3-alt"/>
    <itemref idref="ch4"/>
  </spine>
</package>`,
    'OEBPS/nav.xhtml': xhtml(
      'nav',
      `<nav epub:type="toc" id="toc">
  <h1>目次</h1>
  <ol>
    <li><a href="text/ch1.xhtml">第一章　朝の駅</a></li>
    <li><a href="text/第二章.xhtml">第二章　<span>雨の日</span></a></li>
    <li><a href="text/ch3.xhtml#start">第三章　夜</a></li>
    <li><a href="text/ch4.xhtml">第四章　修正の章</a></li>
  </ol>
</nav>`
    ),
    'OEBPS/text/cover.xhtml': xhtml(
      'cover',
      `<div class="cover"><img src="../images/cover.png" alt="表紙"/></div>`
    ),
    'OEBPS/text/ch1.xhtml': xhtml(
      'ch1',
      `<h1>第一章　朝の駅</h1>
<p>駅のホームには、まだ誰もいなかった。</p>
<p><ruby>改札<rp>（</rp><rt>かいさつ</rt><rp>）</rp></ruby>を抜けると、<ruby><rb>冷</rb><rt>つめ</rt></ruby>たい風が吹いた。</p>
<p>電車は７時３０分に来る。ABCとabcとＡＢＣとａｂｃ、それに123。</p>
<p>「おはよう！」と彼女は言った……。</p>
<p>𠮟られた𩸽の話をしよう。</p>
<p>この文字<img class="gaiji" src="../images/gaiji.png" alt=""/>は外字です。</p>
<p><span aria-hidden="true">読まれない文</span><span hidden="">隠された文</span><span aria-hidden="false">偽でも隠れる</span>見える文。</p>
<p>　　　</p>
<p>々〆〇ゝゞヽヾー〻ｱｲｳ</p>`
    ),
    'OEBPS/text/第二章.xhtml': xhtml(
      'ch2',
      `<h1>第二章　雨の日</h1>
<p>雨が降っていた。傘を忘れた。</p>
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 10 10"><text>図の中の字</text></svg>
<p>図のあとの文。</p>`
    ),
    'OEBPS/text/ch2b.xhtml': xhtml(
      'ch2b',
      `<p>章の続きの節。ここは目次にない。</p>
<p><a id="note1"/>注の後ろの文。</p>`
    ),
    'OEBPS/text/ch3.xhtml': xhtml(
      'ch3',
      `<h1 id="start">第三章　夜</h1>
<p>夜になると、町は静かになった。</p>
<p><span aria-hidden="true"/>修正モードで数が変わる文。</p>
<p>&#x3042;&#12354;\u0001の字。</p>`
    ),
    // `<title/>` makes the text/html parser swallow the document into <title>, so the
    // loader falls back to text/xml (fix mode Off). `<span aria-hidden="true"/>`
    // hides the following text unless "restrict fix to anchor" is off.
    'OEBPS/text/ch4.xhtml': xhtml(
      'ch4',
      `<h1>第四章　修正の章</h1>
<p>最初の段落です。</p>
<p><span aria-hidden="true"/>自己終了タグの後ろの文。</p>`,
      '<title/><meta charset="utf-8"></meta>'
    ),
    'OEBPS/text/ch3.dtb': '<dtbook><p>使われない</p></dtbook>',
    'OEBPS/images/cover.png': pngBytes,
    'OEBPS/images/gaiji.png': pngBytes
  };

  await writeEpub('synthetic-epub3.epub', files);
}

/**
 * EPUB 2 with an `opf:` prefixed package, NCX-only TOC (first spine item is in the TOC),
 * a text/html item, an image-only page and nested navPoints.
 */
async function buildEpub2() {
  const files: Record<string, string | Uint8Array> = {
    'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0" unique-identifier="uid">
  <opf:metadata>
    <dc:identifier id="uid">ttu-fixture-epub2</dc:identifier>
    <dc:title>テスト用の本　その二</dc:title>
    <dc:language>ja</dc:language>
    <opf:meta name="cover" content="img-cover"/>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <opf:item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="p2" href="p2.html" media-type="text/html"/>
    <opf:item id="p3" href="p3.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="p4" href="p4.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="img-cover" href="cover.png" media-type="image/png"/>
  </opf:manifest>
  <opf:spine toc="ncx">
    <opf:itemref idref="p1"/>
    <opf:itemref idref="p2"/>
    <opf:itemref idref="p3"/>
    <opf:itemref idref="p4"/>
  </opf:spine>
</opf:package>`,
    'OEBPS/toc.ncx': `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="ttu-fixture-epub2"/></head>
  <docTitle><text>テスト用の本　その二</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>はじめに</text></navLabel>
      <content src="p1.xhtml"/>
      <navPoint id="n1a" playOrder="2">
        <navLabel><text>  小見出し  </text></navLabel>
        <content src="p2.html#sub"/>
      </navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3">
      <navLabel><text>本編</text></navLabel>
      <content src="p4.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
    'OEBPS/p1.xhtml': xhtml(
      'p1',
      `<p>はじめに、この本について書く。</p>
<p>短い前書きです。</p>`
    ),
    'OEBPS/p2.html': `<!DOCTYPE html><html><head><title>p2</title></head><body>
<h2 id="sub">小見出し</h2><p>普通のHTMLの頁。<br/>改行のあと。</p>
</body></html>`,
    'OEBPS/p3.xhtml': xhtml('p3', `<div><img src="cover.png" alt=""/></div>`),
    'OEBPS/p4.xhtml': xhtml(
      'p4',
      `<p>本編が始まる。</p>
<p>&#x3042;&#12354;と&amp;記号。</p>`
    ),
    'OEBPS/cover.png': pngBytes
  };

  await writeEpub('synthetic-epub2-ncx.epub', files);
}

async function writeEpub(name: string, files: Record<string, string | Uint8Array>) {
  const writer = new ZipWriter(new BlobWriter('application/epub+zip'));

  await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await writer.add('META-INF/container.xml', new TextReader(container));

  for (const [filename, content] of Object.entries(files)) {
    await writer.add(
      filename,
      typeof content === 'string' ? new TextReader(content) : new Uint8ArrayReader(content)
    );
  }

  const blob = await writer.close();

  await writeFile(path.join(outDir, name), Buffer.from(await blob.arrayBuffer()));
  console.log(`wrote ${name}`);
}

await buildEpub3();
await buildEpub2();
