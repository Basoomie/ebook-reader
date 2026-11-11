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
 * dialog layer, so the confirmation gets its own layer above it, built like whispersync's
 * dialog layer (same classes, so it takes the menu's reader-theme colours). It does not use
 * whispersync's dialog store: that store's `add` changes its array in place, which this app's
 * immutable Svelte build doesn't re-render (vendored code, left unchanged). Whispersync's
 * keys are paused while it is open.
 */
export function confirmDestructiveInWhispersync(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const keysWereSkipped = get(skipKeyListener$);
    skipKeyListener$.set(true);

    const layer = document.createElement('div');
    layer.className = 'ttu-whispersync-dialog writing-horizontal-tb fixed inset-0 h-full w-full';
    layer.style.zIndex = '80';
    const backdrop = document.createElement('div');
    backdrop.className = 'tap-highlight-transparent absolute inset-0 bg-black/[.32]';
    const holder = document.createElement('div');
    holder.className =
      'ttu-whispersync-container dialog-container relative top-1/2 left-1/2 inline-block max-w-[80vw] -translate-x-1/2 -translate-y-1/2 rounded';
    layer.append(backdrop, holder);
    document.body.append(layer);

    let closed = false;
    const dialog = new ConfirmDestructiveDialog({
      target: holder,
      props: { ...options, surface: 'inherit', resolver: resolve }
    });
    const close = () => {
      if (closed) return;
      closed = true;
      // Destroying answers "no" when nothing was chosen (the dialog's onDestroy).
      dialog.$destroy();
      layer.remove();
      skipKeyListener$.set(keysWereSkipped);
    };
    dialog.$on('close', close);
    backdrop.addEventListener('click', close);
  });
}
