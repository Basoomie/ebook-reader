/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP19c: a book's Calibre description ("comments", stored as HTML) as plain paragraphs.
 * Block tags and <br> end a paragraph or line, every other tag is dropped and entities
 * are decoded. The result is only ever shown as text (never as HTML), so nothing in the
 * description can run or style the page.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©'
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

const BLOCK = /<\/?(p|div|h[1-6]|li|ul|ol|blockquote|section|article|tr|table|pre)\b[^>]*>/gi;

export function descriptionParagraphs(html: string | null | undefined): string[] {
  if (!html) return [];
  let text = html
    // Whole elements whose content is never shown.
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK, '\n\n')
    .replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
    )
    .filter(Boolean);
}
