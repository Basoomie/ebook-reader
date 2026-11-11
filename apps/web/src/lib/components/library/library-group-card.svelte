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
  <li class="c-card min-w-0" data-testid="group-card" data-group={group.name ?? ''}>
    <a class="c-focus block rounded-sm" {href} on:click={onClick} data-sveltekit-noscroll>
      <div class="c-cover aspect-[2/3] w-full overflow-hidden rounded-sm">
        <CoverCollage {tiles} />
      </div>
      <div class="mt-2 line-clamp-2 font-mincho text-[15px] font-bold leading-snug">
        {groupTitle(group)}
      </div>
    </a>
    <div class="flex items-start">
      {#if infoLine}
        <div class="min-w-0 grow text-xs leading-relaxed text-c-muted" data-testid="group-info">
          {#each details as line}<div class="truncate">{line}</div>{/each}
        </div>
      {:else}
        <div class="grow" />
      {/if}
      {#if menu}
        <button
          class="c-btn c-btn-ghost -mr-2 h-10 min-h-0 w-10 shrink-0 p-0"
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
    class="c-group-row flex items-center border-b"
    style="border-color: var(--c-line)"
    data-testid="group-card"
    data-group={group.name ?? ''}
  >
    <a
      class="c-focus flex min-w-0 grow items-center gap-4 px-1 py-3"
      {href}
      on:click={onClick}
      data-sveltekit-noscroll
    >
      <div class="c-cover h-[72px] w-12 shrink-0 overflow-hidden rounded-sm">
        <CoverCollage {tiles} compact />
      </div>
      <div class="min-w-0 grow">
        <div class="line-clamp-2 font-mincho font-bold">{groupTitle(group)}</div>
        {#if infoLine}
          <div class="truncate text-sm text-c-muted" data-testid="group-info">
            {details.join(' · ')}
          </div>
        {/if}
      </div>
    </a>
    {#if menu}
      <button
        class="c-btn c-btn-ghost h-12 w-12 shrink-0 p-0"
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

<style>
  @media (hover: hover) {
    .c-group-row:hover {
      background-color: var(--c-tint);
    }
  }
</style>
