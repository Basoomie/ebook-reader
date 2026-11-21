<script lang="ts">
  import { isCatalogueDark } from '$lib/data/catalogue-look';
  import { customThemes$, einkMode$, theme$ } from '$lib/data/store';
  import { libraryLook$ } from '$lib/library/settings';

  /**
   * The header's light/dark switch for the catalogue pages (wider screens; phones keep
   * Settings > Library Look). It sets this device's Library Look to the other one of what
   * is shown, so "Like the book" becomes Light or Dark (Settings can set it back).
   * 夜 (night) while light, 紙 (paper) while dark; "D" does the same when not typing.
   * Hidden with E-ink on: E-ink is black on white whatever the look.
   */
  $: dark = isCatalogueDark($libraryLook$, $theme$, $customThemes$);
  $: label = dark ? 'Switch to light' : 'Switch to dark';

  function toggle() {
    libraryLook$.next(dark ? 'light' : 'dark');
  }

  function onWindowKeydown(ev: KeyboardEvent) {
    if ($einkMode$ || ev.defaultPrevented || ev.repeat) return;
    if (ev.key !== 'd' && ev.key !== 'D') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
      return;
    if (!window.matchMedia?.('(min-width: 640px)').matches) return;
    ev.preventDefault();
    toggle();
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

{#if !$einkMode$}
  <div class="hidden h-full shrink-0 items-center pr-1 sm:flex">
    <button
      type="button"
      class="c-focus t-toggle flex h-8 w-8 items-center justify-center rounded-full font-mincho text-sm font-bold leading-none"
      title="{label} (D)"
      aria-label={label}
      data-testid="theme-toggle"
      on:click={toggle}
    >
      <span aria-hidden="true">{dark ? '紙' : '夜'}</span>
    </button>
  </div>
{/if}

<style>
  .t-toggle {
    border: 1px solid var(--c-header-muted);
    color: var(--c-header-ink);
    transition:
      background-color 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .t-toggle:hover {
    background-color: var(--c-header-ink);
    border-color: var(--c-header-ink);
    color: var(--c-header-bg);
  }
</style>
