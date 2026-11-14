<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A /cleanup section that can be folded away (the lists get long): the Settings-style heading
   * (Japanese label, mincho title, gold rule) as one 48 px button with ▸/▾ and a short
   * summary (e.g. how many copies). Closed by default; this device remembers it per section.
   */
  import { onMount } from 'svelte';

  export let id: string;
  export let jp: string;
  export let title: string;
  /** Shown beside the title, also when closed (e.g. "3,700"). */
  export let summary = '';
  export let testid = '';

  const KEY = `ttsu.cleanup.open.${id}`;
  let open = false;

  onMount(() => {
    try {
      open = localStorage.getItem(KEY) === '1';
    } catch {
      // No storage (private window): starts closed.
    }
  });

  function toggle() {
    open = !open;
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
      // Not remembered; still works.
    }
  }
</script>

<section class="mt-10 flex flex-col gap-3" data-testid={testid || undefined}>
  <button
    class="flex min-h-[3rem] w-full flex-wrap items-baseline gap-x-4 gap-y-1 border-b pb-2 text-left"
    style="border-color: var(--c-gold)"
    aria-expanded={open}
    aria-controls="cleanup-section-{id}"
    data-testid={testid ? `${testid}-toggle` : undefined}
    on:click={toggle}
  >
    <span class="c-jp-label" aria-hidden="true">{jp}</span>
    <h2 class="font-mincho text-xl font-bold">
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      {title}
    </h2>
    {#if summary}<span class="text-sm text-c-muted">{summary}</span>{/if}
  </button>
  {#if open}
    <div id="cleanup-section-{id}" class="flex flex-col gap-3">
      <slot />
    </div>
  {/if}
</section>
