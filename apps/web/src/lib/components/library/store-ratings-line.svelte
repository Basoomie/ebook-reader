<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Store ratings on the book page (2026-11-25, docs/design/store-ratings.md), under your own
   * rating: what other readers thought, as numbers and never stars ("4.3 · 251 ratings ·
   * Amazon 4.3 · 201 ratings · BOOK☆WALKER 4.4 · 50 ratings"). Each store's figure links to the
   * book's page there; the hover says when it was read. The saved figures show at once (offline:
   * the pooled one the book carries); old ones are asked for again and the line updates once.
   */
  import { onDestroy } from 'svelte';
  import { bookLink, linkDef, type LinkId } from '$lib/book-links/links';
  import type { BookRatingsAnswer, LibraryApi } from '$lib/library/api';
  import {
    asOfText,
    bookRatingParts$,
    loadRatingFeatures,
    ratingFeatures$,
    ratingPieces,
    type RatingPart
  } from '$lib/library/store-ratings';
  import type { CatalogBookDetail } from '$lib/library/types';

  export let book: CatalogBookDetail;
  export let api: LibraryApi | null;
  export let offline = false;

  const LINK_OF: Record<Exclude<RatingPart, 'pooled'>, LinkId> = {
    amazon_jp: 'amazon',
    bookwalker: 'bookwalker',
    bookmeter: 'bookmeter',
    natively: 'natively'
  };

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
  $: pieces = ratingPieces(answer ?? fallback ?? EMPTY, $bookRatingParts$, $ratingFeatures$);
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

  function href(part: RatingPart): string | null {
    if (part === 'pooled') return null;
    return bookLink(linkDef(LINK_OF[part]), book, false)?.href ?? null;
  }

  onDestroy(() => {
    controller?.abort();
    clearTimeout(again);
  });
</script>

{#if pieces.length}
  <p
    class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-c-muted"
    data-testid="details-store-ratings"
  >
    <span class="sr-only">Other readers' ratings:</span>
    {#each pieces as piece (piece.part)}
      <span title={asOfText(piece.checkedAt)} data-testid="store-rating-{piece.part}">
        {#if piece.label}
          {#if href(piece.part)}<a
              class="c-link"
              href={href(piece.part)}
              target="_blank"
              rel="noopener noreferrer">{piece.label}</a
            >{:else}{piece.label}{/if}
        {/if}
        <span class={piece.part === 'pooled' ? 'font-semibold text-c-ink' : ''}>{piece.text}</span>
      </span>
    {/each}
  </p>
{/if}
