<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: make an image of a highlight. A half-size preview beside the choices (stacked on
   * a phone); Download always works (also over plain http); Copy and Share appear only
   * where the browser allows them (a secure context), so they switch on by themselves
   * under HTTPS. The choices are remembered on this device. Esc closes.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faCopy, faDownload, faShareNodes } from '@fortawesome/free-solid-svg-icons';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { loadCover, loadImageFonts, type CoverImage } from '$lib/image/canvas-text';
  import {
    drawQuoteImage,
    loadQuoteOptions,
    QUOTE_BACKGROUND_NAMES,
    QUOTE_BACKGROUNDS,
    QUOTE_SIZES,
    quoteImageFileName,
    quotePalette,
    renderQuoteImage,
    saveQuoteOptions,
    type QuoteContent,
    type QuoteImageOptions
  } from '$lib/notes/quote-image';

  export let content: QuoteContent;

  const dispatch = createEventDispatcher<{ close: void }>();
  const PREVIEW_SCALE = 0.5;
  const toggle = 'c-btn c-btn-secondary min-h-[2.75rem] flex-1 px-3 text-sm';
  const action = 'c-btn c-btn-secondary min-h-[2.75rem] px-4 text-sm';

  let options: QuoteImageOptions = loadQuoteOptions();
  let canvas: HTMLCanvasElement;
  let cover: CoverImage = null;
  let coverLoaded = false;
  let fontsReady = false;
  let busy = false;
  let status = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canCopy = false;
  let canShare = false;

  $: hasNote = !!content.note?.trim();
  $: backgrounds = QUOTE_BACKGROUNDS.filter((b) => b !== 'cover' || content.coverUrl);
  $: if (options.background === 'cover' && !content.coverUrl) {
    options = { ...options, background: 'paper' };
  }
  $: saveQuoteOptions(options);
  $: if (fontsReady) schedule(options, cover);

  onMount(async () => {
    try {
      canCopy =
        window.isSecureContext &&
        typeof ClipboardItem !== 'undefined' &&
        typeof navigator.clipboard?.write === 'function';
      canShare =
        window.isSecureContext &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [new File([''], 'quote.png', { type: 'image/png' })] });
    } catch {
      canShare = false;
    }
    await loadImageFonts().catch(() => {});
    fontsReady = true;
    if (content.coverUrl) {
      cover = await loadCover(content.coverUrl);
      coverLoaded = true;
    }
  });

  onDestroy(() => clearTimeout(timer));

  function schedule(o: QuoteImageOptions, c: CoverImage) {
    clearTimeout(timer);
    timer = setTimeout(() => draw(o, c), 60);
  }

  function draw(o: QuoteImageOptions, c: CoverImage) {
    if (!canvas) return;
    const { width, height } = QUOTE_SIZES[o.size];
    canvas.width = Math.round(width * PREVIEW_SCALE);
    canvas.height = Math.round(height * PREVIEW_SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(PREVIEW_SCALE, 0, 0, PREVIEW_SCALE, 0, 0);
    try {
      drawQuoteImage(ctx, content, o, c);
    } catch (error) {
      status = `The preview could not be drawn: ${(error as Error).message}`;
    }
  }

  function set<K extends keyof QuoteImageOptions>(key: K, value: QuoteImageOptions[K]) {
    options = { ...options, [key]: value };
    status = '';
  }

  async function image(): Promise<Blob> {
    // The cover already loaded for the preview (null: drawn without it).
    return renderQuoteImage(content, options, document, coverLoaded ? cover : undefined);
  }

  async function run(work: () => Promise<string>) {
    if (busy) return;
    busy = true;
    status = 'Making the image…';
    try {
      status = await work();
    } catch (error) {
      const name = (error as Error)?.name;
      status =
        name === 'AbortError' ? '' : `Something went wrong: ${(error as Error)?.message ?? error}`;
    } finally {
      busy = false;
    }
  }

  function download() {
    run(async () => {
      downloadBlob(await image(), quoteImageFileName(new Date()));
      return 'Image saved.';
    });
  }

  function copy() {
    run(async () => {
      const blob = await image();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'Image copied.';
    });
  }

  function share() {
    run(async () => {
      const blob = await image();
      const file = new File([blob], quoteImageFileName(new Date()), { type: 'image/png' });
      await navigator.share({ files: [file], title: content.title });
      return '';
    });
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      dispatch('close');
    }
  }

  function swatchStyle(background: (typeof QUOTE_BACKGROUNDS)[number]) {
    if (background === 'cover') {
      return content.coverUrl
        ? `background-image: url("${content.coverUrl.replace(/"/g, '%22')}"); background-size: cover; background-position: center;`
        : '';
    }
    const p = quotePalette(background, content.color);
    return `background-color: ${p.bg}; color: ${p.ink};`;
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="c-quote-dialog mdc-elevation--z24 max-h-[calc(100vh-8rem)] w-[min(60rem,80vw)] overflow-y-auto rounded px-4 pt-4 sm:px-6 sm:pt-6"
  role="dialog"
  aria-label="Quote image"
  data-testid="quote-image-dialog"
>
  <h2 class="mb-4 font-mincho text-xl font-bold">Quote image</h2>
  <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
    <div class="c-quote-preview flex items-center justify-center rounded p-3">
      <canvas
        bind:this={canvas}
        class="block h-auto max-h-[60vh] w-auto max-w-full rounded shadow"
        aria-label="Preview"
        data-testid="quote-image-preview"
      />
    </div>

    <div class="flex flex-col gap-4 text-sm">
      <fieldset>
        <legend class="mb-1 font-medium text-c-muted">Text</legend>
        <div class="flex gap-2">
          <button
            type="button"
            class={toggle}
            aria-pressed={options.direction === 'horizontal'}
            data-testid="quote-direction-horizontal"
            on:click={() => set('direction', 'horizontal')}>Horizontal</button
          >
          <button
            type="button"
            class={toggle}
            aria-pressed={options.direction === 'vertical'}
            data-testid="quote-direction-vertical"
            on:click={() => set('direction', 'vertical')}>Vertical 縦</button
          >
        </div>
      </fieldset>

      <fieldset>
        <legend class="mb-1 font-medium text-c-muted">Alignment</legend>
        <div class="flex gap-2">
          <button
            type="button"
            class={toggle}
            aria-pressed={options.align === 'start'}
            data-testid="quote-align-start"
            on:click={() => set('align', 'start')}
            >{options.direction === 'vertical' ? 'Top' : 'Left'}</button
          >
          <button
            type="button"
            class={toggle}
            aria-pressed={options.align === 'center'}
            data-testid="quote-align-center"
            on:click={() => set('align', 'center')}>Centre</button
          >
        </div>
      </fieldset>

      <fieldset>
        <legend class="mb-1 font-medium text-c-muted">Size</legend>
        <div class="flex gap-2">
          <button
            type="button"
            class={toggle}
            aria-pressed={options.size === 'square'}
            data-testid="quote-size-square"
            on:click={() => set('size', 'square')}>Square</button
          >
          <button
            type="button"
            class={toggle}
            aria-pressed={options.size === 'portrait'}
            data-testid="quote-size-portrait"
            on:click={() => set('size', 'portrait')}>Portrait</button
          >
        </div>
      </fieldset>

      <fieldset>
        <legend class="mb-1 font-medium text-c-muted">Background</legend>
        <div class="flex flex-wrap gap-1">
          {#each backgrounds as background (background)}
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-full"
              title={QUOTE_BACKGROUND_NAMES[background]}
              aria-label={QUOTE_BACKGROUND_NAMES[background]}
              aria-pressed={options.background === background}
              data-testid="quote-bg-{background}"
              on:click={() => set('background', background)}
            >
              <span
                class="c-quote-swatch flex h-9 w-9 items-center justify-center rounded-full font-mincho text-sm"
                class:c-quote-swatch-picked={options.background === background}
                style={swatchStyle(background)}
                aria-hidden="true">{background === 'cover' ? '' : 'あ'}</span
              >
            </button>
          {/each}
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-1">
        <legend class="mb-1 font-medium text-c-muted">Show</legend>
        <label class="flex min-h-[2.75rem] items-center gap-3">
          <input
            type="checkbox"
            class="h-5 w-5"
            checked={options.showTitle}
            data-testid="quote-show-title"
            on:change={(ev) => set('showTitle', ev.currentTarget.checked)}
          />
          Title
        </label>
        <label class="flex min-h-[2.75rem] items-center gap-3">
          <input
            type="checkbox"
            class="h-5 w-5"
            checked={options.showAuthor}
            data-testid="quote-show-author"
            on:change={(ev) => set('showAuthor', ev.currentTarget.checked)}
          />
          Author
        </label>
        {#if hasNote}
          <label class="flex min-h-[2.75rem] items-center gap-3">
            <input
              type="checkbox"
              class="h-5 w-5"
              checked={options.showNote}
              data-testid="quote-show-note"
              on:change={(ev) => set('showNote', ev.currentTarget.checked)}
            />
            Note
          </label>
        {/if}
      </fieldset>
    </div>
  </div>

  <footer
    class="c-quote-actions sticky bottom-0 mt-3 flex flex-wrap items-center justify-end gap-2 py-3 sm:py-4"
  >
    <p class="mr-auto text-sm text-c-muted" role="status" data-testid="quote-image-status">
      {status}
    </p>
    <button
      type="button"
      class={action}
      data-testid="quote-image-close"
      on:click={() => dispatch('close')}
    >
      Close
    </button>
    {#if canShare}
      <button
        type="button"
        class={action}
        disabled={busy}
        data-testid="quote-image-share"
        on:click={share}
      >
        <Fa icon={faShareNodes} /> Share
      </button>
    {/if}
    {#if canCopy}
      <button
        type="button"
        class={action}
        disabled={busy}
        data-testid="quote-image-copy"
        on:click={copy}
      >
        <Fa icon={faCopy} /> Copy
      </button>
    {/if}
    <button
      type="button"
      class="c-btn c-btn-primary min-h-[2.75rem] px-4 text-sm"
      disabled={busy}
      data-testid="quote-image-download"
      on:click={download}
    >
      <Fa icon={faDownload} /> Download
    </button>
  </footer>
</section>

<style>
  /* Its own colours, so it reads the same over the catalogue and the reader. */
  .c-quote-dialog {
    background-color: var(--c-raised);
    color: var(--c-ink);
  }

  /* The buttons stay in view while the choices scroll (phones). */
  .c-quote-actions {
    background-color: var(--c-raised);
  }

  .c-quote-preview {
    background-color: var(--c-tint);
  }

  .c-quote-swatch {
    border: var(--c-border-width) solid var(--c-line-strong);
  }

  .c-quote-swatch-picked {
    box-shadow:
      0 0 0 2px var(--c-raised),
      0 0 0 4px var(--c-ink);
  }
</style>
