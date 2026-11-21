/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dialogManager } from './dialog-manager';

afterEach(() => dialogManager.close());

function current() {
  return dialogManager.dialogs$.getValue()[0];
}

describe('dialogManager.open', () => {
  it("resolves with the dialog's answer", async () => {
    const answer = dialogManager.open<string>('<p/>', { a: 1 });
    expect(current().props?.a).toBe(1);
    current().props?.resolver('picked');
    dialogManager.close();
    await expect(answer).resolves.toBe('picked');
  });

  it('resolves undefined when the dialog closes without an answer (Esc, ✕, outside click)', async () => {
    const answer = dialogManager.open<string>('<p/>');
    dialogManager.close();
    await expect(answer).resolves.toBeUndefined();
  });

  it('resolves undefined when another dialog takes its place', async () => {
    const first = dialogManager.open<boolean>('<p/>');
    const second = dialogManager.open<boolean>('<div/>');
    await expect(first).resolves.toBeUndefined();
    current().props?.resolver(true);
    await expect(second).resolves.toBe(true);
  });

  it('counts only the first answer', async () => {
    const answer = dialogManager.open<number>('<p/>');
    current().props?.resolver(1);
    current().props?.resolver(2);
    await expect(answer).resolves.toBe(1);
  });
});
