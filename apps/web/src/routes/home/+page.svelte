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
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { continueReadingIds } from '$lib/home/continue-reading';
  import {
    isPinnedRow,
    moveRow,
    normalizeRows,
    restoreRow,
    rowHref,
    rowKey,
    rowTitle,
    setRowHidden,
    unpinRow,
    type HomeRow as HomeRowEntry,
    type PinTarget
  } from '$lib/home/rows';
  import UndoNotice from '$lib/components/confirm/undo-notice.svelte';
  import { homeRowLength$, homeRows$ } from '$lib/home/settings';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { existingLocalIds } from '$lib/library/browser-open-deps';
  import { removeFromThisDevice } from '$lib/library/remove-from-device';
  import { isCoverBlurred } from '$lib/library/cover-blur';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import {
    bookProgressFraction,
    bookProgressLabel,
    furthestPosition,
    positionsByBook
  } from '$lib/library/progress';
  import { timeLeftMinMinutes$, timeLeftRecentMinutes$ } from '$lib/data/store';
  import type { StatEntry } from '$lib/stats/aggregate';
  import { formatTimeLeft, secondsLeft, speedEstimate } from '$lib/stats/time-left';
  import { libraryInfoLine$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogBook, CatalogLibrary } from '$lib/library/types';
  import type { BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import { bookStateApi, collectionsApi, libraryViewApi, statsApi } from '$lib/sync/sync-service';
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
  /** Reading statistics for the hero's time left (null until read, or if they can't be). */
  let statEntries: StatEntry[] | null = null;
  let views = new Map<string, HomeRowView>();
  let editing = false;
  let ready = false;
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  $: rows = normalizeRows($homeRows$);
  // A pinned collection deleted (here or on another device) is skipped; Edit names it.
  // The lists are passed in so the rows update when the collections arrive or change.
  $: shownRows = rows.filter(
    (r) => !r.hidden && !collectionGone(r, collectionList, collectionsLoaded)
  );
  $: rowLength = Math.min(200, Math.max(1, Math.floor(Number($homeRowLength$) || 20)));
  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  $: infoLine = $libraryInfoLine$;

  function collectionGone(row: HomeRowEntry, list: Collection[], loaded: boolean): boolean {
    return row.type === 'collection' && loaded && !list.some((c) => c.id === row.ref);
  }

  // Reactive, so row titles follow a rename on any device.
  $: collectionName = (id: string): string | null =>
    collectionList.find((c) => c.id === id)?.name ?? null;

  onMount(async () => {
    await loadMirror();
    void loadStatEntries();
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
  $: fractionOf = (book: CatalogBook) =>
    bookProgressFraction(
      book.id,
      states.get(book.id),
      positions.get(book.id) ?? [],
      book.charCount
    );
  /**
   * The Continue reading hero: how far into the current read (the furthest place, as
   * the cards; 100% included) and the time left at the reader's speed estimate.
   */
  $: heroProgressOf = (book: CatalogBook) => {
    const state = states.get(book.id);
    if (state?.status === 'completed') return null;
    const best = furthestPosition(book.id, state, positions.get(book.id) ?? [], book.charCount);
    if (!best) return null;
    // Characters read: the saved place (the server counts with the reader's code), else
    // the fraction of the book's count.
    const charPos = best.record.data?.charPos;
    const total = book.charCount;
    const chars = total
      ? {
          read: Math.min(
            total,
            typeof charPos === 'number' && charPos >= 0
              ? Math.round(charPos)
              : Math.round(best.fraction * total)
          ),
          total
        }
      : null;
    let timeLeft: string | null = null;
    if (statEntries && chars && best.fraction < 1) {
      const estimate = speedEstimate(
        book.id,
        statEntries,
        Math.max(1, Number($timeLeftRecentMinutes$) || 60) * 60,
        Math.max(0, Number($timeLeftMinMinutes$) || 0) * 60
      );
      const seconds = secondsLeft(chars.total - chars.read, estimate);
      timeLeft = seconds === null ? null : formatTimeLeft(seconds);
    }
    return { fraction: best.fraction, chars, timeLeft };
  };

  /** Statistics never block Home: without them the hero has no time left. */
  async function loadStatEntries() {
    try {
      statEntries = await statsApi().allEntries();
    } catch (error) {
      logger.warn(
        `Home: could not read statistics for time left: ${(error as Error)?.message ?? error}`
      );
    }
  }

  $: blurredOf = (book: CatalogBook) =>
    !revealed.has(book.id) && isCoverBlurred(states.get(book.id)?.blur, book.tags, tagRules);

  function reveal(book: CatalogBook) {
    revealed = new Set([...revealed, book.id]);
  }

  /** WP19b: "Add to collection…" from a book's ⋮ menu. */
  function openAddToCollection(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: AddToCollectionDialog,
        disableCloseOnClick: true,
        props: { bookId: book.id, title: book.title, api: collections, resolver: () => {} }
      }
    ]);
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

  /** WP15e: Remove from this device (a book's ⋮ menu). */
  async function removeFromDevice(book: CatalogBook) {
    try {
      if (!(await removeFromThisDevice(book))) return;
    } catch (error) {
      showMessage('Not removed', (error as Error).message);
      return;
    }
    await refreshOnDevice();
    // An "On this device" row needs the new list on the server first.
    await view.sendPendingChanges(timeoutSeconds);
    if (api && ready && !destroyed) await loadAllRows(true);
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

  /** WP19: the last removed row, for Undo (until dismissed, the next removal or Done). */
  let removedRow: { row: HomeRowEntry; index: number; name: string } | null = null;

  function removeRow(row: PinTarget & { hidden: boolean }, index: number) {
    removedRow = { row, index, name: rowTitle(row, collectionName) };
    save(unpinRow(rows, row));
  }

  function undoRemoveRow() {
    if (removedRow) save(restoreRow(rows, removedRow.row, removedRow.index));
    removedRow = null;
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
  <CataloguePageHeader jp="ホーム" title="Home">
    <div class="flex items-center gap-2">
      <a
        class="c-btn c-btn-secondary w-12 px-0"
        href="{pagePath}/library?search=1"
        title="Search the library"
        data-testid="home-search"
      >
        <Fa icon={faMagnifyingGlass} />
        <span class="sr-only">Search the library</span>
      </a>
      <button
        class="c-btn c-btn-secondary"
        aria-pressed={editing}
        data-testid="home-edit"
        on:click={() => {
          editing = !editing;
          removedRow = null;
          if (!editing && api && ready) void loadAllRows(true);
        }}
      >
        {editing ? 'Done' : 'Edit'}
      </button>
    </div>
  </CataloguePageHeader>

  {#if connection === undefined}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if connection === null}
    <p class="c-notice" data-testid="home-not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}

  {#if editing}
    <section class="pt-3" data-testid="home-edit-list">
      <p class="pb-3 text-sm text-c-muted">
        Pin more rows with "Pin to Home" on a collection (Collections page) or on a series, author
        or tag (Library). Rows are kept on this device only.
      </p>
      {#if removedRow}
        <div class="c-notice mb-3">
          <UndoNotice
            message={`Removed “${removedRow.name}” from Home.`}
            buttonClass="c-btn c-btn-secondary px-3"
            testid="home-row-undo-notice"
            undoTestid="home-row-undo"
            on:undo={undoRemoveRow}
            on:dismiss={() => (removedRow = null)}
          />
        </div>
      {/if}
      <ul class="flex flex-col gap-2">
        {#each rows as row, i (rowKey(row))}
          <li
            class="c-edit-row flex flex-wrap items-center gap-2 rounded p-2"
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
              class="c-btn c-btn-secondary w-12 px-0"
              aria-label="Move up"
              disabled={i === 0}
              on:click={() => save(moveRow(rows, i, -1))}
            >
              ↑
            </button>
            <button
              class="c-btn c-btn-secondary w-12 px-0"
              aria-label="Move down"
              disabled={i === rows.length - 1}
              on:click={() => save(moveRow(rows, i, 1))}
            >
              ↓
            </button>
            <button
              class="c-btn c-btn-secondary px-3"
              data-testid="home-row-toggle"
              on:click={() => showRow(i, !row.hidden)}
            >
              {row.hidden ? 'Show' : 'Hide'}
            </button>
            {#if isPinnedRow(row)}
              <button
                class="c-btn c-btn-secondary px-3"
                data-testid="home-row-remove"
                on:click={() => removeRow(row, i)}
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
          class="c-input w-24"
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
          {fractionOf}
          {heroProgressOf}
          {blurredOf}
          hero={row.type === 'continue'}
          {onDevice}
          {infoLine}
          on:open={(ev) => open(ev.detail)}
          on:reveal={(ev) => reveal(ev.detail)}
          on:state={(ev) => openBookState(ev.detail)}
          on:collect={(ev) => openAddToCollection(ev.detail)}
          on:remove={(ev) => removeFromDevice(ev.detail)}
          on:retry={() => loadRow(row)}
          on:openLocal={(ev) => goto(`${pagePath}/b?id=${ev.detail}`)}
        />
      {:else}
        <p class="py-6 text-c-muted">Every row is hidden. Use "Edit" to show some.</p>
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

<style>
  .c-edit-row {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line-strong);
  }
</style>
