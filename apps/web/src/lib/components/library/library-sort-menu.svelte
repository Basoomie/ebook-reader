<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import {
    pickKey,
    sortChoices,
    sortLabel,
    type SortContext,
    type SortDir,
    type SortValue
  } from '$lib/library/sort';
  import { createEventDispatcher } from 'svelte';

  /** WP19a: the Sort button of the Library and collections (lib/library/sort.ts). */
  export let context: SortContext;
  export let value: SortValue;

  const dispatch = createEventDispatcher<{ change: SortValue }>();
  const solid = 'border-gray-800 bg-gray-800 text-white';
  const DIRS: SortDir[] = ['asc', 'desc'];

  $: choices = sortChoices(context);
  $: current = choices.find((c) => c.key === value.key);

  function pick(key: string) {
    const next = pickKey(value, key, context);
    if (next.key !== value.key || next.dir !== value.dir) dispatch('change', next);
  }

  function pickDir(dir: SortDir) {
    if (dir !== value.dir) dispatch('change', { key: value.key, dir });
  }
</script>

<DropdownMenu
  buttonClass="min-h-[3rem] rounded border-2 border-current px-3 text-left"
  align="right"
  label="Sort"
  testid="sort-menu"
>
  <span slot="button" data-testid="sort-label">Sort: {sortLabel(value, context)}</span>
  <div class="flex flex-col gap-1" role="group" aria-label="Sort by">
    {#each choices as choice (choice.key)}
      <button
        type="button"
        class="min-h-[3rem] rounded border-2 px-3 text-left font-medium {choice.key === value.key
          ? solid
          : 'border-transparent'}"
        aria-pressed={choice.key === value.key}
        data-testid="sort-{choice.key}"
        on:click={() => pick(choice.key)}
      >
        {choice.label}
      </button>
    {/each}
  </div>
  {#if current && !current.own}
    <div
      class="mt-2 grid grid-cols-2 gap-1 border-t-2 border-gray-800 pt-2"
      role="group"
      aria-label="Direction"
    >
      {#each DIRS as dir (dir)}
        <button
          type="button"
          class="min-h-[3rem] rounded border-2 px-2 {value.dir === dir ? solid : 'border-current'}"
          aria-pressed={value.dir === dir}
          data-testid="sort-dir-{dir}"
          on:click={() => pickDir(dir)}
        >
          {current.dirLabels[dir]}
        </button>
      {/each}
    </div>
  {/if}
</DropdownMenu>
