<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The series recap, "story so far", on the series page (book summaries session 5; approved
   * mockup "Series page · story so far"): "▸ Story so far" beside "▸ Highlights", closed by
   * default, opening a panel above the volumes.
   *
   * - From the library server when it answers, else this device's copy (offline too).
   * - "Built from the summaries of vols. 1–5 · updated …" (no model name), the language buttons
   *   (translated on first choice, then kept), and the note of what it covers: the volumes, the
   *   ones without a summary (linked to their book pages) and what isn't in it yet.
   * - The book summary's tabs and this device's layouts, "Volume by volume" in place of
   *   "Chapter by chapter"; not editable.
   * - Spoiler blur: with "Completed books", blurred unless every covered volume is Completed.
   * - Regenerate (asks first when it replaces one) or "Make the story so far".
   *
   * Never breaks the page: every failure becomes a line in the panel.
   */
  import { onDestroy, onMount } from 'svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { regenerateRecapCopy } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { bookDetailsHref } from '$lib/library/format';
  import { isUnreachable } from '$lib/library/offline/offline-source';
  import { getSyncEngine } from '$lib/sync/sync-service';
  import {
    summaryCharacterLayout$,
    summaryLanguages$,
    summaryRecapAuto$,
    summaryRelationshipLayout$,
    summarySpoilerBlur$
  } from '$lib/summaries/settings';
  import type { RecapResponse, SeriesRecapRecord, SummaryApi } from '$lib/summaries/summary-api';
  import { failedNote, languageChoices, startLanguage } from '$lib/summaries/summary-page';
  import {
    coverageNote,
    recapHidden,
    recapMeta,
    recapProgress,
    recapState
  } from '$lib/summaries/recap-page';
  import {
    getRecapCopy,
    recapCopies,
    recapState as recordOf,
    summaryApi
  } from '$lib/summaries/summary-sync';
  import type { Summary, SummarySectionKey } from '$lib/summaries/summary-types';
  import SummaryView from './summary-view.svelte';

  export let series: string;
  /** Each book's status now ("completed", …): the blur's "Completed books". */
  export let statusOf: (bookId: string) => string | undefined = () => undefined;
  /** The page's own offline state (the server can't be reached). */
  export let offline = false;

  let open = false;
  let api: SummaryApi | null = null;
  let res: RecapResponse | null = null;
  let record: SeriesRecapRecord | null = null;
  let fromDevice = false;
  let off = false;
  let loaded = false;
  let loading = false;
  let loadError = '';
  let actionError = '';
  let busy = false;
  let revealed = false;
  let lang = '';
  const asked = new Set<string>();
  let now = Date.now();
  let tab: SummarySectionKey = 'overview';
  let destroyed = false;
  let stopListening: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  $: recap = res?.recap ?? null;
  $: serverDown = offline || fromDevice;
  $: recapLang = recap?.lang ?? record?.recap?.lang ?? 'ja';
  $: choices = languageChoices(recapLang, $summaryLanguages$);
  $: if (!lang || !choices.some((c) => c.lang === lang)) lang = startLanguage('', choices);
  $: states = recapState({
    hasRecap: !!recap,
    record,
    coverage: res?.coverage ?? null,
    offline: serverDown
  });
  $: progress = record ? recapProgress(record, now) : null;
  $: failed = record?.outcome === 'failed' ? failedNote(record.note, !!recap, 'recap') : null;
  $: hidden =
    !!recap &&
    !revealed &&
    recapHidden(
      $summarySpoilerBlur$,
      recap.volumes.map((v) => statusOf(v.bookId))
    );
  $: note = res ? coverageNote(recap?.volumes ?? null, res.coverage) : null;
  $: translating =
    !!recap &&
    lang !== recap.lang &&
    !serverDown &&
    (!recap.languages.includes(lang) || recap.untranslated.length > 0);
  $: total = recap
    ? recap.sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0), 0)
    : 0;
  $: notOnDevice = !!recap && lang !== recap.lang && serverDown && recap.viewLang !== lang;
  $: overview = recap?.sections.find((s) => s.key === 'overview')?.groups[0]?.items[0]?.text ?? '';
  /** The recap in the summary view's shape. */
  $: view = recap
    ? ({
        lang: recap.lang,
        viewLang: recap.viewLang,
        bookTitle: recap.series,
        models: recap.models,
        madeAt: recap.madeAt,
        sections: recap.sections,
        alsoMentioned: recap.alsoMentioned
      } as unknown as Summary)
    : null;
  $: auto = res?.auto ?? $summaryRecapAuto$;
  $: canMake = !serverDown && !!res?.coverage.enough && !record?.making;

  function describe(err: unknown): string {
    if (isUnreachable(err)) return 'The library server cannot be reached.';
    return (err as Error)?.message ?? String(err);
  }

  async function fromDeviceCopy(): Promise<void> {
    fromDevice = true;
    const engine = await getSyncEngine().catch(() => null);
    record = engine ? await recordOf(engine, series).catch(() => null) : record;
    const want = await getRecapCopy(series, lang);
    const any =
      want ?? (await recapCopies(series)).find((c) => c.lang === record?.recap?.lang) ?? null;
    res = any?.response ?? null;
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    const name = series;
    try {
      api ??= await summaryApi();
      if (!api || offline) {
        await fromDeviceCopy();
        return;
      }
      const got = await api.recap(name, lang || undefined);
      if (destroyed || name !== series) return;
      fromDevice = false;
      res = got;
      record = got.state;
      loadError = '';
      const r = got.recap;
      // A language chosen for the first time: translated now, then kept.
      if (r && lang && lang !== r.lang && !r.languages.includes(lang) && !asked.has(lang)) {
        asked.add(lang);
        await api.translateRecap(name, lang).catch((err) => {
          actionError = `Not translated: ${describe(err)}`;
        });
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'summaries_off') {
        off = true;
        return;
      }
      if (isUnreachable(err)) await fromDeviceCopy().catch(() => undefined);
      else loadError = describe(err);
      logger.warn(`Story so far of ${name}: ${describe(err)}`);
    } finally {
      loading = false;
      if (!destroyed) {
        loaded = true;
        now = Date.now();
        schedule();
      }
    }
  }

  /** While it is being made, waited for or translated, look again every few seconds. */
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!open || serverDown) return;
    if (!record?.making && !translating) return;
    timer = setTimeout(
      () => void load(),
      record?.making === 'running' || translating ? 3_000 : 15_000
    );
  }

  function toggle() {
    open = !open;
    if (open) void load();
    else if (timer) clearTimeout(timer);
  }

  let lastOffline = offline;
  $: if (offline !== lastOffline) {
    lastOffline = offline;
    if (open) void load();
  }

  onMount(() => {
    void getSyncEngine()
      .then((engine) => {
        if (destroyed) return;
        stopListening = engine.onRemoteChange((records) => {
          if (open && records.some((r) => r.kind === 'series-recap' && r.id === series))
            void load();
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

  async function make() {
    if (!api) return;
    if (
      recap &&
      !(await confirmDestructive({
        ...regenerateRecapCopy(series),
        testid: 'recap-regenerate-confirm',
        confirmTestid: 'recap-regenerate-yes'
      }))
    )
      return;
    busy = true;
    actionError = '';
    try {
      await api.regenerateRecap(series);
      await load();
    } catch (err) {
      actionError = `Not started: ${describe(err)}`;
    } finally {
      busy = false;
    }
  }
</script>

{#if !off}
  <button
    type="button"
    class="c-btn c-btn-secondary"
    aria-expanded={open}
    data-testid="recap-toggle"
    on:click={toggle}
  >
    {open ? '▾' : '▸'} Story so far
  </button>
  {#if open}
    <section class="series-tool-panel recap" aria-label="Story so far" data-testid="recap-panel">
      {#if !loaded}
        <p class="text-sm text-c-muted" role="status">Loading…</p>
      {:else}
        <div class="meta">
          {#if recap}
            <p class="text-sm text-c-muted" data-testid="recap-meta">{recapMeta(recap)}</p>
          {/if}
          {#if recap && choices.length > 1}
            <div class="c-strip langs" role="group" aria-label="Story so far language">
              {#each choices as c (c.lang)}
                <button
                  type="button"
                  class="c-chip c-chip-sm shrink-0"
                  aria-pressed={lang === c.lang}
                  data-testid="recap-lang-{c.lang}"
                  on:click={() => chooseLanguage(c.lang)}>{c.label}</button
                >
              {/each}
            </div>
          {/if}
        </div>

        {#if note && (note.covers || note.stale.length)}
          <div class="note" role="note" data-testid="recap-coverage">
            {#if note.covers}
              <p>
                <strong>{note.covers}</strong>
                {#if note.builtFrom}{note.builtFrom}{/if}
                {#if note.missing.length}
                  No summary:
                  {#each note.missing as m, i (m.bookId)}{#if i},
                    {/if}<a
                      class="c-link"
                      href={bookDetailsHref(pagePath, m.bookId)}
                      data-testid="recap-missing-link">{m.word}</a
                    >{/each}. Nothing that happens there is in it.
                {/if}
              </p>
            {/if}
            {#if note.stale.length}
              <p class="mt-1" data-testid="recap-stale">
                Not in it yet: {note.stale.join('; ')}.
                {#if record?.making}
                  An update is on its way.
                {:else if !auto}
                  Automatic updates are off.
                {/if}
              </p>
            {/if}
          </div>
        {/if}

        {#if states.includes('making') && progress}
          <!-- Compact like the book page's (review of the states, 2026-11-24). -->
          <div class="mt-3" data-testid="recap-making">
            <div class="making-head">
              <p class="text-sm" role="status" aria-live="polite">
                {recap ? `Updating · ${progress.text}` : progress.text}
              </p>
              <span class="text-xs text-c-muted">{progress.time}</span>
            </div>
            <div
              class="c-mbar mt-1"
              role="progressbar"
              aria-label="Story so far progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={progress.value}
            >
              <div style="width: {progress.value}%" />
            </div>
            {#if progress.note}<p class="mt-1 text-xs text-c-muted">{progress.note}</p>{/if}
          </div>
        {/if}
        {#if states.includes('waiting') && progress}
          <div class="mt-3" data-testid="recap-waiting">
            <div class="making-head">
              <p class="text-sm" role="status">{progress.text}</p>
              <span class="text-xs text-c-muted">{progress.time}</span>
            </div>
            {#if progress.note}<p class="mt-1 text-xs text-c-muted">{progress.note}</p>{/if}
          </div>
        {/if}
        {#if states.includes('failed')}
          <!-- In plain words, as a book summary's (review of the states, 2026-11-24). -->
          <div class="c-notice mt-3" role="status" data-testid="recap-failed">
            <p>{failed?.title ?? ''}</p>
            {#each failed?.lines ?? [] as l}<p class="mt-1">{l}</p>{/each}
          </div>
        {/if}
        {#if states.includes('nothing_completed')}
          <p class="mt-3 text-c-muted" data-testid="recap-nothing">
            No volume of this series is completed yet. The story so far covers the volumes you have
            completed.
          </p>
        {/if}
        {#if states.includes('too_few')}
          <p class="mt-3 text-c-muted" data-testid="recap-too-few">
            The story so far is made once two completed volumes have a summary.
            {#each (res?.coverage.volumes ?? []).filter((v) => v.hasSummary) as v (v.bookId)}
              <a class="c-link" href={bookDetailsHref(pagePath, v.bookId)}
                >Read the summary of {v.label !== null ? `vol. ${v.label}` : v.title}</a
              >.
            {/each}
          </p>
        {/if}
        {#if states.includes('none')}
          <p class="mt-3 text-c-muted" data-testid="recap-none">
            {auto
              ? 'No story so far yet. It is made when a volume summary changes or a volume with a summary is completed.'
              : 'No story so far yet.'}
          </p>
        {/if}
        {#if states.includes('offline_none')}
          <p class="mt-3 text-c-muted" data-testid="recap-offline-none">
            No story so far on this device. It shows here when the library server can be reached.
          </p>
        {/if}
        {#if loadError}<p class="c-notice mt-3" role="alert">{loadError}</p>{/if}

        {#if view && recap}
          {#if translating}
            <p class="mt-3 text-sm" role="status" data-testid="recap-translating">
              Translating: {Math.max(0, total - recap.untranslated.length)} of {total} points. Points
              not translated yet show in the original.
            </p>
          {:else if notOnDevice}
            <p class="mt-3 text-sm text-c-muted" data-testid="recap-not-translated">
              Translated when the library server can be reached. Shown in the original.
            </p>
          {/if}
          {#if hidden}
            <div class="blurred mt-3" data-testid="recap-blurred">
              <p class="overview" aria-hidden="true">{overview}</p>
              <div class="cover">
                <span class="hint">Hidden: it may spoil volumes you haven’t completed</span>
                <button
                  type="button"
                  class="c-btn c-btn-primary"
                  data-testid="recap-show"
                  on:click={() => (revealed = true)}>Show the story so far</button
                >
              </div>
            </div>
          {:else}
            <div class="mt-2">
              <SummaryView
                summary={view}
                characterLayout={$summaryCharacterLayout$}
                relationshipLayout={$summaryRelationshipLayout$}
                showMade={false}
                bind:tab
              />
            </div>
          {/if}
        {/if}

        {#if actionError}<p class="c-notice mt-3" role="alert" data-testid="recap-action-error">
            {actionError}
          </p>{/if}

        <!-- Only when it has something (no empty divider; review of the states, 2026-11-24). -->
        {#if serverDown || recap || res?.coverage.enough}
          <div class="actions" class:busy>
            {#if serverDown}
              <span class="mr-auto self-center text-xs text-c-muted"
                >Changes need the library server.</span
              >
            {:else}
              <button
                type="button"
                class="c-btn c-btn-secondary"
                disabled={!canMake || busy}
                data-testid="recap-regenerate"
                on:click={make}>{recap ? 'Regenerate' : 'Make the story so far'}</button
              >
            {/if}
          </div>
        {/if}
      {/if}
    </section>
  {/if}
{/if}

<style>
  .recap {
    padding: clamp(0.875rem, 2.5vw, 1.5rem);
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .langs {
    display: flex;
    gap: 0.375rem;
    margin-left: auto;
    max-width: 100%;
  }
  /* 48 px on touch and E-ink (the user's rule for this feature), like the buttons. */
  .langs .c-chip {
    min-height: var(--c-btn-h);
  }
  .note {
    margin-top: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-radius: 8px;
    border: var(--c-border-width) solid var(--c-line);
    font-size: 0.875rem;
    line-height: 1.8;
  }
  .note a {
    display: inline-flex;
    align-items: center;
    min-height: var(--c-btn-h);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: var(--c-border-width) solid var(--c-line);
  }
  .actions:empty {
    display: none;
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
