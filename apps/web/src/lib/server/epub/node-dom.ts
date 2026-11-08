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

let nodeDocument: Document | undefined;

/**
 * Installs a jsdom-backed DOM on `globalThis` (once per process) and returns its document.
 * For Node only: never import this from browser code.
 */
export function installNodeDom(): Document {
  if (nodeDocument) {
    return nodeDocument;
  }

  const { window } = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: baseUrl
  });
  const target = globalThis as Record<string, unknown>;

  for (const key of domGlobals) {
    if (target[key] !== undefined && target[key] !== window[key]) {
      throw new Error(`Refusing to replace an existing global DOM implementation (${key})`);
    }

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
  installPrefixedAttributeSelectorFix(window as unknown as Window & typeof globalThis);

  nodeDocument = window.document;

  return nodeDocument;
}
