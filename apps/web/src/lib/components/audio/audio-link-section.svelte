<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book details page's "Audiobook" section (WP15b): the confirmation picker.
   *
   * Never links anything by itself: ranked suggestions and a search over the whole
   * audiobooks folder are shown, and only a tap on "Use this" links one. Then a separate
   * subtitle step ("No subtitles" possible). "No audiobook" stops the suggestions.
   * Unlinking, replacing and removing ask first; the link is the same on every device.
   * Loads after the page and never blocks it; its problems show only in here.
   *
   * WP15f: an audiobook in several files opens a file step (audio-files-step.svelte):
   * use one file, or merge files into one. A merge runs on the server; its progress shows
   * here (also after a reload), and when it is done the book uses the merged file and the
   * subtitle step asks.
   *
   * WP16: "Make subtitles on the PC" (subtitle-job-panel.svelte) under the linked audiobook.
   *
   * `link` is bindable so the page's Download menu follows every change made here.
   */
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { onDestroy } from 'svelte';
  import AudioChoiceRow from '$lib/components/audio/audio-choice-row.svelte';
  import AudioFilesStep from '$lib/components/audio/audio-files-step.svelte';
  import SubtitleJobPanel from '$lib/components/audio/subtitle-job-panel.svelte';
  import {
    CHANGED_NOTICE,
    MISSING_NOTICE,
    SUBTITLE_MISSING_NOTICE,
    folderDetails,
    linkDetails,
    linkView,
    mergeActive,
    mergeStatusText,
    severalFilesNote,
    linkedFolderName,
    linkedSubtitleName,
    splitNotice,
    subtitleDetails,
    subtitleView,
    withoutIds
  } from '$lib/audio/audio-link';
  import type {
    AudioCandidates,
    AudioFolderSummary,
    AudioLink,
    AudioLinkChange,
    AudioMergeJob,
    AudioStatus,
    SubtitleFileSummary
  } from '$lib/audio/audio-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    noAudiobookCopy,
    removeSubtitlesCopy,
    replaceAudiobookCopy,
    replaceSubtitlesCopy,
    stopMergeCopy,
    unlinkAudiobookCopy
  } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { settingsTabHref } from '$lib/settings/settings-tab';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  export let bookId: string;

  /** Suggestions shown before "Show more". */
  const FIRST_SUGGESTIONS = 5;
  const MAX_SUGGESTIONS = 10;
  /** Search as you type, once typing pauses this long. */
  const SEARCH_SETTLE_MS = 300;
  /** How often a running merge is asked about. */
  const MERGE_POLL_MS = 2000;

  let loaded = false;
  let audioEnabled = false;
  /** Bound up (read-only for the parent): the book page's Download menu uses it. */
  export let link: AudioLink | null = null;
  let candidates: AudioCandidates | null = null;
  let candidatesError = '';
  let loadError = '';
  let message = '';
  let busy = false;
  let showMore = false;
  /** "Change audiobook" / "Change subtitles" reopen their step. */
  let changingAudio = false;
  let changingSubtitles = false;

  let audioQuery = '';
  let audioResults: AudioFolderSummary[] = [];
  let audioSearched = '';
  let subtitleQuery = '';
  let subtitleResults: SubtitleFileSummary[] = [];
  let subtitleSearched = '';
  let audioTimer: ReturnType<typeof setTimeout> | undefined;
  let subtitleTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTurn = 0;
  let loadedFor = '';
  let destroyed = false;
  /** WP15f: merging on this server, from /audio/status. */
  let mergeInfo: AudioStatus['merge'] = undefined;
  /** WP15f: the folder of several files whose file step is open. */
  let filesFolder: AudioFolderSummary | null = null;
  /** WP15f: the merge shown here (running, or finished while this page was open). */
  let mergeJob: AudioMergeJob | null = null;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;

  $: view = linkView(link);
  $: subView = subtitleView(link);
  $: visible = loaded && (audioEnabled || link !== null || loadError !== '');
  $: showAudioPicker = !filesFolder && (view === 'choose' || changingAudio);
  $: showSubtitlePicker =
    !filesFolder && !showAudioPicker && (subView === 'choose' || changingSubtitles);
  $: merging = mergeActive(mergeJob);
  $: suggestions = (candidates?.audio ?? []).slice(
    0,
    showMore ? MAX_SUGGESTIONS : FIRST_SUGGESTIONS
  );
  $: moreSuggestions = (candidates?.audio.length ?? 0) > FIRST_SUGGESTIONS && !showMore;
  $: audioExtra = withoutIds(audioResults, suggestions);
  $: subtitleSuggestions = candidates?.subtitles ?? [];
  $: subtitleExtra = withoutIds(subtitleResults, subtitleSuggestions);
  $: currentFolderPath = link?.state === 'linked' ? link.folderRelPath : null;
  $: currentSubtitlePath = link?.subtitleState === 'linked' ? link.subtitleRelPath : null;
  $: folderName = link ? linkedFolderName(link) : '';
  $: subtitleName = link ? linkedSubtitleName(link) : '';
  $: changesOff = !audioEnabled;

  $: if (bookId && bookId !== loadedFor) void load(bookId);

  onDestroy(() => {
    destroyed = true;
    clearTimeout(audioTimer);
    clearTimeout(subtitleTimer);
    clearTimeout(mergeTimer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError) {
      if (err.kind === 'unreachable' || err.kind === 'timeout') {
        return 'The library server cannot be reached (offline, or the server is down).';
      }
      if (err.code === 'audio_off') {
        return "The server's audiobooks folder isn't available right now.";
      }
    }
    return (err as Error).message;
  }

  async function load(id: string) {
    loadedFor = id;
    loaded = false;
    loadError = '';
    message = '';
    link = null;
    candidates = null;
    changingAudio = false;
    changingSubtitles = false;
    showMore = false;
    audioQuery = subtitleQuery = '';
    audioResults = subtitleResults = [];
    filesFolder = null;
    mergeJob = null;
    clearTimeout(mergeTimer);
    try {
      const [status, current, merge] = await Promise.all([
        api.audioStatus(),
        api.audioLink(id),
        api.audioMerge(id).catch(() => null)
      ]);
      if (destroyed || loadedFor !== id) return;
      audioEnabled = status.enabled;
      mergeInfo = status.merge;
      link = current;
      // A running merge, or one that failed after the link was last changed.
      if (
        merge &&
        (mergeActive(merge) ||
          (merge.state === 'failed' && (merge.finishedAt ?? 0) > (current?.confirmedAt ?? 0)))
      ) {
        mergeJob = merge;
        if (mergeActive(merge)) scheduleMergePoll();
      }
    } catch (err) {
      if (destroyed || loadedFor !== id) return;
      // Older servers have no audio routes: show nothing.
      if (err instanceof LibraryApiError && err.status === 404 && err.code === 'not_found') {
        audioEnabled = false;
        link = null;
      } else {
        loadError = describe(err);
        logger.warn(`Details: audiobook link: ${loadError}`);
      }
      loaded = true;
      return;
    }
    loaded = true;
    if (audioEnabled && (linkView(link) === 'choose' || subtitleView(link) === 'choose')) {
      await loadCandidates();
    }
  }

  async function loadCandidates() {
    if (!audioEnabled) return;
    const id = bookId;
    candidatesError = '';
    try {
      const result = await api.audioCandidates(id, MAX_SUGGESTIONS);
      if (!destroyed && id === bookId) candidates = result;
    } catch (err) {
      if (!destroyed && id === bookId) candidatesError = describe(err);
    }
  }

  function scheduleAudioSearch() {
    clearTimeout(audioTimer);
    audioTimer = setTimeout(() => void searchAudio(), SEARCH_SETTLE_MS);
  }

  function scheduleSubtitleSearch() {
    clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(() => void searchSubtitles(), SEARCH_SETTLE_MS);
  }

  async function searchAudio() {
    clearTimeout(audioTimer);
    const q = audioQuery.trim();
    const turn = ++searchTurn;
    if (!q) {
      audioResults = [];
      audioSearched = '';
      return;
    }
    try {
      const results = await api.searchAudiobooks(q);
      if (!destroyed && turn === searchTurn) {
        audioResults = results;
        audioSearched = q;
      }
    } catch (err) {
      if (!destroyed && turn === searchTurn) message = describe(err);
    }
  }

  async function searchSubtitles() {
    clearTimeout(subtitleTimer);
    const q = subtitleQuery.trim();
    const turn = ++searchTurn;
    if (!q) {
      subtitleResults = [];
      subtitleSearched = '';
      return;
    }
    try {
      const results = await api.searchSubtitles(q);
      if (!destroyed && turn === searchTurn) {
        subtitleResults = results;
        subtitleSearched = q;
      }
    } catch (err) {
      if (!destroyed && turn === searchTurn) message = describe(err);
    }
  }

  async function save(change: AudioLinkChange | 'delete'): Promise<boolean> {
    if (busy) return false;
    busy = true;
    message = '';
    const id = bookId;
    try {
      if (change === 'delete') {
        await api.deleteAudioLink(id);
        if (id === bookId) link = null;
      } else {
        const saved = await api.putAudioLink(id, change);
        if (id === bookId) link = saved;
      }
      return true;
    } catch (err) {
      message = describe(err);
      logger.warn(`Details: audiobook link change failed: ${message}`);
      return false;
    } finally {
      busy = false;
    }
  }

  async function chooseFolder(folder: AudioFolderSummary) {
    // WP15f: several files: choose one, or merge them (the file step).
    if (!folder.playable) {
      filesFolder = folder;
      return;
    }
    if (link?.state === 'linked' && link.folderRelPath !== folder.relPath) {
      const ok = await confirmDestructive({
        ...replaceAudiobookCopy(folderName, folder.name),
        testid: 'audio-replace-confirm',
        confirmTestid: 'audio-replace-confirm-button'
      });
      if (!ok) return;
    }
    if (await save({ audio: { state: 'linked', folderId: folder.id } })) {
      changingAudio = false;
      resetSearches();
      if (subtitleView(link) === 'choose' && !candidates) await loadCandidates();
    }
  }

  /** WP15f: links one file of a folder of several. */
  async function useFile(folder: AudioFolderSummary, fileName: string) {
    if (link?.state === 'linked') {
      const sameFolder = link.folderRelPath === folder.relPath;
      // Choosing a file for a whole-folder link only completes it; anything else replaces.
      if (!sameFolder || (link.fileName !== null && link.fileName !== fileName)) {
        const ok = await confirmDestructive({
          ...replaceAudiobookCopy(
            sameFolder && link.fileName ? link.fileName : folderName,
            sameFolder ? fileName : folder.name
          ),
          testid: 'audio-replace-confirm',
          confirmTestid: 'audio-replace-confirm-button'
        });
        if (!ok) return;
      }
    }
    if (await save({ audio: { state: 'linked', folderId: folder.id, fileName } })) {
      filesFolder = null;
      changingAudio = false;
      resetSearches();
      if (subtitleView(link) === 'choose' && !candidates) await loadCandidates();
    }
  }

  function openFiles(folder: AudioFolderSummary | null) {
    if (!folder) return;
    filesFolder = folder;
    changingSubtitles = false;
  }

  function closeFiles() {
    filesFolder = null;
  }

  // ---- WP15f: merges

  function onMergeStarted(job: AudioMergeJob) {
    mergeJob = job;
    filesFolder = null;
    changingAudio = false;
    resetSearches();
    scheduleMergePoll();
  }

  function scheduleMergePoll() {
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(() => void pollMerge(), MERGE_POLL_MS);
  }

  async function pollMerge() {
    const id = bookId;
    const watching = mergeJob?.id;
    if (watching === undefined) return;
    let job: AudioMergeJob | null;
    try {
      job = await api.audioMerge(id);
    } catch {
      // Offline for a moment: ask again later.
      if (!destroyed && id === bookId) scheduleMergePoll();
      return;
    }
    if (destroyed || id !== bookId || !job || job.id !== watching) return;
    mergeJob = job;
    if (mergeActive(job)) {
      scheduleMergePoll();
      return;
    }
    if (job.state === 'done') {
      try {
        link = await api.audioLink(id);
        mergeInfo = (await api.audioStatus()).merge;
      } catch (err) {
        message = describe(err);
      }
      if (subtitleView(link) === 'choose' && !candidates) await loadCandidates();
    }
  }

  async function stopMerge() {
    if (!mergeJob) return;
    const ok = await confirmDestructive({
      ...stopMergeCopy(mergeJob.folderName),
      testid: 'audio-merge-stop-confirm',
      confirmTestid: 'audio-merge-stop-confirm-button'
    });
    if (!ok || !mergeJob) return;
    try {
      mergeJob = await api.cancelAudioMerge(mergeJob.id);
      if (mergeActive(mergeJob)) scheduleMergePoll();
    } catch (err) {
      message = describe(err);
    }
  }

  async function chooseNoAudiobook() {
    if (link?.state === 'linked') {
      const ok = await confirmDestructive({
        ...noAudiobookCopy(folderName),
        testid: 'audio-none-confirm',
        confirmTestid: 'audio-none-confirm-button'
      });
      if (!ok) return;
    }
    if (await save({ audio: { state: 'none' } })) {
      changingAudio = false;
      resetSearches();
    }
  }

  /** From "No audiobook": not destructive (it only brings the suggestions back). */
  async function findAgain() {
    if (await save('delete')) await loadCandidates();
  }

  async function unlink() {
    const ok = await confirmDestructive({
      ...unlinkAudiobookCopy(folderName),
      testid: 'audio-unlink-confirm',
      confirmTestid: 'audio-unlink-confirm-button'
    });
    if (!ok) return;
    if (await save('delete')) {
      changingAudio = changingSubtitles = false;
      await loadCandidates();
    }
  }

  async function chooseSubtitle(file: SubtitleFileSummary) {
    if (link?.subtitleState === 'linked' && link.subtitleRelPath !== file.relPath) {
      const ok = await confirmDestructive({
        ...replaceSubtitlesCopy(subtitleName, file.name),
        testid: 'subtitle-replace-confirm',
        confirmTestid: 'subtitle-replace-confirm-button'
      });
      if (!ok) return;
    }
    if (await save({ subtitle: { state: 'linked', subtitleId: file.id } })) {
      changingSubtitles = false;
      resetSearches();
    }
  }

  async function chooseNoSubtitles() {
    if (link?.subtitleState === 'linked') {
      const ok = await confirmDestructive({
        ...removeSubtitlesCopy(subtitleName),
        testid: 'subtitle-remove-confirm',
        confirmTestid: 'subtitle-remove-confirm-button'
      });
      if (!ok) return;
    }
    if (await save({ subtitle: { state: 'none' } })) {
      changingSubtitles = false;
      resetSearches();
    }
  }

  /** WP16: the subtitles made on the PC are ready and the server linked them. */
  async function onSubtitlesMade() {
    const id = bookId;
    try {
      const fresh = await api.audioLink(id);
      if (!destroyed && id === bookId) {
        link = fresh;
        changingSubtitles = false;
      }
    } catch (err) {
      message = describe(err);
    }
  }

  function startChangingAudio() {
    changingAudio = true;
    changingSubtitles = false;
    resetSearches();
    if (!candidates) void loadCandidates();
  }

  function startChangingSubtitles() {
    changingSubtitles = true;
    resetSearches();
    if (!candidates) void loadCandidates();
  }

  function cancelChange() {
    changingAudio = changingSubtitles = false;
    resetSearches();
  }

  function resetSearches() {
    clearTimeout(audioTimer);
    clearTimeout(subtitleTimer);
    searchTurn++;
    audioQuery = subtitleQuery = '';
    audioResults = subtitleResults = [];
    audioSearched = subtitleSearched = '';
  }

  function folderNote(f: AudioFolderSummary): string {
    return f.playable ? '' : severalFilesNote(f.fileCount);
  }

  /**
   * "Linked now" instead of "Use this": only for a single-file folder. A folder of several
   * files keeps its button, so another of its files can be chosen (its file step marks the
   * linked file).
   */
  $: isCurrentFolder = (f: AudioFolderSummary): boolean =>
    f.playable && f.relPath === currentFolderPath;
</script>

{#if visible}
  <section class="mt-12" aria-labelledby="details-audio" data-testid="details-audio">
    <div class="flex items-center gap-4">
      <h2 id="details-audio" class="flex items-baseline gap-3">
        <span class="font-mincho text-2xl font-bold">Audiobook</span>
        <span class="c-jp-label text-xs" aria-hidden="true">朗読</span>
      </h2>
      <span class="c-section-rule" />
      <a
        class="c-link min-h-[3rem] shrink-0 text-sm leading-[3rem]"
        href={settingsTabHref(pagePath, 'Audiobooks')}
        data-testid="details-audio-all">All audiobooks</a
      >
    </div>

    {#if loadError}
      <p class="c-notice mt-4" role="alert" data-testid="audio-load-error">
        {loadError}
        <button class="c-link ml-2 min-h-[2.75rem]" on:click={() => load(bookId)}>Try again</button>
      </p>
    {:else}
      {#if message}
        <p class="c-notice mt-4" role="alert" data-testid="audio-message">{message}</p>
      {/if}

      <!-- WP15f: a merge running on the server, or how it ended -->
      {#if mergeJob}
        <div
          class="c-apanel mt-4 rounded px-5 py-4"
          data-testid="audio-merge"
          data-state={mergeJob.state}
        >
          <div class="text-xs text-c-muted">Merge into one file</div>
          <div class="break-words font-mincho text-lg font-bold leading-snug">
            {mergeJob.folderName}
          </div>
          <p class="mt-1 text-sm" role="status" aria-live="polite" data-testid="audio-merge-text">
            {mergeStatusText(mergeJob)}
          </p>
          {#if merging}
            <div
              class="c-mbar mt-2"
              role="progressbar"
              aria-label="Merge progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.floor(mergeJob.progress * 100)}
            >
              <div style="width: {Math.floor(mergeJob.progress * 100)}%" />
            </div>
            <p class="mt-2 text-sm text-c-muted">
              The merge goes on when you leave this page. Joining a long audiobook can take a few
              minutes.
            </p>
            <div class="mt-3">
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="audio-merge-stop"
                on:click={stopMerge}
              >
                Stop merge
              </button>
            </div>
          {:else}
            <div class="mt-3">
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="audio-merge-dismiss"
                on:click={() => (mergeJob = null)}
              >
                OK
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- The current link -->
      {#if view === 'none' && !changingAudio}
        <div class="c-apanel mt-4 rounded px-5 py-4" data-testid="audio-none">
          <p class="text-[15px]">No audiobook for this book.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="audio-find-again"
              disabled={busy || changesOff}
              on:click={findAgain}
            >
              Find an audiobook
            </button>
          </div>
        </div>
      {:else if link && link.state === 'linked'}
        <div class="c-apanel mt-4 rounded px-5 py-4" data-testid="audio-linked">
          <div class="text-xs text-c-muted">Linked audiobook</div>
          <div
            class="break-words font-mincho text-lg font-bold leading-snug"
            data-testid="audio-linked-name"
          >
            {folderName}
          </div>
          {#if link.folder?.parentName}
            <div class="break-words text-xs text-c-muted">in {link.folder.parentName}</div>
          {/if}
          {#if link.fileName && link.folder && link.folder.fileCount > 1 && view !== 'missing'}
            <div class="break-all text-sm font-medium" data-testid="audio-linked-file">
              File: {link.fileName}
            </div>
          {/if}
          {#if link.folder && view !== 'missing'}
            <div class="mt-0.5 text-sm text-c-muted" data-testid="audio-linked-details">
              {linkDetails(link)}
            </div>
          {/if}
          {#if view === 'split' && link.folder}
            <p class="mt-2 text-sm font-medium" data-testid="audio-split">
              {splitNotice(link.folder.fileCount)}
            </p>
            <div class="mt-2">
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="audio-split-choose"
                disabled={busy || changesOff || !!filesFolder}
                on:click={() => openFiles(link?.folder ?? null)}
              >
                Choose a file or merge
              </button>
            </div>
          {:else if view === 'missing'}
            <p class="mt-2 text-sm font-semibold" data-testid="audio-missing">
              {MISSING_NOTICE}
            </p>
          {:else if view === 'changed'}
            <p class="mt-2 text-sm font-semibold" data-testid="audio-changed">
              {CHANGED_NOTICE}
            </p>
          {/if}

          <div class="mt-3 border-t border-dashed pt-3" style="border-color: var(--c-line)">
            <div class="text-xs text-c-muted">Subtitles</div>
            {#if subView === 'linked' || subView === 'missing'}
              <div class="break-words text-sm font-medium" data-testid="audio-subtitle-name">
                {subtitleName}
              </div>
              {#if subView === 'missing'}
                <p class="text-sm font-semibold" data-testid="audio-subtitle-missing">
                  {SUBTITLE_MISSING_NOTICE}
                </p>
              {/if}
            {:else if subView === 'none'}
              <div class="text-sm" data-testid="audio-subtitle-none">No subtitles</div>
            {:else}
              <div class="text-sm text-c-muted" data-testid="audio-subtitle-pending">
                Not chosen yet
              </div>
            {/if}
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="audio-change"
              disabled={busy || changesOff || changingAudio}
              on:click={startChangingAudio}
            >
              Change audiobook
            </button>
            {#if subView !== 'choose'}
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="audio-change-subtitles"
                disabled={busy || changesOff || changingSubtitles}
                on:click={startChangingSubtitles}
              >
                Change subtitles
              </button>
            {/if}
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="audio-unlink"
              disabled={busy}
              on:click={unlink}
            >
              Unlink
            </button>
          </div>
          {#if changesOff}
            <p class="mt-2 text-sm text-c-muted" data-testid="audio-changes-off">
              The server's audiobooks folder isn't available right now, so the audiobook can't be
              changed.
            </p>
          {/if}
        </div>
      {/if}

      <!-- WP16: subtitles made on the PC (SubPlz) -->
      {#if link && link.state === 'linked' && !changingAudio && !filesFolder}
        <SubtitleJobPanel
          {api}
          {bookId}
          {link}
          {audioEnabled}
          busy={busy || merging}
          on:linked={onSubtitlesMade}
          on:chooseSubtitle={(ev) => chooseSubtitle(ev.detail)}
        />
      {/if}

      <!-- WP15f: an audiobook in several files: one file, or a merge -->
      {#if filesFolder && audioEnabled}
        <AudioFilesStep
          {api}
          {bookId}
          folder={filesFolder}
          currentFileName={link?.state === 'linked' && link.folderRelPath === filesFolder.relPath
            ? link.fileName
            : null}
          merge={mergeInfo}
          busy={busy || merging}
          on:useFile={(ev) => useFile(ev.detail.folder, ev.detail.fileName)}
          on:mergeStarted={(ev) => onMergeStarted(ev.detail)}
          on:cancel={closeFiles}
        />
      {/if}

      <!-- Step 1: the audiobook -->
      {#if showAudioPicker && audioEnabled}
        <div class="mt-4" data-testid="audio-picker">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="font-mincho text-lg font-bold">
              {changingAudio ? 'Choose another audiobook' : 'Choose the audiobook for this book'}
            </h3>
            {#if changingAudio}
              <button
                class="c-link min-h-[2.75rem] text-sm"
                data-testid="audio-cancel-change"
                on:click={cancelChange}>Cancel</button
              >
            {/if}
          </div>
          <p class="text-sm text-c-muted">
            Nothing is linked until you press “Use this”. The link is the same on every device.
          </p>
          {#if candidatesError}
            <p class="c-notice mt-3" role="alert">{candidatesError}</p>
          {:else if !candidates}
            <p class="mt-3 text-sm text-c-muted">Looking for suggestions…</p>
          {:else if suggestions.length === 0}
            <p class="mt-3 text-sm" data-testid="audio-no-suggestions">
              {candidates.libraryHasAudio
                ? 'No suggestions for this book. Search below.'
                : "This book's library has no audiobooks folder. Search below."}
            </p>
          {:else}
            <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="audio-suggestions">
              {#each suggestions as folder (folder.id)}
                <AudioChoiceRow
                  name={folder.name}
                  parent={folder.parentName}
                  details={folderDetails(folder)}
                  note={folderNote(folder)}
                  current={isCurrentFolder(folder)}
                  disabled={busy}
                  testid="audio-suggestion"
                  on:choose={() => chooseFolder(folder)}
                />
              {/each}
            </ul>
            {#if moreSuggestions}
              <button
                class="c-link min-h-[2.75rem] text-sm"
                data-testid="audio-show-more"
                on:click={() => (showMore = true)}>Show more</button
              >
            {/if}
          {/if}

          <form
            class="mt-4 flex w-full max-w-xl items-stretch gap-2"
            role="search"
            on:submit|preventDefault={searchAudio}
          >
            <label class="c-input flex min-w-0 grow items-center gap-2">
              <span class="text-c-muted" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
              <span class="sr-only">Search all audiobooks</span>
              <input
                class="w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
                type="search"
                enterkeyhint="search"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Search all audiobooks"
                data-testid="audio-search"
                bind:value={audioQuery}
                on:input={scheduleAudioSearch}
              />
            </label>
            <button class="c-btn c-btn-secondary px-4" type="submit" title="Search">
              <Fa icon={faMagnifyingGlass} />
              <span class="sr-only">Search</span>
            </button>
          </form>
          {#if audioSearched}
            {#if audioExtra.length}
              <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="audio-results">
                {#each audioExtra as folder (folder.id)}
                  <AudioChoiceRow
                    name={folder.name}
                    parent={folder.parentName}
                    details={folderDetails(folder)}
                    note={folderNote(folder)}
                    current={isCurrentFolder(folder)}
                    disabled={busy}
                    testid="audio-result"
                    on:choose={() => chooseFolder(folder)}
                  />
                {/each}
              </ul>
            {:else}
              <p class="mt-2 text-sm text-c-muted" data-testid="audio-no-results">
                {audioResults.length
                  ? 'Only the suggestions above match.'
                  : `No audiobook matches “${audioSearched}”.`}
              </p>
            {/if}
          {/if}

          {#if view !== 'none'}
            <div class="mt-4">
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="audio-choose-none"
                disabled={busy}
                on:click={chooseNoAudiobook}
              >
                No audiobook
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Step 2: the subtitles -->
      {#if showSubtitlePicker && audioEnabled}
        <div class="mt-4" data-testid="subtitle-picker">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="font-mincho text-lg font-bold">Subtitles for this audiobook</h3>
            {#if changingSubtitles}
              <button
                class="c-link min-h-[2.75rem] text-sm"
                data-testid="subtitle-cancel-change"
                on:click={cancelChange}>Cancel</button
              >
            {/if}
          </div>
          <p class="text-sm text-c-muted">
            Choose the subtitle file that goes with the audiobook, or “No subtitles”.
          </p>
          {#if candidatesError}
            <p class="c-notice mt-3" role="alert">{candidatesError}</p>
          {:else if !candidates}
            <p class="mt-3 text-sm text-c-muted">Looking for suggestions…</p>
          {:else if subtitleSuggestions.length === 0}
            <p class="mt-3 text-sm" data-testid="subtitle-no-suggestions">
              {candidates.libraryHasSubtitles
                ? 'No suggestions. Search below.'
                : "This book's library has no subtitle folder. Search below."}
            </p>
          {:else}
            <ul
              class="mt-2 divide-y divide-dashed divide-c-line"
              data-testid="subtitle-suggestions"
            >
              {#each subtitleSuggestions as file (file.id)}
                <AudioChoiceRow
                  name={file.name}
                  details={subtitleDetails(file)}
                  current={file.relPath === currentSubtitlePath}
                  disabled={busy}
                  testid="subtitle-suggestion"
                  on:choose={() => chooseSubtitle(file)}
                />
              {/each}
            </ul>
          {/if}

          <form
            class="mt-4 flex w-full max-w-xl items-stretch gap-2"
            role="search"
            on:submit|preventDefault={searchSubtitles}
          >
            <label class="c-input flex min-w-0 grow items-center gap-2">
              <span class="text-c-muted" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
              <span class="sr-only">Search all subtitle files</span>
              <input
                class="w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
                type="search"
                enterkeyhint="search"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Search all subtitle files"
                data-testid="subtitle-search"
                bind:value={subtitleQuery}
                on:input={scheduleSubtitleSearch}
              />
            </label>
            <button class="c-btn c-btn-secondary px-4" type="submit" title="Search">
              <Fa icon={faMagnifyingGlass} />
              <span class="sr-only">Search</span>
            </button>
          </form>
          {#if subtitleSearched}
            {#if subtitleExtra.length}
              <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="subtitle-results">
                {#each subtitleExtra as file (file.id)}
                  <AudioChoiceRow
                    name={file.name}
                    details={subtitleDetails(file)}
                    current={file.relPath === currentSubtitlePath}
                    disabled={busy}
                    testid="subtitle-result"
                    on:choose={() => chooseSubtitle(file)}
                  />
                {/each}
              </ul>
            {:else}
              <p class="mt-2 text-sm text-c-muted" data-testid="subtitle-no-results">
                {subtitleResults.length
                  ? 'Only the suggestions above match.'
                  : `No subtitle file matches “${subtitleSearched}”.`}
              </p>
            {/if}
          {/if}

          {#if subView !== 'none'}
            <div class="mt-4">
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="subtitle-choose-none"
                disabled={busy}
                on:click={chooseNoSubtitles}
              >
                No subtitles
              </button>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .c-apanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
  }

  .c-mbar {
    height: 0.75rem;
    border: var(--c-border-width) solid currentColor;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .c-mbar > div {
    height: 100%;
    background-color: currentColor;
    transition: width 0.3s;
  }
</style>
