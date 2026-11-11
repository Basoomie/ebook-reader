<script lang="ts">
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { onDestroy, onMount } from 'svelte';
  import AppNavLinks from './app-nav-links.svelte';

  /**
   * A catalogue page's fixed header (WP19b: the navy bar of the "Archive" look) with the
   * app navigation on wider screens. Pages put <AppBottomBar /> at their end for phones
   * (it also leaves room for itself there) and their own <h1> in the page.
   *
   * Mounting it marks the document as a catalogue page (`html.catalogue`), so the page
   * behind the content takes the catalogue colours too (app.scss).
   */
  export let title: string;

  onMount(() => document.documentElement.classList.add('catalogue'));
  onDestroy(() => {
    if (typeof document !== 'undefined') document.documentElement.classList.remove('catalogue');
  });
</script>

<div
  class="fixed inset-x-0 top-0 z-10 bg-c-header text-c-header-ink"
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
        <AppNavLinks />
      </div>
    </div>
  </div>
</div>
