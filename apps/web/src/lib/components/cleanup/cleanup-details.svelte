<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A card's "Details" fold on /cleanup (user, 2026-11-19: "I don't need to look at all that
   * info 24/7"): closed by default, and this device remembers it per fold, as the Audiobooks
   * tab's cards do. `toggle` fires when it opens, for folds that load a list.
   */
  import { createEventDispatcher, onMount } from 'svelte';

  export let id: string;
  export let label = 'Details';
  export let testid = '';

  const KEY = `ttsu.cleanup.details.${id}`;
  const dispatch = createEventDispatcher<{ opened: void }>();
  let open = false;

  onMount(() => {
    try {
      open = localStorage.getItem(KEY) === '1';
    } catch {
      // No storage (private window): starts closed.
    }
    if (open) dispatch('opened');
  });

  function toggled(e: Event) {
    const now = (e.currentTarget as HTMLDetailsElement).open;
    if (now === open) return;
    open = now;
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
      // Not remembered; still works.
    }
    if (open) dispatch('opened');
  }
</script>

<details {open} on:toggle={toggled} data-testid={testid || undefined}>
  <summary class="cursor-pointer text-sm text-c-muted">{label}</summary>
  <div class="mt-2 flex flex-col gap-2 text-sm">
    <slot />
  </div>
</details>
