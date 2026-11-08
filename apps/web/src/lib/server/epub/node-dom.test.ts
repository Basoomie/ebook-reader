/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from './node-dom';

/**
 * Prefixed attribute selectors (`[epub\:type]`) in the Node DOM must behave like the
 * browser. Expected ids were captured by running the same documents and selectors
 * through DOMParser + querySelectorAll in Chromium 152.
 */
const B = String.fromCharCode(92);

const docs = {
  html: '<html><body><nav epub:type="landmarks" id="lm"></nav><nav epub:type="toc" id="t1"><a href="a.xhtml" epub:type="noteref" id="n1">A</a></nav><nav epub:type="toc page-list" id="t2"></nav><nav EPUB:TYPE="toc" id="t3"></nav><div id="d1" epub:type="toc"></div></body></html>',
  xhtmlNs:
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks" id="lm"></nav><nav epub:type="toc" id="t1"><a href="a.xhtml" epub:type="noteref" id="n1">A</a></nav><nav epub:type="toc page-list" id="t2"></nav><div id="d1" epub:type="toc"></div></body></html>'
};

/** [selector, ids in `html` parsed as text/html, ids in `xhtmlNs` parsed as text/html] */
const htmlParsed: Array<[string, string[], string[]]> = [
  [`nav[epub${B}:type="toc"],nav#toc`, ['t1', 't3'], ['t1']],
  [`nav[epub${B}:type="toc"]`, ['t1', 't3'], ['t1']],
  [`nav[epub${B}:type]`, ['lm', 't1', 't2', 't3'], ['lm', 't1', 't2']],
  [`[epub${B}:type="toc"]`, ['t1', 't3', 'd1'], ['t1', 'd1']],
  [`nav[epub${B}:type~="toc"]`, ['t1', 't2', 't3'], ['t1', 't2']],
  [`nav[epub${B}:type^="toc"]`, ['t1', 't2', 't3'], ['t1', 't2']],
  [`nav[epub${B}:type|="toc"]`, ['t1', 't3'], ['t1']],
  [`nav[epub${B}:type$="list"]`, ['t2'], ['t2']],
  [`nav[epub${B}:type*="age"]`, ['t2'], ['t2']],
  [`nav[epub${B}:type="TOC" i]`, ['t1', 't3'], ['t1']],
  [`nav[EPUB${B}:TYPE="toc"]`, ['t1', 't3'], ['t1']],
  [`body nav[epub${B}:type="toc"]`, ['t1', 't3'], ['t1']],
  [`nav#t1[epub${B}:type="toc"]`, ['t1'], ['t1']],
  [`nav[epub${B}3a type="toc"]`, ['t1', 't3'], ['t1']]
];

describe('prefixed attribute selectors in the Node DOM', () => {
  beforeAll(() => {
    installNodeDom();
  });

  const ids = (doc: Document, selector: string) =>
    Array.from(doc.querySelectorAll(selector)).map((element) => element.id);

  it.each(htmlParsed)('%s (HTML-parsed)', (selector, htmlIds, xhtmlIds) => {
    const parser = new DOMParser();

    expect(ids(parser.parseFromString(docs.html, 'text/html'), selector)).toEqual(htmlIds);
    expect(ids(parser.parseFromString(docs.xhtmlNs, 'text/html'), selector)).toEqual(xhtmlIds);

    const html = parser.parseFromString(docs.html, 'text/html');

    expect(html.querySelector(selector)?.id ?? null).toBe(htmlIds[0] ?? null);
  });

  it.each(htmlParsed.map(([selector]) => selector))(
    '%s never matches prefixed attributes in XML-parsed documents',
    (selector) => {
      const parser = new DOMParser();

      for (const type of ['text/xml', 'application/xhtml+xml'] as const) {
        expect(ids(parser.parseFromString(docs.xhtmlNs, type), selector)).toEqual([]);
        expect(ids(parser.parseFromString(docs.html, type), selector)).toEqual([]);
      }
    }
  );

  it('matches from an element context', () => {
    const doc = new DOMParser().parseFromString(docs.html, 'text/html');

    expect(
      Array.from(doc.body.querySelectorAll(`[epub${B}:type="noteref"]`)).map((e) => e.id)
    ).toEqual(['n1']);
  });

  it('leaves other selectors to jsdom', () => {
    const doc = new DOMParser().parseFromString(docs.html, 'text/html');
    const result = doc.querySelectorAll('nav');

    // A real jsdom NodeList, not the shim's array.
    expect(Array.isArray(result)).toBe(false);
    expect(result.constructor.name).toBe('NodeList');
    expect(result.length).toBe(4);
  });

  it('refuses prefixed attributes outside the selected element instead of guessing', () => {
    const doc = new DOMParser().parseFromString(docs.html, 'text/html');

    expect(() => doc.querySelectorAll(`nav[epub${B}:type="toc"] a`)).toThrow(
      /Unsupported selector/
    );
  });
});
