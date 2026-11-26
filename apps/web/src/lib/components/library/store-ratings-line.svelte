<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Ratings on the book page (redesign 2026-11-25, option A: "one summary line, breakdown on
   * tap"), under the byline: other readers' stars and one figure ("★★★★☆ 4.3 4,731 ratings ·
   * 87,105 readers ⌄"), and your own rating beside it ("You ★ 3"), so the two never read as one.
   * Tapping the line opens each store's figure and when it was read; the store links stay in the
   * Links section. The saved figures show at once (offline: the pooled one the book carries); old
   * ones are asked for again and the line updates once. Without store figures your rating keeps
   * its own row of stars.
   */
  import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
  import { onDestroy } from 'svelte';
  import Fa from 'svelte-fa';
  import RatingStars from '$lib/components/calibre-edit/rating-stars.svelte';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import StarMeter from '$lib/components/library/star-meter.svelte';
  import type { BookRatingsAnswer, LibraryApi } from '$lib/library/api';
  import {
    asOfText,
    bookRatingParts$,
    formatCount,
    formatStars,
    loadRatingFeatures,
    ratingFeatures$,
    ratingPieces,
    ratingSummary,
    ratingsCountText
  } from '$lib/library/store-ratings';
  import type { CatalogBookDetail } from '$lib/library/types';

  export let book: CatalogBookDetail;
  export let api: LibraryApi | null;
  export let offline = false;
  /** Your own rating (Calibre's, 0-10 half stars) and whether the page shows it. */
  export let yourRating: number | null = null;
  export let showYours = false;

  const EMPTY: BookRatingsAnswer = { pooled: null, readers: null, sites: {}, refreshing: false };

  let answer: BookRatingsAnswer | null = null;
  let loadedFor = '';
  let controller: AbortController | null = null;
  let again: ReturnType<typeof setTimeout> | undefined;

  // Offline or before the answer: the pooled figure the book carries.
  $: fallback = book.storeRating
    ? ({
        pooled: { avg: book.storeRating.avg, count: book.storeRating.count },
        readers: null,
        sites: {},
        refreshing: false
      } as BookRatingsAnswer)
    : null;
  $: pieces =
    book.source === 'upload'
      ? []
      : ratingPieces(answer ?? fallback ?? EMPTY, $bookRatingParts$, $ratingFeatures$);
  $: summary = ratingSummary(pieces);
  $: headline = summary.headline;
  $: readers = summary.readers;
  $: pooledNote = headline?.part === 'pooled' && summary.rows.some((r) => r.avg !== null);
  $: spoken = [
    headline
      ? `Readers' rating ${formatStars(headline.avg ?? 0)} of 5 from ${ratingsCountText(headline.count)}${headline.label ? ` on ${headline.label}` : ''}`
      : '',
    readers ? `${formatCount(readers.count)} readers on 読書メーター` : ''
  ]
    .filter(Boolean)
    .join(', ');
  $: checkedText = asOfText(summary.checkedAt).replace(/^as of /, '');
  $: if (book.source !== 'upload' && api && !offline && loadedFor !== book.id) void load(book.id);

  async function load(id: string) {
    loadedFor = id;
    answer = null;
    controller?.abort();
    clearTimeout(again);
    const c = new AbortController();
    controller = c;
    const target = api;
    if (!target) return;
    void loadRatingFeatures(() => target.ratingFeatures({ timeoutSeconds: 20 }));
    try {
      const first = await target.bookRatings(id, true, { signal: c.signal, timeoutSeconds: 20 });
      if (c.signal.aborted || loadedFor !== id) return;
      answer = first;
      // Old figures were asked for again: read once more when they have had time to arrive.
      if (first.refreshing) {
        again = setTimeout(async () => {
          try {
            const next = await target.bookRatings(id, false, {
              signal: c.signal,
              timeoutSeconds: 20
            });
            if (!c.signal.aborted && loadedFor === id) answer = next;
          } catch {
            // The saved figures stay.
          }
        }, 45_000);
      }
    } catch {
      // An older server or none: the pooled figure the book carries stays.
    }
  }

  /**
   * "You ★ 3" beside the line; once it wraps to a line of its own (phones), it drops the divider
   * and says "Your rating ★ 3".
   */
  let yoursWrapped = false;
  function watchWrap(node: HTMLElement) {
    const measure = () => {
      const yours = node.querySelector<HTMLElement>('[data-yours]');
      const first = node.firstElementChild as HTMLElement | null;
      yoursWrapped =
        !!yours &&
        !!first &&
        yours !== first &&
        yours.getBoundingClientRect().top >= first.getBoundingClientRect().bottom - 1;
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(node);
    measure();
    return { destroy: () => ro?.disconnect() };
  }

  onDestroy(() => {
    controller?.abort();
    clearTimeout(again);
  });
</script>

{#if headline || readers}
  <div
    class="-my-2 flex flex-wrap items-center gap-x-3"
    data-testid="details-store-ratings"
    use:watchWrap
  >
    {#if summary.rows.length}
      <DropdownMenu
        buttonClass="c-rsum"
        label="Ratings from each store"
        panelWidth="w-80"
        testid="details-store-ratings-button"
      >
        <svelte:fragment slot="button">
          <span class="sr-only">{spoken}. Show each store.</span>
          <span class="c-rsum-line" aria-hidden="true">
            {#if headline}
              <StarMeter avg={headline.avg ?? 0} />
              <span class="c-rsum-num" data-testid="store-rating-{headline.part}"
                >{formatStars(headline.avg ?? 0)}</span
              >
              <span
                >{ratingsCountText(headline.count)}{headline.label
                  ? ` on ${headline.label}`
                  : ''}</span
              >
            {/if}
            {#if headline && readers}<span>·</span>{/if}
            {#if readers}<span data-testid="details-store-readers"
                >{formatCount(readers.count)} readers</span
              >{/if}
            <Fa icon={faChevronDown} size="xs" />
          </span>
        </svelte:fragment>
        <div class="px-2 py-1 text-sm" data-testid="details-store-ratings-breakdown">
          <dl class="c-rsum-rows">
            {#each summary.rows as row (row.part)}
              <dt title={asOfText(row.checkedAt)}>
                {row.part === 'bookmeter' ? '読書メーター' : row.label}
              </dt>
              <dd title={asOfText(row.checkedAt)} data-testid="store-rating-{row.part}">
                {#if row.avg !== null}
                  <StarMeter avg={row.avg} size={12} />
                  <span class="c-rsum-num">{formatStars(row.avg)}</span>
                  <span class="c-rsum-count">{formatCount(row.count)}</span>
                {:else}
                  <span class="c-rsum-num">{formatCount(row.count)}</span>
                  <span>readers</span>
                {/if}
              </dd>
            {/each}
          </dl>
          <p class="mt-3 text-xs text-c-muted">
            {#if pooledNote}The top figure is Amazon and BOOK☆WALKER together, weighted by how many
              rated each.
            {/if}{#if checkedText}Checked {checkedText}.{/if}
          </p>
        </div>
      </DropdownMenu>
    {:else if headline}
      <!-- Offline: the pooled figure alone, nothing to open. -->
      <span class="c-rsum-line min-h-[2.75rem]" title={asOfText(headline.checkedAt)}>
        <span class="sr-only">{spoken}</span>
        <StarMeter avg={headline.avg ?? 0} />
        <span class="c-rsum-num" aria-hidden="true" data-testid="store-rating-pooled"
          >{formatStars(headline.avg ?? 0)}</span
        >
        <span aria-hidden="true">{ratingsCountText(headline.count)}</span>
      </span>
    {/if}
    {#if showYours}
      <span
        class="c-rsum-yours"
        class:c-rsum-yours-own={yoursWrapped}
        data-yours
        data-testid="details-rating"
      >
        <span class="sr-only"
          >{yourRating ? `Your rating: ${yourRating / 2} of 5` : 'Your rating: none'}</span
        >
        <span
          class="inline-flex items-center gap-1"
          aria-hidden="true"
          data-testid="details-rating-stars"
        >
          {yoursWrapped ? 'Your rating' : 'You'}
          {#if yourRating}
            <svg viewBox="0 0 24 24" width="15" height="15" class="c-rsum-star">
              <path
                d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"
              />
            </svg>
            <span class="text-c-ink">{yourRating / 2}</span>
          {:else}
            <span>· not rated</span>
          {/if}
        </span>
      </span>
    {/if}
  </div>
{:else if showYours}
  <!-- No store figures: your rating keeps its own row of stars (design 2026-11-23). -->
  <div class="-mt-1 flex items-center gap-2" data-testid="details-rating">
    <RatingStars rating={yourRating} testid="details-rating-stars" />
    {#if yourRating}<span class="text-sm text-c-muted">Your rating</span>{/if}
  </div>
{/if}

<style>
  :global(.c-rsum) {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    margin-inline: -0.375rem;
    padding-inline: 0.375rem;
    border-radius: 0.625rem;
    text-align: left;
  }

  :global(.c-rsum:focus-visible) {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    :global(.c-rsum:hover) {
      background-color: var(--c-tint);
    }
  }

  .c-rsum-line {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 0.4rem;
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .c-rsum-num {
    font-weight: 600;
    color: var(--c-ink);
  }

  .c-rsum-yours {
    display: inline-flex;
    align-items: center;
    min-height: 1.5rem;
    padding-left: 0.75rem;
    border-left: 1px solid var(--c-line);
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .c-rsum-yours-own {
    padding-left: 0;
    border-left: 0;
  }

  .c-rsum-star {
    fill: var(--c-ink);
  }

  .c-rsum-rows {
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 1.25rem;
    row-gap: 0.5rem;
    align-items: center;
  }

  .c-rsum-rows dt {
    color: var(--c-ink);
  }

  .c-rsum-rows dd {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    margin: 0;
    color: var(--c-muted);
  }

  .c-rsum-count {
    min-width: 3.5rem;
    text-align: right;
  }
</style>
