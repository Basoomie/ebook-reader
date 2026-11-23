<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A rating in half stars (Calibre keeps 0-10). Shown under the book page's byline, and the
   * edit form's input: tap a star for that many stars, the same star again for a half star;
   * Clear takes it off (design 2026-11-23). Drawn as outlines filled with the text colour, so
   * it reads on E-ink, dark and light alike.
   */
  import { createEventDispatcher } from 'svelte';
  import { ratingText, starGlyphs, tapStar } from '$lib/calibre-edit/format';

  export let rating: number | null;
  export let input = false;
  export let testid = 'rating';

  const dispatch = createEventDispatcher<{ change: number | null }>();
  const uid = Math.random().toString(36).slice(2, 8);

  $: glyphs = starGlyphs(rating);
  $: text = ratingText(rating);
</script>

<svg width="0" height="0" class="absolute" aria-hidden="true">
  <defs>
    <clipPath id="c-half-{uid}"><rect x="0" y="0" width="12" height="24" /></clipPath>
  </defs>
</svg>

{#if input}
  <div
    class="flex flex-wrap items-center gap-1"
    role="group"
    aria-label="Rating"
    data-testid={testid}
  >
    {#each glyphs as g, i (i)}
      <button
        type="button"
        class="c-star-btn"
        aria-label="{i + 1} star{i ? 's' : ''}{g === 'full' ? ' (tap again for a half star)' : ''}"
        aria-pressed={g !== 'empty'}
        data-testid="{testid}-star-{i + 1}"
        on:click={() => dispatch('change', tapStar(rating, i + 1))}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path
            class="c-star-outline"
            d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"
          />
          {#if g !== 'empty'}
            <path
              class="c-star-fill"
              clip-path={g === 'half' ? `url(#c-half-${uid})` : undefined}
              d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"
            />
          {/if}
        </svg>
      </button>
    {/each}
    <span
      class="ml-1 min-w-[5rem] text-sm text-c-muted"
      aria-live="polite"
      data-testid="{testid}-text">{text}</span
    >
    <button
      type="button"
      class="c-btn c-btn-ghost c-btn-sm"
      disabled={!rating}
      data-testid="{testid}-clear"
      on:click={() => dispatch('change', null)}>Clear</button
    >
  </div>
{:else}
  <span class="inline-flex items-center gap-1.5" data-testid={testid}>
    {#if rating}
      <span class="inline-flex" aria-hidden="true">
        {#each glyphs as g, i (i)}
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              class="c-star-outline"
              d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"
            />
            {#if g !== 'empty'}
              <path
                class="c-star-fill"
                clip-path={g === 'half' ? `url(#c-half-${uid})` : undefined}
                d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"
              />
            {/if}
          </svg>
        {/each}
      </span>
      <span class="sr-only">Rating: {text}</span>
      <span class="text-sm text-c-muted" aria-hidden="true">{rating / 2}</span>
    {:else}
      <span class="text-sm text-c-muted">No rating</span>
    {/if}
  </span>
{/if}

<style>
  .c-star-btn {
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 0.625rem;
    color: var(--c-ink);
  }

  .c-star-btn:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .c-star-btn:hover {
      background-color: var(--c-tint);
    }
  }

  .c-star-outline {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: round;
  }

  .c-star-fill {
    fill: currentColor;
  }
</style>
