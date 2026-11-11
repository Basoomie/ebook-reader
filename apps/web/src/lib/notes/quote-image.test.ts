/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { recordingCtx } from '$lib/image/recording-ctx';
import {
  DEFAULT_QUOTE_OPTIONS,
  drawQuoteImage,
  layoutQuote,
  luminance,
  loadQuoteOptions,
  QUOTE_OPTIONS_KEY,
  QUOTE_SIZES,
  quoteImageFileName,
  quoteColors,
  quotePalette,
  renderQuoteImage,
  saveQuoteOptions,
  type QuoteContent,
  type QuoteImageOptions
} from './quote-image';

describe('renderQuoteImage', () => {
  it('draws again without the cover when the cover made the canvas unreadable', async () => {
    const draws: ReturnType<typeof recordingCtx>[] = [];
    const doc = {
      createElement: () => {
        const rec = recordingCtx();
        draws.push(rec);
        const tainted = draws.length === 1;
        return {
          width: 0,
          height: 0,
          getContext: () => rec.ctx,
          toBlob: (done: (b: Blob | null) => void) => {
            if (tainted)
              throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
            done(new Blob(['png'], { type: 'image/png' }));
          }
        };
      }
    } as unknown as Document;
    const cover = { width: 300, height: 450 } as unknown as CanvasImageSource;
    const blob = await renderQuoteImage(
      { ...content(), coverUrl: 'http://x/c.webp' },
      { ...DEFAULT_QUOTE_OPTIONS, background: 'cover' },
      doc,
      cover
    );
    expect(blob.type).toBe('image/png');
    expect(draws).toHaveLength(2);
    expect(draws[0].calls.some((c) => c.name === 'drawImage')).toBe(true);
    expect(draws[1].calls.some((c) => c.name === 'drawImage')).toBe(false);
  });
});

const content = (over: Partial<QuoteContent> = {}): QuoteContent => ({
  text: 'からマグカップを取り出し',
  note: null,
  title: '週に一度クラスメイトを買う話５',
  author: '羽田宇佐',
  color: 1,
  coverUrl: null,
  ...over
});
const opts = (over: Partial<QuoteImageOptions> = {}): QuoteImageOptions => ({
  ...DEFAULT_QUOTE_OPTIONS,
  ...over
});

describe('layoutQuote', () => {
  it('keeps a short quote large, on one line', () => {
    const { ctx } = recordingCtx();
    const layout = layoutQuote(ctx, content({ text: 'マグカップを取り出し' }), opts());
    expect(layout.size).toBe(84);
    expect(layout.lines).toEqual(['マグカップを取り出し']);
  });

  it('shrinks a long quote until it fits the box', () => {
    const { ctx } = recordingCtx();
    const text = '曖昧な言葉を返すと、宮城が洗面室に消える。'.repeat(8);
    const layout = layoutQuote(ctx, content({ text }), opts());
    expect(layout.size).toBeLessThan(84);
    expect(layout.size).toBeGreaterThanOrEqual(28);
    expect(layout.lines.length * layout.advance).toBeLessThanOrEqual(layout.box.height);
    expect(layout.lines.join('')).toBe(text);
  });

  it('cuts a very long quote with an ellipsis at the smallest size', () => {
    const { ctx } = recordingCtx();
    const layout = layoutQuote(ctx, content({ text: 'あ'.repeat(5000) }), opts());
    expect(layout.size).toBe(28);
    expect(layout.lines[layout.lines.length - 1].endsWith('…')).toBe(true);
    expect(layout.lines.length * layout.advance).toBeLessThanOrEqual(layout.box.height);
  });

  it('lays vertical text in columns that fit both ways', () => {
    const { ctx } = recordingCtx();
    const text = '曖昧な言葉を返すと、宮城が洗面室に消える。'.repeat(4);
    const layout = layoutQuote(ctx, content({ text }), opts({ direction: 'vertical' }));
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.length * layout.advance).toBeLessThanOrEqual(layout.box.width);
    for (const column of layout.lines) {
      // One hanging character past the box at most (。 at a column's end).
      expect(([...column].length - 1) * layout.step).toBeLessThanOrEqual(layout.box.height);
    }
  });

  it('gives a portrait image more room than a square one', () => {
    const { ctx } = recordingCtx();
    const square = layoutQuote(ctx, content(), opts());
    const portrait = layoutQuote(ctx, content(), opts({ size: 'portrait' }));
    expect(portrait.box.height).toBe(square.box.height + 270);
  });

  it('adds the note (up to four lines) and leaves out hidden parts', () => {
    const { ctx } = recordingCtx();
    const withNote = layoutQuote(
      ctx,
      content({ note: 'メモ'.repeat(400) }),
      opts({ showNote: true, showTitle: false, showAuthor: false })
    );
    expect(withNote.note).toHaveLength(4);
    expect(withNote.note[3].endsWith('…')).toBe(true);
    expect(withNote.footer).toEqual({ title: '', author: '' });
    const noNote = layoutQuote(ctx, content({ note: 'メモ' }), opts({ showNote: false }));
    expect(noNote.note).toEqual([]);
    expect(withNote.box.height).toBeLessThan(noNote.box.height + 200);
  });
});

describe('drawQuoteImage', () => {
  it('draws the quote, title, author and mark', () => {
    const { ctx, texts } = recordingCtx();
    drawQuoteImage(ctx, content({ text: '取り出し' }), opts(), null);
    expect(texts()).toEqual(
      expect.arrayContaining(['取り出し', '週に一度クラスメイトを買う話５', '羽田宇佐', 'ッツ'])
    );
  });

  it('draws vertical text one character at a time', () => {
    const { ctx, texts } = recordingCtx();
    drawQuoteImage(ctx, content({ text: '取り出し' }), opts({ direction: 'vertical' }), null);
    expect(texts()).toEqual(expect.arrayContaining(['取', 'り', '出', 'し']));
    expect(texts()).not.toContain('取り出し');
  });

  it('uses the cover when there is one, the ink background when not', () => {
    const withCover = recordingCtx();
    const cover = { width: 300, height: 450 } as unknown as CanvasImageSource;
    drawQuoteImage(withCover.ctx, content(), opts({ background: 'cover' }), cover);
    expect(withCover.calls.some((c) => c.name === 'drawImage')).toBe(true);

    const without = recordingCtx();
    drawQuoteImage(without.ctx, content(), opts({ background: 'cover' }), null);
    expect(without.calls.some((c) => c.name === 'drawImage')).toBe(false);
    const firstFill = without.calls.find((c) => c.name === 'set:fillStyle');
    expect(firstFill?.args[0]).toBe('#111111');
  });

  it('fills the whole image in its size', () => {
    const { ctx, calls } = recordingCtx();
    drawQuoteImage(ctx, content(), opts({ size: 'portrait' }), null);
    const rect = calls.find((c) => c.name === 'fillRect');
    expect(rect?.args).toEqual([0, 0, QUOTE_SIZES.portrait.width, QUOTE_SIZES.portrait.height]);
  });
});

describe('palettes, file name, remembered choices', () => {
  it('lightens the highlight colour for the tint background', () => {
    expect(quotePalette('tint', 1).bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(quotePalette('paper', 3).accent).toBe('#3f8cf0');
    expect(quotePalette('navy', 1).ink).toBe('#f3ede0');
  });

  it('names the file with the date and time', () => {
    expect(quoteImageFileName(new Date(2026, 10, 11, 9, 5))).toBe('ttsu-quote-2026-11-11-0905.png');
  });

  it('remembers valid choices and ignores the rest', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v)
    };
    expect(loadQuoteOptions(storage)).toEqual(DEFAULT_QUOTE_OPTIONS);
    const picked = opts({ direction: 'vertical', background: 'navy', showNote: true });
    saveQuoteOptions(picked, storage);
    expect(loadQuoteOptions(storage)).toEqual(picked);
    data.set(
      QUOTE_OPTIONS_KEY,
      JSON.stringify({ direction: 'diagonal', size: 'portrait', showTitle: 'yes' })
    );
    expect(loadQuoteOptions(storage)).toEqual({ ...DEFAULT_QUOTE_OPTIONS, size: 'portrait' });
    data.set(QUOTE_OPTIONS_KEY, '{oops');
    expect(loadQuoteOptions(storage)).toEqual(DEFAULT_QUOTE_OPTIONS);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      }
    };
    expect(loadQuoteOptions(throwing)).toEqual(DEFAULT_QUOTE_OPTIONS);
    expect(() => saveQuoteOptions(picked, throwing)).not.toThrow();
  });
});

describe('quote image choices (WP19d follow-up)', () => {
  it('keeps a chosen quote size and cuts what does not fit', () => {
    const { ctx } = recordingCtx();
    const small = layoutQuote(ctx, content({ text: '取り出し' }), opts({ quoteSize: 40 }));
    expect(small.size).toBe(40);
    const huge = layoutQuote(ctx, content({ text: 'あ'.repeat(400) }), opts({ quoteSize: 120 }));
    expect(huge.size).toBe(120);
    expect(huge.lines[huge.lines.length - 1].endsWith('…')).toBe(true);
    expect(huge.lines.length * huge.advance).toBeLessThanOrEqual(huge.box.height);
    // Out of range: held to the slider's limits.
    expect(layoutQuote(ctx, content(), opts({ quoteSize: 999 })).size).toBe(140);
  });

  it('works out the automatic colours and takes the picked ones', () => {
    const light = quoteColors(opts({ background: 'custom', customBackground: '#fafafa' }), 1);
    expect(light.bg).toBe('#fafafa');
    expect(luminance(light.ink)).toBeLessThan(0.2);
    const dark = quoteColors(opts({ background: 'custom', customBackground: '#102030' }), 1);
    expect(luminance(dark.ink)).toBeGreaterThan(0.6);
    const picked = quoteColors(
      opts({
        textColor: '#aa0000',
        markColor: '#00aa00',
        frame: 'card',
        frameColor: '#0000aa',
        cardColor: '#ffffff'
      }),
      1
    );
    expect(picked).toMatchObject({
      ink: '#aa0000',
      mark: '#00aa00',
      frame: '#0000aa',
      card: '#ffffff'
    });
    // The mark follows the highlight's colour by default.
    expect(quoteColors(opts(), 3).mark).toBe('#3f8cf0');
  });

  it('gives a card a shade of the background and text to suit the card', () => {
    const navyCard = quoteColors(opts({ background: 'navy', frame: 'card' }), 1);
    expect(navyCard.card).toMatch(/^#/);
    expect(luminance(navyCard.ink)).toBeGreaterThan(0.6);
    const whiteCardOnNavy = quoteColors(
      opts({ background: 'navy', frame: 'card', cardColor: '#ffffff' }),
      1
    );
    expect(luminance(whiteCardOnNavy.ink)).toBeLessThan(0.2);
    expect(quoteColors(opts({ frame: 'none' }), 1).card).toBeNull();
  });

  it('draws a frame inside the image and moves the content in', () => {
    const none = recordingCtx();
    drawQuoteImage(none.ctx, content(), opts({ frame: 'none' }), null);
    expect(none.calls.some((c) => c.name === 'stroke')).toBe(false);
    const card = recordingCtx();
    drawQuoteImage(card.ctx, content(), opts({ frame: 'card', cardColor: '#ffffff' }), null);
    expect(card.calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
    expect(card.calls.some((c) => c.name === 'set:fillStyle' && c.args[0] === '#ffffff')).toBe(
      true
    );
    const { ctx } = recordingCtx();
    expect(layoutQuote(ctx, content(), opts({ frame: 'line' })).box.left).toBeGreaterThan(
      layoutQuote(ctx, content(), opts({ frame: 'none' })).box.left
    );
  });

  it('draws the chosen quote mark', () => {
    const quotes = recordingCtx();
    drawQuoteImage(quotes.ctx, content(), opts({ mark: 'quotes' }), null);
    expect(quotes.texts()).toContain('“');
    const corner = recordingCtx();
    drawQuoteImage(corner.ctx, content(), opts({ mark: 'corner' }), null);
    expect(corner.texts()).toContain('「');
    const none = recordingCtx();
    drawQuoteImage(none.ctx, content(), opts({ mark: 'none' }), null);
    expect(none.texts()).not.toContain('“');
    // No mark: the quote starts higher.
    const { ctx } = recordingCtx();
    expect(layoutQuote(ctx, content(), opts({ mark: 'none' })).box.top).toBeLessThan(
      layoutQuote(ctx, content(), opts({ mark: 'quotes' })).box.top
    );
  });

  it('puts the book title in the file name', () => {
    const now = new Date(2026, 10, 11, 9, 5);
    expect(quoteImageFileName(now, '週に一度クラスメイトを買う話５')).toBe(
      'ttsu-quote-週に一度クラスメイトを買う話５-2026-11-11-0905.png'
    );
    expect(quoteImageFileName(now, 'a/b: c')).toBe('ttsu-quote-a-b-c-2026-11-11-0905.png');
    expect(quoteImageFileName(now, 'x\\y')).toBe('ttsu-quote-x-y-2026-11-11-0905.png');
    expect(quoteImageFileName(now, '')).toBe('ttsu-quote-2026-11-11-0905.png');
  });

  it('remembers the new choices and drops invalid ones', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v)
    };
    const picked = opts({
      background: 'custom',
      customBackground: '#123456',
      quoteSize: 72,
      textColor: '#000000',
      mark: 'corner',
      markColor: '#ff0000',
      frame: 'card',
      frameColor: '#cccccc',
      cardColor: '#ffffff'
    });
    saveQuoteOptions(picked, storage);
    expect(loadQuoteOptions(storage)).toEqual(picked);
    data.set(
      QUOTE_OPTIONS_KEY,
      JSON.stringify({
        quoteSize: 5,
        textColor: 'red',
        mark: 'stars',
        frame: 'box',
        customBackground: '#zzz'
      })
    );
    const loaded = loadQuoteOptions(storage);
    expect(loaded).toMatchObject({
      quoteSize: null,
      textColor: null,
      mark: 'line',
      frame: 'none',
      customBackground: DEFAULT_QUOTE_OPTIONS.customBackground
    });
  });
});
