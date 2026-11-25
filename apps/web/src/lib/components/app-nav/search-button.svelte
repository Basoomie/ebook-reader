<script lang="ts">
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { openSearchPalette } from '$lib/search-palette/open';

  /**
   * The header's search button: an icon like 紙/夜 (wider screens, between Stats and the
   * light/dark switch) and the same icon on phones. Not a box with text: it read as a link.
   */
  export let phone = false;
</script>

<div class="h-full shrink-0 items-center px-1 {phone ? 'flex sm:hidden' : 'hidden sm:flex'}">
  <button
    type="button"
    class="c-focus s-btn flex h-8 w-8 items-center justify-center rounded"
    title="Search the library (/)"
    aria-label="Search the library"
    aria-keyshortcuts="/"
    data-testid="header-search"
    on:click={() => openSearchPalette()}
  >
    <Fa icon={faMagnifyingGlass} />
  </button>
</div>

<style>
  .s-btn {
    color: var(--c-header-ink);
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .s-btn:hover {
    background-color: var(--c-header-ink);
    color: var(--c-header-bg);
  }
</style>
