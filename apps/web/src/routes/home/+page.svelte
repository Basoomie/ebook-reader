<script lang="ts">
  /**
   * Home (WP7b, decided with the user): per-device rows. Continue Reading first by
   * default (from the local mirror, furthest place on any device), then anything
   * pinned (collections, built-in lists, series, authors, tags) and, if switched on,
   * Recently added. "Edit" reorders, hides and removes rows. E-ink plain.
   */
  import { goto } from '$app/navigation';
  import { builtinCollection } from '$lib/collections/builtins';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import HomeRow, { type HomeRowView } from '$lib/components/home/home-row.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { inputClasses, pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { continueReadingIds } from '$lib/home/continue-reading';
  import {
    isPinnedRow,
    moveRow,
    normalizeRows,
    rowHref,
    rowKey,
    rowTitle,
    setRowHidden,
    unpinRow,
    type HomeRow as HomeRowEntry
  } from '$lib/home/rows';
  import { homeRowLength$, homeRows$ } from '$lib/home/settings';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { existingLocalIds } from '$lib/library/browser-open-deps';
  import { isCoverBlurred } from '$lib/library/cover-blur';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import { bookProgressLabel, positionsByBook } from '$lib/library/progress';
  import { libraryInfoLine$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogBook, CatalogLibrary } from '$lib/library/types';
  import type { BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import { bookStateApi, collectionsApi, libraryViewApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  const store = getLibraryStore();
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let libraries: CatalogLibrary[] = [];
  let states = new Map<string, BookState>();
  let tagRules = new Set<string>();
  let positions = new Map<string, LocalRecord[]>();
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
  let collectionsLoaded = false;
  let onDevice = new Set<string>();
  let revealed = new Set<string>();
  let views = new Map<string, HomeRowView>();
  let editing = false;
  let ready = false;
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  $: rows = normalizeRows($homeRows$);
  $: shownRows = rows.filter((r) => !r.hidden && !(r.type === 'collection' && collectionGone(r)));
  $: rowLength = Math.min(200, Math.max(1, Math.floor(Number($homeRowLength$) || 20)));
  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  $: infoLine = $libraryInfoLine$;

  function collectionGone(row: HomeRowEntry): boolean {
    return (
      row.type === 'collection' &&
      collectionsLoaded &&
      !collectionList.some((c) => c.id === row.ref)
    );
  }

  function collectionName(id: string): string | null {
    return collectionList.find((c) => c.id === id)?.name ?? null;
  }

  onMount(async () => {
    await loadMirror();
    void view.syncSoon();
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
    try {
      libraries = (await api.libraries()).libraries;
    } catch {
      // Each row reports the problem.
    }
    // The server only knows state changes that reached it (built-in lists filter by them).
    await view.sendPendingChanges(timeoutSeconds);
    ready = true;
  });

  // Rows load when first shown (also a row pinned, shown or added while here).
  $: if (ready && api) {
    for (const row of shownRows) if (!views.has(rowKey(row))) void loadRow(row);
  }

  onDestroy(() => {
    destroyed = true;
    clearTimeout(mirrorTimer);
    stopListeners.forEach((off) => off());
    opening?.controller.abort();
  });

  async function loadMirror() {
    const [s, rules, records, coll] = await Promise.all([
      bookState.getAll().catch(() => new Map<string, BookState>()),
      view.tagBlurRules(),
      view.positions(),
      collections.view()
    ]);
    states = s;
    tagRules = rules;
    positions = positionsByBook(records);
    collectionList = coll.collections;
    collectionItems = coll.items;
    collectionsLoaded = true;
  }

  /** Reading on another device, a status change or a list change: settle, then refresh. */
  function onMirrorChanged() {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async () => {
      if (destroyed) return;
      await loadMirror();
      if (api && ready) await loadAllRows(true);
    }, 300);
  }

  async function refreshOnDevice() {
    try {
      const [links, ids] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      onDevice = new Set(links.filter((l) => ids.has(l.localId)).map((l) => l.bookId));
    } catch (error) {
      logger.warn(`Home: could not read local links: ${(error as Error).message}`);
    }
  }

  function setView(key: string, v: HomeRowView) {
    views = new Map(views).set(key, v);
  }

  /** Reloads the shown rows, keeping what they show until the new books arrive. */
  async function loadAllRows(quiet = false) {
    await Promise.all(shownRows.map((r) => loadRow(r, quiet)));
  }

  function describe(error: unknown): string {
    if (error instanceof LibraryApiError) {
      if (error.kind === 'unreachable' || error.kind === 'timeout') {
        return "The library server can't be reached right now.";
      }
      if (error.kind === 'unauthorized') {
        return 'The server no longer accepts this device. Connect it again on the Library page.';
      }
    }
    return (error as Error).message;
  }

  async function loadRow(row: HomeRowEntry, quiet = false) {
    const key = rowKey(row);
    if (!api) return;
    if (!quiet || !views.has(key)) setView(key, { status: 'loading' });
    try {
      const books = await fetchRow(row, api);
      if (destroyed) return;
      setView(key, { status: 'ok', books });
    } catch (error) {
      if (destroyed) return;
      const message = describe(error);
      if (row.type === 'continue') {
        setView(key, { status: 'offline', message, local: await localContinue() });
      } else {
        setView(key, { status: 'error', message });
      }
    }
  }

  async function fetchRow(row: HomeRowEntry, a: LibraryApi): Promise<CatalogBook[]> {
    switch (row.type) {
      case 'continue': {
        const ids = continueReadingIds(states, positions, rowLength);
        return ids.length ? (await a.lookup(ids)).books : [];
      }
      case 'recent':
        return (await a.books({ limit: rowLength })).books;
      case 'builtin': {
        const b = builtinCollection(row.ref);
        return b ? (await a.books({ scope: b.query, limit: rowLength })).books : [];
      }
      case 'collection': {
        const c = collectionList.find((x) => x.id === row.ref);
        if (!c) return [];
        if (c.type === 'manual') {
          const ids = (collectionItems.get(c.id) ?? []).slice(0, rowLength).map((i) => i.bookId);
          return ids.length ? (await a.lookup(ids)).books : [];
        }
        return c.query ? (await a.books({ scope: c.query, limit: rowLength })).books : [];
      }
      default:
        return (await a.books({ group: { by: row.type, name: row.ref }, limit: rowLength })).books;
    }
  }

  /** Continue Reading without the server: its books that are on this device, by title. */
  async function localContinue() {
    try {
      const ids = continueReadingIds(states, positions, rowLength);
      const [links, existing] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      const byBook = new Map(
        links.filter((l) => existing.has(l.localId)).map((l) => [l.bookId, l])
      );
      return ids
        .map((id) => byBook.get(id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ bookId: l.bookId, title: l.calibreTitle || l.title, localId: l.localId }));
    } catch {
      return [];
    }
  }

  // ---- cards ----------------------------------------------------------------

  $: thumbnailUrl = (book: CatalogBook) =>
    book.thumbnail && api ? api.absolute(book.thumbnail) : '';
  $: stateOf = (book: CatalogBook) => states.get(book.id);
  $: progressOf = (book: CatalogBook) =>
    bookProgressLabel(book.id, states.get(book.id), positions.get(book.id) ?? [], book.charCount);
  $: blurredOf = (book: CatalogBook) =>
    !revealed.has(book.id) && isCoverBlurred(states.get(book.id)?.blur, book.tags, tagRules);

  function reveal(book: CatalogBook) {
    revealed = new Set([...revealed, book.id]);
  }

  function openBookState(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: BookStateDialog,
        disableCloseOnClick: true,
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
    } catch (error) {
      logger.warn(`Home: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage('Could not open the book', describe(error));
    } finally {
      opening = null;
    }
  }

  // ---- editing ----------------------------------------------------------------

  function save(next: HomeRowEntry[]) {
    $homeRows$ = next;
  }

  function showRow(index: number, hidden: boolean) {
    save(setRowHidden(rows, index, hidden));
  }

  function emptyTextFor(row: HomeRowEntry): string {
    if (row.type === 'continue') return 'Nothing in progress. Open a book from the Library.';
    return 'No books here yet.';
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Home')}</title>
</svelte:head>

<AppHeader title="Home" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="home-page">
  <div class="flex items-center justify-end gap-2 pt-3">
    <button
      class="min-h-[3rem] rounded border-2 px-4 font-medium {editing
        ? 'border-gray-800 bg-gray-800 text-white'
        : 'border-current'}"
      aria-pressed={editing}
      data-testid="home-edit"
      on:click={() => {
        editing = !editing;
        if (!editing && api && ready) void loadAllRows(true);
      }}
    >
      {editing ? 'Done' : 'Edit'}
    </button>
  </div>

  {#if connection === undefined}
    <p class="py-8">Loading…</p>
  {:else if connection === null}
    <p class="py-6" data-testid="home-not-connected">
      This device isn't connected to the library server yet.
      <a class="underline" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}

  {#if editing}
    <section class="pt-3" data-testid="home-edit-list">
      <p class="pb-3 text-sm">
        Pin more rows with "Pin to Home" on a collection (Collections page) or on a series, author
        or tag (Library). Rows are kept on this device only.
      </p>
      <ul class="flex flex-col gap-2">
        {#each rows as row, i (rowKey(row))}
          <li
            class="flex flex-wrap items-center gap-2 border-2 border-gray-800 p-2"
            data-testid="home-edit-row"
          >
            <span class="min-w-0 grow font-medium">
              {rowTitle(row, collectionName)}
              {#if row.hidden}<span class="text-sm font-normal"> (hidden)</span>{/if}
              {#if row.type === 'author' || row.type === 'series' || row.type === 'tag'}
                <span class="text-sm font-normal"> · {row.type}</span>
              {/if}
            </span>
            <button
              class="min-h-[3rem] min-w-[3rem] rounded border-2 border-current disabled:opacity-40"
              aria-label="Move up"
              disabled={i === 0}
              on:click={() => save(moveRow(rows, i, -1))}
            >
              ↑
            </button>
            <button
              class="min-h-[3rem] min-w-[3rem] rounded border-2 border-current disabled:opacity-40"
              aria-label="Move down"
              disabled={i === rows.length - 1}
              on:click={() => save(moveRow(rows, i, 1))}
            >
              ↓
            </button>
            <button
              class="min-h-[3rem] rounded border-2 border-current px-3"
              data-testid="home-row-toggle"
              on:click={() => showRow(i, !row.hidden)}
            >
              {row.hidden ? 'Show' : 'Hide'}
            </button>
            {#if isPinnedRow(row)}
              <button
                class="min-h-[3rem] rounded border-2 border-current px-3"
                data-testid="home-row-remove"
                on:click={() => save(unpinRow(rows, row))}
              >
                Remove
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      <label class="flex items-center gap-3 pt-4">
        Books per row
        <input
          class="{inputClasses.replace(/\s*\btransition\b/, '')} w-24"
          type="number"
          min="1"
          max="200"
          step="1"
          data-testid="home-row-length"
          bind:value={$homeRowLength$}
          on:blur={() => {
            if (!(Number($homeRowLength$) >= 1)) $homeRowLength$ = 20;
          }}
        />
      </label>
    </section>
  {:else if connection}
    <div class="pt-2">
      {#each shownRows as row (rowKey(row))}
        <HomeRow
          title={rowTitle(row, collectionName)}
          href={rowHref(row, pagePath)}
          view={views.get(rowKey(row)) ?? { status: 'loading' }}
          emptyText={emptyTextFor(row)}
          {thumbnailUrl}
          {stateOf}
          {progressOf}
          {blurredOf}
          {onDevice}
          {infoLine}
          on:open={(ev) => open(ev.detail)}
          on:reveal={(ev) => reveal(ev.detail)}
          on:state={(ev) => openBookState(ev.detail)}
          on:retry={() => loadRow(row)}
          on:openLocal={(ev) => goto(`${pagePath}/b?id=${ev.detail}`)}
        />
      {:else}
        <p class="py-6">Every row is hidden. Use "Edit" to show some.</p>
      {/each}
    </div>
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
