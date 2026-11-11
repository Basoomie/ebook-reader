<script lang="ts">
  import { faBars, faBug, faCog } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { pagePath } from '$lib/data/env';
  import { openBugReport } from './app-nav';

  /** Where the panel opens: below the button (header) or above it (bottom bar). */
  export let placement: 'below' | 'above' = 'below';
  /** Classes of the Menu button (the header and the bottom bar style it differently). */
  export let buttonClass = '';
  /** WP19b: a one-character mark instead of the icon (the phone bar). */
  export let glyph = '';

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

  const item =
    'c-btn c-btn-ghost w-full justify-start gap-3 rounded-none border-0 px-4 text-left font-medium';
</script>

<svelte:window on:pointerdown={onWindowPointerDown} on:keydown={onWindowKeydown} />

<!-- 48 px items; E-ink plain (no transitions, black frame). -->
<div class="relative h-full" bind:this={root}>
  <button
    type="button"
    class={buttonClass}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid="app-menu-button"
    on:click={() => (open = !open)}
  >
    {#if glyph}
      <span class="c-bar-mark" aria-hidden="true" />
      <span class="font-mincho text-base font-bold leading-none" aria-hidden="true">{glyph}</span>
      <span>Menu</span>
    {:else}
      <Fa icon={faBars} />
      <span class="hidden md:inline">Menu</span>
    {/if}
  </button>
  {#if open}
    <div
      class="c-panel absolute right-0 z-30 w-52 rounded py-1 {placement === 'above'
        ? 'bottom-full mb-1'
        : 'top-full mt-1'}"
      role="menu"
      data-testid="app-menu"
    >
      <a class={item} role="menuitem" href="{pagePath}/settings" on:click={() => (open = false)}>
        <Fa icon={faCog} />
        Settings
      </a>
      <button type="button" class={item} role="menuitem" on:click={bugReport}>
        <Fa icon={faBug} />
        Bug report
      </button>
    </div>
  {/if}
</div>
