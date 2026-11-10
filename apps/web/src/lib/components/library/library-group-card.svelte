<script lang="ts">
  /**
   * A series, author, tag or "No series" card in the browse tabs (WP7a). A link to the
   * group's own page; when a cover in it is hidden, the first tap shows it instead.
   */
  import { formatGroupChars, groupCount, groupTitle } from '$lib/library/format';
  import type { CatalogGroup } from '$lib/library/types';
  import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import CoverCollage from './cover-collage.svelte';

  export let group: CatalogGroup;
  export let href: string;
  /** Resolved tiles (one for a series). */
  export let tiles: { src: string; blurred: boolean }[];
  /** Series: completed volumes (from this device's book state). */
  export let readCount = 0;
  export let layout: 'grid' | 'list' = 'grid';
  export let infoLine = true;
  /** Tags: a "⋯" button for the tag's cover rule. */
  export let menu = false;

  const dispatch = createEventDispatcher<{ reveal: CatalogGroup; menu: CatalogGroup }>();

  $: hidden = tiles.some((t) => t.blurred);
  $: isSeries = group.by === 'series' && group.name !== null;
  $: details = [
    groupCount(group),
    isSeries && readCount > 0 ? `${readCount}/${group.bookCount} read` : '',
    isSeries ? formatGroupChars(group.chars) : ''
  ].filter(Boolean);

  function onClick(ev: MouseEvent) {
    if (!hidden) return;
    ev.preventDefault();
    dispatch('reveal', group);
  }
</script>

{#if layout === 'grid'}
  <li class="min-w-0" data-testid="group-card" data-group={group.name ?? ''}>
    <a class="block" {href} on:click={onClick} data-sveltekit-noscroll>
      <div class="aspect-[2/3] w-full">
        <CoverCollage {tiles} />
      </div>
      <div class="mt-1 line-clamp-2 text-sm font-medium leading-snug">{groupTitle(group)}</div>
    </a>
    <div class="flex items-start">
      {#if infoLine}
        <div class="min-w-0 grow text-xs opacity-75" data-testid="group-info">
          {#each details as line}<div class="truncate">{line}</div>{/each}
        </div>
      {:else}
        <div class="grow" />
      {/if}
      {#if menu}
        <button
          class="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center"
          title="Cover settings for this tag"
          aria-label="Cover settings: {groupTitle(group)}"
          data-testid="group-menu"
          on:click={() => dispatch('menu', group)}
        >
          <Fa icon={faEllipsisVertical} />
        </button>
      {/if}
    </div>
  </li>
{:else}
  <li
    class="flex items-center border-b border-gray-400/40"
    data-testid="group-card"
    data-group={group.name ?? ''}
  >
    <a
      class="flex min-w-0 grow items-center gap-4 py-3"
      {href}
      on:click={onClick}
      data-sveltekit-noscroll
    >
      <div class="h-[72px] w-12 shrink-0">
        <CoverCollage {tiles} compact />
      </div>
      <div class="min-w-0 grow">
        <div class="line-clamp-2 font-medium">{groupTitle(group)}</div>
        {#if infoLine}
          <div class="truncate text-sm opacity-75" data-testid="group-info">
            {details.join(' · ')}
          </div>
        {/if}
      </div>
    </a>
    {#if menu}
      <button
        class="flex h-12 w-12 shrink-0 items-center justify-center"
        title="Cover settings for this tag"
        aria-label="Cover settings: {groupTitle(group)}"
        data-testid="group-menu"
        on:click={() => dispatch('menu', group)}
      >
        <Fa icon={faEllipsisVertical} />
      </button>
    {/if}
  </li>
{/if}
