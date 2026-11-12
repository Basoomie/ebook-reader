<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP14: where an Anki card's link leads: /open?book=<library id>&pos=<characters>. Opens
   * this device's copy of the book, or downloads it from the library first, then the
   * reader jumps to the passage the way "Open in book" does (recorded, not saved; the
   * return marker leads back). The address is replaced, so Back doesn't come here again.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { parseReaderLink } from '$lib/anki/reader-link';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { existingLocalIds } from '$lib/library/browser-open-deps';
  import { getLibraryStore } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { setPendingJump } from '$lib/notes/pending-jump';
  import { onDestroy, onMount } from 'svelte';

  let message = '';
  let title = '';
  let stage: OpenStage | null = null;
  let opening = false;
  const controller = new AbortController();

  async function go(bookId: string, position: number, localId: number) {
    setPendingJump({ bookId, highlightId: null, position });
    await goto(`${pagePath}/b?id=${localId}`, { replaceState: true });
  }

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError) {
      if (err.status === 404) return 'This book is not in the library (any more).';
      if (err.kind === 'unreachable' || err.kind === 'timeout') {
        return 'The library server cannot be reached (offline, or the server is down), and the book is not on this device.';
      }
    }
    return (err as Error)?.message ?? String(err);
  }

  onMount(async () => {
    const target = parseReaderLink($page.url.searchParams);

    if (!target) {
      message = "This link doesn't name a book.";
      return;
    }

    try {
      const store = getLibraryStore();
      const link = await store.getLink(target.bookId);
      const connection = await store.getConnection();

      // On this device and no server to ask: open the copy as it is.
      if (link && !connection && (await existingLocalIds()).has(link.localId)) {
        await go(target.bookId, target.position, link.localId);
        return;
      }

      if (!connection) {
        message = link
          ? 'The book is not on this device, and this device is not connected to a library server.'
          : 'This device is not connected to a library server.';
        return;
      }

      const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
      const api = new LibraryApi(connection.serverUrl, connection.token, timeout);
      let book: { id: string; title: string; authors?: readonly { name: string }[] };

      try {
        book = await api.book(target.bookId, { signal: controller.signal });
      } catch (err) {
        // Offline but the copy is here: open it.
        if (link && (await existingLocalIds()).has(link.localId)) {
          await go(target.bookId, target.position, link.localId);
          return;
        }
        throw err;
      }

      title = book.title;
      opening = true;
      const libraries = await api
        .libraries({ signal: controller.signal })
        .then((r) => r.libraries)
        .catch(() => []);
      const outcome = await openCatalogBook(
        { id: book.id, title: book.title, authors: book.authors },
        api,
        store,
        libraries,
        controller.signal,
        (s) => (stage = s)
      );
      opening = false;

      if (outcome.status === 'opened') {
        await go(target.bookId, target.position, outcome.localId);
      } else if (outcome.status === 'refused') {
        message = outcome.message;
      } else {
        message = 'Opening was cancelled.';
      }
    } catch (err) {
      opening = false;
      if (err instanceof LibraryApiError && err.kind === 'aborted') return;
      logger.warn(`Open link: ${(err as Error)?.message ?? err}`);
      message = describe(err);
    }
  });

  onDestroy(() => controller.abort());
</script>

<svelte:head>
  <title>{formatPageTitle(title)}</title>
</svelte:head>

<main class="mx-auto max-w-xl p-6 sm:p-8" data-testid="open-link-page">
  {#if message}
    <p class="mb-4" role="status" data-testid="open-link-message">{message}</p>
    <a class="c-btn c-btn-secondary min-h-[3rem]" href="{pagePath}/library">Go to the Library</a>
  {:else}
    <p class="text-c-muted" role="status">Opening the book…</p>
  {/if}
</main>

{#if opening}
  <LibraryOpenOverlay
    {title}
    {stage}
    on:cancel={() => {
      controller.abort();
      opening = false;
      message = 'Opening was cancelled.';
    }}
  />
{/if}
