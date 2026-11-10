<script lang="ts">
  /**
   * WP11a: the highlight bar. Docked at the bottom above the reader's bottom bar, never over
   * the selected text (Yomitan's popup and the browser's own Copy/Share toolbar float near
   * the selection). Plain for e-ink: no transitions, 48 px bordered buttons. Kept narrower
   * than the screen so the page-turn edge strips stay free.
   *
   * Pressing a button must not clear the selection on desktop (mousedown is prevented);
   * on touch the reader keeps the selection's anchor when a tap on the bar clears it.
   */
  import { createEventDispatcher } from 'svelte';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    type HighlightColor
  } from '$lib/notes/highlights';
  import type { BarState } from './reader-highlights';
  import { HIGHLIGHT_SWATCHES, EINK_UNDERLINES } from './highlight-colors';

  export let state: BarState;
  export let lastColor: HighlightColor;
  export let eink = false;

  const dispatch = createEventDispatcher<{
    color: HighlightColor;
    note: void;
    remove: void;
    undo: void;
    close: void;
  }>();

  const button =
    'flex min-h-[3rem] min-w-[3rem] items-center justify-center rounded border-2 border-current px-3 font-medium';

  function swatchStyle(color: HighlightColor) {
    return eink
      ? `text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 4px;`
      : `background-color: ${HIGHLIGHT_SWATCHES[color]};`;
  }
</script>

{#if state.mode !== 'hidden'}
  <div
    class="writing-horizontal-tb fixed inset-x-6 bottom-10 z-30 mx-auto flex max-w-lg flex-wrap items-center gap-2 rounded border-2 border-gray-700 bg-white p-2 text-black select-none"
    role="toolbar"
    tabindex="-1"
    aria-label="Highlight"
    data-highlight-bar
    data-testid="highlight-bar"
    on:mousedown|preventDefault
  >
    {#if state.mode === 'new' || state.mode === 'existing'}
      {#if state.mode === 'existing'}
        <span class="px-1 text-sm" data-testid="highlight-bar-existing">Highlighted</span>
      {/if}
      {#each HIGHLIGHT_COLORS as color}
        <button
          class={button}
          title={HIGHLIGHT_COLOR_NAMES[color]}
          aria-label={HIGHLIGHT_COLOR_NAMES[color]}
          aria-pressed={state.mode === 'existing' ? state.colors.includes(color) : undefined}
          data-testid="highlight-color-{color}"
          on:click={() => dispatch('color', color)}
        >
          <span
            class="block h-6 w-6 rounded-sm"
            class:outline={state.mode === 'new' && color === lastColor}
            class:outline-2={state.mode === 'new' && color === lastColor}
            style={swatchStyle(color)}
          >
            {#if eink}あ{/if}
          </span>
        </button>
      {/each}
      <button class={button} data-testid="highlight-note" on:click={() => dispatch('note')}>
        Note
      </button>
      {#if state.mode === 'existing'}
        <button class={button} data-testid="highlight-remove" on:click={() => dispatch('remove')}>
          Remove
        </button>
      {/if}
    {:else if state.mode === 'removed'}
      <span class="px-1" role="status">{state.message}</span>
      <button class={button} data-testid="highlight-undo" on:click={() => dispatch('undo')}>
        Undo
      </button>
    {:else}
      <span class="px-1" role="status" data-testid="highlight-bar-message">{state.message}</span>
    {/if}
    <button
      class="{button} ml-auto"
      aria-label="Close"
      title="Close"
      data-testid="highlight-close"
      on:click={() => dispatch('close')}
    >
      ✕
    </button>
  </div>
{/if}
