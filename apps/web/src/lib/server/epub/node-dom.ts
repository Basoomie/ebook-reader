/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { JSDOM } from 'jsdom';
import { installPrefixedAttributeSelectorFix } from './prefixed-attribute-selectors';

/**
 * DOM globals that the shared EPUB loader and character counter reference directly
 * (`DOMParser`, `Node.TEXT_NODE`, `instanceof HTMLElement` / `HTMLImageElement`).
 * Nothing else is installed; in particular Node's own `Blob` stays in place so
 * `value instanceof Blob` keeps matching what zip.js produces.
 */
const domGlobals = ['DOMParser', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement'] as const;

/**
 * jsdom resolves `anchor.href` against this URL. Browsers percent-encode non-ASCII
 * paths while resolving, which decides whether TOC entries match spine items, so a
 * real http(s) URL is required (about:blank would return the raw attribute).
 */
const baseUrl = 'http://localhost/manage';

let nodeWindow: (Window & typeof globalThis) | undefined;

/**
 * Installs a jsdom-backed DOM on `globalThis` (once per process) and returns its document.
 * For Node only: never import this from browser code.
 */
export function installNodeDom(): Document {
  return nodeWindow ? nodeWindow.document : createNodeWindow(undefined).document;
}

/**
 * Replaces the installed DOM with a fresh jsdom window and returns its document.
 *
 * jsdom keeps every element with an `id` or `name` in any document of a window,
 * including each DOMParser document, in the window's named-property tracker
 * (lib/jsdom/living/window-properties.js), and never lets go of them while they stay
 * in their document. Browsers only do that for the window's own document. So in one
 * window every parsed chapter stays in memory (about 40 MB per light novel). A fresh
 * window per book lets the previous one, and everything it tracked, be collected.
 * Creating a window takes a few milliseconds.
 */
export function renewNodeDom(): Document {
  const previous = nodeWindow;
  const document = createNodeWindow(previous).document;

  previous?.close();

  return document;
}

function createNodeWindow(previous: (Window & typeof globalThis) | undefined) {
  const window = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: baseUrl
  }).window as unknown as Window & typeof globalThis;
  const target = globalThis as Record<string, unknown>;

  for (const key of domGlobals) {
    const current = target[key];

    if (current !== undefined && current !== window[key] && current !== previous?.[key]) {
      throw new Error(`Refusing to replace an existing global DOM implementation (${key})`);
    }
  }

  for (const key of domGlobals) {
    target[key] = window[key];
  }

  // jsdom does not implement innerText. The loader only reads innerText from documents
  // created by DOMParser (TOC labels). Those documents are never rendered, and for
  // elements that are not being rendered the spec defines innerText as textContent.
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? '';
      }
    });
  }

  // jsdom 28 cannot match `nav[epub\:type="toc"]`; see prefixed-attribute-selectors.ts.
  installPrefixedAttributeSelectorFix(window);

  nodeWindow = window;

  return window;
}
