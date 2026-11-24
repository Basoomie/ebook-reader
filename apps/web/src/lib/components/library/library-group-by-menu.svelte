<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import type { GroupBy } from '$lib/library/types';
  import { createEventDispatcher } from 'svelte';

  /**
   * A collection's Group by (2026-11-24, Sections in Settings › Library › Look): the books
   * under one heading per series, author or tag, or one list (null).
   */
  export let value: GroupBy | null;

  const dispatch = createEventDispatcher<{ change: GroupBy | null }>();
  const CHOICES: { by: GroupBy | null; label: string; jp: string }[] = [
    { by: null, label: 'None', jp: '' },
    { by: 'series', label: 'Series', jp: '叢書' },
    { by: 'author', label: 'Author', jp: '著者' },
    { by: 'tag', label: 'Tag', jp: '分類' }
  ];

  $: current = CHOICES.find((c) => c.by === value) ?? CHOICES[0];
</script>

<DropdownMenu
  buttonClass="c-btn c-btn-ghost px-3"
  align="right"
  label="Group by"
  testid="group-by-menu"
  let:close
>
  <span slot="button" class="flex items-center gap-2">
    <span class="text-c-muted">Group by</span>
    <span data-testid="group-by-label">{current.label}</span>
    <span class="opacity-70" aria-hidden="true"><Fa icon={faChevronDown} size="xs" /></span>
  </span>
  <div class="flex flex-col gap-1" role="group" aria-label="Group by">
    {#each CHOICES as choice (choice.label)}
      <button
        type="button"
        class="c-btn c-btn-ghost justify-between px-3 text-left"
        class:c-selected={choice.by === value}
        aria-pressed={choice.by === value}
        data-testid="group-by-{choice.by ?? 'none'}"
        on:click={() => {
          close();
          if (choice.by !== value) dispatch('change', choice.by);
        }}
      >
        <span>{choice.label}</span>
        <span class="font-mincho text-xs opacity-80" aria-hidden="true">{choice.jp}</span>
      </button>
    {/each}
  </div>
</DropdownMenu>
