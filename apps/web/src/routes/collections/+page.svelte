<script lang="ts">
  import { BUILTIN_COLLECTIONS } from '$lib/collections/builtins';
  import { builtinMenu, collectionMenu, newCollection } from '$lib/collections/collection-dialogs';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import CollectionCard from '$lib/components/collections/collection-card.svelte';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { isCoverBlurred } from '$lib/library/cover-blur';
  import { plural } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import {
    askServerFirst,
    freshOfflineCatalog,
    noteReachable,
    noteUnreachable,
    offlineCatalog,
    OFFLINE_NOTICE,
    refreshOfflineCopies,
    serverAnswersAgain,
    startsOffline
  } from '$lib/library/offline/offline-source';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import LibraryDisplayMenu from '$lib/components/library/library-display-menu.svelte';
  import { coverGrid } from '$lib/library/cover-size';
  import {
    libraryCoverSize$,
    libraryRequestTimeoutSeconds$,
    libraryView$
  } from '$lib/library/settings';
  import type { CollectionCardData } from '$lib/library/types';
  import type { BookState } from '$lib/sync/book-state';
  import { bookStateApi, collectionsApi, libraryViewApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  /**
   * Collections (WP8b, decisions.md "Library UI"): the built-ins (Reading, Completed,
   * Dropped, Unread, Favorites) and your own lists and saved searches, each with a 2x2
   * cover collage. Names and list counts come from the local mirror (shown at once,
   * offline too); covers and the other counts come from the server. Plain for e-ink: no
   * animations, 48 px bordered controls, everything on one page.
   */

  const store = getLibraryStore();
  const collections = collectionsApi();
  const bookState = bookStateApi();
  const view = libraryViewApi();

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let mine: Collection[] = [];
  let items = new Map<string, CollectionItem[]>();
  let cards = new Map<string, CollectionCardData>();
  let cardsLoading = false;
  let cardsError = '';
  /** Season 2 §2: the server can't be reached; the cards count this device's books. */
  let offline = false;
  let staleNote = false;
  let states = new Map<string, BookState>();
  let tagRules = new Set<string>();
  let revealed = new Set<string>();
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cardsRequest = 0;

  $: grid = $libraryView$ !== 'list';
  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);

  onMount(async () => {
    // Offline, this visit reads this device's books once.
    freshOfflineCatalog();
    void view.syncSoon();
    await loadMirror();
    for (const sub of [
      collections.onChanged(() => schedule()),
      bookState.onChanged(() => schedule()),
      view.onChanged(() => schedule())
    ]) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    connection = (await store.getConnection()) ?? null;
    if (connection) {
      api = new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds);
      // No network, or the server didn't answer a moment ago (another page): this device's
      // books at once, and the server is asked again in the background.
      offline = startsOffline();
      if (offline) void recheckServer(connection);
      window.addEventListener('online', tryServerAgain);
      await loadCards();
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (typeof window !== 'undefined') window.removeEventListener('online', tryServerAgain);
    clearTimeout(timer);
    stopListeners.forEach((off) => off());
  });

  /** Changes come in bursts (a sync, a deleted collection): settle first. */
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (destroyed) return;
      await loadMirror();
      await loadCards();
    }, 300);
  }

  async function loadMirror() {
    const [v, s, rules] = await Promise.all([
      collections.view(),
      bookState.getAll().catch(() => new Map<string, BookState>()),
      view.tagBlurRules()
    ]);
    mine = v.collections;
    items = v.items;
    states = s;
    tagRules = rules;
  }

  async function loadCards() {
    if (!api) return;
    const request = ++cardsRequest;
    cardsLoading = true;
    const asked = offline;
    const server = api;
    const serverUrl = connection?.serverUrl ?? server.serverUrl;
    try {
      let result: { cards: CollectionCardData[] };
      if (asked) {
        // The offline Library: this device's books, from its own records.
        staleNote = false;
        result = await offlineCatalog().collectionCards();
      } else {
        // With the quick server check beside it: no answer in its time means offline.
        const first = await askServerFirst(serverUrl, async (signal) => {
          // Counts and covers of built-ins and saved searches use your book state on the
          // server.
          const stale = await view.sendPendingChanges(timeoutSeconds);
          const answer = await server.collectionCards({ signal });
          return { stale, answer };
        });
        if (request !== cardsRequest) return;
        if (first.status === 'unreachable') {
          offline = true;
          noteUnreachable();
          cardsLoading = false;
          void loadCards();
          return;
        }
        if (first.status === 'error') throw first.error;
        staleNote = first.value.stale;
        result = first.value.answer;
      }
      if (request !== cardsRequest) return;
      cards = new Map(result.cards.map((c) => [c.id, c]));
      cardsError = '';
      if (!asked) {
        noteReachable();
        void refreshOfflineCopies(server);
      }
    } catch (error) {
      if (request !== cardsRequest) return;
      cardsError = `Covers and counts could not be loaded: ${(error as Error).message}`;
    } finally {
      if (request === cardsRequest) cardsLoading = false;
    }
  }

  /** "Try again", or the browser is online again: ask the server. */
  function tryServerAgain() {
    if (!offline) return;
    offline = false;
    noteReachable();
    void loadCards();
  }

  /** Offline: when the server answers the quick check again, ask it. */
  async function recheckServer(conn: LibraryConnection) {
    if (!(await serverAnswersAgain(conn.serverUrl))) return;
    if (!destroyed && offline && connection === conn) tryServerAgain();
  }

  function tilesOf(
    id: string,
    data: Map<string, CollectionCardData>,
    s: Map<string, BookState>,
    rules: Set<string>,
    shown: Set<string>
  ) {
    const card = data.get(id);
    if (!card || !api) return [];
    const open = shown.has(id);
    return card.tiles.map((t) => ({
      src: t.thumbnail && api ? api.absolute(t.thumbnail) : '',
      blurred: !open && isCoverBlurred(s.get(t.bookId)?.blur, t.tags, rules)
    }));
  }

  function countLine(id: string, data: Map<string, CollectionCardData>, list?: CollectionItem[]) {
    const card = data.get(id);
    if (card?.error) {
      return card.error.code === 'regex_timeout'
        ? 'The search took too long'
        : "The search doesn't work any more";
    }
    if (card) return plural(card.bookCount, 'book', 'books');
    if (list) return plural(list.length, 'book', 'books');
    return cardsLoading ? 'Counting…' : '';
  }

  function hrefFor(id: string) {
    return `${pagePath}/library?collection=${encodeURIComponent(id)}`;
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function create() {
    const id = await newCollection(collections);
    if (id) await loadMirror();
  }

  async function menu(id: string) {
    const c = mine.find((x) => x.id === id);
    if (!c) return;
    try {
      await collectionMenu(collections, c);
    } catch (error) {
      showMessage('Not saved', (error as Error).message);
    }
    await loadMirror();
  }

  function reveal(id: string) {
    revealed = new Set([...revealed, id]);
  }

  // WP19a: the cover size of the Display menu (shared with the Library).
  $: gridLayout = coverGrid($libraryCoverSize$);
  $: listClass = grid ? gridLayout.classes : '';
  $: listStyle = grid && gridLayout.style ? gridLayout.style : undefined;
</script>

<svelte:head>
  <title>{formatPageTitle('Collections')}</title>
</svelte:head>

<AppHeader title="Collections" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="collections-page">
  <CataloguePageHeader jp="書架" title="Collections">
    <span slot="meta" class="text-sm text-c-muted" data-testid="collections-count">
      {plural(BUILTIN_COLLECTIONS.length + mine.length, 'collection', 'collections')}
    </span>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <LibraryDisplayMenu details={false} autoLoad={false} />
      <button class="c-btn c-btn-primary" data-testid="new-collection-page" on:click={create}>
        New collection
      </button>
    </div>
  </CataloguePageHeader>

  {#if connection === null}
    <p class="c-notice" data-testid="not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}
  {#if offline && connection}
    <p class="c-notice flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="offline-notice">
      <span role="status">{OFFLINE_NOTICE}</span>
      <button
        class="c-btn c-btn-secondary px-3"
        data-testid="offline-retry"
        on:click={tryServerAgain}>Try again</button
      >
    </p>
  {/if}
  {#if cardsError}
    <p class="c-notice" role="alert" data-testid="cards-error">{cardsError}</p>
  {/if}
  {#if staleNote}
    <p class="c-notice" data-testid="stale-note">
      Some of your recent changes haven't reached the server yet; the counts may be out of date.
    </p>
  {/if}

  <div class="flex items-center gap-4 pb-4 pt-4">
    <h2 class="flex items-baseline gap-3 font-mincho text-2xl font-bold">
      Built-in <span class="c-jp-label text-xs" aria-hidden="true">既定</span>
    </h2>
    <span class="c-section-rule" />
  </div>
  <ul class={listClass} style={listStyle} data-testid="builtin-collections">
    {#each BUILTIN_COLLECTIONS as b (b.id)}
      <CollectionCard
        id={b.id}
        name={b.name}
        href={hrefFor(b.id)}
        details={[countLine(b.id, cards)].filter(Boolean)}
        tiles={tilesOf(b.id, cards, states, tagRules, revealed)}
        layout={grid ? 'grid' : 'list'}
        menu
        on:reveal={(ev) => reveal(ev.detail)}
        on:menu={() => builtinMenu(b)}
      />
    {/each}
  </ul>

  <div class="flex items-center gap-4 pb-4 pt-10">
    <h2 class="flex items-baseline gap-3 font-mincho text-2xl font-bold">
      Your collections <span class="c-jp-label text-xs" aria-hidden="true">自分の書架</span>
    </h2>
    <span class="c-section-rule" />
  </div>
  {#if mine.length}
    <ul class={listClass} style={listStyle} data-testid="my-collections">
      {#each mine as c (c.id)}
        <CollectionCard
          id={c.id}
          name={c.name}
          href={hrefFor(c.id)}
          details={[
            countLine(c.id, cards, c.type === 'manual' ? (items.get(c.id) ?? []) : undefined),
            c.type === 'smart' ? 'Smart' : 'Manual'
          ].filter(Boolean)}
          tiles={tilesOf(c.id, cards, states, tagRules, revealed)}
          layout={grid ? 'grid' : 'list'}
          menu
          on:reveal={(ev) => reveal(ev.detail)}
          on:menu={(ev) => menu(ev.detail)}
        />
      {/each}
    </ul>
  {:else}
    <p class="py-2 text-c-muted">
      None yet. Make one with "New collection", or save a Library search as a smart collection.
    </p>
  {/if}
</div>

<AppBottomBar />
