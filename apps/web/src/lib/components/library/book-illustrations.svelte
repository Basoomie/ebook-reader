<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 §6: the book page's illustrations, one sideways strip. `variant` is the
   * device's "Illustrations on the book page" setting: 'description' (a full-width section
   * styled like Series) or 'cover' (in the cover's column, styled like Description).
   * Pictures come from this device's copy, else from the server (gallery-source.ts).
   * "Hide spoiler images" blurs them as in the reader; a tap reveals one, "Show all" all of
   * them, until the book page is left. A tap on a shown picture, or on the cover
   * (`openCover`, called by the page), opens the expanded view (image-lightbox.svelte),
   * which starts with the cover.
   */
  import { onDestroy } from 'svelte';
  import { hideSpoilerImage$, hideSpoilerImageMode$ } from '$lib/data/store';
  import type { LibraryApi } from '$lib/library/api';
  import { loadGallery, type GalleryState } from '$lib/library/illustrations/gallery-source';
  import { anyHidden, isHidden } from '$lib/library/illustrations/hidden';
  import { localGallery, type LocalGallery } from '$lib/library/illustrations/local-illustrations';
  import ImageLightbox from './image-lightbox.svelte';

  export let api: LibraryApi | undefined;
  export let bookId: string;
  /** Whether the book is stored on this device; null while that isn't known yet. */
  export let onDevice: boolean | null;
  /** The page already knows the library server can't be reached. */
  export let offline: boolean;
  export let variant: 'description' | 'cover';
  /** The cover as the page shows it (the thumbnail), until a full-size one is at hand. */
  export let coverThumb: string;

  let state: GalleryState = { kind: 'loading' };
  let local: LocalGallery | null = null;
  let controller: AbortController | undefined;
  let loadedKey = '';
  let revealed = new Set<number>();
  let allShown = false;
  /** -1 = closed; 0 = the cover; i + 1 = picture i. */
  let openAt = -1;
  let coverFull: string | null = null;
  let coverFetch: AbortController | undefined;

  let currentBook = '';
  // Another book (a volume of the series opens on this same page): nothing of the previous
  // book stays, hidden pictures are hidden again and the expanded view closes.
  $: if (bookId !== currentBook) resetFor(bookId);
  $: key = onDevice === null ? '' : `${bookId}|${onDevice}|${offline}|${api ? 1 : 0}`;
  $: if (key && key !== loadedKey) void load(key);

  $: pictures = state.kind === 'ready' ? state.pictures : [];
  $: hiddenState = {
    hideSpoilerImage: $hideSpoilerImage$,
    mode: $hideSpoilerImageMode$,
    revealed,
    allShown
  };
  $: hidden = pictures.map((p, i) => isHidden(p, i, hiddenState));
  $: someHidden = anyHidden(pictures, hiddenState);
  $: coverSrc = (state.kind === 'ready' ? state.coverSrc : null) ?? coverFull ?? coverThumb;
  $: lightboxPictures = [
    { src: coverSrc, hidden: false, caption: '表紙 · Cover' },
    ...pictures.map((p, i) => ({
      src: p.fullSrc,
      hidden: hidden[i],
      caption: `${i + 1} / ${pictures.length}`
    }))
  ];

  function resetFor(id: string) {
    currentBook = id;
    controller?.abort();
    local?.release();
    local = null;
    loadedKey = '';
    state = { kind: 'loading' };
    revealed = new Set();
    allShown = false;
    openAt = -1;
    releaseCover();
  }

  async function load(forKey: string) {
    loadedKey = forKey;
    controller?.abort();
    local?.release();
    local = null;
    const c = new AbortController();
    controller = c;
    const a = api;
    const got = await loadGallery(
      bookId,
      {
        local: (id) => (onDevice ? localGallery(id) : Promise.resolve(null)),
        server: a ? (id, signal) => a.illustrations(id, { signal }) : null,
        absolute: (url) => (a ? a.absolute(url) : url),
        offline
      },
      c.signal,
      (next) => {
        if (!c.signal.aborted) state = next;
      }
    );
    if (c.signal.aborted) got?.release();
    else local = got;
  }

  function releaseCover() {
    coverFetch?.abort();
    coverFetch = undefined;
    if (coverFull) URL.revokeObjectURL(coverFull);
    coverFull = null;
  }

  /** The page's cover tap: the expanded view, starting with the cover. */
  export function openCover() {
    openAt = 0;
    // The full-size cover from the server (the page shows a thumbnail), unless this
    // device's copy has its own.
    if (
      !coverFull &&
      !coverFetch &&
      api &&
      !offline &&
      !(state.kind === 'ready' && state.coverSrc)
    ) {
      const c = new AbortController();
      coverFetch = c;
      const forBook = bookId;
      api
        .coverImage(forBook, c.signal)
        .then((blob) => {
          if (!c.signal.aborted && forBook === bookId) coverFull = URL.createObjectURL(blob);
        })
        .catch(() => {
          // The thumbnail stays.
        });
    }
  }

  function tap(i: number) {
    if (hidden[i]) revealed = new Set([...revealed, i]);
    else openAt = i + 1;
  }

  function showAll() {
    allShown = true;
  }

  function revealFromLightbox(at: number) {
    if (at > 0) revealed = new Set([...revealed, at - 1]);
  }

  onDestroy(() => {
    controller?.abort();
    local?.release();
    releaseCover();
  });
</script>

{#if state.kind === 'ready' && pictures.length}
  <section
    class={variant === 'description' ? 'c-ill c-ill-wide mt-12' : 'c-ill c-ill-cover'}
    aria-labelledby="details-illustrations-h"
    data-testid="details-illustrations"
    data-variant={variant}
    data-source={state.local ? 'device' : 'server'}
  >
    {#if variant === 'description'}
      <div class="flex items-center gap-4">
        <h2 id="details-illustrations-h" class="flex items-baseline gap-3">
          <span class="font-mincho text-2xl font-bold">Illustrations</span>
          <span class="c-jp-label text-xs" aria-hidden="true">挿絵</span>
        </h2>
        <span class="c-count" data-testid="illustrations-count">{pictures.length}</span>
        <span class="c-section-rule" />
        {#if someHidden}
          <button
            type="button"
            class="c-link min-h-[3rem] shrink-0 text-sm leading-[3rem]"
            data-testid="illustrations-show-all"
            on:click={showAll}>Show all</button
          >
        {/if}
      </div>
    {:else}
      <div class="flex items-center justify-between gap-2">
        <h2 id="details-illustrations-h" class="flex items-baseline gap-2">
          <span class="font-mincho text-lg font-bold text-c-label">挿絵</span>
          <span class="text-sm text-c-muted"
            >Illustrations · <span data-testid="illustrations-count">{pictures.length}</span></span
          >
        </h2>
        {#if someHidden}
          <button
            type="button"
            class="c-link min-h-[2.75rem] shrink-0 text-sm"
            data-testid="illustrations-show-all"
            on:click={showAll}>Show all</button
          >
        {/if}
      </div>
    {/if}
    <div
      class="c-ill-strip"
      class:mt-4={variant === 'description'}
      data-testid="illustrations-strip"
    >
      {#each pictures as picture, i (picture.fullSrc)}
        <button
          type="button"
          class="c-ill-thumb"
          class:c-ill-hidden={hidden[i]}
          aria-label={hidden[i] ? `Show illustration ${i + 1}` : `Expand illustration ${i + 1}`}
          data-testid="illustration-thumb"
          data-hidden={hidden[i] ? 'true' : 'false'}
          on:click={() => tap(i)}
        >
          <img
            src={picture.thumbSrc}
            alt=""
            width={picture.width ?? 2}
            height={picture.height ?? 3}
            loading="lazy"
            decoding="async"
            draggable="false"
          />
          {#if hidden[i]}
            <span class="c-ill-spoiler" aria-hidden="true">ネタバレ</span>
          {/if}
        </button>
      {/each}
    </div>
  </section>
{:else if state.kind === 'preparing' || state.kind === 'failed' || state.kind === 'offline'}
  <p
    class="text-sm text-c-muted"
    class:mt-12={variant === 'description'}
    data-testid="illustrations-note"
    data-state={state.kind}
  >
    {#if state.kind === 'preparing'}
      Getting the illustrations from the library server…
    {:else if state.kind === 'failed'}
      Couldn't read this book's illustrations: {state.message}
    {:else}
      The illustrations show here when the library server can be reached, or once the book is on
      this device.
    {/if}
  </p>
{/if}

{#if openAt >= 0}
  <ImageLightbox
    pictures={lightboxPictures}
    bind:index={openAt}
    on:close={() => (openAt = -1)}
    on:reveal={(ev) => revealFromLightbox(ev.detail)}
  />
{/if}

<style>
  .c-ill-wide {
    --ill-h: 13.5rem;
  }

  .c-ill-cover {
    --ill-h: 6.75rem;
  }

  @media (max-width: 599px) {
    .c-ill-wide {
      --ill-h: 10.5rem;
    }
  }

  .c-ill-strip {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    padding: 2px 2px 8px;
    scrollbar-width: thin;
    scrollbar-color: var(--c-line-strong) transparent;
  }

  .c-ill-thumb {
    position: relative;
    display: block;
    flex: 0 0 auto;
    overflow: hidden;
    border-radius: 2px;
    background-color: var(--c-tint);
    box-shadow: var(--c-cover-shadow);
    cursor: zoom-in;
  }

  .c-ill-thumb img {
    display: block;
    width: auto;
    height: var(--ill-h);
    object-fit: cover;
  }

  .c-ill-hidden {
    cursor: pointer;
  }

  .c-ill-hidden img {
    filter: blur(12px);
    transform: scale(1.08);
  }

  .c-ill-spoiler {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    border-radius: 20px;
    background-color: rgba(0, 0, 0, 0.6);
    padding: 8px 10px;
    color: #dcddde;
    font-family: 'Noto Sans JP', sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
</style>
