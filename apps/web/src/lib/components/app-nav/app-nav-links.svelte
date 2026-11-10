<script lang="ts">
  import Fa from 'svelte-fa';
  import { page } from '$app/stores';
  import { pagePath } from '$lib/data/env';
  import AppMenu from './app-menu.svelte';
  import { APP_NAV, isCurrentRoute } from './app-nav';

  /** The app navigation inside a page's gray header, for wider screens (phones use the bottom bar). */
  $: items = APP_NAV.map((entry) => ({ ...entry, current: isCurrentRoute($page.route.id, entry) }));
</script>

<nav class="hidden h-full items-stretch sm:flex" aria-label="App">
  {#each items as entry (entry.routeId)}
    <a
      class="flex min-w-[3rem] items-center justify-center gap-2 px-3 text-sm font-medium {entry.current
        ? 'bg-white text-gray-900'
        : ''}"
      href="{pagePath}{entry.routeId}"
      aria-current={entry.current ? 'page' : undefined}
      title={entry.label}
      data-testid="nav-{entry.label.toLowerCase()}"
    >
      <Fa icon={entry.icon} />
      <span class="hidden md:inline">{entry.label}</span>
    </a>
  {/each}
  <AppMenu
    buttonClass="flex h-full min-w-[3rem] items-center justify-center gap-2 px-3 text-sm font-medium"
    placement="below"
  />
</nav>
