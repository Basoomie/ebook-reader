<script lang="ts">
  /**
   * A collection on the Collections page (WP8b): 2x2 cover collage, name and a line or
   * two (book count, "Saved search"). A link to the collection; when a cover in it is
   * hidden, the first tap shows it instead (as group cards, WP7a).
   */
  import CoverCollage from '$lib/components/library/cover-collage.svelte';
  import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

  export let id: string;
  export let name: string;
  export let href: string;
  export let details: string[] = [];
  export let tiles: { src: string; blurred: boolean }[];
  export let layout: 'grid' | 'list' = 'grid';
  /** A "⋯" button (rename, delete; not for built-ins). */
  export let menu = false;

  const dispatch = createEventDispatcher<{ reveal: string; menu: string }>();

  $: hidden = tiles.some((t) => t.blurred);

  function onClick(ev: MouseEvent) {
    if (!hidden) return;
    ev.preventDefault();
    dispatch('reveal', id);
  }
</script>

{#if layout === 'grid'}
  <li class="min-w-0" data-testid="collection-card" data-collection={id}>
    <a class="block" {href} on:click={onClick}>
      <div class="aspect-[2/3] w-full">
        <CoverCollage {tiles} />
      </div>
      <div class="mt-1 line-clamp-2 break-words text-sm font-medium leading-snug">{name}</div>
    </a>
    <div class="flex items-start">
      <div class="min-w-0 grow text-xs opacity-75" data-testid="collection-info">
        {#each details as line}<div class="truncate">{line}</div>{/each}
      </div>
      {#if menu}
        <button
          class="-mr-2 -mt-1 flex h-12 w-12 shrink-0 items-center justify-center"
          title="Rename or delete"
          aria-label="More: {name}"
          data-testid="collection-menu"
          on:click={() => dispatch('menu', id)}
        >
          <Fa icon={faEllipsisVertical} />
        </button>
      {/if}
    </div>
  </li>
{:else}
  <li
    class="flex items-center border-b border-gray-400/40"
    data-testid="collection-card"
    data-collection={id}
  >
    <a class="flex min-w-0 grow items-center gap-4 py-3" {href} on:click={onClick}>
      <div class="h-[72px] w-12 shrink-0">
        <CoverCollage {tiles} compact />
      </div>
      <div class="min-w-0 grow">
        <div class="line-clamp-2 break-words font-medium">{name}</div>
        <div class="truncate text-sm opacity-75" data-testid="collection-info">
          {details.join(' · ')}
        </div>
      </div>
    </a>
    {#if menu}
      <button
        class="flex h-12 w-12 shrink-0 items-center justify-center"
        title="Rename or delete"
        aria-label="More: {name}"
        data-testid="collection-menu"
        on:click={() => dispatch('menu', id)}
      >
        <Fa icon={faEllipsisVertical} />
      </button>
    {/if}
  </li>
{/if}
