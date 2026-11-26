<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries on the book details page (session 4; book-summaries.md "UI", option C).
   *
   * - The summary comes from the library server when it answers (always the newest), else from
   *   this device's copy (session 3's IndexedDB `ttsu-summaries`), so it reads offline too.
   * - Language buttons: the book's language and the summary languages setting's; a language not
   *   saved yet is translated on first choice (online), then kept and offline too.
   * - Spoiler blur (Settings › Library): only the Overview, blurred and cut short, with "Show
   *   summary"; no tabs until shown. Shown lasts for this visit of the page.
   * - Below it, right-aligned: Edit (a filled Done while editing), Replace ▾ (Regenerate with
   *   AI, Write my own; Add summary ▾ when there is none) and ⋯ (Earlier versions, Delete
   *   summary). Replacing and deleting ask first.
   * - States: being made (step, bar, time), failed on every setup (the note), no text, none
   *   yet, offline. Kept simple: session 5 reviews them with the user.
   *
   * Never breaks the page: every failure becomes a line in the section.
   */
  import { onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faChevronDown, faChevronUp, faEllipsis } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import LanguagePicker from './language-picker.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    deleteSummaryCopy,
    regenerateSummaryCopy,
    replaceSummaryWithOwnCopy
  } from '$lib/confirm/confirm-copy';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { logger } from '$lib/data/logger';
  import { isUnreachable } from '$lib/library/offline/offline-source';
  import { getSyncEngine } from '$lib/sync/sync-service';
  import {
    summaryAutoOnFirstCompletion$,
    summaryCharacterLayout$,
    summaryLanguages$,
    summaryRelationshipLayout$,
    summarySpoilerBlur$
  } from '$lib/summaries/settings';
  import type {
    BookSummaryRecord,
    OwnSummaryInput,
    SummaryApi,
    SummaryItemInput,
    SummaryJob,
    SummaryView as View
  } from '$lib/summaries/summary-api';
  import {
    failedNote,
    languageChoices,
    madeLine,
    makingProgress,
    sectionState,
    startLanguage,
    summaryHidden
  } from '$lib/summaries/summary-page';
  import { getSummary, summaryApi, summaryState } from '$lib/summaries/summary-sync';
  import type { SummaryItem, SummarySectionKey } from '$lib/summaries/summary-types';
  import SummaryVersionsDialog from './summary-versions-dialog.svelte';
  import SummaryView from './summary-view.svelte';
  import SummaryWriteDialog from './summary-write-dialog.svelte';

  export let book: { id: string; title: string; charCount: number | null };
  /** The book's status now ("completed", …): the spoiler blur's "Completed books". */
  export let status: string | undefined = undefined;
  /** The page's own offline state (the server can't be reached). */
  export let offline = false;

  let api: SummaryApi | null = null;
  let record: BookSummaryRecord | null = null;
  let view: View | null = null;
  /** The language shown: the book's, or one of the summary languages. */
  let lang = '';
  /** This section reads the device's copy (the server didn't answer). */
  let fromDevice = false;
  /** The server has summaries off (503): the section isn't shown. */
  let off = false;
  let loaded = false;
  let loadError = '';
  let actionError = '';
  let busy = false;
  let editing = false;
  let revealed = false;
  let job: SummaryJob | null = null;
  /** Languages asked to be translated on this visit (asked once each). */
  const asked = new Set<string>();
  let now = Date.now();
  let tab: SummarySectionKey = 'overview';

  let destroyed = false;
  let loadingFor = '';
  let stopListening: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  $: serverDown = offline || fromDevice;
  $: bookLang = record?.summary?.lang ?? view?.lang ?? 'ja';
  $: choices = languageChoices(bookLang, $summaryLanguages$);
  $: if (!lang || !choices.some((c) => c.lang === lang)) lang = startLanguage('', choices);
  $: states = sectionState({ hasSummary: !!view, record, offline: serverDown });
  $: hidden = !!view && !revealed && !editing && summaryHidden($summarySpoilerBlur$, status);
  $: progress = record ? makingProgress(record, now, job) : null;
  $: failed = record?.outcome === 'failed' ? failedNote(record.note, !!view) : null;
  $: translating =
    !!view &&
    lang !== bookLang &&
    !serverDown &&
    (!view.languages.includes(lang) || view.untranslated.length > 0);
  $: total = view
    ? view.sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0), 0)
    : 0;
  $: notOnDevice = !!view && lang !== bookLang && serverDown && view.viewLang !== lang;
  $: overview = view?.sections.find((s) => s.key === 'overview')?.groups[0]?.items[0]?.text ?? '';

  function describe(err: unknown): string {
    if (isUnreachable(err)) return 'The library server cannot be reached.';
    return (err as Error)?.message ?? String(err);
  }

  async function fromDeviceCopy(id: string): Promise<void> {
    fromDevice = true;
    const engine = await getSyncEngine().catch(() => null);
    record = engine ? await summaryState(engine, id).catch(() => null) : record;
    const want = await getSummary(id, lang);
    const own = want ?? (record?.summary ? await getSummary(id, record.summary.lang) : null);
    view = own?.summary ?? null;
  }

  async function load(): Promise<void> {
    const id = book.id;
    loadingFor = id;
    try {
      api ??= await summaryApi();
      if (!api || offline) {
        await fromDeviceCopy(id);
        return;
      }
      const got = await api.get(id, lang || undefined);
      if (destroyed || loadingFor !== id) return;
      fromDevice = false;
      record = got.state;
      view = got.summary;
      loadError = '';
      // A language chosen for the first time: translated now, then kept.
      if (
        view &&
        lang &&
        lang !== view.lang &&
        !view.languages.includes(lang) &&
        !asked.has(lang)
      ) {
        asked.add(lang);
        await api.translate(id, lang).catch((err) => {
          actionError = `Not translated: ${describe(err)}`;
        });
      }
      job = record?.making
        ? ((await api.jobs(id).catch(() => null))?.jobs.find(
            (j) => j.state === 'queued' || j.state === 'running'
          ) ?? null)
        : null;
    } catch (err) {
      if ((err as { code?: string })?.code === 'summaries_off') {
        off = true;
        return;
      }
      if (isUnreachable(err)) await fromDeviceCopy(id).catch(() => undefined);
      else loadError = describe(err);
      logger.warn(`Summary of ${id}: ${describe(err)}`);
    } finally {
      if (!destroyed && loadingFor === id) {
        loaded = true;
        now = Date.now();
        schedule();
      }
    }
  }

  /** While something is being made or translated, look again every few seconds. */
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    const waiting = !!record?.making || translating;
    if (!waiting || serverDown) return;
    timer = setTimeout(() => void load(), record?.making ? 10_000 : 3_000);
  }

  let lastBook = '';
  $: if (book.id !== lastBook) {
    lastBook = book.id;
    view = null;
    record = null;
    job = null;
    loaded = false;
    editing = false;
    revealed = false;
    actionError = '';
    asked.clear();
    tab = 'overview';
    void load();
  }
  let lastOffline = offline;
  $: if (offline !== lastOffline) {
    lastOffline = offline;
    void load();
  }

  onMount(() => {
    void getSyncEngine()
      .then((engine) => {
        if (destroyed) return;
        // Another device, or the server, changed this book's summary.
        stopListening = engine.onRemoteChange((records) => {
          if (records.some((r) => r.kind === 'book-summary' && r.id === book.id)) void load();
        });
      })
      .catch(() => undefined);
  });
  onDestroy(() => {
    destroyed = true;
    stopListening?.();
    if (timer) clearTimeout(timer);
  });

  function chooseLanguage(l: string) {
    lang = l;
    void load();
  }

  // ---- actions ----

  async function run(
    fn: (a: SummaryApi) => Promise<unknown>,
    failed: string
  ): Promise<string | null> {
    if (!api) return 'The library server cannot be reached.';
    busy = true;
    actionError = '';
    try {
      await fn(api);
      await load();
      return null;
    } catch (err) {
      const msg = `${failed}: ${describe(err)}`;
      actionError = msg;
      return msg;
    } finally {
      busy = false;
    }
  }

  async function regenerate() {
    if (
      view &&
      !(await confirmDestructive({
        ...regenerateSummaryCopy(book.title),
        testid: 'summary-regenerate-confirm',
        confirmTestid: 'summary-regenerate-yes'
      }))
    )
      return;
    editing = false;
    await run((a) => a.regenerate(book.id), 'Not started');
  }

  async function writeOwn() {
    if (
      view &&
      !(await confirmDestructive({
        ...replaceSummaryWithOwnCopy(book.title),
        testid: 'summary-own-confirm',
        confirmTestid: 'summary-own-yes'
      }))
    )
      return;
    const typed = await dialogManager.open<OwnSummaryInput | undefined>(SummaryWriteDialog, {
      title: book.title,
      lang: bookLang
    });
    if (!typed) return;
    editing = false;
    await run((a) => a.writeOwn(book.id, typed), 'Not saved');
  }

  async function deleteSummary() {
    if (
      !(await confirmDestructive({
        ...deleteSummaryCopy(book.title),
        testid: 'summary-delete-confirm',
        confirmTestid: 'summary-delete-yes'
      }))
    )
      return;
    editing = false;
    await run((a) => a.deleteCurrent(book.id), 'Not deleted');
  }

  async function earlierVersions() {
    if (!api) return;
    const changed = await dialogManager.open<boolean>(SummaryVersionsDialog, {
      api,
      bookId: book.id,
      title: book.title,
      charCount: book.charCount
    });
    if (changed) await load();
  }

  function toggleEdit() {
    editing = !editing;
    // Translations follow the original: edits are made in the book's language.
    if (editing && lang !== bookLang) chooseLanguage(bookLang);
  }

  const saveItem = (item: SummaryItem, input: SummaryItemInput) =>
    run(
      (a) =>
        tab === 'overview'
          ? a.editOverview(book.id, input.text)
          : a.editItem(book.id, item.id as number, {
              text: input.text,
              ...(input.heading !== undefined ? { heading: input.heading } : {}),
              ...(input.between ? { between: input.between } : {}),
              ...(input.label !== undefined ? { label: input.label } : {})
            }),
      'Not saved'
    );
  const removeItem = (item: SummaryItem) =>
    run((a) => a.deleteItem(book.id, item.id as number), 'Not deleted');
  const addItem = (section: SummarySectionKey, input: SummaryItemInput) =>
    run(
      (a) =>
        section === 'overview'
          ? a.editOverview(book.id, input.text)
          : section === 'volumes'
            ? Promise.reject(new Error('a book summary has no volumes'))
            : a.addItem(book.id, section, input),
      'Not added'
    );

  $: menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
  let replaceOpen = false;
</script>

{#if !off && loaded}
  <section class="mt-12" aria-labelledby="details-summary" data-testid="summary-section">
    <div class="flex items-center gap-4">
      <h2 id="details-summary" class="flex items-baseline gap-3">
        <span class="font-mincho text-2xl font-bold">Summary</span>
        <span class="c-jp-label text-xs" aria-hidden="true">あらすじ</span>
      </h2>
      <span class="c-section-rule" />
    </div>

    {#if view}
      <div class="meta">
        <p class="text-sm text-c-muted" data-testid="summary-made">{madeLine(view)}</p>
        {#if choices.length > 1}
          <div class="c-strip langs" role="group" aria-label="Summary language">
            {#each choices as c (c.lang)}
              <button
                type="button"
                class="c-chip c-chip-sm shrink-0"
                aria-pressed={lang === c.lang}
                disabled={editing && !c.original}
                data-testid="summary-lang-{c.lang}"
                on:click={() => chooseLanguage(c.lang)}>{c.label}</button
              >
            {/each}
          </div>
          <!-- Phones: a small dropdown, so more languages never take more room. -->
          <div class="langs-select">
            <LanguagePicker
              {choices}
              {lang}
              label="Summary language"
              testid="summary-lang-menu"
              disabled={(c) => editing && !c.original}
              on:choose={(e) => chooseLanguage(e.detail)}
            />
          </div>
        {/if}
      </div>
    {/if}

    {#if states.includes('making') && progress}
      <!-- Compact (review of the states, 2026-11-24): the step with its time, the bar, one note. -->
      <div class="mt-4" data-testid="summary-making">
        <div class="making-head">
          <p class="text-sm" role="status" aria-live="polite">
            {view ? `New summary · ${progress.text}` : progress.text}{#if progress.waiting}<span
                class="waiting text-xs text-c-muted"
                data-testid="summary-waiting">{progress.waiting}</span
              >{/if}
          </p>
          <span class="text-xs text-c-muted">{progress.time}</span>
        </div>
        <div
          class="c-mbar mt-1"
          role="progressbar"
          aria-label="Summary progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress.value}
        >
          <div style="width: {progress.value}%" />
        </div>
        {#if progress.note}
          <p class="mt-1 text-xs text-c-muted" data-testid="summary-making-note">{progress.note}</p>
        {/if}
      </div>
    {/if}
    {#if states.includes('failed') && failed}
      <!-- In plain words, one line per setup (review of the states, 2026-11-24). -->
      <div class="c-notice mt-4" role="status" data-testid="summary-failed">
        <p>{failed.title}</p>
        {#each failed.lines as l}<p class="mt-1">{l}</p>{/each}
      </div>
    {/if}
    {#if states.includes('no_text')}
      <p class="mt-4 text-c-muted" data-testid="summary-no-text">No text to summarize.</p>
    {/if}
    {#if states.includes('none')}
      <p class="mt-4 text-c-muted" data-testid="summary-none">
        {$summaryAutoOnFirstCompletion$ && status !== 'completed'
          ? 'No summary yet. One is made when you first complete the book.'
          : 'No summary yet.'}
      </p>
    {/if}
    {#if states.includes('offline_none')}
      <p class="mt-4 text-c-muted" data-testid="summary-offline-none">
        No summary on this device. It shows here when the library server can be reached.
      </p>
    {/if}
    {#if loadError}<p class="c-notice mt-4" role="alert">{loadError}</p>{/if}

    {#if view}
      {#if translating}
        <p class="mt-3 text-sm" role="status" data-testid="summary-translating">
          Translating: {Math.max(0, total - view.untranslated.length)} of {total} items. Items not translated
          yet show in the original.
        </p>
      {:else if notOnDevice}
        <p class="mt-3 text-sm text-c-muted" data-testid="summary-not-translated">
          Translated when the library server can be reached. Shown in the original.
        </p>
      {/if}

      {#if hidden}
        <div class="blurred mt-4" data-testid="summary-blurred">
          <p class="overview" aria-hidden="true">{overview}</p>
          <div class="cover">
            <span class="hint">Hidden: it may spoil the book</span>
            <button
              type="button"
              class="c-btn c-btn-primary"
              data-testid="summary-show"
              on:click={() => (revealed = true)}>Show summary</button
            >
          </div>
        </div>
      {:else}
        <div class="mt-2">
          <SummaryView
            summary={view}
            bookId={book.id}
            charCount={book.charCount}
            characterLayout={$summaryCharacterLayout$}
            relationshipLayout={$summaryRelationshipLayout$}
            showMade={false}
            {editing}
            {saveItem}
            {removeItem}
            {addItem}
            bind:tab
          />
        </div>
      {/if}
    {/if}

    {#if actionError}<p class="c-notice mt-4" role="alert" data-testid="summary-action-error">
        {actionError}
      </p>{/if}

    <div class="actions" class:busy>
      {#if serverDown}
        <span class="mr-auto self-center text-xs text-c-muted"
          >Changes need the library server.</span
        >
      {/if}
      {#if view}
        <button
          type="button"
          class="c-btn {editing ? 'c-btn-primary' : 'c-btn-secondary'}"
          disabled={serverDown || busy}
          data-testid="summary-edit"
          on:click={toggleEdit}>{editing ? 'Done' : 'Edit'}</button
        >
      {/if}
      {#if !serverDown}
        <DropdownMenu
          buttonClass="c-btn c-btn-secondary"
          align="right"
          label={view ? 'Replace the summary' : 'Add a summary'}
          testid="summary-replace"
          panelWidth="w-64"
          bind:open={replaceOpen}
          let:close
        >
          <svelte:fragment slot="button">
            {view ? 'Replace' : 'Add summary'}
            <Fa icon={replaceOpen ? faChevronUp : faChevronDown} size="xs" />
          </svelte:fragment>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class={menuItem}
              disabled={!!record?.making}
              data-testid="summary-regenerate"
              on:click={() => {
                close();
                void regenerate();
              }}>Regenerate with AI</button
            >
            <button
              type="button"
              class={menuItem}
              data-testid="summary-write-own"
              on:click={() => {
                close();
                void writeOwn();
              }}>Write my own</button
            >
          </div>
        </DropdownMenu>
        <DropdownMenu
          buttonClass="c-btn c-btn-secondary c-btn-icon"
          align="right"
          label="More summary actions"
          testid="summary-more"
          panelWidth="w-64"
          let:close
        >
          <svelte:fragment slot="button">
            <Fa icon={faEllipsis} /><span class="sr-only">More</span>
          </svelte:fragment>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class={menuItem}
              data-testid="summary-versions-open"
              on:click={() => {
                close();
                void earlierVersions();
              }}>Earlier versions</button
            >
            {#if view}
              <button
                type="button"
                class="{menuItem} text-c-seal"
                data-testid="summary-delete"
                on:click={() => {
                  close();
                  void deleteSummary();
                }}>Delete summary</button
              >
            {/if}
          </div>
        </DropdownMenu>
      {/if}
    </div>
  </section>
{/if}

<style>
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin-top: 0.75rem;
  }
  /* 48 px on touch and E-ink (the user's rule for this feature), like the buttons. */
  .langs .c-chip {
    min-height: var(--c-btn-h);
  }
  .langs {
    display: flex;
    gap: 0.375rem;
    margin-left: auto;
    max-width: 100%;
  }
  .langs-select {
    display: none;
    margin-left: auto;
  }
  @media (max-width: 40rem) {
    .langs {
      display: none;
    }
    .langs-select {
      display: block;
    }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: var(--c-border-width) solid var(--c-line);
  }
  .actions.busy {
    opacity: 0.6;
    pointer-events: none;
  }
  .blurred {
    position: relative;
    overflow: hidden;
    padding: 1rem 1.25rem;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
    min-height: 9rem;
  }
  .blurred .overview {
    filter: blur(6px);
    user-select: none;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.9;
  }
  .cover {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    padding: 1rem;
    text-align: center;
  }
  .hint {
    font-size: 0.875rem;
    padding: 0.125rem 0.5rem;
    border-radius: 6px;
    background: var(--c-raised);
  }
  .waiting {
    margin-left: 0.75rem;
  }
  .making-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0 1rem;
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
  }
  .overview {
    white-space: pre-line;
  }
</style>
