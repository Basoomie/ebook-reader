/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { StorageKey } from './storage/storage-types';
import { writableSubject } from '$lib/functions/svelte/store';

export interface SyncSelection {
  id: string;
  label: string;
  type: StorageKey;
}

/**
 * One open dialog. A component draws its own frame (lib/components/modal/modal.svelte:
 * backdrop, Esc, ✕, outside click) and dispatches `close` to go away. A string (`'<div/>'`)
 * is only a backdrop that blocks the page while the reader runs an action or a side menu is
 * open; it never closes on a click.
 */
export interface Dialog {
  component: (new (...args: any[]) => any) | string;
  props?: Record<string, any>;
}

const dialogs$ = writableSubject<Dialog[]>([]);

/**
 * Opens a dialog that answers through its `resolver` prop. The promise settles however the
 * dialog goes away: with the dialog's answer, or `undefined` when it was closed without one
 * (Esc, ✕, an outside click, another dialog taking its place), so a caller never hangs.
 */
function open<T>(
  component: Dialog['component'],
  props: Record<string, unknown> = {}
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const settle = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const entry: Dialog = { component, props: { ...props, resolver: settle } };
    dialogs$.next([entry]);
    let shown = false;
    const subscription = dialogs$.subscribe((list) => {
      if (list.includes(entry)) {
        shown = true;
        return;
      }
      if (!shown) return;
      settle(undefined);
      queueMicrotask(() => subscription.unsubscribe());
    });
  });
}

function close() {
  dialogs$.next([]);
}

export const dialogManager = {
  dialogs$,
  open,
  close
};
