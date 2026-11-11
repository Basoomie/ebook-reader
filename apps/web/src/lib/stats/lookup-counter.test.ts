/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { LookupCounter } from '$lib/stats/lookup-counter';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('LookupCounter', () => {
  let counter: LookupCounter | null = null;
  afterEach(() => {
    counter?.stop();
    document.body.innerHTML = '';
  });

  it('counts each time a Yomitan popup is shown, not while it stays shown', async () => {
    let count = 0;
    counter = new LookupCounter(document, () => (count += 1));
    counter.start();
    const popup = document.createElement('iframe');
    popup.className = 'yomitan-popup';
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    await settle();
    expect(count).toBe(0);
    popup.style.visibility = 'visible';
    await settle();
    expect(count).toBe(1);
    popup.style.left = '10px'; // moved to the next word, still shown
    await settle();
    expect(count).toBe(1);
    popup.style.visibility = 'hidden';
    await settle();
    popup.style.visibility = 'visible';
    await settle();
    expect(count).toBe(2);
  });

  it('counts a popup that is added already shown, and the jpdb popup by opacity', async () => {
    let count = 0;
    counter = new LookupCounter(document, () => (count += 1));
    counter.start();
    const popup = document.createElement('div');
    popup.className = 'yomichan-float';
    document.body.appendChild(popup);
    await settle();
    expect(count).toBe(1);
    const jpdb = document.createElement('div');
    jpdb.id = 'jpdb-popup';
    jpdb.style.opacity = '0';
    document.body.appendChild(jpdb);
    await settle();
    expect(count).toBe(1);
    jpdb.style.opacity = '1';
    await settle();
    expect(count).toBe(2);
  });

  it('stops counting after stop()', async () => {
    let count = 0;
    counter = new LookupCounter(document, () => (count += 1));
    counter.start();
    counter.stop();
    const popup = document.createElement('div');
    popup.className = 'yomitan-popup';
    document.body.appendChild(popup);
    await settle();
    expect(count).toBe(0);
  });
});
