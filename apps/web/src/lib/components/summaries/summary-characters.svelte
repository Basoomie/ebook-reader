<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, the Characters tab (session 4; approved mockups): this device's layout.
   * - list: one entry under another;
   * - cards: cards flowing in columns, so a long entry leaves no empty space beside it;
   * - carousel: one card at a time with ‹ › on its two ends, a sideways swipe, and a row of
   *   name buttons to jump to one ("Also mentioned" is the last card).
   * Headings show the book's furigana; in a translation the server's "Name (original)".
   */
  import { einkMode$ } from '$lib/data/store';
  import { dragAxis, swipeStep, wrapIndex } from '$lib/summaries/carousel';
  import type { SummaryCharacterLayout } from '$lib/summaries/settings';
  import type { SummaryItem } from '$lib/summaries/summary-types';
  import RubyHeading from './ruby-heading.svelte';
  import SummaryExtras from './summary-extras.svelte';

  export let items: SummaryItem[];
  export let alsoMentioned: string[] = [];
  export let layout: SummaryCharacterLayout = 'cards';
  /** The view's language (a translation's when it is one). */
  export let lang = 'ja';
  export let ruby = false;
  export let quoteLang = 'ja';
  export let hrefOf: (it: SummaryItem) => string | null = () => null;
  export let linkTextOf: (it: SummaryItem) => string = () => 'Open the book here';

  $: also = alsoMentioned.join(lang.startsWith('ja') ? '、' : ', ');
  $: alsoLabel = 'Also mentioned';
  /** The carousel's cards: the characters, then "Also mentioned" when there is one. */
  $: cards = items.length + (also ? 1 : 0);
  let at = 0;
  $: at = wrapIndex(at, cards);
  $: current = at < items.length ? items[at] : null;

  let chips: HTMLElement | undefined;
  function go(i: number) {
    at = wrapIndex(i, cards);
    // Keep the chosen name in view in its row (no animation on E-ink).
    const el = chips?.querySelectorAll<HTMLElement>('[data-chip]')[at];
    el?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: $einkMode$ ? 'auto' : 'smooth'
    });
  }

  let startX = 0;
  let startY = 0;
  let axis: 'x' | 'y' | null = null;
  let dragging = false;
  function down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a')) return;
    dragging = true;
    axis = null;
    startX = e.clientX;
    startY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (!dragging || axis) return;
    axis = dragAxis(e.clientX - startX, e.clientY - startY);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const a = axis ?? dragAxis(e.clientX - startX, e.clientY - startY);
    const step = swipeStep(e.clientX - startX, a);
    if (step) go(at + step);
  }
</script>

{#if layout === 'carousel' && cards}
  <div
    class="c-strip chips"
    role="group"
    aria-label="Characters"
    bind:this={chips}
    data-testid="summary-char-chips"
  >
    {#each items as it, i (it.ref)}
      <button
        type="button"
        class="c-chip c-chip-sm shrink-0"
        aria-pressed={i === at}
        data-chip
        on:click={() => go(i)}>{it.heading ?? ''}</button
      >
    {/each}
    {#if also}
      <button
        type="button"
        class="c-chip c-chip-sm shrink-0"
        aria-pressed={at === items.length}
        data-chip
        on:click={() => go(items.length)}>{alsoLabel}</button
      >
    {/if}
  </div>
  <div
    class="carousel"
    on:pointerdown={down}
    on:pointermove={move}
    on:pointerup={up}
    on:pointercancel={() => (dragging = false)}
    data-testid="summary-carousel"
  >
    <article class="slide" aria-live="polite" data-testid="summary-character">
      {#if current}
        <h3 class="text-lg font-bold">
          <RubyHeading text={current.heading ?? ''} pieces={ruby ? current.ruby : null} />
        </h3>
        <p class="mt-2 leading-relaxed">{current.text}<SummaryExtras item={current} /></p>
        <SummaryExtras
          part="quote"
          item={current}
          {quoteLang}
          href={hrefOf(current)}
          linkText={linkTextOf(current)}
        />
      {:else}
        <h3 class="text-lg font-bold">{alsoLabel}</h3>
        <p class="mt-2 leading-relaxed">{also}</p>
      {/if}
    </article>
    {#if cards > 1}
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-icon arrow left"
        aria-label="Previous character"
        data-testid="summary-car-prev"
        on:click={() => go(at - 1)}>‹</button
      >
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-icon arrow right"
        aria-label="Next character"
        data-testid="summary-car-next"
        on:click={() => go(at + 1)}>›</button
      >
    {/if}
  </div>
  <p class="mt-1 text-center text-xs text-c-muted" data-testid="summary-car-pos">
    {at + 1} / {cards}
  </p>
{:else}
  <div class:cards={layout === 'cards'} class:list={layout !== 'cards'}>
    {#each items as it (it.ref)}
      <article class="entry" data-ref={it.ref} data-testid="summary-character">
        <h3 class="font-bold">
          <RubyHeading text={it.heading ?? ''} pieces={ruby ? it.ruby : null} />
        </h3>
        <p class="mt-1 leading-relaxed">{it.text}<SummaryExtras item={it} /></p>
        <SummaryExtras
          part="quote"
          item={it}
          {quoteLang}
          href={hrefOf(it)}
          linkText={linkTextOf(it)}
        />
      </article>
    {/each}
  </div>
  {#if also}
    <p class="mt-3 text-sm text-c-muted" data-testid="summary-also">{alsoLabel}: {also}</p>
  {/if}
{/if}

<style>
  .cards {
    columns: 17rem;
    column-gap: 0.75rem;
  }
  .cards .entry {
    break-inside: avoid;
    display: inline-block;
    width: 100%;
    margin-bottom: 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
  }
  .list .entry {
    padding: 0.75rem 0;
    border-top: var(--c-border-width) dashed var(--c-line);
  }
  .list .entry:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .chips {
    display: flex;
    gap: 0.5rem;
    padding-bottom: 0.25rem;
  }
  .carousel {
    position: relative;
    margin-top: 0.625rem;
    touch-action: pan-y;
  }
  .slide {
    min-height: 9rem;
    padding: 1rem calc(var(--c-btn-h) + 0.75rem);
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
  }
  .arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 1.5rem;
    line-height: 1;
  }
  .arrow.left {
    left: 0.25rem;
  }
  .arrow.right {
    right: 0.25rem;
  }
</style>
