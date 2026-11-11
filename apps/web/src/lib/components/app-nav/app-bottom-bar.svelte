<script lang="ts">
  import Fa from 'svelte-fa';
  import { page } from '$app/stores';
  import { pagePath } from '$lib/data/env';
  import AppMenu from './app-menu.svelte';
  import { APP_NAV, isCurrentRoute } from './app-nav';

  /** Hidden while another bottom bar takes its place (the Library's select bar). */
  export let hidden = false;

  $: items = APP_NAV.map((entry) => ({ ...entry, current: isCurrentRoute($page.route.id, entry) }));
  const cell =
    'flex h-full w-full min-h-[3.5rem] flex-col items-center justify-center gap-1 text-xs font-medium';
</script>

{#if !hidden}
  <!-- Phones only: room for the bar at the end of the page, then the bar. E-ink plain. -->
  <div class="h-16 sm:hidden" aria-hidden="true" />
  <nav
    class="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t-2 border-gray-800 bg-white text-gray-900 sm:hidden"
    aria-label="App"
    data-testid="app-bottom-bar"
  >
    {#each items as entry (entry.routeId)}
      <a
        class="{cell} border-r-2 border-gray-800 {entry.current ? 'bg-gray-800 text-white' : ''}"
        href="{pagePath}{entry.routeId}"
        aria-current={entry.current ? 'page' : undefined}
        data-testid="bottom-nav-{entry.label.toLowerCase()}"
      >
        <Fa icon={entry.icon} />
        {entry.label}
      </a>
    {/each}
    <AppMenu buttonClass={cell} placement="above" />
  </nav>
{/if}
