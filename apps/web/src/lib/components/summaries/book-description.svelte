<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book page's Description (内容紹介): its text, cut to about six lines until "More", and
   * (book summaries session 4b) language buttons like the summary's: the book's language and
   * the Summary languages setting's.
   *
   * - A language is translated the first time it is chosen (online), then kept on the server
   *   and on every device, so it reads offline too.
   * - A translation is shown only while the description is the text it was made from: one the
   *   cleanup changed shows the original until that language is translated again.
   * - The last language chosen is remembered on this device, apart from the summary's.
   *
   * Never breaks the page: a failure is a line under the text, which stays in the original.
   */
  import { onDestroy, onMount } from 'svelte';
  import { logger } from '$lib/data/logger';
  import { isUnreachable } from '$lib/library/offline/offline-source';
  import { getSyncEngine } from '$lib/sync/sync-service';
  import { descriptionViewLang$, summaryLanguages$ } from '$lib/summaries/settings';
  import type { DescriptionView, SummaryApi } from '$lib/summaries/summary-api';
  import type { CachedDescription } from '$lib/summaries/summary-cache';
  import { descriptionBookLang, shownDescription } from '$lib/summaries/description-page';
  import { languageChoices, startLanguage } from '$lib/summaries/summary-page';
  import {
    getDescriptionTranslation,
    keepDescriptionTranslation,
    summaryApi
  } from '$lib/summaries/summary-sync';

  export let bookId: string;
  /** The description as the catalog gives it (Calibre's HTML). */
  export let description: string | null | undefined;
  /** Its paragraphs as the page shows them (descriptionParagraphs). */
  export let paragraphs: string[];
  /** The book's library's language and Calibre's languages (the original's language). */
  export let libraryLanguage: string | null | undefined = null;
  export let languages: string[] | undefined = undefined;
  /** The page's own offline state (the server can't be reached). */
  export let offline = false;

  let api: SummaryApi | null = null;
  let server: DescriptionView | null = null;
  let cached: CachedDescription | null = null;
  /** The server has summaries off (503): no buttons. */
  let off = false;
  let unreachable = false;
  let lang = '';
  let open = false;
  /** Languages asked to be translated on this visit (asked once each unless chosen again). */
  const asked = new Set<string>();
  let destroyed = false;
  let loadingFor = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopListening: (() => void) | null = null;

  $: serverDown = offline || unreachable;
  $: bookLang = server?.bookLang ?? descriptionBookLang(libraryLanguage, languages);
  $: choices = off ? [] : languageChoices(bookLang, $summaryLanguages$);
  $: if (choices.length && (!lang || !choices.some((c) => c.lang === lang)))
    lang = startLanguage($descriptionViewLang$, choices);
  $: shown = shownDescription({
    original: paragraphs,
    description,
    lang: off ? bookLang : lang || bookLang,
    bookLang,
    server,
    cached,
    offline: serverDown
  });
  $: long = shown.paragraphs.join('').length > 220 || shown.paragraphs.length > 3;

  function describe(err: unknown): string {
    if (isUnreachable(err)) return 'The library server cannot be reached.';
    return (err as Error)?.message ?? String(err);
  }

  async function load(): Promise<void> {
    const key = `${bookId}|${lang}|${description ?? ''}`;
    loadingFor = key;
    if (timer) clearTimeout(timer);
    timer = null;
    const want = lang;
    if (!want || want === bookLang || !description) return;
    cached = await getDescriptionTranslation(bookId, want);
    if (destroyed || loadingFor !== key) return;
    try {
      api ??= await summaryApi();
      if (!api || offline) {
        unreachable = !api;
        return;
      }
      let v = await api.description(bookId, want);
      if (destroyed || loadingFor !== key) return;
      unreachable = false;
      // A language chosen for the first time (or a failed one chosen again): translated now.
      if (v.lang && v.source === description && v.state === 'none' && !asked.has(want)) {
        asked.add(want);
        v = await api.translateDescription(bookId, want);
        if (destroyed || loadingFor !== key) return;
      }
      server = v;
      if (v.state === 'done' && v.translation && v.source !== null)
        void keepDescriptionTranslation({
          bookId,
          lang: want,
          source: v.source,
          paragraphs: v.translation.paragraphs
        });
      if (v.state === 'queued') timer = setTimeout(() => void load(), 2_000);
    } catch (err) {
      if ((err as { code?: string })?.code === 'summaries_off') {
        off = true;
        return;
      }
      if (isUnreachable(err)) unreachable = true;
      else
        server = { ...(server ?? emptyView()), lang: want, state: 'failed', error: describe(err) };
      logger.warn(`Description of ${bookId}: ${describe(err)}`);
    }
  }

  function emptyView(): DescriptionView {
    return {
      bookLang,
      source: description ?? null,
      lang: null,
      state: 'none',
      error: null,
      translation: null
    };
  }

  function choose(l: string) {
    if (l === lang && !(server?.state === 'failed')) return;
    // A failed translation chosen again is asked again.
    if (server?.lang === l && server.state === 'failed') {
      asked.delete(l);
      server = { ...server, state: 'none', error: null };
      void retry(l);
    }
    lang = l;
    descriptionViewLang$.next(l === bookLang ? '' : l);
  }

  async function retry(l: string) {
    try {
      api ??= await summaryApi();
      if (!api) return;
      asked.add(l);
      server = await api.translateDescription(bookId, l);
      if (server.state === 'queued') timer = setTimeout(() => void load(), 2_000);
    } catch (err) {
      server = { ...emptyView(), lang: l, state: 'failed', error: describe(err) };
    }
  }

  let last = '';
  /** Another book, language, text or connection: look again (a new book starts afresh). */
  function changed(key: string, book: string) {
    if (key === last) return;
    if (!last.startsWith(`${book}|`)) {
      open = false;
      asked.clear();
      server = null;
      cached = null;
    }
    last = key;
    void load();
  }
  $: changed(`${bookId}|${lang}|${description ?? ''}|${offline}`, bookId);

  onMount(() => {
    void getSyncEngine()
      .then((engine) => {
        if (destroyed) return;
        // A translation made on another device (or the description changed): look again.
        stopListening = engine.onRemoteChange((records) => {
          if (records.some((r) => r.kind === 'book-summary' && r.id === bookId)) void load();
        });
      })
      .catch(() => undefined);
  });
  onDestroy(() => {
    destroyed = true;
    stopListening?.();
    if (timer) clearTimeout(timer);
  });
</script>

<div class="head">
  <h2 id="details-desc" class="flex items-baseline gap-3">
    <span class="font-mincho text-lg font-bold text-c-label">内容紹介</span>
    <span class="text-sm text-c-muted">Description</span>
  </h2>
  {#if choices.length > 1}
    <div class="c-strip langs" role="group" aria-label="Description language">
      {#each choices as c (c.lang)}
        <button
          type="button"
          class="c-chip c-chip-sm shrink-0"
          aria-pressed={lang === c.lang}
          data-testid="description-lang-{c.lang}"
          on:click={() => choose(c.lang)}>{c.label}</button
        >
      {/each}
    </div>
  {/if}
</div>
<div
  class="mt-2 flex flex-col gap-3 text-[15px] leading-loose"
  class:c-clamped={long && !open}
  lang={shown.translated ? lang : undefined}
  data-testid="details-description"
  data-translated={shown.translated ? lang : undefined}
>
  {#each shown.paragraphs as p}<p class="whitespace-pre-line">{p}</p>{/each}
</div>
{#if long}
  <button
    class="c-link mt-1 min-h-[2.75rem] text-sm"
    aria-expanded={open}
    data-testid="details-more"
    on:click={() => (open = !open)}
  >
    {open ? 'Less' : 'More'}
  </button>
{/if}
{#if shown.note === 'translating'}
  <p class="mt-2 text-sm" role="status" data-testid="description-translating">
    Translating… Shown in the original until it is ready.
  </p>
{:else if shown.note === 'offline'}
  <p class="mt-2 text-sm text-c-muted" data-testid="description-not-translated">
    Translated when the library server can be reached. Shown in the original.
  </p>
{:else if shown.note === 'failed'}
  <p class="c-notice mt-2 text-sm" role="alert" data-testid="description-failed">
    Not translated: {shown.error ?? 'unknown error'}. Shown in the original; choose the language
    again to try again.
  </p>
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  /* The summary's language buttons (summary-section.svelte): 48 px on touch and E-ink. */
  .langs {
    display: flex;
    gap: 0.375rem;
    margin-left: auto;
    max-width: 100%;
  }
  .langs .c-chip {
    min-height: var(--c-btn-h);
  }
  /* About six lines of the description until "More". */
  .c-clamped {
    max-height: 12.5rem;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, #000 70%, transparent);
  }
  :global(html.eink) .c-clamped {
    mask-image: none;
  }
</style>
