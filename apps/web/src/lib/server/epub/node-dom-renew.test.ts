/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { installNodeDom, renewNodeDom } from './node-dom';

const B = String.fromCharCode(92);
const toc =
  '<html><body><nav epub:type="toc" id="t1"><a href="ch1.xhtml">第一章</a></nav></body></html>';

describe('renewNodeDom', () => {
  it('swaps in a fresh window that works like the first one', () => {
    const first = installNodeDom();

    expect(installNodeDom()).toBe(first);

    const firstParser = globalThis.DOMParser;
    const second = renewNodeDom();

    expect(second).not.toBe(first);
    expect(installNodeDom()).toBe(second);
    expect(globalThis.DOMParser).not.toBe(firstParser);
    expect(globalThis.DOMParser).toBe(second.defaultView!.DOMParser);

    // The Node-only fixes are installed on the new window too.
    const parsed = new DOMParser().parseFromString(toc, 'text/html');
    const nav = parsed.querySelector(`nav[epub${B}:type="toc"]`);

    expect(nav?.id).toBe('t1');
    expect((parsed.querySelector('a') as HTMLElement).innerText).toBe('第一章');
    expect((parsed.querySelector('a') as HTMLAnchorElement).href).toBe(
      'http://localhost/ch1.xhtml'
    );
  });
});
