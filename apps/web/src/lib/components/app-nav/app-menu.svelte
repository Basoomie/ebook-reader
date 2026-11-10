<script lang="ts">
  import { faBars, faBug, faCog } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { pagePath } from '$lib/data/env';
  import { openBugReport } from './app-nav';

  /** Where the panel opens: below the button (header) or above it (bottom bar). */
  export let placement: 'below' | 'above' = 'below';
  /** Classes of the Menu button (the header and the bottom bar style it differently). */
  export let buttonClass = '';

  let open = false;
  let root: HTMLElement;

  function onWindowPointerDown(ev: PointerEvent) {
    if (open && root && !root.contains(ev.target as Node)) open = false;
  }

  function onWindowKeydown(ev: KeyboardEvent) {
    if (open && ev.key === 'Escape') open = false;
  }

  function bugReport() {
    open = false;
    openBugReport();
  }
</script>

<svelte:window on:pointerdown={onWindowPointerDown} on:keydown={onWindowKeydown} />

<!-- E-ink plain: no transitions; 48 px items with borders. -->
<div class="relative h-full" bind:this={root}>
  <button
    type="button"
    class={buttonClass}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="app-menu-button"
    on:click={() => (open = !open)}
  >
    <Fa icon={faBars} />
    <span>Menu</span>
  </button>
  {#if open}
    <div
      class="absolute right-0 z-30 w-48 border-2 border-gray-800 bg-white text-gray-900 {placement ===
      'above'
        ? 'bottom-full mb-1'
        : 'top-full mt-1'}"
      role="menu"
      data-testid="app-menu"
    >
      <a
        class="flex min-h-[3rem] items-center gap-3 px-4 font-medium"
        role="menuitem"
        href="{pagePath}/settings"
        on:click={() => (open = false)}
      >
        <Fa icon={faCog} />
        Settings
      </a>
      <button
        type="button"
        class="flex min-h-[3rem] w-full items-center gap-3 border-t-2 border-gray-800 px-4 text-left font-medium"
        role="menuitem"
        on:click={bugReport}
      >
        <Fa icon={faBug} />
        Bug report
      </button>
    </div>
  {/if}
</div>
