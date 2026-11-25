<script lang="ts">
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { onDestroy, onMount } from 'svelte';
  import AppNavLinks from './app-nav-links.svelte';
  import Fa from 'svelte-fa';
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import { searchHeaderButton$, searchPaletteCtrlK$ } from '$lib/library/search-settings';
  import { openSearchPalette, opensPalette } from '$lib/search-palette/open';
  /**
   * A catalogue page's fixed header (WP19b: the navy bar of the "Archive" look) with the
   * app navigation on wider screens. Pages put <AppBottomBar /> at their end for phones
   * (it also leaves room for itself there) and their own <h1> in the page.
   *
   * Mounting it marks the document as a catalogue page (`html.catalogue`), so the page
   * behind the content takes the catalogue colours too (app.scss).
   *
   * z-40: above everything that scrolls under it (the cards' ⋮ buttons and author links
   * are z-10, the drag-select box z-20, the Sort / Display / Download panels z-30), below
   * dialogs and overlays (z-50). `data-app-header` lets a floating menu keep clear of it.
   */
  export let title: string;
  /**
   * Search palette step 2: the search button and its keys ("/", Ctrl+K when on). Only the
   * catalogue pages pass it (Home, Library, Collections, Notes, Recently viewed, Stats).
   */
  export let search = false;

  function onKeydown(event: KeyboardEvent) {
    if (!search || !opensPalette(event, $searchPaletteCtrlK$)) return;
    // Another dialog is open: its own keys win.
    if (document.querySelector('.c-modal-layer')) return;
    event.preventDefault();
    void openSearchPalette();
  }

  onMount(() => document.documentElement.classList.add('catalogue'));
  onDestroy(() => {
    if (typeof document !== 'undefined') document.documentElement.classList.remove('catalogue');
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div
  class="fixed inset-x-0 top-0 z-40 bg-c-header text-c-header-ink"
  data-app-header
  style="border-bottom: var(--c-border-width) solid var(--c-header-border)"
>
  <div class="relative h-12 xl:h-10">
    <div class="{pxScreen} flex h-full items-center justify-between gap-2">
      <a
        class="c-focus flex min-w-0 items-center gap-2"
        href="{pagePath}/home"
        title="Home"
        data-testid="app-logo"
      >
        <span class="font-mincho text-xl font-bold tracking-wide">ッツ</span>
        <span
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-c-seal font-mincho text-xs font-bold leading-none text-white"
          aria-hidden="true">書</span
        >
        <span class="truncate pl-1 text-sm font-medium text-c-header-muted sm:hidden">{title}</span>
      </a>
      <div class="flex h-full items-center">
        <slot />
        {#if search && $searchHeaderButton$}
          <button
            type="button"
            class="c-focus mr-1 flex h-9 items-center gap-2 rounded-[10px] px-3 text-sm text-c-header-muted hover:text-c-header-ink sm:mr-2 sm:border"
            style="border-color: color-mix(in srgb, var(--c-header-muted) 40%, transparent)"
            title="Search the library (/)"
            aria-label="Search the library"
            aria-keyshortcuts="/"
            data-testid="header-search"
            on:click={() => openSearchPalette()}
          >
            <Fa icon={faMagnifyingGlass} />
            <span class="hidden lg:inline">Search</span>
            <kbd
              class="hidden rounded border px-1 font-mono text-xs lg:inline"
              style="border-color: color-mix(in srgb, var(--c-header-muted) 40%, transparent)"
              >/</kbd
            >
          </button>
        {/if}
        <AppNavLinks />
      </div>
    </div>
  </div>
</div>
