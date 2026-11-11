<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: make an image of a highlight. A preview (exactly the image, nothing
   * around it) beside the choices (stacked on a phone): text direction, alignment, quote
   * size (automatic or chosen) and colour; the quote mark and its colour; preset or custom
   * backgrounds; a frame (line or card) and its colours; title, author and note. Every
   * colour is automatic until one is picked. Download always works (also over plain http);
   * Copy and Share appear only where the browser allows them (a secure context). The
   * choices are remembered on this device. Esc closes.
   *
   * `refreshAuthor` (the reader): asks the library server for the book's authors after the
   * dialog opens; a different answer replaces the remembered one.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faCopy, faDownload, faShareNodes } from '@fortawesome/free-solid-svg-icons';
  import QuoteColorInput from '$lib/components/notes/quote-color-input.svelte';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { loadCover, loadImageFonts, type CoverImage } from '$lib/image/canvas-text';
  import {
    drawQuoteImage,
    layoutQuote,
    loadQuoteOptions,
    QUOTE_BACKGROUND_NAMES,
    QUOTE_BACKGROUNDS,
    QUOTE_FRAME_NAMES,
    QUOTE_MARK_NAMES,
    QUOTE_SIZE_MAX,
    QUOTE_SIZE_MIN,
    QUOTE_SIZES,
    quoteColors,
    quoteImageFileName,
    quotePalette,
    renderQuoteImage,
    saveQuoteOptions,
    type QuoteBackground,
    type QuoteContent,
    type QuoteFrame,
    type QuoteImageOptions,
    type QuoteMark
  } from '$lib/notes/quote-image';

  export let content: QuoteContent;
  export let refreshAuthor: (() => Promise<string | null>) | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();
  /** On screen at most half size (drawn at full size: shrunk text measures differently). */
  const PREVIEW_SCALE = 0.5;
  const toggle = 'c-btn c-btn-secondary min-h-[2.75rem] flex-1 px-2 text-sm';
  const action = 'c-btn c-btn-secondary min-h-[2.75rem] px-4 text-sm';
  const legend = 'mb-1 font-medium text-c-muted';
  const marks: QuoteMark[] = ['line', 'quotes', 'corner', 'none'];
  const frames: QuoteFrame[] = ['none', 'line', 'card'];

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
  /** The size "Auto" gives right now (shown on the slider). */
  let autoSize = 64;

  $: hasNote = !!content.note?.trim();
  $: presets = QUOTE_BACKGROUNDS.filter(
    (b) => b !== 'custom' && (b !== 'cover' || content.coverUrl)
  );
  $: if (options.background === 'cover' && !content.coverUrl) {
    options = { ...options, background: 'paper' };
  }
  $: auto = quoteColors(
    { ...options, textColor: null, markColor: null, frameColor: null, cardColor: null },
    content.color,
    options.background === 'cover' && coverLoaded && !cover ? 'ink' : options.background
  );
  $: previewStyle = (() => {
    const { width, height } = QUOTE_SIZES[options.size];
    return `width: min(100%, ${width * PREVIEW_SCALE}px, calc(60vh * ${width / height}));`;
  })();
  $: saveQuoteOptions(options);
  $: if (fontsReady) schedule(options, cover, content);

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
    void askAuthor();
    await loadImageFonts().catch(() => {});
    fontsReady = true;
    if (content.coverUrl) {
      cover = await loadCover(content.coverUrl);
      coverLoaded = true;
    }
  });

  onDestroy(() => clearTimeout(timer));

  async function askAuthor() {
    if (!refreshAuthor) return;
    try {
      const fresh = await refreshAuthor();
      if (fresh !== null && fresh !== content.author) content = { ...content, author: fresh };
    } catch {
      // Offline or no answer: the remembered author (or none) stays.
    }
  }

  function schedule(o: QuoteImageOptions, c: CoverImage, q: QuoteContent) {
    clearTimeout(timer);
    timer = setTimeout(() => draw(o, c, q), 60);
  }

  function draw(o: QuoteImageOptions, c: CoverImage, q: QuoteContent) {
    if (!canvas) return;
    const { width, height } = QUOTE_SIZES[o.size];
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      drawQuoteImage(ctx, q, o, c);
      autoSize = layoutQuote(ctx, q, { ...o, quoteSize: null }).size;
    } catch (error) {
      status = `The preview could not be drawn: ${(error as Error).message}`;
    }
  }

  function set<K extends keyof QuoteImageOptions>(key: K, value: QuoteImageOptions[K]) {
    options = { ...options, [key]: value };
    status = '';
  }

  /** The picker needs #rrggbb; automatic colours may be rgba(). */
  function asHex(color: string): string {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    const m = color.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return '#888888';
    return `#${m
      .slice(0, 3)
      .map((v) => Math.round(Number(v)).toString(16).padStart(2, '0'))
      .join('')}`;
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

  const fileName = () => quoteImageFileName(new Date(), content.title);

  function download() {
    run(async () => {
      downloadBlob(await image(), fileName());
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
      const file = new File([blob], fileName(), { type: 'image/png' });
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

  function swatchStyle(background: QuoteBackground) {
    if (background === 'cover') {
      return content.coverUrl
        ? `background-image: url("${content.coverUrl.replace(/"/g, '%22')}"); background-size: cover; background-position: center;`
        : '';
    }
    const p = quotePalette(background, content.color, options.customBackground);
    return `background-color: ${p.bg}; color: ${p.ink};`;
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="c-quote-dialog mdc-elevation--z24 max-h-[calc(100vh-8rem)] w-[min(64rem,80vw)] overflow-y-auto rounded px-4 pt-4 sm:px-6 sm:pt-6"
  role="dialog"
  aria-label="Quote image"
  data-testid="quote-image-dialog"
>
  <h2 class="mb-4 font-mincho text-xl font-bold">Quote image</h2>
  <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_19rem]">
    <div class="flex items-start justify-center md:sticky md:top-0 md:self-start">
      <canvas
        bind:this={canvas}
        class="c-quote-canvas block h-auto"
        style={previewStyle}
        aria-label="Preview"
        data-testid="quote-image-preview"
      />
    </div>

    <div class="flex flex-col gap-5 text-sm">
      <fieldset class="flex flex-col gap-2">
        <legend class={legend}>Quote</legend>
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
        <div class="flex min-h-[2.75rem] items-center gap-3">
          <button
            type="button"
            class="c-btn c-btn-secondary min-h-[2.75rem] shrink-0 px-3 text-sm"
            aria-pressed={options.quoteSize === null}
            title="Fit the quote to the image"
            data-testid="quote-fontsize-auto"
            on:click={() => set('quoteSize', null)}>Auto</button
          >
          <input
            type="range"
            class="min-w-0 flex-1"
            min={QUOTE_SIZE_MIN}
            max={QUOTE_SIZE_MAX}
            step="2"
            value={options.quoteSize ?? autoSize}
            aria-label="Quote size"
            data-testid="quote-fontsize"
            on:input={(ev) => set('quoteSize', Number(ev.currentTarget.value))}
          />
          <span class="w-10 shrink-0 text-right tabular-nums" data-testid="quote-fontsize-value"
            >{options.quoteSize ?? autoSize}</span
          >
        </div>
        <QuoteColorInput
          label="Text colour"
          value={options.textColor}
          auto={asHex(auto.ink)}
          testid="quote-text-color"
          on:change={(ev) => set('textColor', ev.detail)}
        />
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class={legend}>Quote mark</legend>
        <div class="flex gap-1">
          {#each marks as mark (mark)}
            <button
              type="button"
              class={toggle}
              aria-pressed={options.mark === mark}
              data-testid="quote-mark-{mark}"
              on:click={() => set('mark', mark)}>{QUOTE_MARK_NAMES[mark]}</button
            >
          {/each}
        </div>
        {#if options.mark !== 'none'}
          <QuoteColorInput
            label="Mark colour"
            value={options.markColor}
            auto={asHex(auto.mark)}
            testid="quote-mark-color"
            on:change={(ev) => set('markColor', ev.detail)}
          />
        {/if}
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class={legend}>Background</legend>
        <div class="flex flex-wrap items-center gap-1">
          {#each presets as background (background)}
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
          <label
            class="c-quote-swatch c-quote-custom ml-1 flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-full"
            class:c-quote-swatch-picked={options.background === 'custom'}
            title={QUOTE_BACKGROUND_NAMES.custom}
          >
            <span class="sr-only">{QUOTE_BACKGROUND_NAMES.custom}</span>
            <input
              type="color"
              class="h-12 w-12 shrink-0 cursor-pointer border-0 p-0"
              value={options.customBackground}
              data-testid="quote-bg-custom"
              on:input={(ev) =>
                (options = {
                  ...options,
                  customBackground: ev.currentTarget.value,
                  background: 'custom'
                })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class={legend}>Frame</legend>
        <div class="flex gap-1">
          {#each frames as frame (frame)}
            <button
              type="button"
              class={toggle}
              aria-pressed={options.frame === frame}
              data-testid="quote-frame-{frame}"
              on:click={() => set('frame', frame)}>{QUOTE_FRAME_NAMES[frame]}</button
            >
          {/each}
        </div>
        {#if options.frame !== 'none'}
          <QuoteColorInput
            label="Border colour"
            value={options.frameColor}
            auto={asHex(auto.frame)}
            testid="quote-frame-color"
            on:change={(ev) => set('frameColor', ev.detail)}
          />
        {/if}
        {#if options.frame === 'card'}
          <QuoteColorInput
            label="Card colour"
            value={options.cardColor}
            auto={asHex(auto.card ?? '#888888')}
            testid="quote-card-color"
            on:change={(ev) => set('cardColor', ev.detail)}
          />
        {/if}
      </fieldset>

      <fieldset>
        <legend class={legend}>Image</legend>
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

      {#if content.title.trim() || content.author.trim() || hasNote}
        <fieldset class="flex flex-col gap-1">
          <legend class={legend}>Show</legend>
          {#if content.title.trim()}
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
          {/if}
          {#if content.author.trim()}
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
          {/if}
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
      {/if}
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

  /* Exactly the image: only a hairline to show where it ends. */
  .c-quote-canvas {
    outline: 1px solid var(--c-line);
  }

  .c-quote-swatch {
    border: var(--c-border-width) solid var(--c-line-strong);
  }

  .c-quote-swatch-picked {
    box-shadow:
      0 0 0 2px var(--c-raised),
      0 0 0 4px var(--c-ink);
  }

  /* The custom colour: a round window onto the browser's colour input. */
  .c-quote-custom {
    background: conic-gradient(#f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171);
  }

  .c-quote-custom input {
    opacity: 0.001;
  }

  .c-quote-custom.c-quote-swatch-picked input {
    opacity: 1;
  }
</style>
