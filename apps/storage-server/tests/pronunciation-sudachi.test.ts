/**
 * Season 2 Phase 12, opt-in (`npm run test:sudachi`): pronunciation fixes through the PC's
 * real kana step. The server's reader import reads an EPUB (the real book-script child),
 * the fixes are applied as a job applies them, and the PC's own kana.py with the real
 * SudachiPy (the image's pins: sudachipy 0.6.10, sudachidict-core 20260428) turns the
 * readings into what the model is given. Needs TTSU_SUDACHI_PYTHON: a Python with those
 * packages (e.g. a venv); skipped without it.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readBookScript } from '../src/audio/book-script';
import { applyFixes, type FixEntry } from '../src/pronunciation/fix-rules';
import { write } from './helpers/audio-fixtures';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';

const PYTHON = process.env.TTSU_SUDACHI_PYTHON ?? '';
const TTS_DIR = path.resolve(__dirname, '..', '..', 'gpu-worker', 'tts');
const DRIVER = path.join(__dirname, 'fixtures', 'sudachi-kana.py');

function toKana(readings: string[]): string[] {
  const out = execFileSync(PYTHON, ['-I', '-B', DRIVER, TTS_DIR], {
    input: Buffer.from(JSON.stringify(readings), 'utf8'),
    windowsHide: true,
  });
  return JSON.parse(out.toString('utf8')) as string[];
}

function epubWith(paragraphs: string[]): Buffer {
  const xhtml = (body: string) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>試験</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: xhtml(
        '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">一章</a></li></ol></nav>',
      ),
    },
    { name: 'OEBPS/c1.xhtml', data: xhtml(paragraphs.map((p) => `<p>${p}</p>`).join('')) },
  ]);
}

let nextId = 1;
const fix = (kind: 'word' | 'pattern', match: string, reading: string, book = false): FixEntry => ({
  id: nextId,
  bookId: book ? 'b' : null,
  kind,
  match,
  reading,
  createdAt: nextId++,
});

describe.skipIf(!PYTHON)('pronunciation fixes through the real SudachiPy kana step', () => {
  it("speaks each fix's reading as typed, converts the kanji around it, keeps the furigana", async () => {
    const file = write(
      makeTempDir('pf-sudachi'),
      'book.epub',
      epubWith([
        '<ruby>椎名<rt>しいな</rt></ruby>は笑った。',
        '椎名先輩は日本橋に住んでいる。',
        '彼はAIの研究者だ。',
        '昨日は3人来た。',
        '御茶を飲む。',
        '紅茶を飲む。',
        '日本の首都は東京です。',
      ]),
    );
    const script = await readBookScript(file, {
      importOptions: { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true },
      maxSentence: 120,
      timeoutMs: 120_000,
    });
    const sentences = script.chapters.flatMap((c) => c.sentences);
    const entries = [
      fix('word', '椎名', 'しいな', true),
      fix('word', '日本橋', 'にほんばし'),
      fix('word', '日本', 'にっぽん'),
      fix('word', 'AI', 'エーアイ'),
      fix('pattern', '(\\d+)人', '$1にん'),
      fix('word', '御', 'お'),
      fix('word', '紅', 'コウ', true),
    ];
    const results = applyFixes(sentences, entries);
    const readings = results.map((r, i) => r.reading ?? sentences[i].reading);
    const spoken = toKana(readings);
    const rows = sentences.map((s, i) => ({
      text: s.text,
      reading: readings[i],
      spoken: spoken[i],
      fixes: results[i].hits.map((h) => h.reading),
    }));
    console.log(JSON.stringify(rows, null, 1));

    // Every fix's reading reaches the model exactly as typed.
    for (const row of rows) {
      for (const r of row.fixes) expect(row.spoken).toContain(r);
    }
    // The book's furigana place: the fix is skipped, the book's reading is spoken.
    expect(results[0].skipped).toHaveLength(1);
    expect(rows.map((r) => r.spoken)).toEqual([
      'しいなはわらった。',
      'しいなせんぱいはにほんばしにすんでいる。',
      'かれはエーアイのけんきゅうしゃだ。',
      'きのうは3にんきた。',
      'おちゃをのむ。',
      'コウちゃをのむ。',
      'にっぽんのしゅとはとうきょうです。',
    ]);
  }, 180_000);
});
