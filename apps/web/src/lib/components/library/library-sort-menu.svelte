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
  const DIRS: SortDir[] = ['asc', 'desc'];
  /** WP19b: the small Japanese name of each sort. */
  const JP: Record<string, string> = {
    added: '追加日',
    title: '書名',
    author: '著者',
    chars: '文字数',
    published: '刊行日',
    series: '巻順',
    list: '並べた順',
    newest: '追加日',
    name: '名前',
    count: '冊数'
  };

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
  buttonClass="c-btn c-btn-secondary px-3"
  align="right"
  label="Sort"
  testid="sort-menu"
>
  <span slot="button" class="flex items-center gap-2">
    <span class="hidden font-mincho font-bold text-c-label sm:inline" aria-hidden="true"
      >並び順</span
    >
    <span data-testid="sort-label"
      ><span class="sr-only">Sort: </span>{sortLabel(value, context)}</span
    >
  </span>
  <div class="flex flex-col gap-1" role="group" aria-label="Sort by">
    {#each choices as choice (choice.key)}
      <button
        type="button"
        class="c-btn c-btn-ghost justify-between px-3 text-left"
        class:c-selected={choice.key === value.key}
        aria-pressed={choice.key === value.key}
        data-testid="sort-{choice.key}"
        on:click={() => pick(choice.key)}
      >
        <span>{choice.label}</span>
        <span class="font-mincho text-xs opacity-80" aria-hidden="true">{JP[choice.key] ?? ''}</span
        >
      </button>
    {/each}
  </div>
  {#if current && !current.own}
    <div
      class="mt-2 grid grid-cols-2 gap-1 border-t pt-2"
      style="border-color: var(--c-line)"
      role="group"
      aria-label="Direction"
    >
      {#each DIRS as dir (dir)}
        <button
          type="button"
          class="c-btn c-btn-secondary px-2 text-sm"
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
