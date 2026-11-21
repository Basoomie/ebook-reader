<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: a book's pronunciation fixes, in its Audiobook section (decided with
   * the user, 2026-11-14/15). This book's list wins over the global one (Settings >
   * Audiobooks); the book's own furigana wins over both. Opening it runs the text check:
   * the server reads the book and says where each fix matches, with the reading the PC
   * will be given. When the linked audiobook was made on the PC before the fixes that
   * match this book changed, a note says so (checked at once for such a book).
   *
   * 2026-11-20 redesign: a folded part of the Text-to-speech row (no box of its own); with the
   * row closed (`compact`) only that note shows.
   */
  import { onDestroy } from 'svelte';
  import { globalHere, versionNote } from '$lib/audio/pronunciation/fix-text';
  import type { AudioLink } from '$lib/audio/audio-types';
  import type {
    FixCheck,
    FixList,
    PronunciationCheck,
    PronunciationFix
  } from '$lib/audio/pronunciation/fix-types';
  import PronunciationFixList from '$lib/components/audio/pronunciation-fix-list.svelte';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { settingsTabHref } from '$lib/settings/settings-tab';

  export let api: LibraryApi;
  export let bookId: string;
  export let link: AudioLink | null;
  /** The Text-to-speech row is closed: only the "made before the fixes changed" note. */
  export let compact = false;
  /** Bound up: this book's fixes, null until known. */
  export let count: number | null = null;

  let book: FixList | null = null;
  let global: PronunciationFix[] = [];
  let check: PronunciationCheck | null = null;
  let checking = false;
  let checkError = '';
  let open = false;
  let loadedFor = '';
  let checkedFor = '';
  let destroyed = false;
  let run = 0;

  $: generated = link?.state === 'linked' && !!link.folder?.generated;
  $: if (bookId && bookId !== loadedFor) void load(bookId);
  // A generated audiobook's note shows without opening the panel.
  $: if (book?.available && generated && checkedFor !== `${bookId}|${link?.confirmedAt}`)
    void runCheck();
  $: checks = check ? new Map<number, FixCheck>(check.entries.map((c) => [c.id, c])) : null;
  $: shownGlobal = globalHere(global, check);
  $: note = versionNote(check);
  $: count = book?.available ? book.entries.length : null;

  onDestroy(() => (destroyed = true));

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load(id: string) {
    loadedFor = id;
    book = null;
    global = [];
    check = null;
    checkedFor = '';
    open = false;
    await reload(id);
  }

  async function reload(id = bookId) {
    try {
      const [mine, all] = await Promise.all([
        api.pronunciationFixes(id),
        api.pronunciationFixes(null).catch(() => null)
      ]);
      if (destroyed || id !== bookId) return;
      book = mine;
      global = all?.entries ?? [];
    } catch (err) {
      // An older server (404) or no connection: the panel stays hidden.
      logger.warn(`Details: pronunciation fixes: ${describe(err)}`);
    }
  }

  async function runCheck() {
    const id = bookId;
    const mine = ++run;
    checkedFor = `${id}|${link?.confirmedAt}`;
    checking = true;
    checkError = '';
    try {
      const result = await api.pronunciationCheck(id);
      if (destroyed || id !== bookId || mine !== run) return;
      check = result;
    } catch (err) {
      if (!destroyed && id === bookId && mine === run) checkError = describe(err);
    } finally {
      if (mine === run) checking = false;
    }
  }

  async function toggle() {
    open = !open;
    if (open && !check && !checking) await runCheck();
  }

  async function changed() {
    await reload();
    await runCheck();
  }
</script>

{#if book?.available && compact}
  {#if note}
    <p class="c-notice mt-2 text-sm" role="status" data-testid="book-pron-fixes-note">{note}</p>
  {/if}
{:else if book?.available}
  <div class="c-sub mt-4 pt-3" data-testid="book-pron-fixes">
    {#if note}
      <p class="c-notice mb-3 text-sm" role="status" data-testid="book-pron-fixes-note">{note}</p>
    {/if}
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h4 class="font-medium">Pronunciation fixes{count ? ` (${count})` : ''}</h4>
        <p class="max-w-3xl text-sm text-c-muted">How a word should be read, for this book only.</p>
      </div>
      <button
        class="c-btn c-btn-secondary c-round shrink-0"
        aria-expanded={open}
        data-testid="book-pron-fixes-toggle"
        on:click={toggle}
      >
        {open ? 'Close' : 'Open'}
      </button>
    </div>
    {#if open}
      <p class="mt-2 max-w-3xl text-sm text-c-muted">
        They win over the fixes in Settings, and the book's own furigana wins over both. A word is
        fixed wherever it appears, the longer fix first. Audiobooks already made stay as they are.
      </p>
      {#if checking}
        <p class="mt-2 text-sm" role="status" data-testid="book-pron-fixes-checking">
          Checking the book…
        </p>
      {:else if checkError}
        <p class="c-notice mt-2 text-sm" role="alert" data-testid="book-pron-fixes-check-error">
          {checkError}
        </p>
      {/if}
      <h3 class="mt-3 text-sm font-medium">This book</h3>
      <PronunciationFixList
        {api}
        {bookId}
        entries={book.entries}
        limits={book.limits}
        {checks}
        testid="book-pron-fixes-list"
        emptyText="No fixes for this book yet."
        on:changed={changed}
      />
      <h3 class="mt-5 text-sm font-medium">From Settings, used in every book</h3>
      {#if check}
        <PronunciationFixList
          {api}
          bookId={null}
          entries={shownGlobal}
          {checks}
          readonly
          testid="book-pron-fixes-global"
          emptyText={global.length
            ? 'None of them is in this book.'
            : 'None. Fixes for every book are in Settings.'}
        />
      {/if}
      <p class="mt-2 text-sm">
        <a class="c-link" href={settingsTabHref(pagePath, 'Audiobooks')}>
          Pronunciation fixes in Settings
        </a>
      </p>
    {/if}
  </div>
{/if}

<style>
  .c-sub {
    border-top: var(--c-border-width) dashed var(--c-line);
  }
  .c-round {
    border-radius: 0.75rem;
  }
</style>
