<script lang="ts">
  import { page } from '$app/stores';
  import { pagePath } from '$lib/data/env';
  import AppMenu from './app-menu.svelte';
  import { APP_NAV, isCurrentRoute } from './app-nav';

  /** Hidden while another bottom bar takes its place (the Library's select bar). */
  export let hidden = false;

  $: items = APP_NAV.map((entry) => ({ ...entry, current: isCurrentRoute($page.route.id, entry) }));
  // 56 px cells: a one-character mark over the label (WP19b). The current page has a
  // vermilion mark on top (E-ink: a black cell).
  const cell =
    'c-focus relative flex h-full w-full min-h-[3.5rem] flex-col items-center justify-center gap-0.5 text-[11px] font-medium';
</script>

{#if !hidden}
  <!-- Phones only: room for the bar at the end of the page, then the bar. -->
  <div class="h-16 sm:hidden" aria-hidden="true" />
  <nav
    class="c-bottom-bar fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 sm:hidden"
    aria-label="App"
    data-testid="app-bottom-bar"
  >
    {#each items as entry (entry.routeId)}
      <a
        class="{cell} {entry.current ? 'c-bar-current' : 'text-c-header-muted'}"
        href="{pagePath}{entry.routeId}"
        aria-current={entry.current ? 'page' : undefined}
        data-testid="bottom-nav-{entry.label.toLowerCase()}"
      >
        <span class="c-bar-mark" aria-hidden="true" />
        <span class="font-mincho text-base font-bold leading-none" aria-hidden="true"
          >{entry.glyph}</span
        >
        {entry.label}
      </a>
    {/each}
    <AppMenu buttonClass="{cell} text-c-header-muted" placement="above" glyph="⋯" />
  </nav>
{/if}

<style>
  .c-bottom-bar {
    background-color: var(--c-bar-bg);
    border-top: var(--c-border-width) solid var(--c-bar-border);
  }

  .c-bar-current {
    color: var(--c-header-ink);
  }

  .c-bar-mark {
    position: absolute;
    top: 4px;
    width: 18px;
    height: 3px;
    border-radius: 2px;
  }

  .c-bar-current .c-bar-mark {
    background-color: var(--c-seal);
  }

  :global(html.eink) .c-bar-current {
    background-color: #000;
    color: #fff;
  }

  :global(html.eink) .c-bottom-bar :global(a + a),
  :global(html.eink) .c-bottom-bar :global(a + div) {
    border-left: 2px solid #000;
  }
</style>
