<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries session 2: one setup's full summary as it would look in the app (the
   * approved tabs), from the accuracy test's judging page. /summaries-test/summary?run=…&lang=…
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import SummaryView from '$lib/components/summaries/summary-view.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { SummaryTestApi, type SummaryPage } from '$lib/summaries/test-api';

  let data: SummaryPage | null = null;
  let error = '';
  let run = '';
  let lang = 'ja';

  onMount(async () => {
    if (!browser) return;
    run = $page.url.searchParams.get('run') ?? '';
    lang = $page.url.searchParams.get('lang') ?? 'ja';
    const api = await SummaryTestApi.connect();
    if (!api) {
      error = 'Connect this device to the library server first (Settings > Data).';
      return;
    }
    try {
      data = await api.summary(run, lang);
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<AppHeader title="Summary" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="summary-test-page">
  <a
    class="c-link mt-4 inline-flex min-h-[3rem] items-center text-sm"
    href="{pagePath}/summaries-test{data ? `?book=${encodeURIComponent(data.book.key)}` : ''}"
    >‹ Back to judging</a
  >
  {#if error}
    <p class="c-notice mt-3 text-sm" role="alert">{error}</p>
  {:else if data}
    <h1 class="mt-2 text-xl font-bold" lang="ja">{data.book.title}</h1>
    <p class="mt-1 text-sm text-c-muted">{data.run.label}</p>
    {#if data.languages.length > 1}
      <div class="mt-2 flex gap-2">
        {#each data.languages as l (l)}
          <a
            class="c-chip c-chip-sm"
            aria-current={l === lang ? 'page' : undefined}
            href="{pagePath}/summaries-test/summary?run={encodeURIComponent(run)}&lang={l}"
            data-testid="summary-lang-{l}">{l === 'ja' ? '日本語' : l === 'en' ? 'English' : l}</a
          >
        {/each}
      </div>
    {/if}
    <div class="mt-4 max-w-3xl">
      <SummaryView
        summary={data.summary}
        bookId={data.book.readerId}
        chapters={data.chapters}
        characters={data.characters}
      />
    </div>
  {/if}
</div>
