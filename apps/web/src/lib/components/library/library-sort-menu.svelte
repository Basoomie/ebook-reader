<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
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
  import { ratingFeatures$ } from '$lib/library/store-ratings';

  /** WP19a: the Sort button of the Library, collections and the Notes page (lib/library/sort.ts). */
  export let context: SortContext;
  export let value: SortValue;
  /** On a phone the button shows the sort's name only (the direction is in the menu). */
  export let shortOnPhone = false;

  const dispatch = createEventDispatcher<{ change: SortValue }>();
  const DIRS: SortDir[] = ['asc', 'desc'];
  /** WP19b: the small Japanese name of each sort. */
  const JP: Record<string, string> = {
    added: '追加日',
    title: '書名',
    author: '著者',
    chars: '文字数',
    published: '刊行日',
    level: '難易度',
    rating: '評価',
    ratings: '評価数',
    readers: '読者数',
    series: '巻順',
    list: '並べた順',
    newest: '追加日',
    name: '名前',
    count: '冊数',
    // The Notes page (its own `count` is highlights, not books).
    changed: '更新日',
    created: '作成日',
    book: '本順'
  };
  const NOTES_JP: Record<string, string> = { count: '件数' };

  // Most read (読書メーター) only once the server shows 読書メーター (its links are being fixed).
  $: choices = sortChoices(context).filter(
    (c) => c.key !== 'readers' || $ratingFeatures$.bookmeter || value.key === 'readers'
  );
  $: current = choices.find((c) => c.key === value.key);

  function pick(key: string) {
    const next = pickKey(value, key, context);
    if (next.key !== value.key || next.dir !== value.dir) dispatch('change', next);
  }

  function pickDir(dir: SortDir) {
    if (dir !== value.dir) dispatch('change', { key: value.key, dir });
  }
</script>

<DropdownMenu buttonClass="c-btn c-btn-ghost px-3" align="right" label="Sort" testid="sort-menu">
  <span slot="button" class="flex items-center gap-2">
    <span class="hidden font-mincho font-bold text-c-label sm:inline" aria-hidden="true"
      >並び順</span
    >
    <span data-testid="sort-label"
      ><span class="sr-only"
        >Sort:
      </span>{#if shortOnPhone && current && !current.own}{current.label}<span
          class="hidden sm:inline"
        >
          · {current.dirLabels[value.dir]}</span
        ><span class="sr-only sm:hidden">, {current.dirLabels[value.dir]}</span>{:else}{sortLabel(
          value,
          context
        )}{/if}</span
    >
    <span class="opacity-70" aria-hidden="true"><Fa icon={faChevronDown} size="xs" /></span>
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
        <span class="font-mincho text-xs opacity-80" aria-hidden="true"
          >{(context.startsWith('notes') ? NOTES_JP[choice.key] : undefined) ??
            JP[choice.key] ??
            ''}</span
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
