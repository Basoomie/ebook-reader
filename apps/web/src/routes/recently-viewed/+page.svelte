<script lang="ts">
  /**
   * Recently viewed (2026-11-24, docs/design/recently-viewed.md): the Home row's "See all".
   * The books whose details page you looked at, newest first, as the Library's cards under
   * day headings (Today, Yesterday, then dates). No search, filters or sort: the order is
   * the point. Remove one book (its ⋮ menu), several (Select) or all (Clear all…), each
   * after asking. Offline: this device's copies of the books.
   */
  import { goto } from '$app/navigation';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { clearRecentlyViewedCopy, forgetViewedCopy } from '$lib/confirm/confirm-copy';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { audioBookIdsOnDevice } from '$lib/audio/offline/audio-offline';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { existingLocalIds } from '$lib/library/browser-open-deps';
  import { coverGrid } from '$lib/library/cover-size';
  import {
    collectionMembership,
    coverBlurDefault,
    isCoverBlurred,
    NO_COVER_RULES,
    type CoverBlurContext,
    type CoverRules
  } from '$lib/library/cover-blur';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import {
    askServerFirst,
    freshOfflineCatalog,
    isUnreachable,
    noteReachable,
    noteUnreachable,
    offlineCatalog,
    OFFLINE_NOTICE,
    serverAnswersAgain,
    serverWorthAsking,
    startsOffline
  } from '$lib/library/offline/offline-source';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import { bookProgressFraction, bookProgressLabel, positionsByBook } from '$lib/library/progress';
  import { removeFromThisDevice } from '$lib/library/remove-from-device';
  import {
    libraryCoverBlur$,
    libraryCoverSize$,
    libraryInfoLine$,
    libraryRequestTimeoutSeconds$
  } from '$lib/library/settings';
  import type { CatalogBook, CatalogLibrary } from '$lib/library/types';
  import { lookupInOrder } from '$lib/recently-viewed/lookup';
  import { groupByDay, kept, type ViewedEntry } from '$lib/recently-viewed/recently-viewed';
  import { currentKeep, recentlyViewedOn$ } from '$lib/recently-viewed/settings';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import type { BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import {
    bookStateApi,
    collectionsApi,
    libraryViewApi,
    recentlyViewedApi
  } from '$lib/sync/sync-service';
  import { faCheck, faRotateRight } from '@fortawesome/free-solid-svg-icons';
  import { onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';

  const store = getLibraryStore();
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  const recentlyViewed = recentlyViewedApi();
  const entries = recentlyViewed.entries;

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let offline = false;
  let libraries: CatalogLibrary[] = [];
  let states = new Map<string, BookState>();
  let coverRules: CoverRules = NO_COVER_RULES;
  let positions = new Map<string, LocalRecord[]>();
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
  let onDevice = new Set<string>();
  let audioOnDevice = new Set<string>();
  let revealed = new Set<string>();
  let ready = false;
  let destroyed = false;
  let stopListeners: (() => void)[] = [];
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;

  /** The cards, newest first; null while loading. */
  let books: CatalogBook[] | null = null;
  let error = '';
  let selectMode = false;
  let selected = new Set<string>();
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  $: gridLayout = coverGrid($libraryCoverSize$);
  $: shownEntries =
    $entries === null ? null : $recentlyViewedOn$ ? kept($entries, currentKeep(), Date.now()) : [];
  $: viewedAtOf = new Map((shownEntries ?? []).map((e) => [e.bookId, e.viewedAt]));
  $: days = books ? groupByDay(books, (b) => viewedAtOf.get(b.id) ?? 0, Date.now()) : [];
  $: listKey = shownEntries === null ? null : shownEntries.map((e) => e.bookId).join(',');
  // Reload when the list changes (a view, removal or clear, here or on another device).
  $: if (ready && listKey !== null) void loadBooks(shownEntries ?? [], listKey);

  onMount(async () => {
    freshOfflineCatalog();
    await loadMirror();
    const subscriptions = [
      bookState.onChanged(onMirrorChanged),
      view.onChanged(onMirrorChanged),
      collections.onChanged(onMirrorChanged)
    ];
    for (const sub of subscriptions) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    connection = (await store.getConnection()) ?? null;
    if (!connection) return;
    api = new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds);
    await refreshOnDevice();
    offline = startsOffline();
    if (offline) {
      void recheckServer(connection);
    } else {
      const a = api;
      const first = await askServerFirst(connection.serverUrl, (signal) => a.libraries({ signal }));
      if (first.status === 'ok') libraries = first.value.libraries;
      if (first.status === 'unreachable') offline = true;
    }
    ready = true;
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(mirrorTimer);
    stopListeners.forEach((off) => off());
    opening?.controller.abort();
  });

  async function loadMirror() {
    const [s, rules, records, coll] = await Promise.all([
      bookState.getAll().catch(() => new Map<string, BookState>()),
      view.coverRules(),
      view.positions(),
      collections.view()
    ]);
    states = s;
    coverRules = rules;
    positions = positionsByBook(records);
    collectionList = coll.collections;
    collectionItems = coll.items;
  }

  function onMirrorChanged() {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
      if (!destroyed) void loadMirror();
    }, 300);
  }

  async function refreshOnDevice() {
    try {
      const [links, ids] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      onDevice = new Set(links.filter((l) => ids.has(l.localId)).map((l) => l.bookId));
    } catch (err) {
      logger.warn(`Recently viewed: could not read local links: ${(err as Error).message}`);
    }
    try {
      audioOnDevice = new Set(await audioBookIdsOnDevice());
    } catch (err) {
      logger.warn(
        `Recently viewed: could not read the downloaded audio: ${(err as Error).message}`
      );
    }
  }

  /** The latest list asked for: an older answer never replaces a newer one. */
  let asked = '';

  async function loadBooks(list: readonly ViewedEntry[], key: string) {
    if (!api) return;
    asked = key;
    error = '';
    const ids = list.map((e) => e.bookId);
    const wasOffline = offline;
    try {
      const found = await lookupInOrder(wasOffline ? offlineCatalog() : api, ids);
      if (destroyed || asked !== key) return;
      books = found;
      if (!wasOffline) noteReachable();
      // Books removed meanwhile leave the selection.
      const shown = new Set(found.map((b) => b.id));
      selected = new Set([...selected].filter((id) => shown.has(id)));
    } catch (err) {
      if (destroyed || asked !== key) return;
      if (!wasOffline && isUnreachable(err)) {
        offline = true;
        noteUnreachable();
        await loadBooks(list, key);
        return;
      }
      error = describe(err);
    }
  }

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError) {
      if (err.kind === 'unreachable' || err.kind === 'timeout') {
        return "The library server can't be reached right now.";
      }
      if (err.kind === 'unauthorized') {
        return 'The server no longer accepts this device. Connect it again on the Library page.';
      }
    }
    return (err as Error).message;
  }

  async function recheckServer(conn: LibraryConnection) {
    if (!(await serverAnswersAgain(conn.serverUrl))) return;
    if (!destroyed && offline && connection === conn) void tryServerAgain();
  }

  async function tryServerAgain() {
    if (!offline || !connection) return;
    if (!(await serverWorthAsking(connection.serverUrl))) return;
    if (destroyed || !offline) return;
    offline = false;
    if (listKey !== null) void loadBooks(shownEntries ?? [], listKey);
  }

  // ---- cards ----------------------------------------------------------------

  $: thumbnailUrl = (book: CatalogBook) =>
    book.thumbnail && api ? api.absolute(book.thumbnail) : '';
  $: progressOf = (book: CatalogBook) =>
    bookProgressLabel(book.id, states.get(book.id), positions.get(book.id) ?? [], book.charCount);
  $: fractionOf = (book: CatalogBook) =>
    bookProgressFraction(
      book.id,
      states.get(book.id),
      positions.get(book.id) ?? [],
      book.charCount
    );

  let blurCtx: CoverBlurContext;
  $: blurCtx = {
    rules: coverRules,
    fallback: coverBlurDefault($libraryCoverBlur$),
    inCollection: collectionMembership({
      rules: coverRules,
      collections: collectionList,
      items: collectionItems,
      states,
      onDevice: (id) => onDevice.has(id),
      audioOnDevice: (id) => audioOnDevice.has(id)
    })
  };
  $: blurredOf = (book: CatalogBook) =>
    !revealed.has(book.id) && isCoverBlurred(states.get(book.id)?.blur, book, blurCtx);

  function reveal(book: CatalogBook) {
    revealed = new Set([...revealed, book.id]);
  }

  function toggle(book: CatalogBook) {
    const next = new Set(selected);
    if (next.has(book.id)) next.delete(book.id);
    else next.add(book.id);
    selected = next;
  }

  function openAddToCollection(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: AddToCollectionDialog,
        props: { bookId: book.id, title: book.title, api: collections, resolver: () => {} }
      }
    ]);
  }

  function openBookState(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: BookStateDialog,
        props: {
          bookId: book.id,
          title: book.title,
          charCount: book.charCount,
          api: bookState,
          collections,
          resolver: () => {}
        }
      }
    ]);
  }

  async function removeFromDevice(book: CatalogBook) {
    try {
      if (!(await removeFromThisDevice(book))) return;
    } catch (err) {
      showMessage('Not removed', (err as Error).message);
      return;
    }
    await refreshOnDevice();
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function open(book: CatalogBook) {
    if (!api || opening) return;
    const controller = new AbortController();
    opening = { book, stage: null, controller };
    try {
      const outcome = await openCatalogBook(
        book,
        api,
        store,
        libraries,
        controller.signal,
        (stage) => {
          if (opening) opening = { ...opening, stage };
        }
      );
      if (outcome.status === 'opened') {
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
      await refreshOnDevice();
    } catch (err) {
      logger.warn(`Recently viewed: opening "${book.title}" failed: ${(err as Error).message}`);
      showMessage('Could not open the book', describe(err));
    } finally {
      opening = null;
    }
  }

  // ---- removing -------------------------------------------------------------

  async function forget(list: CatalogBook[]) {
    if (!list.length) return;
    const confirmed = await confirmDestructive({
      ...forgetViewedCopy(list.length, list[0].title),
      testid: 'viewed-forget-confirm',
      confirmTestid: 'viewed-forget-confirm-button'
    });
    if (!confirmed) return;
    await recentlyViewed.remove(list.map((b) => b.id));
    selected = new Set();
    selectMode = false;
  }

  async function clearAll() {
    const count = $entries?.length ?? 0;
    if (!count) return;
    const confirmed = await confirmDestructive({
      ...clearRecentlyViewedCopy(count),
      testid: 'viewed-clear-confirm',
      confirmTestid: 'viewed-clear-confirm-button'
    });
    if (!confirmed) return;
    await recentlyViewed.clear();
    selected = new Set();
    selectMode = false;
  }

  $: selectedBooks = (books ?? []).filter((b) => selected.has(b.id));
</script>

<svelte:head>
  <title>{formatPageTitle('Recently viewed')}</title>
</svelte:head>

<AppHeader title="Recently viewed" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="viewed-page">
  <CataloguePageHeader jp="閲覧履歴" title="Recently viewed">
    <a
      slot="back"
      class="c-link inline-flex min-h-[2.75rem] items-center"
      href="{pagePath}/home"
      data-testid="back-home"
    >
      ← Home
    </a>
    {#if books?.length}
      <div class="flex flex-wrap items-center gap-2">
        {#if selectMode}
          <button
            class="c-btn c-btn-secondary px-3.5"
            disabled={!selectedBooks.length}
            data-testid="viewed-remove-selected"
            on:click={() => forget(selectedBooks)}
          >
            {selectedBooks.length ? `Remove ${selectedBooks.length}…` : 'Remove…'}
          </button>
        {:else}
          <button
            class="c-btn c-btn-secondary px-3.5"
            data-testid="viewed-clear"
            on:click={clearAll}
          >
            Clear all…
          </button>
        {/if}
        <button
          class="c-btn {selectMode ? 'c-btn-primary' : 'c-btn-secondary'} px-3.5"
          aria-pressed={selectMode}
          data-testid="viewed-select"
          on:click={() => {
            selectMode = !selectMode;
            selected = new Set();
          }}
        >
          {#if selectMode}<Fa icon={faCheck} />Done{:else}Select{/if}
        </button>
      </div>
    {/if}
  </CataloguePageHeader>

  {#if connection === undefined}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if connection === null}
    <p class="c-notice" data-testid="viewed-not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else}
    {#if offline}
      <p
        class="c-notice mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="offline-notice"
      >
        <span role="status">{OFFLINE_NOTICE}</span>
        <button
          class="c-btn c-btn-ghost c-btn-sm -my-1 gap-1.5 px-2.5"
          data-testid="offline-retry"
          on:click={tryServerAgain}><Fa icon={faRotateRight} />Try again</button
        >
      </p>
    {/if}
    {#if !$recentlyViewedOn$}
      <p class="py-6 text-c-muted" data-testid="viewed-off">
        Recently viewed is off. Turn it on in
        <a class="c-link" href="{pagePath}/settings?tab=library"
          >Settings › Library › Recently viewed</a
        >.
      </p>
    {:else if error}
      <div class="flex flex-wrap items-center gap-3 py-4 text-sm" role="alert">
        <span>{error}</span>
        <button
          class="c-btn c-btn-secondary"
          on:click={() => listKey !== null && loadBooks(shownEntries ?? [], listKey)}>Retry</button
        >
      </div>
    {:else if books === null}
      <p class="py-8 text-c-muted">Loading…</p>
    {:else if books.length === 0}
      <p class="py-6 text-c-muted" data-testid="viewed-empty">
        Books whose details you open show up here.
      </p>
    {:else}
      {#each days as day (day.key)}
        <section class="pb-6" data-testid="viewed-day" data-day={day.label}>
          <div class="flex items-center gap-4 pb-3 pt-2">
            <h2 class="shrink-0 font-mincho text-xl font-bold">{day.label}</h2>
            <span class="c-section-rule" />
          </div>
          <ul
            class={gridLayout.classes}
            style={gridLayout.style ? gridLayout.style : undefined}
            data-testid="viewed-books"
          >
            {#each day.items as book (book.id)}
              <LibraryBookCard
                {book}
                thumbnailUrl={thumbnailUrl(book)}
                state={states.get(book.id)}
                progress={progressOf(book)}
                progressFraction={fractionOf(book)}
                blurred={blurredOf(book)}
                onDevice={onDevice.has(book.id)}
                audioOnDevice={audioOnDevice.has(book.id)}
                infoLine={$libraryInfoLine$}
                {selectMode}
                selected={selected.has(book.id)}
                forgettable
                on:open={(ev) => open(ev.detail)}
                on:reveal={(ev) => reveal(ev.detail)}
                on:toggle={(ev) => toggle(ev.detail.book)}
                on:state={(ev) => openBookState(ev.detail)}
                on:collect={(ev) => openAddToCollection(ev.detail)}
                on:remove={(ev) => removeFromDevice(ev.detail)}
                on:forget={(ev) => forget([ev.detail])}
              />
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<AppBottomBar />

{#if opening}
  <LibraryOpenOverlay
    title={opening.book.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}
