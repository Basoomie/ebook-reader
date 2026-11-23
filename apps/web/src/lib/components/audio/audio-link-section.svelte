<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book details page's "Audiobook" section.
   *
   * Redesigned with the user (2026-11-20): one box with three rows, one open at a time:
   * - Audiobook: what is linked, a merge's progress, the offline copy on this device; open,
   *   the chooser (suggestions, search, "No audiobook for this book", "Make one with
   *   text-to-speech") or the file step of an audiobook in several files (WP15f).
   * - Subtitles: the subtitle file; open, its chooser and "Make subtitles on your PC" (WP16).
   * - Text-to-speech: the book's TTS voice (Season 2 Phase 12), "Make an audiobook with this
   *   voice" (WP17), Characters and Pronunciation fixes.
   * A closed row shows a short summary and the status of its running jobs. Every row starts
   * closed (user, 2026-11-23); after a choice the next thing to choose opens by itself (the
   * audiobook, then its subtitles: WP15b's separate subtitle step).
   *
   * WP15b rules kept: nothing is linked until "Use this"; replacing and removing ask first;
   * the link is the same on every device. Loads after the page and never blocks it; its
   * problems show only in here. `link` is bindable so the page's Download menu follows every
   * change made here.
   */
  import { tick, onDestroy } from 'svelte';
  import AudioChooser from '$lib/components/audio/audio-chooser.svelte';
  import AudioFilesStep from '$lib/components/audio/audio-files-step.svelte';
  import SubtitleJobPanel from '$lib/components/audio/subtitle-job-panel.svelte';
  import AudiobookJobPanel from '$lib/components/audio/audiobook-job-panel.svelte';
  import BookPronunciationPanel from '$lib/components/audio/book-pronunciation-panel.svelte';
  import BookVoiceChoice from '$lib/components/audio/book-voice-choice.svelte';
  import BookSpeakersPanel from '$lib/components/audio/book-speakers-panel.svelte';
  import AudioDevicePanel from '$lib/components/audio/audio-device-panel.svelte';
  import WhispersyncMatchPanel from '$lib/components/audio/whispersync-match-panel.svelte';
  import type { LibraryStore } from '$lib/library/library-db';
  import type { OpenTarget } from '$lib/library/open-calibre-book';
  import type { CatalogLibrary } from '$lib/library/types';
  import { storedAudio } from '$lib/audio/offline/audio-offline';
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
    subtitleView
  } from '$lib/audio/audio-link';
  import {
    audioRowButton,
    rowToOpen,
    subtitleRowButton,
    ttsCountsText,
    ttsVoiceText,
    type SectionRow
  } from '$lib/audio/audio-section-text';
  import type {
    AudioCandidates,
    AudioFolderSummary,
    AudioLink,
    AudioLinkChange,
    AudioMergeJob,
    AudioStatus,
    SubtitleFileSummary
  } from '$lib/audio/audio-types';
  import type { BookVoiceChoices } from '$lib/audio/tts-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    noAudiobookCopy,
    removeSubtitlesCopy,
    replaceAudiobookCopy,
    replaceSubtitlesCopy,
    stopMergeCopy
  } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { settingsTabHref } from '$lib/settings/settings-tab';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  export let bookId: string;
  /**
   * Season 2 Phase 9: the book's own copy is on this device (audio downloads need it). Bound:
   * Whispersync Match stores the book here when it isn't (2026-11-21).
   */
  export let bookOnDevice = false;
  /** Whispersync Match on the book page: what it needs to store the book on this device. */
  export let book: OpenTarget | null = null;
  export let store: LibraryStore | null = null;
  export let libraries: readonly CatalogLibrary[] = [];
  /** Bound up (read-only for the parent): the book page's Download menu uses it. */
  export let link: AudioLink | null = null;

  /** Suggestions asked for (the chooser shows them 5 a page). */
  const MAX_SUGGESTIONS = 10;
  /** How often a running merge is asked about. */
  const MERGE_POLL_MS = 2000;

  /** Season 2 Phase 9: audio of this book is stored on this device (shows the section). */
  let hasAudioCopy = false;
  let loaded = false;
  let audioEnabled = false;
  let candidates: AudioCandidates | null = null;
  let candidatesError = '';
  let loadError = '';
  let message = '';
  let busy = false;
  let loadedFor = '';
  let destroyed = false;
  /** The open row; null = all closed. */
  let open: SectionRow | null = null;
  /** WP15f: merging on this server, from /audio/status. */
  let mergeInfo: AudioStatus['merge'] = undefined;
  /** WP15f: the folder of several files whose file step is open (in the Audiobook row). */
  let filesFolder: AudioFolderSummary | null = null;
  /** WP15f: the merge shown here (running, or finished while this page was open). */
  let mergeJob: AudioMergeJob | null = null;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The book's TTS voice; null = text-to-speech isn't set up (the row is left out). */
  let voiceChoices: BookVoiceChoices | null = null;
  let jobPanel: AudiobookJobPanel | undefined;
  /** The PC can make an audiobook (bound up from the job panel). */
  let canMakeAudiobook = false;
  let characterCount: number | null = null;
  let fixCount: number | null = null;

  $: view = linkView(link);
  $: subView = subtitleView(link);
  $: visible = loaded && (audioEnabled || link !== null || loadError !== '' || hasAudioCopy);
  $: merging = mergeActive(mergeJob);
  $: linked = link?.state === 'linked';
  $: currentFolderPath = link?.state === 'linked' ? link.folderRelPath : null;
  $: currentSubtitlePath = link?.subtitleState === 'linked' ? link.subtitleRelPath : null;
  $: folderName = link ? linkedFolderName(link) : '';
  $: subtitleName = link ? linkedSubtitleName(link) : '';
  $: changesOff = !audioEnabled;
  $: ttsCounts = ttsCountsText(characterCount, fixCount);
  /** Whispersync Match: when an audiobook and a subtitle file are linked (user, 2026-11-21). */
  $: canMatch = linked && subView === 'linked' && !!book && !!store;
  /** The saved match on the server (bound up from the Match panel). */
  let matchState: 'matched' | 'not-matched' | 'pending' | null = null;

  /**
   * A row in the audiobook chooser. "In use" instead of "Use this" only for a single-file
   * folder: a folder of several files keeps its button, so another of its files can be
   * chosen (its file step marks the linked file).
   */
  $: audioRow = (f: AudioFolderSummary) => ({
    name: f.name,
    parent: f.parentName,
    details: folderDetails(f),
    note: f.playable ? '' : severalFilesNote(f.fileCount),
    current: f.playable && f.relPath === currentFolderPath
  });
  $: subtitleRow = (f: SubtitleFileSummary) => ({
    name: f.name,
    details: subtitleDetails(f),
    current: f.relPath === currentSubtitlePath
  });

  $: if (bookId && bookId !== loadedFor) void load(bookId);

  onDestroy(() => {
    destroyed = true;
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
    open = null;
    filesFolder = null;
    mergeJob = null;
    voiceChoices = null;
    clearTimeout(mergeTimer);
    hasAudioCopy = !!(await storedAudio(id));
    void loadVoiceChoices(id);
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
    // The section starts closed (user, 2026-11-23); the next step still opens by itself after
    // a choice made here (openNext from save and a finished merge).
  }

  /** The book's TTS voice, for the Text-to-speech row (absent: the row is left out). */
  async function loadVoiceChoices(id: string) {
    try {
      const choices = await api.bookVoiceChoice(id);
      if (!destroyed && id === loadedFor) voiceChoices = choices;
    } catch {
      // Not set up on this server (503), or an older one (404): no Text-to-speech row.
    }
  }

  /** Opens the next thing to choose, if any (the audiobook, then its subtitles). */
  async function openNext() {
    open = audioEnabled ? rowToOpen(linkView(link), subtitleView(link)) : null;
    if (open === 'audio' || open === 'subs') await loadCandidates();
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

  function toggle(row: SectionRow) {
    message = '';
    if (open === row) {
      open = null;
      filesFolder = null;
      return;
    }
    open = row;
    filesFolder = null;
    if ((row === 'audio' || row === 'subs') && !candidates) void loadCandidates();
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

  /** After the audiobook changed: its subtitles are next when they aren't chosen. */
  async function afterAudioChange() {
    filesFolder = null;
    candidates = null;
    await openNext();
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
    if (await save({ audio: { state: 'linked', folderId: folder.id } })) await afterAudioChange();
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
      await afterAudioChange();
    }
  }

  /** The split notice's "Choose a file or merge": the Audiobook row at its file step. */
  function openFiles(folder: AudioFolderSummary | null) {
    if (!folder) return;
    open = 'audio';
    filesFolder = folder;
  }

  // ---- WP15f: merges

  function onMergeStarted(job: AudioMergeJob) {
    mergeJob = job;
    filesFolder = null;
    open = null;
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
      if (open === null) await openNext();
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
      open = null;
      filesFolder = null;
    }
  }

  /** "Make one with text-to-speech": the Text-to-speech row with the form open. */
  async function makeWithTts() {
    open = 'tts';
    filesFolder = null;
    await tick();
    await jobPanel?.openForm();
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
    if (await save({ subtitle: { state: 'linked', subtitleId: file.id } })) open = null;
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
    if (await save({ subtitle: { state: 'none' } })) open = null;
  }

  /**
   * WP16: the subtitles made on the PC are ready and the server linked them.
   * WP17: also an audiobook made on the PC (with its subtitles).
   */
  async function onMade() {
    const id = bookId;
    try {
      const fresh = await api.audioLink(id);
      if (!destroyed && id === bookId) {
        link = fresh;
        if (open !== 'tts') open = null;
        filesFolder = null;
      }
    } catch (err) {
      message = describe(err);
    }
  }
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
      <div class="c-apanel mt-4 rounded px-5 pb-4">
        <AudioDevicePanel
          {bookId}
          link={null}
          linkKnown={false}
          {bookOnDevice}
          bind:hasCopy={hasAudioCopy}
        />
      </div>
    {:else}
      {#if message}
        <p class="c-notice mt-4" role="alert" data-testid="audio-message">{message}</p>
      {/if}

      <div class="c-apanel mt-4 rounded" data-testid="audio-rows">
        <!-- The audiobook -->
        <div
          class="c-arow px-5 py-4"
          data-testid="audio-row-audio"
          data-open={open === 'audio' ? 'true' : 'false'}
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-xs text-c-muted">Audiobook</h3>
              {#if view === 'choose'}
                <p class="text-[15px]" data-testid="audio-choose">
                  {open === 'audio'
                    ? 'Choose the audiobook for this book. Nothing is linked until you press “Use this”.'
                    : 'No audiobook chosen yet.'}
                </p>
              {:else if view === 'none'}
                <p class="text-[15px]" data-testid="audio-none">No audiobook for this book.</p>
              {:else if link && link.state === 'linked'}
                <div data-testid="audio-linked">
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
                </div>
              {/if}
            </div>
            {#if open === 'audio'}
              <button
                class="c-btn c-btn-ghost shrink-0"
                aria-expanded="true"
                data-testid="audio-row-audio-toggle"
                on:click={() => toggle('audio')}
              >
                Close
              </button>
            {:else}
              <button
                class="c-btn c-btn-secondary shrink-0"
                aria-expanded="false"
                data-testid="audio-row-audio-toggle"
                disabled={busy || changesOff}
                on:click={() => toggle('audio')}
              >
                {audioRowButton(view)}
              </button>
            {/if}
          </div>

          {#if view === 'split' && link?.folder && open !== 'audio'}
            <p class="mt-2 text-sm font-medium" data-testid="audio-split">
              {splitNotice(link.folder.fileCount)}
            </p>
            <div class="mt-2">
              <button
                class="c-btn c-btn-secondary"
                data-testid="audio-split-choose"
                disabled={busy || changesOff}
                on:click={() => openFiles(link?.folder ?? null)}
              >
                Choose a file or merge
              </button>
            </div>
          {:else if view === 'missing'}
            <p class="mt-2 text-sm font-semibold" data-testid="audio-missing">{MISSING_NOTICE}</p>
          {:else if view === 'changed'}
            <p class="mt-2 text-sm font-semibold" data-testid="audio-changed">{CHANGED_NOTICE}</p>
          {/if}
          {#if changesOff && open !== 'audio'}
            <p class="mt-2 text-sm text-c-muted" data-testid="audio-changes-off">
              The server's audiobooks folder isn't available right now, so the audiobook can't be
              changed.
            </p>
          {/if}

          <!-- WP15f: a merge running on the server, or how it ended -->
          {#if mergeJob}
            <div class="mt-3" data-testid="audio-merge" data-state={mergeJob.state}>
              <p class="text-sm" role="status" aria-live="polite" data-testid="audio-merge-text">
                Merging {mergeJob.folderName}: {mergeStatusText(mergeJob)}
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
                  The merge goes on when you leave this page. Joining a long audiobook can take a
                  few minutes.
                </p>
                <div class="mt-2">
                  <button
                    class="c-btn c-btn-secondary"
                    data-testid="audio-merge-stop"
                    on:click={stopMerge}
                  >
                    Stop merge
                  </button>
                </div>
              {:else}
                <div class="mt-2">
                  <button
                    class="c-btn c-btn-ghost"
                    data-testid="audio-merge-dismiss"
                    on:click={() => (mergeJob = null)}
                  >
                    OK
                  </button>
                </div>
              {/if}
            </div>
          {/if}

          {#if open === 'audio'}
            {#if filesFolder && audioEnabled}
              <!-- WP15f: an audiobook in several files: one file, or a merge -->
              <AudioFilesStep
                {api}
                {bookId}
                folder={filesFolder}
                currentFileName={link?.state === 'linked' &&
                link.folderRelPath === filesFolder.relPath
                  ? link.fileName
                  : null}
                merge={mergeInfo}
                busy={busy || merging}
                on:useFile={(ev) => useFile(ev.detail.folder, ev.detail.fileName)}
                on:mergeStarted={(ev) => onMergeStarted(ev.detail)}
                on:cancel={() => (filesFolder = null)}
              />
            {:else if audioEnabled}
              <AudioChooser
                suggestions={candidates?.audio ?? null}
                suggestionsError={candidatesError}
                suggestionsTitle="Suggested for this book"
                noSuggestionsText={candidates?.libraryHasAudio === false
                  ? "This book's library has no audiobooks folder."
                  : 'No suggestions for this book.'}
                searchLabel="Search all audiobooks"
                noun="audiobook"
                search={(q) => api.searchAudiobooks(q)}
                row={audioRow}
                disabled={busy}
                testid="audio"
                showOr={view !== 'none' || canMakeAudiobook}
                on:choose={(ev) => chooseFolder(ev.detail)}
                on:error={(ev) => (message = ev.detail)}
              >
                {#if view !== 'none'}
                  <button
                    class="c-btn c-btn-ghost"
                    data-testid="audio-choose-none"
                    disabled={busy}
                    on:click={chooseNoAudiobook}
                  >
                    No audiobook for this book
                  </button>
                {/if}
                {#if canMakeAudiobook}
                  <button
                    class="c-btn c-btn-secondary"
                    data-testid="audio-make-tts"
                    disabled={busy}
                    on:click={makeWithTts}
                  >
                    Make one with text-to-speech
                  </button>
                {/if}
              </AudioChooser>
            {/if}
          {:else}
            <!-- Season 2 Phase 9: the audio on this device -->
            <AudioDevicePanel
              {bookId}
              {link}
              linkKnown
              {bookOnDevice}
              bind:hasCopy={hasAudioCopy}
            />
          {/if}
        </div>

        <!-- The subtitles (for a linked audiobook) -->
        {#if linked || view === 'choose'}
          <div
            class="c-arow px-5 py-4"
            data-testid="audio-row-subs"
            data-open={open === 'subs' ? 'true' : 'false'}
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-xs text-c-muted">Subtitles</h3>
                {#if !linked}
                  <p class="text-sm text-c-muted" data-testid="audio-subtitle-later">
                    Choose the audiobook first.
                  </p>
                {:else if subView === 'linked' || subView === 'missing'}
                  <div class="break-words text-sm font-medium" data-testid="audio-subtitle-name">
                    {subtitleName}
                  </div>
                  {#if subView === 'missing'}
                    <p class="text-sm font-semibold" data-testid="audio-subtitle-missing">
                      {SUBTITLE_MISSING_NOTICE}
                    </p>
                  {/if}
                  {#if canMatch && matchState}
                    <div
                      class="text-sm text-c-muted"
                      data-testid="ws-match-state"
                      data-state={matchState}
                    >
                      {matchState === 'not-matched' ? 'Not matched yet' : 'Matched'}
                    </div>
                  {/if}
                {:else if subView === 'none'}
                  <div class="text-sm" data-testid="audio-subtitle-none">No subtitles</div>
                {:else}
                  <div class="text-sm" data-testid="audio-subtitle-pending">
                    {open === 'subs'
                      ? 'Choose the subtitle file that goes with the audiobook.'
                      : 'Not chosen yet'}
                  </div>
                {/if}
              </div>
              {#if linked}
                {#if open === 'subs'}
                  <button
                    class="c-btn c-btn-ghost shrink-0"
                    aria-expanded="true"
                    data-testid="audio-row-subs-toggle"
                    on:click={() => toggle('subs')}
                  >
                    Close
                  </button>
                {:else}
                  <button
                    class="c-btn c-btn-secondary shrink-0"
                    aria-expanded="false"
                    data-testid="audio-row-subs-toggle"
                    disabled={busy || changesOff}
                    on:click={() => toggle('subs')}
                  >
                    {subtitleRowButton(subView)}
                  </button>
                {/if}
              {/if}
            </div>

            <!-- Whispersync Match: the reader's matcher, from the book page (2026-11-21) -->
            {#if canMatch && book && store && open !== 'subs'}
              <WhispersyncMatchPanel
                {api}
                {bookId}
                {book}
                {store}
                {libraries}
                bind:state={matchState}
                on:stored={() => (bookOnDevice = true)}
              />
            {/if}

            {#if open === 'subs' && audioEnabled}
              <AudioChooser
                suggestions={candidates?.subtitles ?? null}
                suggestionsError={candidatesError}
                suggestionsTitle="Suggested for this audiobook"
                noSuggestionsText={candidates?.libraryHasSubtitles === false
                  ? "This book's library has no subtitle folder."
                  : 'No suggestions.'}
                searchLabel="Search all subtitle files"
                noun="subtitle file"
                search={(q) => api.searchSubtitles(q)}
                row={subtitleRow}
                disabled={busy}
                testid="subtitle"
                showOr={subView !== 'none'}
                on:choose={(ev) => chooseSubtitle(ev.detail)}
                on:error={(ev) => (message = ev.detail)}
              >
                <button
                  class="c-btn c-btn-ghost"
                  data-testid="subtitle-choose-none"
                  disabled={busy}
                  on:click={chooseNoSubtitles}
                >
                  No subtitles
                </button>
              </AudioChooser>
            {/if}

            <!-- WP16: subtitles made on the PC (SubPlz); its status also with the row closed -->
            {#if linked}
              <SubtitleJobPanel
                {api}
                {bookId}
                {link}
                {audioEnabled}
                compact={open !== 'subs'}
                busy={busy || merging}
                on:linked={onMade}
                on:chooseSubtitle={(ev) => chooseSubtitle(ev.detail)}
              />
            {/if}
          </div>
        {/if}

        <!-- Text-to-speech: the book's TTS voice, audiobooks made on the PC, characters, fixes -->
        {#if voiceChoices}
          <div
            class="c-arow px-5 py-4"
            data-testid="audio-row-tts"
            data-open={open === 'tts' ? 'true' : 'false'}
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-xs text-c-muted">Text-to-speech</h3>
                {#if open !== 'tts'}
                  <p class="break-words text-sm" data-testid="audio-tts-voice">
                    {ttsVoiceText(voiceChoices)}
                  </p>
                  {#if ttsCounts}
                    <p class="text-sm text-c-muted" data-testid="audio-tts-counts">{ttsCounts}</p>
                  {/if}
                {:else}
                  <p class="max-w-3xl text-sm" data-testid="audio-tts-about">
                    Your PC reads this book aloud with its TTS voice: Read aloud in the reader,
                    {linked
                      ? 'and audiobooks made below (Anki sentence audio comes from the linked audiobook).'
                      : 'Anki sentence audio while the book has no audiobook, and audiobooks made below.'}
                  </p>
                {/if}
              </div>
              <button
                class="c-btn c-btn-secondary shrink-0"
                aria-expanded={open === 'tts'}
                data-testid="audio-row-tts-toggle"
                on:click={() => toggle('tts')}
              >
                {open === 'tts' ? 'Close' : 'Open'}
              </button>
            </div>

            {#if open === 'tts'}
              <BookVoiceChoice {api} {bookId} on:changed={(e) => (voiceChoices = e.detail)} />
            {/if}
            <!-- WP17: an audiobook made on the PC with the book's TTS voice -->
            <AudiobookJobPanel
              bind:this={jobPanel}
              bind:available={canMakeAudiobook}
              {api}
              {bookId}
              {link}
              {audioEnabled}
              choice={voiceChoices.effective}
              compact={open !== 'tts'}
              busy={busy || merging}
              on:linked={onMade}
            />
            <!-- Session 5: who speaks each quote, and each character's voice -->
            <BookSpeakersPanel
              {api}
              {bookId}
              compact={open !== 'tts'}
              bind:count={characterCount}
            />
            <BookPronunciationPanel
              {api}
              {bookId}
              {link}
              compact={open !== 'tts'}
              bind:count={fixCount}
            />
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .c-apanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-arow + .c-arow {
    border-top: var(--c-border-width) solid var(--c-line);
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
