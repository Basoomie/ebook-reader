<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book details page's Download menu: Book (the EPUB, always listed), Cover (the
   * full-size cover image, when the book has one), Audiobook (a link to one audio file that
   * is there) and SRT (a linked subtitle file that is there). Only reads: nothing on the
   * server changes. The button's chevron shows whether the menu is open.
   *
   * The EPUB, the cover and the subtitles are small: fetched with the token and saved
   * through `downloadBlob` (works over plain http). The audiobook can be gigabytes: its
   * signed URL with `download=1` goes to the browser's own downloads, so it is never held
   * in memory.
   */
  import { faChevronDown, faChevronUp, faDownload } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Fa from 'svelte-fa';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import type { AudioLink } from '$lib/audio/audio-types';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import {
    audioDownloadUrl,
    coverFileName,
    downloadChoices,
    downloadSizes,
    epubFileName,
    formatDownloadSize,
    subtitleFileName
  } from '$lib/library/book-download';
  import type { CatalogBookDetail } from '$lib/library/types';

  export let api: LibraryApi;
  export let book: CatalogBookDetail;
  export let link: AudioLink | null = null;
  /** Classes of the menu button (the page's rounded buttons). */
  export let buttonClass = 'c-btn c-btn-secondary';
  /** Classes of the wrapper (DropdownMenu's rootClass). */
  export let rootClass = '';

  const dispatch = createEventDispatcher<{ error: Error }>();
  const item = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
  /** The size beside an item's name, on the same line (no added height). */
  const sizeClass = 'ml-auto pl-3 text-xs text-c-muted tabular-nums';

  let busy: '' | 'book' | 'cover' | 'subtitles' = '';
  let controller: AbortController | undefined;
  let open = false;

  $: choices = downloadChoices(book, link);
  $: sizes = downloadSizes(book, link);

  // The cover's size: asked once per book, when the menu first opens (a HEAD request).
  let coverSize: number | null = null;
  let coverSizeFor = '';
  let sizeController: AbortController | undefined;
  $: if (open && choices.cover && coverSizeFor !== book.id) loadCoverSize(book.id);

  function loadCoverSize(id: string) {
    coverSizeFor = id;
    coverSize = null;
    sizeController?.abort();
    const ctl = new AbortController();
    sizeController = ctl;
    api
      .coverSize(id, { signal: ctl.signal })
      .then((size) => {
        if (coverSizeFor === id) coverSize = size;
      })
      // Only a hint: without it the item shows no size.
      .catch(() => undefined);
  }

  onDestroy(() => {
    controller?.abort();
    sizeController?.abort();
  });

  async function run(
    kind: 'book' | 'cover' | 'subtitles',
    task: (signal: AbortSignal) => Promise<void>
  ) {
    if (busy) return;
    busy = kind;
    controller = new AbortController();
    try {
      await task(controller.signal);
    } catch (err) {
      if (err instanceof LibraryApiError && err.kind === 'aborted') return;
      dispatch('error', err as Error);
    } finally {
      busy = '';
      controller = undefined;
    }
  }

  function saveBook() {
    const target = book;
    void run('book', async (signal) => {
      const { blob } = await api.downloadFile(target.id, signal);
      downloadBlob(blob, epubFileName(target.title));
    });
  }

  function saveCover() {
    const target = book;
    void run('cover', async (signal) => {
      const blob = await api.coverImage(target.id, signal);
      downloadBlob(blob, coverFileName(target.title, blob.type));
    });
  }

  function saveSubtitles() {
    const target = book;
    const name = subtitleFileName(link);
    void run('subtitles', async (signal) => {
      const file = await api.linkedSubtitleFile(target.id, { signal });
      if (!file) throw new Error('The subtitle file is no longer in the subtitle folder.');
      downloadBlob(file, name);
    });
  }

  function saveAudio(playUrl: string) {
    // A plain link: the server answers with an attachment, so the page stays.
    const a = document.createElement('a');
    a.href = audioDownloadUrl((p) => api.absolute(p), playUrl);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
</script>

<DropdownMenu
  buttonClass="{buttonClass} {busy ? 'pointer-events-none opacity-60' : ''}"
  label="Download: {book.title}"
  testid="details-download"
  panelWidth="w-56"
  {rootClass}
  bind:open
  let:close
>
  <span slot="button" class="c-download-label flex items-center gap-2" aria-busy={busy !== ''}>
    <Fa icon={faDownload} />
    {busy ? 'Downloading…' : 'Download'}
    <span class="c-download-chevron opacity-70"
      ><Fa icon={open ? faChevronUp : faChevronDown} size="xs" /></span
    >
  </span>
  <div class="flex flex-col gap-1">
    <button
      type="button"
      class={item}
      disabled={!choices.book}
      data-testid="details-download-book"
      on:click={() => {
        close();
        saveBook();
      }}
    >
      {#if choices.book}
        Book
        {#if sizes.book}
          <span class={sizeClass} data-testid="details-download-book-size"
            >{formatDownloadSize(sizes.book)}</span
          >
        {/if}
      {:else}
        <span class="flex flex-col items-start">
          Book
          <span class="text-xs text-c-muted">No longer in the library</span>
        </span>
      {/if}
    </button>
    {#if choices.cover}
      <button
        type="button"
        class={item}
        data-testid="details-download-cover"
        on:click={() => {
          close();
          saveCover();
        }}
      >
        Cover
        {#if coverSize}
          <span class={sizeClass} data-testid="details-download-cover-size"
            >{formatDownloadSize(coverSize)}</span
          >
        {/if}
      </button>
    {/if}
    {#if choices.audio}
      <button
        type="button"
        class={item}
        data-testid="details-download-audio"
        on:click={() => {
          close();
          if (choices.audio) saveAudio(choices.audio);
        }}
      >
        Audiobook
        {#if sizes.audio}
          <span class={sizeClass} data-testid="details-download-audio-size"
            >{formatDownloadSize(sizes.audio)}</span
          >
        {/if}
      </button>
    {/if}
    {#if choices.subtitles}
      <button
        type="button"
        class={item}
        data-testid="details-download-srt"
        on:click={() => {
          close();
          saveSubtitles();
        }}
      >
        SRT
        {#if sizes.subtitles}
          <span class={sizeClass} data-testid="details-download-srt-size"
            >{formatDownloadSize(sizes.subtitles)}</span
          >
        {/if}
      </button>
    {/if}
  </div>
</DropdownMenu>
