<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Audiobooks tab of /cleanup (WP21a): the audiobook cleanup's analysis. Nothing here
   * changes a file or Audiobookshelf: stage 0 takes a read-only snapshot of Audiobookshelf
   * (libraries, counts, every user's listening progress, to download), stage 1 finds which
   * library files are copies of which torrent files, stage 2 groups the files into books and
   * checks each file. Both stages are Off or Preview. The disk line shows which cleanup job
   * reads the disk (one at a time; the Calibre cleanup goes first). Asks the server again
   * every few seconds while open.
   */
  import { onDestroy, onMount } from 'svelte';
  import type {
    AbsSnapshot,
    AudioBookRow,
    AudioFileRow,
    AudioStageMode,
    AudioStageRow,
    AudioStatus,
    CleanupApi
  } from '$lib/cleanup/cleanup-api';
  import {
    AUDIO_MODE_LABELS,
    AUDIO_STAGE_HINTS,
    BOOK_LISTS,
    FILE_LISTS,
    audioStage1Bar,
    audioStage1Lines,
    audioStage2Bar,
    audioStage2Lines,
    booksLines,
    diskLine,
    durationText,
    identityLines,
    snapshotLine
  } from '$lib/cleanup/audio-text';
  import { bytesText, n, type ProgressBar } from '$lib/cleanup/cleanup-text';
  import { LibraryApiError } from '$lib/library/api';
  import { formatWhen } from '$lib/notes/notes-format';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import CleanupSection from './cleanup-section.svelte';

  export let api: CleanupApi;

  const POLL_MS = 5000;
  const PAGE = 50;
  const MODES: AudioStageMode[] = ['off', 'analyse'];

  let status: AudioStatus | null = null;
  let error = '';
  let actionError = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: AbsSnapshot | null = null;
  let snapshotId: number | null = null;

  let fileList = FILE_LISTS[0].id;
  let files: { total: number; items: AudioFileRow[] } | null = null;
  let fileOffset = 0;
  let bookList = BOOK_LISTS[0].id;
  let books: { total: number; items: AudioBookRow[] } | null = null;
  let bookOffset = 0;

  $: stage1 = status?.stages.find((s) => s.stage === 1) ?? null;
  $: stage2 = status?.stages.find((s) => s.stage === 2) ?? null;
  $: p1 = status?.stage1.progress ?? null;
  $: p2 = status?.stage2.progress ?? null;
  $: bars1 = [audioStage1Bar(p1, Date.now())].filter((b): b is ProgressBar => b !== null);
  $: bars2 = [audioStage2Bar(p2, Date.now())].filter((b): b is ProgressBar => b !== null);
  $: latest = status?.stage0.latest ?? null;
  $: snapshotError =
    (status?.stages.find((s) => s.stage === 0)?.progress as { error?: string | null } | undefined)
      ?.error ?? null;

  onMount(async () => {
    await refresh();
    void loadFiles(0);
    void loadBooks(0);
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function refresh() {
    if (destroyed) return;
    clearTimeout(timer);
    try {
      status = await api.audioStatus();
      error = status.available
        ? ''
        : `The audiobook cleanup is off on the server: ${status.error ?? ''}`;
      const id = status.stage0?.latest?.id ?? null;
      if (id !== null && id !== snapshotId) {
        snapshotId = id;
        snapshot = await api.absSnapshot(id).catch(() => null);
      }
    } catch (err) {
      if (!destroyed) error = describe(err);
    }
    if (!destroyed) {
      timer = setTimeout(
        () => void refresh(),
        document.visibilityState !== 'hidden' ? POLL_MS : POLL_MS * 6
      );
    }
  }

  async function setMode(stage: AudioStageRow, mode: AudioStageMode) {
    if (stage.mode === mode) return;
    actionError = '';
    try {
      status = await api.setAudioStageMode(stage.stage, mode);
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function analyseAgain(stage: number) {
    actionError = '';
    try {
      status = await api.audioAnalyseAgain(stage);
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function takeSnapshot() {
    actionError = '';
    try {
      status = await api.takeAbsSnapshot();
      setTimeout(() => void refresh(), 1500);
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function download(format: 'json' | 'csv') {
    if (snapshotId === null) return;
    actionError = '';
    try {
      const blob = await api.absSnapshotFile(snapshotId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        format === 'csv'
          ? `audiobookshelf-progress-${snapshotId}.csv`
          : `audiobookshelf-snapshot-${snapshotId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function loadFiles(at: number) {
    try {
      files = await api.audioFiles(fileList, at, PAGE);
      fileOffset = at;
    } catch (err) {
      files = null;
      actionError = describe(err);
    }
  }

  async function loadBooks(at: number) {
    try {
      books = await api.audioBooks(bookList, at, PAGE);
      bookOffset = at;
    } catch (err) {
      books = null;
      actionError = describe(err);
    }
  }

  function position(seconds: number | null): string {
    if (seconds === null) return '–';
    const t = Math.round(seconds);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  function rootLabel(root: string): string {
    return root === 'torrents' ? 'Torrents' : 'Library';
  }
</script>

{#if error && !status}
  <p class="c-notice mt-6" role="alert">{error}</p>
{:else if !status}
  <p class="c-rule-text mt-6 text-sm text-c-muted">Loading…</p>
{:else}
  {#if error}<p class="c-notice mt-6" role="alert">{error}</p>{/if}
  {#if actionError}<p class="c-notice mt-6 font-bold" role="alert">{actionError}</p>{/if}

  <section class="mt-6 flex flex-col gap-4" data-testid="audio-status">
    <SettingsSection jp="状況" title="Audiobooks" />
    <p class="max-w-prose text-sm">
      The audiobook cleanup only looks for now: nothing in the torrents, the library folder or
      Audiobookshelf is changed.
    </p>
    <p class="text-sm" data-testid="audio-disk">{diskLine(status.lock)}</p>
    {#if status.available && !status.roots.ok}
      <p class="c-notice text-sm" role="alert" data-testid="audio-roots">
        {status.roots.problem}
      </p>
    {/if}

    <div class="c-tile flex flex-col gap-3 rounded p-4" data-testid="audio-stage-0">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-mincho text-lg font-bold">0 · Audiobookshelf snapshot</h3>
        <span class="text-sm text-c-muted"
          >Read only: libraries, counts and listening progress.</span
        >
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          class="c-btn c-btn-primary"
          disabled={status.stage0.snapshotting || !status.stage0.absUrlSet || !status.stage0.keySet}
          on:click={takeSnapshot}
          data-testid="audio-snapshot-take"
        >
          {status.stage0.snapshotting ? 'Taking a snapshot…' : 'Take a snapshot'}
        </button>
        {#if latest}
          <button
            class="c-btn c-btn-secondary"
            on:click={() => download('csv')}
            data-testid="audio-snapshot-csv"
          >
            Download progress (CSV)
          </button>
          <button
            class="c-btn c-btn-secondary"
            on:click={() => download('json')}
            data-testid="audio-snapshot-json"
          >
            Download everything (JSON)
          </button>
        {/if}
      </div>
      {#if !status.stage0.absUrlSet || !status.stage0.keySet}
        <p class="text-sm text-c-muted" data-testid="audio-snapshot-needs">
          Fill in Audiobookshelf’s address and API key in the Settings tab first.
        </p>
      {/if}
      {#if snapshotError}
        <p class="c-notice text-sm" role="alert" data-testid="audio-snapshot-error">
          The last snapshot failed: {snapshotError}
        </p>
      {/if}
      <p class="text-sm" data-testid="audio-snapshot-summary">
        {#if latest}Taken {formatWhen(latest.summary.takenAt)}:
        {/if}{snapshotLine(latest?.summary)}
      </p>
      {#if snapshot && snapshot.progress.length}
        <ul class="flex flex-col text-sm" data-testid="audio-progress-list">
          {#each snapshot.progress as row, i (i)}
            <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
              <span class="font-medium">
                {row.title ?? '(no title)'}
                {#if !row.inAbs}<span class="text-c-muted">
                    · no longer in Audiobookshelf</span
                  >{/if}
              </span>
              <span class="text-c-muted">
                {row.user} ·
                {row.isFinished
                  ? 'Finished'
                  : `${row.progressPercent} % · at ${position(row.currentTime)} of ${position(row.duration)}`}
                {#if row.lastUpdate}
                  · {formatWhen(row.lastUpdate)}{/if}
              </span>
              {#if row.relPath}<span class="break-all text-c-muted">{row.relPath}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#each [stage1, stage2] as stage (stage?.stage)}
      {#if stage}
        <div class="c-tile flex flex-col gap-3 rounded p-4" data-testid="audio-stage-{stage.stage}">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="font-mincho text-lg font-bold">{stage.stage} · {stage.name}</h3>
          </div>
          <p class="text-sm text-c-muted">
            {AUDIO_STAGE_HINTS[stage.stage]?.[stage.mode === 'on' ? 'analyse' : stage.mode] ?? ''}
          </p>
          <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage {stage.stage}">
            {#each MODES as mode (mode)}
              <button
                class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
                role="radio"
                aria-checked={stage.mode === mode}
                on:click={() => stage && setMode(stage, mode)}
                data-testid="audio-stage-{stage.stage}-{mode}"
              >
                {AUDIO_MODE_LABELS[mode]}
              </button>
            {/each}
            {#if stage.mode !== 'off'}
              <button
                class="c-btn c-btn-ghost"
                on:click={() => stage && analyseAgain(stage.stage)}
                data-testid="audio-analyse-again-{stage.stage}">Run the analysis again</button
              >
            {/if}
          </div>
          {#each stage.stage === 1 ? bars1 : bars2 as bar (bar.label)}
            <div class="flex flex-col gap-1" data-testid="audio-progress-{stage.stage}">
              <div class="flex flex-wrap justify-between gap-x-4 text-sm">
                <span>{bar.label}</span>
                <span>{Math.floor(bar.fraction * 100)} %{bar.eta ? ` · ${bar.eta}` : ''}</span>
              </div>
              <div
                class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
                role="progressbar"
                aria-label={bar.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(bar.fraction * 100)}
              >
                <div class="h-full bg-c-fill" style="width: {bar.fraction * 100}%" />
              </div>
            </div>
          {/each}
          {#each stage.stage === 1 ? audioStage1Lines(p1, Date.now()) : audioStage2Lines(p2) as line}
            <p class="text-sm">{line}</p>
          {/each}
          {#if stage.pauseReason}
            <p class="c-notice text-sm" role="alert">
              <b>Paused:</b>
              {stage.pauseDetail ?? stage.pauseReason}
            </p>
          {:else if stage.mode !== 'off' && (stage.stage === 1 ? status.stage1.waiting : status.stage2.waiting)}
            <p class="text-sm text-c-muted" data-testid="audio-waiting-{stage.stage}">
              {stage.stage === 1 ? status.stage1.waiting : status.stage2.waiting}
            </p>
          {/if}
          {#each stage.stage === 1 ? identityLines(status.stage1.counts) : booksLines(status.stage2.counts) as line}
            <p class="text-sm" data-testid="audio-found-{stage.stage}">{line}</p>
          {/each}
        </div>
      {/if}
    {/each}
  </section>

  <CleanupSection id="audio-files" jp="一覧" title="Files" testid="audio-files">
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">List</span>
      <select
        class="c-input"
        bind:value={fileList}
        on:change={() => loadFiles(0)}
        data-testid="audio-file-list"
      >
        {#each FILE_LISTS as l (l.id)}
          <option value={l.id}>{l.label}</option>
        {/each}
      </select>
    </label>
    {#if files}
      <p class="text-sm text-c-muted" data-testid="audio-file-total">{n(files.total)} files</p>
      <ul class="flex flex-col text-sm">
        {#each files.items as f (f.id)}
          <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
            <span class="break-all">{rootLabel(f.root)} / {f.rel_path}</span>
            {#if f.decoded_path}<span class="break-all text-c-muted">Read as: {f.decoded_path}</span
              >{/if}
            <span class="text-c-muted">
              {bytesText(f.size)}{f.format
                ? ` · ${f.format}${f.codec ? `/${f.codec}` : ''}`
                : ''}{f.duration ? ` · ${durationText(f.duration)}` : ''}{f.raw_name
                ? ' · name is not UTF-8'
                : ''}
            </span>
            {#if f.originals?.length}
              {#each f.originals as o}
                <span class="break-all text-c-muted"
                  >Original: {rootLabel(o.root)} / {o.rel_path}</span
                >
              {/each}
            {/if}
            {#if f.error || f.decode_error || f.detail}
              <span class="text-c-muted">{f.error ?? f.decode_error ?? f.detail}</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if files.total > PAGE}
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="c-btn c-btn-secondary"
            disabled={fileOffset === 0}
            on:click={() => loadFiles(Math.max(0, fileOffset - PAGE))}>Previous</button
          >
          <span class="text-sm"
            >{n(fileOffset + 1)}–{n(Math.min(files.total, fileOffset + PAGE))} of {n(
              files.total
            )}</span
          >
          <button
            class="c-btn c-btn-secondary"
            disabled={fileOffset + PAGE >= files.total}
            on:click={() => loadFiles(fileOffset + PAGE)}>Next</button
          >
        </div>
      {/if}
    {/if}
  </CleanupSection>

  <CleanupSection id="audio-books" jp="本" title="Books" testid="audio-books">
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">List</span>
      <select
        class="c-input"
        bind:value={bookList}
        on:change={() => loadBooks(0)}
        data-testid="audio-book-list"
      >
        {#each BOOK_LISTS as l (l.id)}
          <option value={l.id}>{l.label}</option>
        {/each}
      </select>
    </label>
    {#if books}
      <p class="text-sm text-c-muted" data-testid="audio-book-total">{n(books.total)} books</p>
      <ul class="flex flex-col text-sm">
        {#each books.items as b (b.id)}
          <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
            <span class="break-all font-medium">{rootLabel(b.root)} / {b.unit_rel_path}</span>
            {#if b.name_decoded}<span class="break-all text-c-muted">Read as: {b.name_decoded}</span
              >{/if}
            <span class="text-c-muted">
              {n(b.file_count)} files · {durationText(b.total_seconds)}{b.class_reason
                ? ` · ${b.class_reason}`
                : ''}
            </span>
            {#each b.files as f}
              <span class="break-all text-c-muted">
                {f.rel_path.split('/').pop()} · {bytesText(f.size)} · {durationText(
                  f.duration
                )}{f.chapter_count ? ` · ${f.chapter_count} chapters` : ''}
              </span>
            {/each}
          </li>
        {/each}
      </ul>
      {#if books.total > PAGE}
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="c-btn c-btn-secondary"
            disabled={bookOffset === 0}
            on:click={() => loadBooks(Math.max(0, bookOffset - PAGE))}>Previous</button
          >
          <span class="text-sm"
            >{n(bookOffset + 1)}–{n(Math.min(books.total, bookOffset + PAGE))} of {n(
              books.total
            )}</span
          >
          <button
            class="c-btn c-btn-secondary"
            disabled={bookOffset + PAGE >= books.total}
            on:click={() => loadBooks(bookOffset + PAGE)}>Next</button
          >
        </div>
      {/if}
    {/if}
  </CleanupSection>
{/if}
