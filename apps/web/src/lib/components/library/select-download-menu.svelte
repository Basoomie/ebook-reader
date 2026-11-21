<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Select mode's Download menu (the Library's select bar): Books, Covers, Audiobooks and
   * SRT of the selected books, each with how many books have one and their size, by the
   * book page's rules (a book offers what its own Download menu offers). Only reads:
   * nothing on the server changes.
   *
   * The sizes are the server's plan of the selection (stored sizes, no disk reads), asked
   * when the menu opens. A download larger than Settings > Data > "Ask before downloads
   * larger than" (default 5 GB) asks first. Settings > Data > "Several files arrive as":
   * - One ZIP file: the server looks up every file (a bar with the time left), then the
   *   browser downloads the ZIP itself (its own progress and time left; never held here).
   * - Separate files: each saved on its own, like the book page's menu (a bar by bytes);
   *   an audiobook goes to the browser's downloads by its signed link.
   */
  import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Fa from 'svelte-fa';
  import BulkDownloadProgress from '$lib/components/library/bulk-download-progress.svelte';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { largeDownloadCopy } from '$lib/confirm/confirm-copy';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import {
    audioDownloadUrl,
    coverFileName,
    epubFileName,
    formatDownloadSize
  } from '$lib/library/book-download';
  import {
    DOWNLOAD_KINDS,
    KIND_LABELS,
    KIND_NOUNS,
    needsSizeConfirm,
    totalSizeLabel,
    type DownloadKind,
    type DownloadPlan,
    type DownloadPlanItem
  } from '$lib/library/bulk-download';
  import { libraryBulkDownloadMode$, libraryDownloadConfirmGb$ } from '$lib/library/settings';

  /** null while offline (the menu needs the server). */
  export let api: LibraryApi | null;
  /** The selected book ids (a new Set on every change). */
  export let selection: ReadonlySet<string>;

  const dispatch = createEventDispatcher<{
    error: Error;
    notice: { title: string; message: string };
  }>();
  const item = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
  /** The size beside an item's name, on the same line (as on the book page). */
  const sizeClass = 'ml-auto pl-3 text-xs text-c-muted tabular-nums';
  /** How often the page asks the server how far a ZIP is. */
  const POLL_MS = 500;

  let open = false;
  let plan: DownloadPlan | null = null;
  let planFor: ReadonlySet<string> | null = null;
  let planError = '';
  let planController: AbortController | undefined;

  $: if (open && api && planFor !== selection) loadPlan(api, selection);
  // No {@const}: prettier-plugin-svelte can't format it (the pre-commit hook).
  $: rows = DOWNLOAD_KINDS.map((kind) => ({ kind, total: plan?.totals[kind] ?? null }));

  function loadPlan(a: LibraryApi, ids: ReadonlySet<string>) {
    planFor = ids;
    plan = null;
    planError = '';
    planController?.abort();
    const ctl = new AbortController();
    planController = ctl;
    a.downloadPlan([...ids], {}, { signal: ctl.signal })
      .then((p) => {
        if (planFor === ids) plan = p;
      })
      .catch((err) => {
        if (err instanceof LibraryApiError && err.kind === 'aborted') return;
        if (planFor === ids) planError = (err as Error).message;
      });
  }

  // ---- the running download ------------------------------------------------

  interface Progress {
    heading: string;
    detail: string;
    done: number;
    total: number;
    countText: string;
    startedAt: number;
  }
  let progress: Progress | null = null;
  let controller: AbortController | undefined;
  /** The ZIP being prepared (Cancel tells the server). */
  let zipToken = '';

  onDestroy(() => {
    planController?.abort();
    cancel();
  });

  function cancel() {
    controller?.abort();
    if (zipToken && api) void api.cancelZip(zipToken).catch(() => undefined);
    zipToken = '';
    progress = null;
  }

  async function start(kind: DownloadKind) {
    const a = api;
    const total = plan?.totals[kind];
    if (!a || !total?.count || progress) return;
    const ids = [...selection];
    const zip = $libraryBulkDownloadMode$ !== 'files';
    if (needsSizeConfirm(total.bytes, Number($libraryDownloadConfirmGb$))) {
      const ok = await confirmDestructive({
        ...largeDownloadCopy({
          what: KIND_NOUNS[kind],
          count: total.count,
          size: totalSizeLabel(total),
          zip
        }),
        testid: 'large-download-confirm',
        confirmTestid: 'large-download-confirm-button'
      });
      if (!ok) return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    try {
      if (zip) await downloadZip(a, ids, kind, total.count, signal);
      else await downloadFiles(a, ids, kind, signal);
    } catch (err) {
      if (signal.aborted || (err instanceof LibraryApiError && err.kind === 'aborted')) return;
      dispatch('error', err as Error);
    } finally {
      if (controller?.signal === signal) {
        controller = undefined;
        zipToken = '';
        progress = null;
      }
    }
  }

  function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** A plain link: the server answers with an attachment, so the page stays. */
  function saveLink(href: string) {
    const link = document.createElement('a');
    link.href = href;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadZip(
    a: LibraryApi,
    ids: string[],
    kind: DownloadKind,
    count: number,
    signal: AbortSignal
  ) {
    const startedAt = Date.now();
    progress = {
      heading: `Preparing the ZIP of ${count.toLocaleString('en-US')} ${KIND_NOUNS[kind]}`,
      detail: '',
      done: 0,
      total: count,
      countText: 'Looking up the files…',
      startedAt
    };
    zipToken = await a.startZip(ids, kind, signal);
    for (;;) {
      await wait(POLL_MS, signal);
      if (signal.aborted) return;
      const status = await a.zipStatus(zipToken, { signal });
      if (status.state === 'ready') {
        saveLink(a.absolute(status.url));
        zipToken = '';
        if (status.skipped.length) {
          dispatch('notice', {
            title: 'Some files were left out',
            message: `${status.skipped.length.toLocaleString('en-US')} of the selected books' files couldn't be found: ${listTitles(status.skipped)}`
          });
        }
        return;
      }
      if (status.state !== 'preparing') {
        throw new Error(status.error ?? 'The ZIP could not be prepared.');
      }
      progress = {
        ...progress!,
        done: status.done,
        total: status.total || count,
        countText: `${status.done.toLocaleString('en-US')} of ${(status.total || count).toLocaleString('en-US')} files looked up`
      };
    }
  }

  function listTitles(titles: string[]): string {
    const shown = titles.slice(0, 5).join(', ');
    return titles.length > 5 ? `${shown} and ${titles.length - 5} more.` : `${shown}.`;
  }

  async function downloadFiles(
    a: LibraryApi,
    ids: string[],
    kind: DownloadKind,
    signal: AbortSignal
  ) {
    const startedAt = Date.now();
    progress = {
      heading: `Downloading ${KIND_NOUNS[kind]}`,
      detail: '',
      done: 0,
      total: 1,
      countText: 'Getting the list of files…',
      startedAt
    };
    const items = ((await a.downloadPlan(ids, { items: true }, { signal })).items ?? []).filter(
      (i) => i[kind] !== null
    );
    // The bar goes by bytes where the sizes are known, else by files.
    const sizeOf = (i: DownloadPlanItem) => i[kind]?.size ?? 0;
    const bytesTotal = items.reduce((n, i) => n + sizeOf(i), 0);
    const byBytes = bytesTotal > 0 && items.every((i) => i[kind]?.size !== null);
    let bytesDone = 0;
    const failed: string[] = [];
    for (let index = 0; index < items.length; index++) {
      if (signal.aborted) return;
      const target = items[index];
      const set = (extra: number) => {
        progress = {
          heading: `Downloading ${items.length.toLocaleString('en-US')} ${KIND_NOUNS[kind]}`,
          detail: target.title,
          done: byBytes ? bytesDone + extra : index,
          total: byBytes ? bytesTotal : items.length,
          countText: `File ${(index + 1).toLocaleString('en-US')} of ${items.length.toLocaleString('en-US')}${
            byBytes
              ? ` · ${formatDownloadSize(bytesDone + extra) || '0 KB'} of ${formatDownloadSize(bytesTotal)}`
              : ''
          }`,
          startedAt
        };
      };
      set(0);
      try {
        await saveOne(a, target, kind, signal, (loaded) => set(Math.min(loaded, sizeOf(target))));
      } catch (err) {
        if (signal.aborted) return;
        failed.push(target.title);
      }
      bytesDone += sizeOf(target);
    }
    if (failed.length) {
      dispatch('notice', {
        title: 'Not every file was downloaded',
        message: `${failed.length.toLocaleString('en-US')} of ${items.length.toLocaleString('en-US')} files couldn't be downloaded: ${listTitles(failed)}`
      });
    }
  }

  async function saveOne(
    a: LibraryApi,
    target: DownloadPlanItem,
    kind: DownloadKind,
    signal: AbortSignal,
    onBytes: (loaded: number) => void
  ) {
    switch (kind) {
      case 'book': {
        const { blob } = await a.downloadFile(target.id, signal, (loaded) => onBytes(loaded));
        downloadBlob(blob, epubFileName(target.title));
        return;
      }
      case 'cover': {
        const blob = await a.coverImage(target.id, signal);
        downloadBlob(blob, coverFileName(target.title, blob.type));
        return;
      }
      case 'subtitles': {
        const file = await a.linkedSubtitleFile(target.id, { signal });
        if (!file) throw new Error('The subtitle file is no longer in the subtitle folder.');
        downloadBlob(file, target.subtitles?.name || file.name);
        return;
      }
      case 'audio': {
        if (!target.audio) return;
        // Goes to the browser's own downloads (gigabytes are never held here). A short
        // pause between links: browsers drop downloads started in the same instant.
        saveLink(audioDownloadUrl((p) => a.absolute(p), target.audio.url));
        await wait(600, signal);
        return;
      }
    }
  }
</script>

<DropdownMenu
  buttonClass="c-btn c-btn-secondary {!api || !selection.size || progress
    ? 'pointer-events-none opacity-60'
    : ''}"
  label="Download the selected books"
  testid="select-download"
  panelWidth="w-64"
  floating
  bind:open
  let:close
>
  <span slot="button" class="flex items-center gap-2">
    Download
    <Fa icon={open ? faChevronUp : faChevronDown} size="xs" />
  </span>
  <div class="flex flex-col gap-1">
    {#each rows as { kind, total } (kind)}
      <button
        type="button"
        class={item}
        disabled={!total?.count}
        data-testid="select-download-{kind}"
        on:click={() => {
          close();
          void start(kind);
        }}
      >
        {KIND_LABELS[kind]}
        <span class={sizeClass} data-testid="select-download-{kind}-size">
          {#if planError}
            –
          {:else if !total}
            …
          {:else if total.count}
            {total.count.toLocaleString('en-US')} · {totalSizeLabel(total) || 'size unknown'}
          {:else}
            None
          {/if}
        </span>
      </button>
    {/each}
    {#if planError}
      <p class="px-3 pb-1 text-xs text-c-muted" data-testid="select-download-error">
        Couldn't count the sizes: {planError}
      </p>
    {/if}
  </div>
</DropdownMenu>

{#if progress}
  <BulkDownloadProgress
    heading={progress.heading}
    detail={progress.detail}
    done={progress.done}
    total={progress.total}
    countText={progress.countText}
    startedAt={progress.startedAt}
    on:cancel={cancel}
  />
{/if}
