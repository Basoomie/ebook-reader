/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import ConfirmDestructiveDialog from '$lib/components/confirm/confirm-destructive-dialog.svelte';
import { dialogManager } from '$lib/data/dialog-manager';
import type { ConfirmOptions } from './confirm-state';

/**
 * Asks before a destructive action (WP19). Resolves true only when the action button was
 * pressed; Cancel, Esc, a backdrop tap or another dialog taking its place resolve false.
 * Replaces any open dialog, so call it from a page, not from inside a dialog (use
 * inline-confirm.svelte there).
 */
export function confirmDestructive(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    dialogManager.dialogs$.next([
      {
        component: ConfirmDestructiveDialog,
        props: { ...options, resolver: resolve }
      }
    ]);
  });
}
