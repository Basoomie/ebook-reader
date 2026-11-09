<script lang="ts">
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import MergedHeaderIcon from '$lib/components/merged-header-icon/merged-header-icon.svelte';
  import { baseHeaderClasses, pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { getLibraryStore } from '$lib/library/library-db';
  import type { CheckBook, CheckResult } from '$lib/migration/api';
  import { duration, formatWhen, percent } from '$lib/migration/describe';
  import {
    compareThisDeviceBookmarks,
    getMigrationApi,
    type BookmarkComparison
  } from '$lib/sync/sync-service';
  import { onMount } from 'svelte';

  /**
   * Check page (WP5 decision 4.3): compares the old sync's files with the new
   * records per book (position, this device's bookmark, statistic totals) and
   * shows "All match" or lists the differences. Read-only; it changes nothing.
   */

  const bigButton =
    'min-h-[48px] rounded border-2 border-current px-4 py-2 font-medium disabled:opacity-50';

  let connected: boolean | undefined;
  let result: CheckResult | null = null;
  let bookmarks = new Map<string, BookmarkComparison>();
  let error = '';
  let running = false;

  $: rows = (result?.books ?? []).map((book) => {
    const bm = bookmarks.get(book.bookId);
    const bookmarkMatch =
      !bm?.local || (book.position.new !== null && bm.local.charPos === book.position.new.charPos);
    return { book, bm, bookmarkMatch, match: book.match && bookmarkMatch };
  });
  $: differing = rows.filter((r) => !r.match);
  $: matching = rows.filter((r) => r.match);

  onMount(async () => {
    connected = !!(await getLibraryStore().getConnection());
    if (connected) await run();
  });

  async function run() {
    running = true;
    error = '';
    try {
      const api = await getMigrationApi();
      if (!api) throw new Error('Not connected to the server');
      result = await api.check();
      bookmarks = await compareThisDeviceBookmarks(
        result.books.map((b) => ({ bookId: b.bookId, title: b.title }))
      );
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    } finally {
      running = false;
    }
  }

  function place(p: { charPos: number; progress?: number | null } | null) {
    if (!p) return 'none';
    const pct = percent(p.progress ?? null);
    return `${p.charPos.toLocaleString()} chars${pct ? ` (${pct})` : ''}`;
  }

  function stats(s: CheckBook['stats']['old']) {
    return `${s.days} days · ${s.characters.toLocaleString()} chars · ${duration(s.seconds)}${
      s.completed ? ` · completed ${s.completed}` : ''
    }`;
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Migration check')}</title>
</svelte:head>

<div class="elevation-4 fixed inset-x-0 top-0 z-10">
  <div class={baseHeaderClasses}>
    <div class="{pxScreen} flex h-full items-center justify-between">
      <h1 class="text-lg font-medium">Migration check</h1>
      <MergedHeaderIcon items={[mergeEntries.MANAGE, mergeEntries.LIBRARY]} />
    </div>
  </div>
</div>

<div class="{pxScreen} max-w-3xl pb-16 pt-16 xl:pt-14">
  <p class="py-3 text-sm">
    <a class="underline" href="{pagePath}/migration">Back to the migration</a>
  </p>
  {#if connected === false}
    <p class="py-8">
      Connect this device first, on the <a class="underline" href="{pagePath}/library"
        >Library page</a
      >.
    </p>
  {:else}
    <p class="text-sm">
      Compares, per book, the old sync's files with the new sync: the place reached, this device's
      bookmark, and the statistic totals. A fresh difference can just be a sync that hasn't run yet:
      the old sync uploads at most once a minute. Sync both devices and check again.
    </p>
    <button class="{bigButton} mt-3" disabled={running} on:click={run}>
      {running ? 'Checking…' : 'Check again'}
    </button>
    {#if error}
      <p class="py-2 font-medium" role="alert">{error}</p>
    {/if}

    {#if result}
      <p class="mt-4 text-xl font-medium" role="status">
        {#if !differing.length}
          All match ({rows.length} books).
        {:else}
          {differing.length} of {rows.length} books differ.
        {/if}
      </p>
      <p class="text-sm opacity-75">Checked {formatWhen(result.generatedAt)}.</p>

      {#if differing.length}
        <ul class="mt-3 flex flex-col gap-3">
          {#each differing as { book, bm, bookmarkMatch } (book.bookId)}
            <li class="border-2 border-current p-3 text-sm">
              <div class="font-medium">{book.title}</div>
              {#if book.error}
                <p>The old sync's folder can't be read: {book.error}</p>
              {/if}
              {#if !book.importedAt}
                <p>Not imported yet (step 3 on the migration page).</p>
              {/if}
              {#if !book.position.match}
                <p class="mt-1 font-medium">Position</p>
                <p>
                  Old: {place(book.position.old)}{book.position.old
                    ? `, ${formatWhen(book.position.old.at)}`
                    : ''}
                </p>
                <p>
                  New: {place(book.position.new)}{book.position.new
                    ? `, ${formatWhen(book.position.new.at)} on ${book.position.new.deviceName ?? 'a device'}`
                    : ''}
                </p>
              {/if}
              {#if !bookmarkMatch && bm?.local}
                <p class="mt-1 font-medium">Bookmark (this device)</p>
                <p>This device: {place(bm.local)}, {formatWhen(bm.local.at)}</p>
                <p>New sync: {place(book.position.new)}</p>
              {/if}
              {#if !book.stats.match}
                <p class="mt-1 font-medium">Statistics</p>
                <p>Old: {stats(book.stats.old)}</p>
                <p>New: {stats(book.stats.new)}</p>
                {#if book.stats.days.length}
                  <ul class="mt-1">
                    {#each book.stats.days as day (day.dateKey)}
                      <li>
                        {day.dateKey}: old {day.old
                          ? `${day.old.characters} chars, ${duration(day.old.seconds)}`
                          : 'none'} · new {day.new
                          ? `${day.new.characters} chars, ${duration(day.new.seconds)}`
                          : 'none'}
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if matching.length}
        <details class="mt-6 text-sm">
          <summary class="cursor-pointer font-medium">Matching ({matching.length})</summary>
          <ul class="mt-2">
            {#each matching as { book } (book.bookId)}
              <li class="border-b border-gray-400/40 py-1">
                {book.title} — {place(book.position.new)} · {stats(book.stats.new)}
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if result.notMigrated.length}
        <details class="mt-4 text-sm">
          <summary class="cursor-pointer font-medium">
            Not migrated ({result.notMigrated.length}): stay on the old sync
          </summary>
          <ul class="mt-2">
            {#each result.notMigrated as b (b.folder)}
              <li class="border-b border-gray-400/40 py-1">{b.title}</li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if result.audioOnOldSync.length}
        <details class="mt-4 text-sm">
          <summary class="cursor-pointer font-medium">
            Audiobook data stays on the old sync ({result.audioOnOldSync.length})
          </summary>
          <p class="mt-1">Audiobook position and subtitles move with the audio work (WP15).</p>
          <ul class="mt-2">
            {#each result.audioOnOldSync as b (b.folder)}
              <li class="border-b border-gray-400/40 py-1">{b.title}</li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  {/if}
</div>
