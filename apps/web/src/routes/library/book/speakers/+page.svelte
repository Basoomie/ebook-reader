<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12 session 5: checking who speaks each quote (a page of its own, decided
   * with the user 2026-11-16; reached from the book page's Characters). The address is
   * /library/book/speakers?id=<book>[&character=<id>].
   *
   * Filters: "To check" (default: the PC was unsure, or the speaker's name isn't near the
   * quote, where step A found most misses), unsure only (least sure first), one character, no
   * speaker, changed by you, no longer in the book, all. Each quote shows its paragraph (the
   * quote marked) with the paragraphs around it, its speaker and how sure the PC was. A
   * change saves at once and stays through later runs; "Use the PC's answer" undoes it.
   */
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import type {
    QuoteFilter,
    SpeakerCharacter,
    SpeakerOverview,
    SpeakerQuoteItem
  } from '$lib/audio/speakers/speaker-types';
  import { characterLabel, sortedCharacters, sureText } from '$lib/audio/speakers/speaker-text';
  import { speakerUnsureBelow$, unsureBelow } from '$lib/audio/tts-settings';
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { bookDetailsHref } from '$lib/library/format';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';

  const PAGE = 50;
  const FILTERS: { value: QuoteFilter; label: string }[] = [
    { value: 'check', label: 'To check' },
    { value: 'unsure', label: 'Unsure (least sure first)' },
    { value: 'character', label: 'One character' },
    { value: 'none', label: 'No speaker' },
    { value: 'corrected', label: 'Changed by you' },
    { value: 'lost', label: 'No longer in the book' },
    { value: 'all', label: 'All quotes' }
  ];

  let api: LibraryApi | null = null;
  let bookId = '';
  let title = '';
  let overview: SpeakerOverview | null = null;
  let items: SpeakerQuoteItem[] = [];
  let total = 0;
  let offset = 0;
  let filter: QuoteFilter = 'check';
  let character: number | null = null;
  let loading = true;
  let error = '';
  let saving: number | null = null;
  let destroyed = false;
  let noConnection = false;

  // Follows the setting (Settings > Audiobooks; it may change on another device).
  $: below = $speakerUnsureBelow$ ? unsureBelow() : 0.9;
  $: characters = overview ? sortedCharacters(overview.characters).filter((c) => !c.hidden) : [];
  $: byId = new Map<number, SpeakerCharacter>((overview?.characters ?? []).map((c) => [c.id, c]));

  onDestroy(() => (destroyed = true));

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  onMount(async () => {
    if (!browser) return;
    bookId = $page.url.searchParams.get('id') ?? '';
    const c = Number($page.url.searchParams.get('character'));
    if (Number.isInteger(c) && c > 0) {
      character = c;
      filter = 'character';
    }
    const connection = await getLibraryStore().getConnection();
    if (!connection) {
      noConnection = true;
      loading = false;
      return;
    }
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    void api
      .book(bookId)
      .then((b) => (title = b.title))
      .catch(() => undefined);
    await load();
  });

  async function load() {
    if (!api) return;
    loading = true;
    error = '';
    try {
      const [o, q] = await Promise.all([
        api.speakers(bookId, below),
        api.speakerQuotes(bookId, {
          filter,
          ...(filter === 'character' && character !== null ? { character } : {}),
          below,
          offset,
          limit: PAGE
        })
      ]);
      if (destroyed) return;
      overview = o;
      items = q.items;
      total = q.total;
    } catch (err) {
      if (!destroyed) error = describe(err);
    } finally {
      loading = false;
    }
  }

  function setFilter(value: string) {
    filter = value as QuoteFilter;
    if (filter === 'character' && character === null) character = characters[0]?.id ?? null;
    offset = 0;
    void load();
  }

  function setCharacter(value: string) {
    character = Number(value);
    offset = 0;
    void load();
  }

  function go(to: number) {
    offset = Math.max(0, to);
    void load();
    if (browser) window.scrollTo({ top: 0 });
  }

  async function setSpeaker(q: SpeakerQuoteItem, value: string) {
    if (!api) return;
    saving = q.quote;
    error = '';
    try {
      const saved = (await api.setQuoteSpeaker(
        bookId,
        q.quote,
        value === 'model' ? { reset: true } : { character: value === '' ? null : Number(value) }
      )) as { character: number | null; modelCharacter: number | null; corrected: boolean };
      // The row stays where it is until the list is loaded again (no jumping away).
      items = items.map((x) =>
        x.quote === q.quote
          ? {
              ...x,
              character: saved.character,
              modelCharacter: saved.modelCharacter,
              corrected: saved.corrected
            }
          : x
      );
    } catch (err) {
      error = describe(err);
    } finally {
      saving = null;
    }
  }

  function speakerName(id: number | null): string {
    if (id === null) return 'No speaker';
    const c = byId.get(id);
    return c ? c.name : 'A removed character';
  }

  const back = () => goto(bookDetailsHref(pagePath, bookId));
</script>

<svelte:head>
  <title>{formatPageTitle(title ? `${title}: who speaks` : 'Who speaks')}</title>
</svelte:head>

<AppHeader title="Who speaks" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="speakers-page">
  <button
    class="c-link mt-4 inline-flex min-h-[3rem] items-center gap-2 text-sm"
    data-testid="speakers-back"
    on:click={back}
  >
    ← Back to the book
  </button>
  <h1 class="mt-2 text-xl font-bold" lang="ja">{title || 'Who speaks'}</h1>

  {#if noConnection}
    <p class="mt-4" data-testid="speakers-no-connection">
      This device isn't connected to a library server.
    </p>
  {:else}
    {#if overview && !overview.run}
      <p class="mt-4" data-testid="speakers-no-run">
        Who speaks hasn't been worked out for this book yet: use “Find who speaks each quote” under
        Characters on the book's page.
      </p>
    {/if}
    {#if overview?.run}
      <p class="mt-2 max-w-3xl text-sm text-c-muted">
        {overview.counts.quotes.toLocaleString('en-US')} quotes · {overview.counts.check.toLocaleString(
          'en-US'
        )} to check · {overview.counts.corrected.toLocaleString('en-US')} changed by you. A quote you
        change keeps your speaker when the PC finds who speaks again.
      </p>
      <div class="mt-4 flex flex-wrap items-end gap-3">
        <label class="block text-sm text-c-muted">
          Show
          <select
            class="c-input mt-1 block min-h-[3rem] w-64 text-base"
            data-testid="speakers-filter"
            value={filter}
            on:change={(e) => setFilter(e.currentTarget.value)}
          >
            {#each FILTERS as f (f.value)}
              <option value={f.value}>{f.label}</option>
            {/each}
          </select>
        </label>
        {#if filter === 'character'}
          <label class="block text-sm text-c-muted">
            Character
            <select
              class="c-input mt-1 block min-h-[3rem] w-64 text-base"
              data-testid="speakers-character"
              value={character === null ? '' : String(character)}
              on:change={(e) => setCharacter(e.currentTarget.value)}
            >
              {#each characters as c (c.id)}
                <option value={String(c.id)}>{characterLabel(c)} · {c.quotes}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>
      {#if filter === 'check'}
        <p class="mt-2 max-w-3xl text-xs text-c-muted">
          Quotes the PC was less than {Math.round(below * 100)} % sure of (Settings > Audiobooks), and
          quotes whose speaker isn't named in or next to their paragraph: most of the PC's mistakes are
          there.
        </p>
      {/if}
    {/if}

    {#if error}
      <p class="c-notice mt-3 text-sm" role="alert" data-testid="speakers-error">{error}</p>
    {/if}
    {#if loading && !items.length}
      <p class="mt-4 text-sm" role="status">Loading the quotes…</p>
    {:else if overview?.run && !items.length}
      <p class="mt-4" data-testid="speakers-empty">Nothing here.</p>
    {/if}

    <ol class="mt-4 max-w-3xl" data-testid="speakers-list">
      {#each items as q (q.quote)}
        <li class="c-qrow py-4" data-testid="speakers-quote" data-quote={q.quote}>
          {#if q.before}
            <p class="text-sm text-c-muted" lang="ja">{q.before}</p>
          {/if}
          {#if q.paragraph}
            <p class="mt-1 break-words text-[17px]" lang="ja">
              {q.paragraph.text.slice(0, q.paragraph.start)}<mark class="c-quote"
                >{q.paragraph.text.slice(q.paragraph.start, q.paragraph.end)}</mark
              >{q.paragraph.text.slice(q.paragraph.end)}
            </p>
          {:else}
            <p class="mt-1 break-words text-[17px]" lang="ja">
              <mark class="c-quote">{q.text}</mark>
            </p>
          {/if}
          {#if q.after}
            <p class="mt-1 text-sm text-c-muted" lang="ja">{q.after}</p>
          {/if}
          <div class="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
            <label class="block text-sm text-c-muted">
              Speaker
              <select
                class="c-input mt-1 block min-h-[3rem] w-64 text-base"
                data-testid="speakers-quote-speaker"
                value={q.character === null ? '' : String(q.character)}
                disabled={saving === q.quote || q.lost}
                on:change={(e) => setSpeaker(q, e.currentTarget.value)}
              >
                <option value="">No speaker (the dialogue voice)</option>
                {#each characters as c (c.id)}
                  <option value={String(c.id)}>{characterLabel(c)}</option>
                {/each}
                {#if q.character !== null && !characters.some((c) => c.id === q.character)}
                  <option value={String(q.character)}>{speakerName(q.character)}</option>
                {/if}
                {#if q.corrected}
                  <option value="model"
                    >Use the PC's answer ({speakerName(q.modelCharacter)})</option
                  >
                {/if}
              </select>
            </label>
            <div class="text-sm" data-testid="speakers-quote-sure">
              {#if q.corrected}
                <span>Changed by you (the PC said {speakerName(q.modelCharacter)})</span>
              {:else if q.unknown}
                <span class="text-c-muted">The PC couldn't tell who speaks</span>
              {:else}
                <span class:font-bold={q.p !== null && q.p < below}>{sureText(q.p, below)}</span>
                {#if !q.nameNearby && q.character !== null}
                  <span class="block text-xs text-c-muted">The speaker isn't named nearby</span>
                {/if}
              {/if}
              {#if q.lost}
                <span class="block text-xs text-c-muted">No longer in the book</span>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ol>

    {#if total > PAGE}
      <div class="mt-4 flex flex-wrap items-center gap-3" data-testid="speakers-pages">
        <button
          class="c-btn c-btn-secondary c-round"
          disabled={offset === 0 || loading}
          on:click={() => go(offset - PAGE)}>Previous</button
        >
        <span class="text-sm">
          {offset + 1}–{Math.min(total, offset + PAGE)} of {total.toLocaleString('en-US')}
        </span>
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="speakers-next"
          disabled={offset + PAGE >= total || loading}
          on:click={() => go(offset + PAGE)}>Next</button
        >
      </div>
    {/if}
  {/if}
</div>

<AppBottomBar />

<style>
  .c-qrow + .c-qrow {
    border-top: var(--c-border-width) solid var(--c-line);
  }
  /* The selection tokens: readable in light, dark and E-ink (black on white there). */
  .c-quote {
    background-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
    border-radius: 2px;
  }
  .c-round {
    border-radius: 0.75rem;
  }
</style>
