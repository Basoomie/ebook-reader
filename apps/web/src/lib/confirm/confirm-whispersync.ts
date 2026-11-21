/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import ConfirmDestructiveDialog from '$lib/components/confirm/confirm-destructive-dialog.svelte';
import { skipKeyListener$ } from '$lib/whispersync/lib/stores';
import { get } from 'svelte/store';
import type { ConfirmOptions } from './confirm-state';

/**
 * `confirmDestructive` for whispersync's audiobook menu (WP19). The menu sits above the app's
 * dialog layer, so the confirmation is mounted on its own at z-index 80, in the reader
 * theme's colours. It does not use whispersync's dialog store: that store's `add` changes its
 * array in place, which this app's immutable Svelte build doesn't re-render (vendored code,
 * left unchanged). Whispersync's keys are paused while it is open; Esc, a click outside and
 * Cancel answer "no".
 */
export function confirmDestructiveInWhispersync(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const keysWereSkipped = get(skipKeyListener$);
    skipKeyListener$.set(true);

    const holder = document.createElement('div');
    document.body.append(holder);

    let closed = false;
    const dialog = new ConfirmDestructiveDialog({
      target: holder,
      props: { ...options, surface: 'inherit', zIndex: 80, resolver: resolve }
    });
    const close = () => {
      if (closed) return;
      closed = true;
      // Destroying answers "no" when nothing was chosen (the dialog's onDestroy).
      dialog.$destroy();
      holder.remove();
      skipKeyListener$.set(keysWereSkipped);
    };
    dialog.$on('close', close);
  });
}
