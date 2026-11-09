<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
  import LibraryBookRow from '$lib/components/library/library-book-row.svelte';
  import LibraryConnect from '$lib/components/library/library-connect.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import LibrarySyncStatus from '$lib/components/library/library-sync-status.svelte';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import MergedHeaderIcon from '$lib/components/merged-header-icon/merged-header-icon.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { baseHeaderClasses, buttonClasses, inputClasses, pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { database, selfHostStorageSource$ } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { browserOpenDeps, existingLocalIds } from '$lib/library/browser-open-deps';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import {
    openCalibreBook,
    type ExistingBookQuestion,
    type OpenStage
  } from '$lib/library/open-calibre-book';
  import { libraryFilter$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogBook, CatalogLibrary } from '$lib/library/types';
  import { notifySyncConnectionChanged } from '$lib/sync/sync-service';
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import { onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';

  /**
   * Library (WP6, minimal): browse and search the Calibre catalog and open a
   * book through the existing import pipeline. State lives in the URL
   * (?q=&lib=) so going back from the reader restores the search.
   */

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let connectNotice = '';
  let suggestedServerUrl = '';
  let api: LibraryApi | undefined;

  let libraries: CatalogLibrary[] = [];
  let indexerError = '';
  let books: CatalogBook[] = [];
  let nextCursor: string | null = null;
  let loading = false;
  let loadError = '';
  let onDevice = new Set<string>();

  let queryInput = '';
  let appliedQuery = '';
  let appliedLibrary = '';
  let listController: AbortController | undefined;

  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  // A changed timeout setting applies to the next request.
  $: if (connection && api && api.timeoutSeconds !== timeoutSeconds) api = makeApi(connection);
  $: libraryNames = new Map(libraries.map((l) => [l.id, l.name]));
  $: enabledLibraries = libraries.filter((l) => l.enabled);

  onMount(async () => {
    suggestedServerUrl = await selfHostServerUrl();
    connection = (await store.getConnection()) ?? null;
    if (connection) await startSession(connection);
  });

  onDestroy(() => {
    listController?.abort();
    opening?.controller.abort();
  });

  afterNavigate(() => {
    if (connection && api) void readUrlAndLoad();
  });

  /** The self-hosted sync server's address, as a starting point for the connect form. */
  async function selfHostServerUrl(): Promise<string> {
    try {
      const name = selfHostStorageSource$.getValue();
      if (!name) return '';
      const db = await database.db;
      const source = await db.get('storageSource', name);
      const data = source?.data as { clientId?: unknown } | undefined;
      return typeof data?.clientId === 'string' ? data.clientId.replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  }

  function makeApi(conn: LibraryConnection) {
    return new LibraryApi(conn.serverUrl, conn.token, timeoutSeconds);
  }

  async function startSession(conn: LibraryConnection) {
    api = makeApi(conn);
    await refreshOnDevice();
    try {
      const result = await api.libraries();
      libraries = result.libraries;
      indexerError = result.indexer.enabled ? '' : result.indexer.error || 'The indexer is off';
    } catch (error) {
      if (handleAuthError(error)) return;
      // The list request below reports the problem.
    }
    await readUrlAndLoad();
  }

  async function refreshOnDevice() {
    try {
      const [links, ids] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      onDevice = new Set(links.filter((l) => ids.has(l.localId)).map((l) => l.bookId));
    } catch (error) {
      logger.warn(`Library: could not read local links: ${(error as Error).message}`);
    }
  }

  function readUrlAndLoad() {
    const params = $page.url.searchParams;
    appliedQuery = params.get('q') ?? '';
    appliedLibrary = params.has('lib') ? (params.get('lib') ?? '') : $libraryFilter$;
    queryInput = appliedQuery;
    return loadPage(true);
  }

  async function loadPage(reset: boolean) {
    if (!api) return;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    loading = true;
    loadError = '';
    try {
      const result = await api.books(
        {
          q: appliedQuery || undefined,
          library: appliedLibrary || undefined,
          cursor: reset ? undefined : (nextCursor ?? undefined)
        },
        { signal: controller.signal }
      );
      books = reset ? result.books : [...books, ...result.books];
      nextCursor = result.nextCursor;
    } catch (error) {
      if (error instanceof LibraryApiError && error.kind === 'aborted') return;
      if (handleAuthError(error)) return;
      loadError = describe(error);
      if (reset) {
        books = [];
        nextCursor = null;
      }
    } finally {
      if (listController === controller) loading = false;
    }
  }

  function describe(error: unknown): string {
    if (error instanceof LibraryApiError) {
      if (error.kind === 'unreachable' || error.kind === 'timeout') {
        return 'The library server cannot be reached (offline, or the server is down). Books already on this device open from the Manager.';
      }
      if (error.code === 'indexer_off')
        return 'The Calibre library is not available on the server.';
    }
    return (error as Error).message;
  }

  /** A revoked or unknown token: back to the connect form. */
  function handleAuthError(error: unknown): boolean {
    if (error instanceof LibraryApiError && error.kind === 'unauthorized') {
      connectNotice = 'The server no longer accepts this device. Connect it again.';
      suggestedServerUrl = connection?.serverUrl || suggestedServerUrl;
      connection = null;
      api = undefined;
      return true;
    }
    return false;
  }

  async function onConnected(conn: LibraryConnection) {
    await store.setConnection(conn);
    connection = conn;
    connectNotice = '';
    notifySyncConnectionChanged();
    await startSession(conn);
  }

  async function disconnect() {
    await store.clearConnection();
    notifySyncConnectionChanged();
    suggestedServerUrl = connection?.serverUrl || suggestedServerUrl;
    connection = null;
    api = undefined;
    books = [];
  }

  function search() {
    navigate(queryInput.trim(), appliedLibrary);
  }

  function pickLibrary(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    $libraryFilter$ = value;
    navigate(appliedQuery, value);
  }

  function navigate(q: string, lib: string) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (lib) params.set('lib', lib);
    const qs = params.toString();
    goto(`${pagePath}/library${qs ? `?${qs}` : ''}`, { keepFocus: true, noScroll: true });
  }

  function askExisting(question: ExistingBookQuestion): Promise<boolean> {
    return new Promise((resolve) => {
      dialogManager.dialogs$.next([
        {
          component: ConfirmDialog,
          disableCloseOnClick: true,
          props: {
            dialogHeader: 'Already on this device',
            dialogMessage:
              `You already have "${question.title}" on this device ` +
              `(${question.localCharacters.toLocaleString()} characters). The Calibre copy has ` +
              `${question.calibreCharacters.toLocaleString()} characters, so it may be a different ` +
              'edition. Confirm opens your copy and remembers it as this Calibre book; your copy ' +
              'and its progress are not changed.',
            resolver: (canceled: boolean) => resolve(!canceled)
          }
        }
      ]);
    });
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function open(book: CatalogBook) {
    if (!api || opening) return;
    const controller = new AbortController();
    opening = { book, stage: null, controller };
    try {
      const deps = browserOpenDeps(
        api,
        store,
        async (libraryId) => libraries.find((l) => l.id === libraryId)?.calibreLibraryUuid ?? null,
        askExisting
      );
      const outcome = await openCalibreBook(book, deps, controller.signal, (stage) => {
        if (opening) opening = { ...opening, stage };
      });
      if (outcome.status === 'opened') {
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
      await refreshOnDevice();
    } catch (error) {
      if (handleAuthError(error)) return;
      logger.warn(`Library: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage('Could not open the book', describe(error));
    } finally {
      opening = null;
    }
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Library')}</title>
</svelte:head>

<div class="elevation-4 fixed inset-x-0 top-0 z-10">
  <div class={baseHeaderClasses}>
    <div class="{pxScreen} flex h-full items-center justify-between">
      <h1 class="text-lg font-medium">Library</h1>
      <MergedHeaderIcon items={[mergeEntries.MANAGE, mergeEntries.LIBRARY]} />
    </div>
  </div>
</div>

<div class="{pxScreen} pb-16 pt-16 xl:pt-14">
  {#if connection === undefined}
    <p class="py-8">Loading…</p>
  {:else if connection === null}
    <LibraryConnect
      serverUrl={suggestedServerUrl}
      notice={connectNotice}
      {timeoutSeconds}
      on:connected={(ev) => onConnected(ev.detail)}
    />
  {:else}
    <form class="flex items-end gap-3 py-3" on:submit|preventDefault={search}>
      <label class="grow">
        <span class="sr-only">Search title, author or series</span>
        <input
          class={inputClasses}
          type="search"
          enterkeyhint="search"
          placeholder="Title, author or series"
          bind:value={queryInput}
        />
      </label>
      <button
        class="flex h-10 items-center rounded border border-current px-5"
        type="submit"
        title="Search"
      >
        <Fa icon={faMagnifyingGlass} />
      </button>
    </form>
    {#if enabledLibraries.length > 1}
      <label class="mb-2 block text-sm">
        Library
        <select class="ml-2 bg-transparent" value={appliedLibrary} on:change={pickLibrary}>
          <option value="">All libraries</option>
          {#each enabledLibraries as lib (lib.id)}
            <option value={lib.id}>{lib.name}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if indexerError}
      <p class="py-2 font-medium">{indexerError}</p>
    {/if}
    {#if loadError}
      <p class="py-4 font-medium" role="alert">
        {loadError}
        <a class="underline" href="{pagePath}/manage">Go to the Manager</a>
      </p>
    {/if}

    {#if books.length}
      <ul>
        {#each books as book (book.id)}
          <LibraryBookRow
            {book}
            thumbnailUrl={book.thumbnail && api ? api.absolute(book.thumbnail) : ''}
            onDevice={onDevice.has(book.id)}
            libraryName={enabledLibraries.length > 1
              ? (libraryNames.get(book.libraryId) ?? '')
              : ''}
            on:open={(ev) => open(ev.detail)}
          />
        {/each}
      </ul>
    {:else if !loading && !loadError}
      <p class="py-8">{appliedQuery ? `No books match "${appliedQuery}".` : 'No books yet.'}</p>
    {/if}

    {#if loading}
      <p class="py-4">Loading…</p>
    {:else if nextCursor}
      <div class="flex justify-center py-6">
        <button class="{buttonClasses} border border-current" on:click={() => loadPage(false)}>
          Load more
        </button>
      </div>
    {/if}

    <details class="mt-10 text-sm">
      <summary class="cursor-pointer">Connection</summary>
      <div class="py-3">
        <p>Server: {connection.serverUrl}</p>
        <p>This device: {connection.label}</p>
        <label class="mt-3 block max-w-xs">
          Request timeout (seconds, 0 = none)
          <input
            class={inputClasses}
            type="number"
            min="0"
            step="1"
            bind:value={$libraryRequestTimeoutSeconds$}
          />
        </label>
        <LibrarySyncStatus />
        <p class="mt-6">
          Disconnecting forgets the token on this device. To block it on the server too, run
          <code>token revoke</code> there.
        </p>
        <button class="{buttonClasses} mt-2 border border-current" on:click={disconnect}>
          Disconnect
        </button>
      </div>
    </details>
  {/if}
</div>

{#if opening}
  <LibraryOpenOverlay
    title={opening.book.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}
