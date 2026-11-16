<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 §9: the on-track dot at the right end of the reader's bottom bar, and the goal
   * card a tap opens. Display only: the reader page computes the state (`lib/stats/on-track`).
   * The card is not a dialog (no backdrop, reader keys keep working), so neither the tracker
   * nor the pacer pauses; it closes on a tap outside, Esc or the dot.
   * Looks: on track = filled, met = filled with a tick, behind = an empty ring, no goal = a
   * faint dashed ring. E-ink: the same shapes in black.
   */
  import { createEventDispatcher } from 'svelte';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import { DOT_STATE_LABELS, dotColors, type OnTrackDotState } from '$lib/stats/on-track';

  export let state: OnTrackDotState = 'none';
  /** One entry per active goal. */
  export let lines: { title: string; text: string }[] = [];
  export let note = '';
  export let eink = false;
  /** The bar's text colour (the dashed ring). */
  export let barColor = 'currentColor';
  export let fontColor = '#000';
  export let backgroundColor = '#fff';
  export let open = false;

  const dispatch = createEventDispatcher<{ stats: void }>();

  $: colors = dotColors(backgroundColor);
  $: fill = eink ? '#000' : colors.fill;
  $: ring = eink ? '#000' : colors.ring;
  $: label = DOT_STATE_LABELS[state];

  function onKeydown(ev: KeyboardEvent) {
    if (open && ev.key === 'Escape') {
      ev.preventDefault();
      open = false;
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Clicks inside never reach the bar (whose click shows or hides the progress). -->
<div
  class="contents"
  role="none"
  use:clickOutside={() => (open = false)}
  on:click|stopPropagation
  on:keyup|stopPropagation
>
  <div
    tabindex="0"
    role="button"
    title={label}
    aria-label={label}
    aria-expanded={open}
    class="fixed bottom-0 right-0 z-10 flex h-8 w-10 items-center justify-center"
    data-testid="footer-on-track"
    data-state={state}
    on:click={() => (open = !open)}
    on:keyup={(ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') open = !open;
    }}
  >
    {#if state === 'none'}
      <span
        class="ttu-on-track-dot"
        style:border="1px dashed {barColor}"
        style:opacity={eink ? '1' : '0.6'}
        data-testid="on-track-shape"
      />
    {:else if state === 'behind'}
      <span class="ttu-on-track-dot" style:border="2px solid {ring}" data-testid="on-track-shape" />
    {:else}
      <span
        class="ttu-on-track-dot flex items-center justify-center"
        style:background-color={fill}
        style:border="2px solid {fill}"
        data-testid="on-track-shape"
      >
        {#if state === 'met'}
          <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path
              d="M1.5 5.2 L4 7.6 L8.6 2.4"
              fill="none"
              stroke="#fff"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {/if}
      </span>
    {/if}
  </div>

  {#if open}
    <div
      role="dialog"
      aria-label="Reading goals"
      class="fixed bottom-10 right-2 z-30 w-max max-w-[min(20rem,calc(100vw-1rem))] p-3 text-sm leading-snug"
      style:color={fontColor}
      style:background-color={backgroundColor}
      style:border="1px solid {fontColor}"
      data-testid="on-track-card"
    >
      {#if lines.length}
        <ul class="flex flex-col gap-2">
          {#each lines as line}
            <li data-testid="on-track-line">
              <div class="font-bold">{line.title}</div>
              <div>{line.text}</div>
            </li>
          {/each}
        </ul>
      {:else}
        <p data-testid="on-track-line">No reading goal yet. Add one on the Stats page.</p>
      {/if}
      {#if note}
        <p class="mt-2" data-testid="on-track-note">{note}</p>
      {/if}
      <button
        type="button"
        class="mt-2 min-h-[2.75rem] underline"
        data-testid="on-track-stats"
        on:click={() => {
          open = false;
          dispatch('stats');
        }}
      >
        Stats page
      </button>
    </div>
  {/if}
</div>

<style>
  .ttu-on-track-dot {
    display: block;
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
  }
</style>
