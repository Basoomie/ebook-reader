<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > Audiobooks (WP15b): the server's audiobooks folder (what the last scan
   * found, Scan again), the books with a linked audiobook (problems first) and the books
   * marked "No audiobook". (WP15e removed the empty "From the old sync" section: WP15d was
   * dropped.) Linking itself happens on each book's details page. Read-only towards
   * the audiobooks folder. Polling stops when the tab is left (the panel is destroyed).
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import {
    folderDetails,
    linkMarks,
    linkedFolderName,
    linkedSubtitleName,
    scanBusy,
    scanStatusText,
    subtitleView
  } from '$lib/audio/audio-link';
  import type { AudioLinkListEntry, AudioStatus } from '$lib/audio/audio-types';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { plural } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { formatWhen } from '$lib/notes/notes-format';
  import { onDestroy, onMount } from 'svelte';

  /** How often the panel asks again while a scan is asked for or running. */
  const POLL_MS = 3000;

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let status: AudioStatus | null = null;
  let links: AudioLinkListEntry[] = [];
  let loading = true;
  let error = '';
  let scanError = '';
  let scanning = false;
  let showNone = false;
  let destroyed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  $: linked = links.filter((l) => l.state === 'linked');
  $: none = links.filter((l) => l.state === 'none');
  $: busy = scanning || scanBusy(status);

  onMount(async () => {
    connection = (await store.getConnection()) ?? null;
    if (!connection) {
      loading = false;
      return;
    }
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    await load();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(pollTimer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load() {
    if (!api) return;
    try {
      const [s, l] = await Promise.all([api.audioStatus(), api.audioLinks()]);
      if (destroyed) return;
      status = s;
      links = l;
      error = '';
    } catch (err) {
      if (!destroyed) error = describe(err);
    } finally {
      loading = false;
    }
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (destroyed || !scanBusy(status)) return;
    pollTimer = setTimeout(() => void load(), POLL_MS);
  }

  async function scanAgain() {
    if (!api || busy) return;
    scanning = true;
    scanError = '';
    try {
      await api.requestAudioScan();
      // Show "Scan requested…" at once; the next status read takes over.
      if (status) {
        status = {
          ...status,
          libraries: status.libraries.map((l) => ({ ...l, scanRequested: true }))
        };
      }
    } catch (err) {
      scanError = describe(err);
    } finally {
      scanning = false;
    }
    schedulePoll();
  }

  function bookHref(id: string) {
    return `${pagePath}/library/book?id=${encodeURIComponent(id)}`;
  }

  function subtitleLine(l: AudioLinkListEntry): string {
    const v = subtitleView(l);
    if (v === 'linked' || v === 'missing') return linkedSubtitleName(l);
    if (v === 'none') return 'No subtitles';
    return '';
  }
</script>

<div class="col-span-full flex flex-col" data-testid="audiobooks-page">
  {#if connection === null}
    <p class="c-notice" data-testid="not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else if loading}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if error}
    <p class="c-notice" role="alert" data-testid="audiobooks-error">
      {error}
      <button class="c-link ml-2 min-h-[2.75rem]" on:click={load}>Try again</button>
    </p>
  {:else}
    <p class="mb-6 max-w-3xl text-[15px] text-c-muted">
      Audiobooks stay in the server's audiobooks folder and play from there; nothing is copied or
      changed in it. Link a book's audiobook on the book's page.
    </p>

    <!-- The audiobooks folder -->
    <section aria-label="Audiobooks folder" data-testid="audiobooks-folder">
      <SettingsSection
        jp="音源"
        title="Audiobooks folder"
        tooltip="What the server's last scan of its audiobooks and subtitle folders found. New audiobooks show up after the next scan: every day, when the server starts, or when you press Scan again."
      />
      {#if !status?.enabled}
        <p class="c-notice mt-4" data-testid="audiobooks-off">
          The server has no audiobooks folder set up{status?.error ? ` (${status.error})` : ''}.
        </p>
      {:else}
        {#if status.libraries.length === 0}
          <p class="c-notice mt-4" data-testid="audiobooks-no-library">
            No library has an audiobooks folder yet.
          </p>
        {/if}
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          {#each status.libraries as lib (lib.id)}
            <div class="c-abpanel rounded px-5 py-4" data-testid="audiobooks-library">
              <div class="font-mincho text-lg font-bold">{lib.name}</div>
              <dl class="mt-2 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-y-1 text-sm">
                <dt class="text-c-muted">Audiobooks</dt>
                <dd data-testid="audiobooks-folders">
                  {lib.audioDir ? plural(lib.folders, 'audiobook', 'audiobooks') : 'No folder'}
                </dd>
                <dt class="text-c-muted">Subtitle files</dt>
                <dd data-testid="audiobooks-subtitles">
                  {lib.subtitleDir ? plural(lib.subtitles, 'file', 'files') : 'No folder'}
                </dd>
                {#if lib.archivesSkipped}
                  <dt class="text-c-muted">Archives skipped</dt>
                  <dd>{lib.archivesSkipped.toLocaleString()}</dd>
                {/if}
                {#if lib.durationsPending}
                  <dt class="text-c-muted">Lengths still being read</dt>
                  <dd data-testid="audiobooks-pending">{lib.durationsPending.toLocaleString()}</dd>
                {/if}
                <dt class="text-c-muted">Last scan</dt>
                <dd data-testid="audiobooks-scanned">
                  {lib.scannedAt ? formatWhen(lib.scannedAt) : 'Never'}
                </dd>
                <dt class="text-c-muted">Status</dt>
                <dd data-testid="audiobooks-status">{scanStatusText(lib)}</dd>
              </dl>
              {#if lib.lastError && lib.status === 'error'}
                <p class="mt-2 break-words text-sm font-semibold" role="alert">
                  {lib.lastError}
                </p>
              {/if}
            </div>
          {/each}
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            class="c-btn c-btn-secondary"
            data-testid="audiobooks-scan"
            disabled={busy}
            on:click={scanAgain}
          >
            {busy ? 'Scanning…' : 'Scan again'}
          </button>
          {#if scanError}
            <span class="text-sm font-medium text-c-seal" role="alert">{scanError}</span>
          {/if}
        </div>
      {/if}
    </section>

    <!-- Linked books -->
    <section class="mt-10" aria-label="Linked books" data-testid="audiobooks-linked">
      <SettingsSection
        jp="紐付け"
        title="Linked books"
        note={plural(linked.length, 'book', 'books')}
      />
      {#if linked.length === 0}
        <p class="mt-4 text-[15px]" data-testid="audiobooks-linked-empty">
          No book has an audiobook linked yet. Open a book's page and choose one under “Audiobook”.
        </p>
      {:else}
        <ul class="mt-2">
          {#each linked as l (l.bookId)}
            <li class="c-abrow flex flex-col gap-1 py-3" data-testid="audiobooks-linked-row">
              <a
                class="c-link self-start break-words font-mincho text-[15px] font-bold"
                href={bookHref(l.bookId)}
                data-testid="audiobooks-linked-title">{l.book?.title ?? l.bookId}</a
              >
              <div class="break-words text-sm">
                <span class="text-c-muted">Audiobook:</span>
                {linkedFolderName(l)}
                {#if l.folder && l.status !== 'missing'}
                  <span class="text-c-muted">· {folderDetails(l.folder)}</span>
                {/if}
              </div>
              {#if subtitleLine(l)}
                <div class="break-words text-sm">
                  <span class="text-c-muted">Subtitles:</span>
                  {subtitleLine(l)}
                </div>
              {/if}
              {#if linkMarks(l).length}
                <div class="flex flex-wrap gap-2" data-testid="audiobooks-marks">
                  {#each linkMarks(l) as mark (mark)}
                    <span class="c-abmark rounded px-2 py-0.5 text-xs font-medium">{mark}</span>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- No audiobook -->
    {#if none.length}
      <section class="mt-10" aria-label="No audiobook" data-testid="audiobooks-none">
        <SettingsSection jp="音声なし" title="No audiobook" />
        <button
          class="c-link mt-2 min-h-[3rem] self-start text-sm"
          aria-expanded={showNone}
          data-testid="audiobooks-none-toggle"
          on:click={() => (showNone = !showNone)}
        >
          {showNone ? 'Hide' : 'Show'}
          {plural(none.length, 'book', 'books')} marked “No audiobook”
        </button>
        {#if showNone}
          <ul class="mt-1" data-testid="audiobooks-none-list">
            {#each none as l (l.bookId)}
              <li class="c-abrow py-2">
                <a class="c-link break-words font-mincho text-[15px]" href={bookHref(l.bookId)}
                  >{l.book?.title ?? l.bookId}</a
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .c-abpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-abrow + .c-abrow {
    border-top: 1px dashed var(--c-line);
  }

  .c-abmark {
    border: 1px solid var(--c-line);
    color: var(--c-ink);
  }
</style>
