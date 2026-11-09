<script lang="ts">
  import type { CatalogBook } from '$lib/library/types';
  import { faCheck } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

  export let book: CatalogBook;
  /** Absolute thumbnail URL, or '' for none. */
  export let thumbnailUrl: string;
  export let onDevice = false;
  export let libraryName = '';

  const dispatch = createEventDispatcher<{ open: CatalogBook }>();

  let thumbFailed = false;

  $: authors = book.authors.map((a) => a.name).join(', ');
  $: series = book.series
    ? `${book.series.name}${book.series.index !== null ? ` ${formatIndex(book.series.index)}` : ''}`
    : '';

  function formatIndex(index: number) {
    return Number.isInteger(index) ? String(index) : index.toFixed(1);
  }
</script>

<li>
  <button
    class="flex w-full items-center gap-4 border-b border-gray-400/40 py-3 text-left"
    on:click={() => dispatch('open', book)}
  >
    <div class="flex h-[72px] w-12 shrink-0 items-center justify-center bg-gray-400/20">
      {#if thumbnailUrl && !thumbFailed}
        <img
          class="h-[72px] w-12 object-cover"
          src={thumbnailUrl}
          alt=""
          width="48"
          height="72"
          loading="lazy"
          decoding="async"
          on:error={() => (thumbFailed = true)}
        />
      {/if}
    </div>
    <div class="min-w-0 grow">
      <div class="line-clamp-2 font-medium">{book.title}</div>
      {#if authors}
        <div class="truncate text-sm">{authors}</div>
      {/if}
      {#if series || libraryName}
        <div class="truncate text-sm opacity-75">
          {series}{series && libraryName ? ' · ' : ''}{libraryName}
        </div>
      {/if}
    </div>
    {#if onDevice}
      <div class="flex shrink-0 items-center gap-1 text-sm" title="Saved on this device">
        <Fa icon={faCheck} />
        <span class="hidden sm:inline">On this device</span>
      </div>
    {/if}
  </button>
</li>
