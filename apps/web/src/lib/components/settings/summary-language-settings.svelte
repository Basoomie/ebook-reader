<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings › Library › Summaries: the summary languages, the same on every device (book
   * summaries session 4). A summary is written in its book's language; each language here is a
   * button on the book page, translated the first time it is chosen. Default English and
   * Japanese.
   */
  import { summaryLanguages$ } from '$lib/summaries/settings';

  /** The languages offered (their own names); the server takes any language tag. */
  const OFFERED: { lang: string; name: string }[] = [
    { lang: 'en', name: 'English' },
    { lang: 'ja', name: '日本語' },
    { lang: 'zh', name: '中文' },
    { lang: 'ko', name: '한국어' },
    { lang: 'es', name: 'Español' },
    { lang: 'fr', name: 'Français' },
    { lang: 'de', name: 'Deutsch' },
    { lang: 'pt', name: 'Português' }
  ];

  function toggle(lang: string) {
    const now = $summaryLanguages$;
    summaryLanguages$.next(now.includes(lang) ? now.filter((l) => l !== lang) : [...now, lang]);
  }
</script>

<div
  class="flex flex-wrap gap-2"
  role="group"
  aria-label="Summary languages"
  data-testid="summary-languages"
>
  {#each OFFERED as o (o.lang)}
    <button
      type="button"
      class="c-chip"
      lang={o.lang}
      aria-pressed={$summaryLanguages$.includes(o.lang)}
      data-testid="summary-language-{o.lang}"
      on:click={() => toggle(o.lang)}>{o.name}</button
    >
  {/each}
</div>

<style>
  /* 48 px on touch and E-ink, like the buttons. */
  button {
    min-height: var(--c-btn-h);
  }
</style>
