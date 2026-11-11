<script lang="ts">
  /**
   * WP11a: the highlight bar. Docked at the bottom above the reader's bottom bar, never over
   * the selected text (Yomitan's popup and the browser's own Copy/Share toolbar float near
   * the selection). Plain for e-ink: no transitions, bordered. Kept narrower than the
   * screen so the page-turn edge strips stay free.
   *
   * WP19d: one slim row: five round colour dots (the last-used one ringed for a new
   * highlight, the colours under the selection ringed for an existing one), then Note,
   * Quote image, Remove (existing only) and Close as icons. Still docked and still
   * horizontal in vertical books; every button 44 px; behaviour unchanged.
   *
   * Pressing a button must not clear the selection on desktop (mousedown is prevented);
   * on touch the reader keeps the selection's anchor when a tap on the bar clears it.
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faImage, faNoteSticky, faTrashCan, faXmark } from '@fortawesome/free-solid-svg-icons';
  import ColorDot from '$lib/components/notes/color-dot.svelte';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    type HighlightColor
  } from '$lib/notes/highlights';
  import type { BarState } from './reader-highlights';

  export let state: BarState;
  export let lastColor: HighlightColor;
  export let eink = false;

  const dispatch = createEventDispatcher<{
    color: HighlightColor;
    note: void;
    quote: void;
    remove: void;
    undo: void;
    close: void;
  }>();

  const icon = 'c-hl-bar-btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full';

  $: picked = (color: HighlightColor) =>
    state.mode === 'existing' ? state.colors.includes(color) : color === lastColor;
</script>

{#if state.mode !== 'hidden'}
  <div
    class="c-hl-bar writing-horizontal-tb fixed inset-x-6 bottom-10 z-30 mx-auto flex w-fit max-w-[calc(100%-3rem)] flex-wrap items-center justify-center gap-0.5 rounded-3xl bg-white px-1.5 py-1 text-black select-none"
    class:c-hl-bar-eink={eink}
    role="toolbar"
    tabindex="-1"
    aria-label="Highlight"
    data-highlight-bar
    data-testid="highlight-bar"
    on:mousedown|preventDefault
  >
    {#if state.mode === 'new' || state.mode === 'existing'}
      {#if state.mode === 'existing'}
        <span class="sr-only" data-testid="highlight-bar-existing">Highlighted</span>
      {/if}
      <span class="flex">
        {#each HIGHLIGHT_COLORS as color}
          <button
            class={icon}
            title={HIGHLIGHT_COLOR_NAMES[color]}
            aria-label={HIGHLIGHT_COLOR_NAMES[color]}
            aria-pressed={state.mode === 'existing' ? state.colors.includes(color) : undefined}
            data-testid="highlight-color-{color}"
            on:click={() => dispatch('color', color)}
          >
            <ColorDot {color} {eink} size={28} picked={picked(color)} />
          </button>
        {/each}
      </span>
      <!-- Colours and actions wrap as two rows on a narrow phone (no divider there). -->
      <span class="flex items-center">
        <span class="c-hl-bar-rule mx-1 hidden h-6 w-px shrink-0 sm:block" aria-hidden="true" />
        <button
          class={icon}
          title="Note"
          aria-label="Note"
          data-testid="highlight-note"
          on:click={() => dispatch('note')}
        >
          <Fa icon={faNoteSticky} />
        </button>
        <button
          class={icon}
          title="Quote image"
          aria-label="Quote image"
          data-testid="highlight-quote"
          on:click={() => dispatch('quote')}
        >
          <Fa icon={faImage} />
        </button>
        {#if state.mode === 'existing'}
          <button
            class={icon}
            title="Remove highlight"
            aria-label="Remove highlight"
            data-testid="highlight-remove"
            on:click={() => dispatch('remove')}
          >
            <Fa icon={faTrashCan} />
          </button>
        {/if}
        <button
          class={icon}
          aria-label="Close"
          title="Close"
          data-testid="highlight-close"
          on:click={() => dispatch('close')}
        >
          <Fa icon={faXmark} />
        </button>
      </span>
    {:else if state.mode === 'removed'}
      <span class="px-3" role="status">{state.message}</span>
      <button
        class="c-hl-bar-btn flex h-11 shrink-0 items-center justify-center rounded-full px-4 font-medium underline"
        data-testid="highlight-undo"
        on:click={() => dispatch('undo')}
      >
        Undo
      </button>
    {:else}
      <span class="px-3" role="status" data-testid="highlight-bar-message">{state.message}</span>
    {/if}
    {#if state.mode !== 'new' && state.mode !== 'existing'}
      <button
        class={icon}
        aria-label="Close"
        title="Close"
        data-testid="highlight-close"
        on:click={() => dispatch('close')}
      >
        <Fa icon={faXmark} />
      </button>
    {/if}
  </div>
{/if}

<style>
  .c-hl-bar {
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow:
      0 6px 24px rgba(0, 0, 0, 0.16),
      0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .c-hl-bar-rule {
    background-color: rgba(0, 0, 0, 0.15);
  }

  .c-hl-bar-btn:focus-visible {
    outline: 2px solid #2b4c9b;
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .c-hl-bar:not(.c-hl-bar-eink) .c-hl-bar-btn:hover {
      background-color: rgba(0, 0, 0, 0.06);
    }
  }

  .c-hl-bar:not(.c-hl-bar-eink) .c-hl-bar-btn:active {
    background-color: rgba(0, 0, 0, 0.12);
  }

  /* E-ink: a plain black frame, no shadow; pressing fills black. */
  .c-hl-bar-eink {
    border: 2px solid #000;
    box-shadow: none;
  }

  .c-hl-bar-eink .c-hl-bar-rule {
    background-color: #000;
  }

  .c-hl-bar-eink .c-hl-bar-btn:active {
    background-color: #000;
    color: #fff;
  }
</style>
