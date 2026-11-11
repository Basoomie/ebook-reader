<script lang="ts">
  /**
   * A collection on the Collections page (WP8b): 2x2 cover collage, name and a line or
   * two (book count, "Manual" or "Smart"). A link to the collection; when a cover in it is
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
  <li class="c-card min-w-0" data-testid="collection-card" data-collection={id}>
    <a class="c-focus block rounded-sm" {href} on:click={onClick}>
      <div class="c-cover aspect-[2/3] w-full overflow-hidden rounded-sm">
        <CoverCollage {tiles} />
      </div>
      <div class="mt-2 line-clamp-2 break-words font-mincho text-[15px] font-bold leading-snug">
        {name}
      </div>
    </a>
    <div class="flex items-start">
      <div class="min-w-0 grow text-xs leading-relaxed text-c-muted" data-testid="collection-info">
        {#each details as line}<div class="truncate">{line}</div>{/each}
      </div>
      {#if menu}
        <button
          class="c-btn c-btn-ghost -mr-2 h-12 w-12 shrink-0 p-0"
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
    class="c-collection-row flex items-center border-b"
    style="border-color: var(--c-line)"
    data-testid="collection-card"
    data-collection={id}
  >
    <a class="c-focus flex min-w-0 grow items-center gap-4 px-1 py-3" {href} on:click={onClick}>
      <div class="c-cover h-[72px] w-12 shrink-0 overflow-hidden rounded-sm">
        <CoverCollage {tiles} compact />
      </div>
      <div class="min-w-0 grow">
        <div class="line-clamp-2 break-words font-mincho font-bold">{name}</div>
        <div class="truncate text-sm text-c-muted" data-testid="collection-info">
          {details.join(' · ')}
        </div>
      </div>
    </a>
    {#if menu}
      <button
        class="c-btn c-btn-ghost h-12 w-12 shrink-0 p-0"
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

<style>
  @media (hover: hover) {
    .c-collection-row:hover {
      background-color: var(--c-tint);
    }
  }
</style>
