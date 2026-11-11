<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import {
    COVER_SIZE_MAX,
    COVER_SIZE_MIN,
    COVER_SIZE_START,
    COVER_SIZE_STEP,
    coverSize
  } from '$lib/library/cover-size';
  import {
    libraryAutoLoad$,
    libraryCoverSize$,
    libraryInfoLine$,
    libraryView$
  } from '$lib/library/settings';
  import { faTableCellsLarge } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';

  /**
   * WP19a: the Display button of the Library and the Collections page. Every choice is a
   * per-device setting and applies at once.
   */

  /** Show "Details under covers" (lists of books, not the Collections page). */
  export let details = true;
  /** Show "Load more while scrolling". */
  export let autoLoad = true;

  $: grid = $libraryView$ !== 'list';
  $: size = coverSize($libraryCoverSize$);

  function onSlider(ev: Event) {
    $libraryCoverSize$ = coverSize((ev.currentTarget as HTMLInputElement).value);
  }
</script>

<DropdownMenu
  buttonClass="c-btn c-btn-secondary px-3"
  align="right"
  label="Display"
  testid="display-menu"
  panelWidth="w-80"
>
  <span slot="button" class="flex items-center gap-2"><Fa icon={faTableCellsLarge} />Display</span>
  <div class="flex flex-col gap-3 p-1">
    <div class="grid grid-cols-2 gap-1" role="group" aria-label="View">
      <button
        type="button"
        class="c-btn c-btn-secondary px-3"
        aria-pressed={grid}
        data-testid="view-grid"
        on:click={() => ($libraryView$ = 'grid')}
      >
        Grid
      </button>
      <button
        type="button"
        class="c-btn c-btn-secondary px-3"
        aria-pressed={!grid}
        data-testid="view-list"
        on:click={() => ($libraryView$ = 'list')}
      >
        List
      </button>
    </div>
    <div>
      <label class="flex flex-col gap-1" for="library-cover-size">
        <span class="flex justify-between text-sm">
          <span class="font-medium">Cover size</span>
          <span class="text-c-muted" data-testid="cover-size-value"
            >{size ? `${size} px` : 'Automatic'}</span
          >
        </span>
      </label>
      <input
        id="library-cover-size"
        class="c-range h-12 w-full"
        type="range"
        min={COVER_SIZE_MIN}
        max={COVER_SIZE_MAX}
        step={COVER_SIZE_STEP}
        value={size || COVER_SIZE_START}
        disabled={!grid}
        data-testid="cover-size"
        on:input={onSlider}
      />
      <div class="flex items-center justify-between text-xs text-c-muted">
        <span>Small</span>
        <button
          type="button"
          class="c-btn c-btn-secondary min-h-[2.75rem] px-3 text-sm"
          aria-pressed={size === 0}
          disabled={!grid}
          data-testid="cover-size-auto"
          on:click={() => ($libraryCoverSize$ = 0)}
        >
          Automatic
        </button>
        <span>Large</span>
      </div>
    </div>
    {#if details}
      <label class="flex min-h-[3rem] items-center gap-3 text-sm">
        <input
          class="h-5 w-5 rounded"
          type="checkbox"
          data-testid="view-details"
          bind:checked={$libraryInfoLine$}
        />
        Details under covers
      </label>
    {/if}
    {#if autoLoad}
      <label class="flex min-h-[3rem] items-center gap-3 text-sm">
        <input
          class="h-5 w-5 rounded"
          type="checkbox"
          data-testid="auto-load"
          bind:checked={$libraryAutoLoad$}
        />
        Load more while scrolling
      </label>
    {/if}
  </div>
</DropdownMenu>
