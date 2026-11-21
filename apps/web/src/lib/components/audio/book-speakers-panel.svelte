<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12 session 5: a book's characters (the book page's "PC voice" area, after
   * the PC voice; closed until opened, like the pronunciation fixes). The PC works out who
   * speaks each quote in 「」 with a model from the list in Settings > Audiobooks (chosen per
   * run, like the TTS models); each character can then have a voice preset. Quotes without
   * a speaker, or whose speaker has no voice, are read with the dialogue voice. Corrections,
   * renames, merges and voices stay through a new run. "Check quotes" is a page of its own.
   *
   * 2026-11-20 redesign: a folded part of the Text-to-speech row (no box of its own); with the
   * row closed (`compact`) only a running job's status shows; the list is shown 10 a page.
   */
  import { onDestroy } from 'svelte';
  import type { GpuWorkerStatus } from '$lib/audio/audio-types';
  import type { SpeakerCharacter, SpeakerOverview } from '$lib/audio/speakers/speaker-types';
  import {
    characterLabel,
    pcProgramNote,
    runText,
    sortedCharacters,
    isQuiet,
    speakerJobActive,
    speakerJobText
  } from '$lib/audio/speakers/speaker-text';
  import { speakerUnsureBelow$, unsureBelow } from '$lib/audio/tts-settings';
  import type { VoicePreset } from '$lib/audio/tts-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    mergeCharacterCopy,
    runSpeakersAgainCopy,
    stopSpeakersCopy
  } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { settingsTabHref } from '$lib/settings/settings-tab';
  import PagedList from '$lib/components/paged-list.svelte';

  export let api: LibraryApi;
  export let bookId: string;
  export let bookTitle = '';
  /** The Text-to-speech row is closed: only a running job's status shows. */
  export let compact = false;
  /** Bound up: the characters shown (not "not a character"), null until known. */
  export let count: number | null = null;

  /** Characters shown a page at a time. */
  const PAGE_SIZE = 10;

  const selectClasses = 'c-input mt-1 block min-h-[3rem] w-full max-w-[18rem] text-base';

  let overview: SpeakerOverview | null = null;
  let voices: VoicePreset[] = [];
  let worker: GpuWorkerStatus | null = null;
  let open = false;
  let loadedFor = '';
  let busy = false;
  let error = '';
  let modelId: number | null = null;
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let addName = '';
  let renaming: number | null = null;
  let renameTo = '';
  let merging: number | null = null;
  let mergeInto = '';

  $: if (bookId && bookId !== loadedFor) void load(bookId);
  $: job = overview?.job ?? null;
  $: active = speakerJobActive(job);
  $: characters = overview ? sortedCharacters(overview.characters) : [];
  // Characters without quotes (the PC lists everyone a scene mentions) stay folded away.
  let showQuiet = false;
  $: quiet = characters.filter(isQuiet).length;
  $: listed = showQuiet ? characters : characters.filter((c) => !isQuiet(c));
  $: shown = characters.filter((c) => !c.hidden);
  $: count = overview ? shown.length : null;
  $: narrator = overview?.characters.find((c) => c.narrator && !c.hidden) ?? null;
  $: note = overview ? pcProgramNote(overview, worker) : '';
  $: if (overview && modelId === null) {
    modelId = overview.models.find((m) => m.isDefault)?.id ?? overview.models[0]?.id ?? null;
  }
  $: reviewHref = `${pagePath}/library/book/speakers?id=${encodeURIComponent(bookId)}`;
  // A new "unsure" bar (Settings, another device) counts again.
  let lastBar = $speakerUnsureBelow$;
  $: if ($speakerUnsureBelow$ !== lastBar) {
    lastBar = $speakerUnsureBelow$;
    if (loadedFor) void refresh();
  }

  onDestroy(() => {
    destroyed = true;
    if (timer) clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load(id: string) {
    loadedFor = id;
    overview = null;
    open = false;
    modelId = null;
    await refresh();
  }

  async function refresh() {
    const id = loadedFor;
    try {
      const [o, v, w] = await Promise.all([
        api.speakers(id, unsureBelow()),
        voices.length ? Promise.resolve(null) : api.voices().catch(() => null),
        api.gpuWorker().catch(() => null)
      ]);
      if (destroyed || id !== bookId) return;
      overview = o;
      if (v) voices = v.voices;
      worker = w;
      now = Date.now();
    } catch (err) {
      // An older server or no connection: the panel stays as it was (hidden at first).
      logger.warn(`Details: characters: ${describe(err)}`);
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (destroyed || !speakerJobActive(overview?.job)) return;
    timer = setTimeout(() => void refresh(), 2000);
  }

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    error = '';
    try {
      await fn();
      await refresh();
    } catch (err) {
      error = describe(err);
    } finally {
      busy = false;
    }
  }

  async function run() {
    if (
      overview?.run &&
      !(await confirmDestructive(runSpeakersAgainCopy(overview.counts.corrected)))
    )
      return;
    await act(() => api.runSpeakers(bookId, modelId));
  }

  async function stop() {
    if (!job) return;
    const j = job;
    if (!(await confirmDestructive(stopSpeakersCopy(bookTitle || (j.bookTitle ?? ''))))) return;
    await act(() => api.cancelSubtitleJob(j.id));
  }

  const setVoice = (c: SpeakerCharacter, value: string) =>
    act(() => api.editCharacter(bookId, c.id, { voiceId: value || null }));

  const setHidden = (c: SpeakerCharacter, hidden: boolean) =>
    act(() => api.editCharacter(bookId, c.id, { hidden }));

  async function rename(c: SpeakerCharacter) {
    const name = renameTo.trim();
    if (!name || name === c.name) {
      renaming = null;
      return;
    }
    await act(() => api.editCharacter(bookId, c.id, { name }));
    if (!error) renaming = null;
  }

  async function merge(c: SpeakerCharacter) {
    const into = overview?.characters.find((x) => String(x.id) === mergeInto);
    if (!into) return;
    if (!(await confirmDestructive(mergeCharacterCopy(c.name, into.name, c.quotes)))) return;
    await act(() => api.mergeCharacter(bookId, c.id, into.id));
    if (!error) merging = null;
  }

  async function add() {
    const name = addName.trim();
    if (!name) return;
    await act(() => api.addCharacter(bookId, name));
    if (!error) addName = '';
  }

  const setNarration = (by: string) =>
    act(() => api.setNarrationBy(bookId, by === 'narrator' ? 'narrator' : 'narration'));
</script>

{#if overview && compact}
  {#if active && job}
    <p class="mt-1 text-sm" role="status" data-testid="book-speakers-status-closed">
      Characters on the PC: {speakerJobText(job, worker, now)}
    </p>
  {/if}
{:else if overview}
  <div class="c-sub mt-4 pt-3" data-testid="book-speakers">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h4 class="font-medium">Characters{shown.length ? ` (${shown.length})` : ''}</h4>
        <p class="max-w-3xl text-sm text-c-muted">Give a character a voice of their own.</p>
      </div>
      <button
        class="c-btn c-btn-secondary c-round shrink-0"
        aria-expanded={open}
        data-testid="book-speakers-toggle"
        on:click={() => (open = !open)}
      >
        {open ? 'Close' : 'Open'}
      </button>
    </div>
    {#if active && job && !open}
      <p class="mt-1 text-sm" role="status" data-testid="book-speakers-status-closed">
        {speakerJobText(job, worker, now)}
      </p>
    {/if}
    {#if open}
      <p class="mt-2 max-w-3xl text-sm text-c-muted">
        The PC works out who speaks each quote in 「」, so each character can have a voice of their
        own in audiobooks made on the PC, in read-aloud and in sentence audio for Anki. Quotes
        without a speaker, or whose speaker has no voice, are read with the dialogue voice.
      </p>

      {#if job && (active || job.state === 'failed' || job.state === 'cancelled')}
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <p class="text-sm" role="status" data-testid="book-speakers-status">
            {speakerJobText(job, worker, now)}
          </p>
          {#if active && !job.cancelRequested}
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="book-speakers-stop"
              disabled={busy}
              on:click={stop}
            >
              Stop
            </button>
          {/if}
        </div>
        {#if active && job.progress !== null && String(job.stage) === 'generating'}
          <progress
            class="mt-2 w-full max-w-md"
            max="1"
            value={job.progress}
            data-testid="book-speakers-progress"
          />
        {/if}
      {/if}
      {#if note}
        <p class="c-notice mt-3 text-sm" role="alert" data-testid="book-speakers-pc-note">{note}</p>
      {/if}

      {#if overview.run}
        <p class="mt-3 text-sm" data-testid="book-speakers-run">{runText(overview, now)}</p>
        {#if overview.run.renumbered}
          <p class="mt-1 text-sm text-c-muted" data-testid="book-speakers-renumbered">
            The book's file changed since; its quotes were found again by their text.
          </p>
        {/if}
        <p class="mt-2 text-sm">
          <a class="c-link" href={reviewHref} data-testid="book-speakers-review">
            Check quotes{overview.counts.check
              ? ` (${overview.counts.check.toLocaleString('en-US')} to check)`
              : ''}
          </a>
        </p>
      {/if}

      {#if !active}
        <div class="mt-3 flex flex-wrap items-end gap-3">
          {#if overview.models.length > 1}
            <label class="block text-sm text-c-muted">
              Speaker model
              <select
                class={selectClasses}
                data-testid="book-speakers-model"
                value={modelId === null ? '' : String(modelId)}
                on:change={(e) => (modelId = Number(e.currentTarget.value))}
              >
                {#each overview.models as m (m.id)}
                  <option value={String(m.id)}>{m.label}</option>
                {/each}
              </select>
            </label>
          {/if}
          <button
            class="c-btn {overview.run ? 'c-btn-secondary' : 'c-btn-primary'} c-round"
            data-testid="book-speakers-run-button"
            disabled={busy || !overview.models.length}
            on:click={run}
          >
            {overview.run ? 'Find who speaks again' : 'Find who speaks each quote'}
          </button>
        </div>
        {#if !overview.run}
          <p class="mt-1 text-xs text-c-muted">
            On the PC, about 10–20 minutes for a novel, after 1–2 minutes to load. It makes way for
            read-aloud and sentence audio, and continues afterwards.
          </p>
        {/if}
        {#if !overview.models.length}
          <p class="mt-2 text-sm">
            <a class="c-link" href={settingsTabHref(pagePath, 'Audiobooks')}>
              Add a speaker model in Settings
            </a>
          </p>
        {/if}
      {/if}

      {#if narrator}
        <label class="mt-4 block text-sm text-c-muted">
          The narration (told by {narrator.name}) is read by
          <select
            class={selectClasses}
            data-testid="book-speakers-narration"
            value={overview.narrationBy}
            disabled={busy}
            on:change={(e) => setNarration(e.currentTarget.value)}
          >
            <option value="narration">The book's TTS voice</option>
            <option value="narrator">{narrator.name}'s voice</option>
          </select>
          {#if overview.narrationBy === 'narrator' && !narrator.voiceId}
            <span class="mt-1 block text-xs">Choose a voice for {narrator.name} below.</span>
          {/if}
        </label>
      {/if}

      {#if characters.length}
        <PagedList
          items={listed}
          size={PAGE_SIZE}
          resetKey={showQuiet}
          label="Characters"
          testid="book-speakers-pages"
          let:pageItems
        >
          <ul class="mt-3 max-w-3xl" data-testid="book-speakers-list">
            {#each pageItems as c (c.id)}
              <li class="c-crow py-3" data-testid="book-speaker" data-name={c.name}>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div class="min-w-0 grow basis-48">
                    <div class="break-words text-[15px]" lang="ja">
                      <span class="font-bold" class:text-c-muted={c.hidden}>{c.name}</span>
                      {#if c.narrator}<span class="text-xs text-c-muted"> · narrator</span>{/if}
                    </div>
                    <div class="text-xs text-c-muted" lang="ja">
                      {c.aliases.length ? `${c.aliases.slice(0, 4).join('、')} · ` : ''}{c.quotes}
                      {c.quotes === 1 ? 'quote' : 'quotes'}{c.hidden ? ' · not a character' : ''}
                    </div>
                  </div>
                  {#if !c.hidden}
                    <label class="block text-sm text-c-muted">
                      <span class="sr-only">Voice of {c.name}</span>
                      <select
                        class="c-input block min-h-[3rem] w-48 text-base"
                        data-testid="book-speaker-voice"
                        value={c.voiceId ?? ''}
                        disabled={busy}
                        on:change={(e) => setVoice(c, e.currentTarget.value)}
                      >
                        <option value="">Dialogue voice</option>
                        {#each voices as v (v.id)}
                          <option value={v.id}>{v.name}</option>
                        {/each}
                        {#if c.voiceId && !voices.some((v) => v.id === c.voiceId)}
                          <option value={c.voiceId}>A deleted voice</option>
                        {/if}
                      </select>
                    </label>
                  {/if}
                </div>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    class="c-btn c-btn-secondary c-round"
                    data-testid="book-speaker-rename"
                    disabled={busy}
                    on:click={() => {
                      renaming = c.id;
                      renameTo = c.name;
                      merging = null;
                    }}>Rename</button
                  >
                  {#if characters.length > 1}
                    <button
                      class="c-btn c-btn-secondary c-round"
                      data-testid="book-speaker-merge"
                      disabled={busy}
                      on:click={() => {
                        merging = c.id;
                        mergeInto = '';
                        renaming = null;
                      }}>Merge into…</button
                    >
                  {/if}
                  <button
                    class="c-btn c-btn-secondary c-round"
                    data-testid="book-speaker-hide"
                    disabled={busy}
                    on:click={() => setHidden(c, !c.hidden)}
                  >
                    {c.hidden ? 'It is a character' : 'Not a character'}
                  </button>
                  {#if c.quotes}
                    <a
                      class="c-btn c-btn-secondary c-round"
                      data-testid="book-speaker-quotes"
                      href={`${reviewHref}&character=${c.id}`}>Quotes</a
                    >
                  {/if}
                </div>
                {#if renaming === c.id}
                  <form
                    class="mt-2 flex flex-wrap items-center gap-2"
                    on:submit|preventDefault={() => rename(c)}
                  >
                    <label class="text-sm text-c-muted">
                      New name
                      <input
                        class="c-input mt-1 block min-h-[3rem] w-56 text-base"
                        lang="ja"
                        maxlength="40"
                        data-testid="book-speaker-rename-input"
                        bind:value={renameTo}
                      />
                    </label>
                    <button
                      class="c-btn c-btn-primary c-round"
                      data-testid="book-speaker-rename-save"
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      class="c-btn c-btn-secondary c-round"
                      on:click={() => (renaming = null)}
                    >
                      Cancel
                    </button>
                  </form>
                {/if}
                {#if merging === c.id}
                  <div class="mt-2 flex flex-wrap items-end gap-2">
                    <label class="text-sm text-c-muted">
                      Merge {c.name} into
                      <select
                        class="c-input mt-1 block min-h-[3rem] w-56 text-base"
                        data-testid="book-speaker-merge-into"
                        bind:value={mergeInto}
                      >
                        <option value="">Choose a character</option>
                        {#each characters.filter((x) => x.id !== c.id) as x (x.id)}
                          <option value={String(x.id)}>{characterLabel(x)}</option>
                        {/each}
                      </select>
                    </label>
                    <button
                      class="c-btn c-btn-primary c-round"
                      data-testid="book-speaker-merge-save"
                      disabled={busy || !mergeInto}
                      on:click={() => merge(c)}>Merge</button
                    >
                    <button class="c-btn c-btn-secondary c-round" on:click={() => (merging = null)}>
                      Cancel
                    </button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </PagedList>
        {#if quiet}
          <button
            class="c-btn c-btn-secondary c-round mt-2"
            data-testid="book-speakers-quiet"
            aria-expanded={showQuiet}
            on:click={() => (showQuiet = !showQuiet)}
          >
            {showQuiet ? `Hide the ${quiet} without quotes` : `${quiet} more without quotes`}
          </button>
        {/if}
      {/if}

      {#if overview.run}
        <form class="mt-3 flex flex-wrap items-end gap-2" on:submit|preventDefault={add}>
          <label class="text-sm text-c-muted">
            Add a character the PC missed
            <input
              class="c-input mt-1 block min-h-[3rem] w-56 text-base"
              lang="ja"
              maxlength="40"
              data-testid="book-speakers-add-input"
              bind:value={addName}
            />
          </label>
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="book-speakers-add"
            disabled={busy || !addName.trim()}>Add</button
          >
        </form>
      {/if}

      {#if error}
        <p class="c-notice mt-3 text-sm" role="alert" data-testid="book-speakers-error">{error}</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .c-sub {
    border-top: var(--c-border-width) dashed var(--c-line);
  }
  .c-crow + .c-crow {
    border-top: var(--c-border-width) solid var(--c-line);
  }
  .c-round {
    border-radius: 0.75rem;
  }
</style>
