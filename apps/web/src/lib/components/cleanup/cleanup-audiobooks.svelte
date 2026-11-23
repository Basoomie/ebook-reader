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
   * checks each file, stage 3 (WP21b) finds copies of the same recording and picks the best
   * copy (its review queue below), stage 4 (WP21c) looks each recording up on Audible, kikubon
   * and audiobook.jp (its lists below), stage 5 (WP21d) decides each recording's metadata with the
   * rules and the two AI models (its list below). The stages are Off or Preview. The disk line shows which cleanup job
   * reads the disk (one at a time; the Calibre cleanup goes first). Asks the server again
   * every few seconds while open.
   */
  import { onDestroy, onMount } from 'svelte';
  import type {
    AbsSnapshot,
    AudioBuildBook,
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
    count,
    diskLine,
    durationText,
    identityLines,
    snapshotLine
  } from '$lib/cleanup/audio-text';
  import {
    STAGE3_HINTS,
    audioStage3Bar,
    audioStage3Lines,
    dupLines,
    gateLines,
    missLine
  } from '$lib/cleanup/audio-dup-text';
  import {
    STAGE4_HINTS,
    audioStage4Bar,
    audioStage4Lines,
    onlineFoundLines,
    onlineGateLines,
    onlineMissLine,
    siteLine
  } from '$lib/cleanup/audio-online-text';
  import { bytesText, n, type ProgressBar } from '$lib/cleanup/cleanup-text';
  import { LibraryApiError } from '$lib/library/api';
  import { formatWhen } from '$lib/notes/notes-format';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { analyseAgainCopy, buildOnCopy } from '$lib/confirm/confirm-copy';
  import {
    MODE_LABEL_ON,
    STAGE6_HINTS,
    audioStage6Bar,
    audioStage6Lines,
    bookLine,
    checkLines,
    labelDiffLines,
    metadataLine,
    stage6Summary
  } from '$lib/cleanup/audio-build-text';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import CleanupSection from './cleanup-section.svelte';
  import CleanupAudioDups from './cleanup-audio-dups.svelte';
  import CleanupAudioOnline from './cleanup-audio-online.svelte';
  import CleanupAudioMeta from './cleanup-audio-meta.svelte';
  import CleanupAudioSwitch from './cleanup-audio-switch.svelte';
  import CleanupAudioArrivals from './cleanup-audio-arrivals.svelte';
  import CleanupAudioArrivalsLists from './cleanup-audio-arrivals-lists.svelte';
  import CleanupAudioEbooks from './cleanup-audio-ebooks.svelte';
  import CleanupAudioEbooksLists from './cleanup-audio-ebooks-lists.svelte';
  import {
    diskBusy,
    gateSummary,
    metaGateSummary,
    stageSummary
  } from '$lib/cleanup/audio-card-text';
  import {
    STAGE5_HINTS,
    audioStage5Bar,
    audioStage5Lines,
    metaCountLines,
    metaGateLines,
    metaMissLine,
    spendLine
  } from '$lib/cleanup/audio-meta-text';

  export let api: CleanupApi;

  const POLL_MS = 5000;
  const PAGE = 50;
  const MODES: AudioStageMode[] = ['off', 'analyse'];
  /** Stage 6 (WP21e-1) can also be On: it then builds japanese-new. */
  const MODES_6: (AudioStageMode | 'on')[] = ['off', 'analyse', 'on'];
  const modesOf = (stage: AudioStageRow) => (stage.stage === 6 ? MODES_6 : MODES);
  const modeLabel = (mode: AudioStageMode | 'on') =>
    mode === 'on' ? MODE_LABEL_ON : AUDIO_MODE_LABELS[mode];

  let status: AudioStatus | null = null;
  let error = '';
  let actionError = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: AbsSnapshot | null = null;
  let snapshotId: number | null = null;
  /** The stages' analyses and phases last seen (the lists reload when they change). */
  let lastAnalyses: string | null = null;

  let fileList = FILE_LISTS[0].id;
  let files: { total: number; items: AudioFileRow[] } | null = null;
  let fileOffset = 0;
  let bookList = BOOK_LISTS[0].id;
  let books: { total: number; items: AudioBookRow[] } | null = null;
  let bookOffset = 0;

  $: stage1 = status?.stages.find((s) => s.stage === 1) ?? null;
  $: stage2 = status?.stages.find((s) => s.stage === 2) ?? null;
  $: stage3 = status?.stages.find((s) => s.stage === 3) ?? null;
  $: p3 = status?.stage3?.progress ?? null;
  $: bars3 = [audioStage3Bar(p3, Date.now())].filter((b): b is ProgressBar => b !== null);
  /** Stage 3's analysis and phase: the duplicate lists reload when it changes. */
  $: analysis3 = p3 ? `${p3.analysisId}:${p3.phase}:${p3.finishedAt ?? ''}` : '';
  $: stage4 = status?.stages.find((s) => s.stage === 4) ?? null;
  $: s4 = status?.stage4 ?? null;
  $: p4 = s4?.progress ?? null;
  $: bars4 = [audioStage4Bar(s4)].filter((b): b is ProgressBar => b !== null);
  /** Stage 4's analysis and phase (the online lists reload when it changes, or every 50 decided). */
  $: analysis4 = p4
    ? `${p4.analysisId}:${p4.phase}:${p4.finishedAt ?? ''}:${Math.floor(p4.decided / 50)}`
    : '';
  $: stage5 = status?.stages.find((s) => s.stage === 5) ?? null;
  $: s5 = status?.stage5 ?? null;
  $: p5 = s5?.progress ?? null;
  $: bars5 = [audioStage5Bar(s5)].filter((b): b is ProgressBar => b !== null);
  /** Stage 5's analysis and phase (the metadata list reloads when it changes). */
  $: analysis5 = p5
    ? `${p5.analysisId}:${p5.phase}:${p5.finishedAt ?? ''}:${Math.floor(p5.decided / 200)}`
    : '';
  $: stage6 = status?.stages.find((s) => s.stage === 6) ?? null;
  $: s6 = status?.stage6?.available ? status.stage6 : null;
  $: p6 = s6?.progress ?? null;
  $: bars6 = [audioStage6Bar(s6)].filter((b): b is ProgressBar => b !== null);
  /** Stage 6's analysis and phase: the sample reloads when it changes. */
  $: analysis6 = p6 ? `${p6.analysisId}:${p6.phase}` : '';
  /** Stage 7 (WP21f-1): the daily new arrivals. */
  $: stage7 = status?.stages.find((s) => s.stage === 7) ?? null;
  $: run7 = status?.stage7?.available ? (status.stage7.run ?? null) : null;
  $: analysis7 = run7 ? `${run7.runId}:${run7.phase}` : '';
  $: stage8 = status?.stages.find((s) => s.stage === 8) ?? null;
  $: p8 = status?.stage8?.available ? status.stage8.progress : null;
  $: pass8 = p8 ? `${p8.runId ?? ''}:${p8.phase}:${p8.finishedAt ?? ''}` : '';
  /** While a run waits for stages 1-5, the bar of the one that is working. */
  $: activeStage = [1, 2, 3, 4, 5].find(
    (k) => status?.stages.find((s) => s.stage === k)?.state === 'analysing'
  );
  $: stage7Bars = activeStage ? (views[activeStage]?.bars ?? []) : [];
  $: if (analysis6 !== sampleFor) void loadSample(analysis6);
  let sample: AudioBuildBook[] = [];
  let sampleFor = '';
  async function loadSample(key: string) {
    sampleFor = key;
    if (!key) {
      sample = [];
      return;
    }
    try {
      sample = (await api.audioBuild('sample', 0, 30)).items as unknown as AudioBuildBook[];
    } catch {
      sample = [];
    }
  }
  interface StageView {
    bars: ProgressBar[];
    lines: string[];
    waiting: string | null;
    found: string[];
    /** The stage's analysis has finished (the bar and the waiting line give way to the summary). */
    done: boolean;
    summary: string | null;
    gate: string | null;
  }
  /** Per stage: its bars, lines, waiting text and what it found. */
  $: views = {
    1: {
      bars: bars1,
      lines: audioStage1Lines(p1, Date.now()),
      waiting: status?.stage1.waiting ?? null,
      found: identityLines(status?.stage1.counts ?? null),
      done: p1?.phase === 'done',
      summary: status ? stageSummary(1, status) : null,
      gate: null
    },
    2: {
      bars: bars2,
      lines: audioStage2Lines(p2),
      waiting: status?.stage2.waiting ?? null,
      found: booksLines(status?.stage2.counts ?? null),
      done: p2?.phase === 'done',
      summary: status ? stageSummary(2, status) : null,
      gate: null
    },
    3: {
      bars: bars3,
      lines: audioStage3Lines(p3),
      waiting: status?.stage3?.waiting ?? null,
      found: dupLines(status?.stage3?.counts ?? null),
      done: p3?.phase === 'done',
      summary: status ? stageSummary(3, status) : null,
      gate: gateSummary(3, p3?.gate)
    },
    4: {
      bars: bars4,
      lines: audioStage4Lines(s4),
      waiting: s4?.waiting ?? null,
      found: onlineFoundLines(s4?.counts ?? null),
      done: p4?.phase === 'done',
      summary: status ? stageSummary(4, status) : null,
      gate: gateSummary(4, p4?.gate)
    },
    5: {
      bars: bars5,
      lines: audioStage5Lines(s5),
      waiting: s5?.waiting ?? null,
      found: metaCountLines(p5?.counts),
      done: p5?.phase === 'done',
      summary: status ? stageSummary(5, status) : null,
      gate: metaGateSummary(p5?.gate)
    },
    6: {
      bars: bars6,
      lines: audioStage6Lines(s6),
      waiting: s6?.waiting ?? status?.stage6?.waiting ?? null,
      found: [],
      done: p6?.phase === 'done' || p6?.phase === 'planned',
      summary: stage6Summary(s6),
      gate: null
    }
  } as Record<number, StageView>;
  function hint(stage: AudioStageRow): string {
    if (stage.stage === 6) return STAGE6_HINTS[stage.mode];
    const mode = stage.mode === 'on' ? 'analyse' : stage.mode;
    if (stage.stage === 5) return STAGE5_HINTS[mode];
    if (stage.stage === 4) return STAGE4_HINTS[mode];
    return stage.stage === 3 ? STAGE3_HINTS[mode] : (AUDIO_STAGE_HINTS[stage.stage]?.[mode] ?? '');
  }
  $: p1 = status?.stage1.progress ?? null;
  $: p2 = status?.stage2.progress ?? null;
  $: bars1 = [audioStage1Bar(p1, Date.now())].filter((b): b is ProgressBar => b !== null);
  $: bars2 = [audioStage2Bar(p2, Date.now())].filter((b): b is ProgressBar => b !== null);
  $: latest = status?.stage0.latest ?? null;
  $: snapshotError =
    (status?.stages.find((s) => s.stage === 0)?.progress as { error?: string | null } | undefined)
      ?.error ?? null;

  /** Which cards have their details open (closed by default; remembered on this device). */
  const DETAILS_KEY = 'ttsu.cleanup.audio.details';
  let detailsOpen: Record<number, boolean> = {};

  function toggleDetails(stage: number, e: Event) {
    const open = (e.currentTarget as HTMLDetailsElement).open;
    if (open === !!detailsOpen[stage]) return;
    detailsOpen = { ...detailsOpen, [stage]: open };
    try {
      localStorage.setItem(DETAILS_KEY, JSON.stringify(detailsOpen));
    } catch {
      // Not remembered; still works.
    }
  }

  onMount(async () => {
    try {
      detailsOpen = JSON.parse(localStorage.getItem(DETAILS_KEY) ?? '{}') as Record<
        number,
        boolean
      >;
    } catch {
      detailsOpen = {};
    }
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
      // A stage finished or started again: the lists show what it found now.
      const analyses = [status.stage1?.progress, status.stage2?.progress]
        .map((p) => (p ? `${p.analysisId}:${p.phase}` : '-'))
        .join('|');
      if (analyses !== lastAnalyses) {
        const first = lastAnalyses === null;
        lastAnalyses = analyses;
        if (!first) {
          void loadFiles(fileOffset);
          void loadBooks(bookOffset);
        }
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

  async function setMode(stage: AudioStageRow, mode: AudioStageMode | 'on') {
    if (stage.mode === mode) return;
    // On builds japanese-new on the NAS: it asks first.
    if (mode === 'on' && !(await confirmDestructive(buildOnCopy(stage6Summary(s6))))) return;
    actionError = '';
    try {
      status = await api.setAudioStageMode(stage.stage, mode);
    } catch (err) {
      actionError = describe(err);
    }
  }

  /** Stages whose "Run the analysis again" was sent and has not come back yet. */
  let analysing: Record<number, boolean> = {};

  /**
   * "Run the analysis again" starts the stage over, so it asks first (a second press on a slow
   * page started stage 5 over again on 2026-11-20) and can't be pressed while it is sent.
   */
  async function analyseAgain(stage: AudioStageRow) {
    const detail =
      stage.stage === 5
        ? 'Every recording is decided again from the answers already given; only questions without an answer are asked (a few cents at most).'
        : 'The stage starts over and can take as long as its first run.';
    if (!(await confirmDestructive(analyseAgainCopy(stage.name, detail)))) return;
    actionError = '';
    analysing = { ...analysing, [stage.stage]: true };
    try {
      status = await api.audioAnalyseAgain(stage.stage);
    } catch (err) {
      actionError = describe(err);
    } finally {
      analysing = { ...analysing, [stage.stage]: false };
    }
  }

  /** Stage 6: the move list or the plan as CSV. */
  async function downloadBuild(file: 'moves.csv' | 'plan.csv') {
    actionError = '';
    try {
      const blob = await api.audioBuildFile(file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file === 'moves.csv' ? 'audiobooks-move-list.csv' : 'audiobooks-build-plan.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function checkAgain() {
    actionError = '';
    try {
      status = await api.audioBuildCheckAgain();
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

  async function resumeSite(site: string) {
    actionError = '';
    try {
      await api.resumeSite(site);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function retrySite(site: string) {
    actionError = '';
    try {
      await api.retryAudioSite(site);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
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

  <section class="mt-6 flex flex-col gap-3" data-testid="audio-status">
    <SettingsSection jp="状況" title="Audiobooks" />
    {#if diskBusy(status.lock)}
      <p class="text-sm" data-testid="audio-disk">{diskLine(status.lock)}</p>
    {/if}
    {#if status.available && !status.roots.ok}
      <p class="c-notice text-sm" role="alert" data-testid="audio-roots">
        {status.roots.problem}
      </p>
    {/if}

    <div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="audio-stage-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-mincho font-bold">0 · Audiobookshelf snapshot</h3>
        <button
          class="c-btn c-btn-secondary"
          disabled={status.stage0.snapshotting || !status.stage0.absUrlSet || !status.stage0.keySet}
          on:click={takeSnapshot}
          data-testid="audio-snapshot-take"
        >
          {status.stage0.snapshotting ? 'Taking a snapshot…' : 'Take a snapshot'}
        </button>
      </div>
      <p class="text-sm text-c-muted" data-testid="audio-snapshot-when">
        {latest ? `Taken ${formatWhen(latest.summary.takenAt)}.` : 'No snapshot yet.'}
      </p>
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
      {#if latest}
        <details
          open={detailsOpen[0]}
          on:toggle={(e) => toggleDetails(0, e)}
          data-testid="audio-details-0"
        >
          <summary class="cursor-pointer text-sm text-c-muted">Details</summary>
          <div class="mt-2 flex flex-col gap-2 text-sm">
            <p class="text-c-muted">Read only: libraries, counts and listening progress.</p>
            <p data-testid="audio-snapshot-summary">{snapshotLine(latest?.summary)}</p>
            <div class="flex flex-wrap gap-2">
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
            </div>
          </div>
        </details>
      {/if}
    </div>

    {#each [stage1, stage2, stage3, stage4, stage5, stage6] as stage (stage?.stage)}
      {#if stage}
        <div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="audio-stage-{stage.stage}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-mincho font-bold">{stage.stage} · {stage.name}</h3>
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage {stage.stage}">
              {#each modesOf(stage) as mode (mode)}
                <button
                  class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
                  role="radio"
                  aria-checked={stage.mode === mode}
                  on:click={() => stage && setMode(stage, mode)}
                  data-testid="audio-stage-{stage.stage}-{mode}"
                >
                  {modeLabel(mode)}
                </button>
              {/each}
            </div>
          </div>
          {#if stage.pauseReason}
            <p class="c-notice text-sm" role="alert">
              <b>Paused:</b>
              {stage.pauseDetail ?? stage.pauseReason}
            </p>
          {/if}
          {#if stage.mode !== 'off' && !views[stage.stage].done}
            {#each views[stage.stage].bars as bar (bar.label)}
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
            {#if !stage.pauseReason && views[stage.stage].waiting}
              <p class="text-sm text-c-muted" data-testid="audio-waiting-{stage.stage}">
                {views[stage.stage].waiting}
              </p>
            {/if}
          {/if}
          {#if stage.mode !== 'off' && views[stage.stage].summary}
            <p class="text-sm" data-testid="audio-summary-{stage.stage}">
              {views[stage.stage].summary}
            </p>
          {/if}
          {#if stage.mode !== 'off' && views[stage.stage].gate}
            <p class="text-sm" data-testid="audio-gate-summary-{stage.stage}">
              {views[stage.stage].gate}
            </p>
          {/if}
          {#if stage.stage === 5 && s5 && stage.mode !== 'off'}
            <p class="text-sm" data-testid="audio-spend">{spendLine(s5)}</p>
          {/if}
          {#if stage.stage === 6 && s6 && stage.mode !== 'off'}
            {#if s6.waiting && views[6].done && !stage.pauseReason}
              <p class="text-sm text-c-muted" data-testid="audio-waiting-6-done">{s6.waiting}</p>
            {/if}
            {#if stage.mode === 'analyse' && p6?.phase === 'planned' && s6.onRefusals?.length}
              <p class="c-notice text-sm" data-testid="audio-build-refusals">
                <b>Can’t build yet:</b>
                {s6.onRefusals.join('; ')}
              </p>
            {/if}
            {#if p6?.check}
              <p class="text-sm" data-testid="audio-build-check">
                Check: {p6.check.passed ? '✓ passed' : '✗ not passed (see Details)'}
              </p>
            {/if}
          {/if}
          {#if stage.stage === 6 && status?.switch?.available && (p6?.phase === 'done' || (status.switch.state ?? 'none') !== 'none')}
            <CleanupAudioSwitch {api} sw={status.switch} onStatus={(next) => (status = next)} />
          {/if}
          {#if stage.stage === 4 && s4 && stage.mode !== 'off'}
            {#if s4.fetcher && !s4.fetcher.online}
              <p class="c-notice text-sm" role="alert" data-testid="audio-fetcher-offline">
                The fetch container is offline: nothing is asked until it is back.
              </p>
            {/if}
            <!-- A site that needs you (paused, or requests given up) shows outside the fold. -->
            {#each s4.sites.filter((x) => x.pausedReason || x.failed > 0) as site (site.site)}
              <p class="text-sm" data-testid="audio-site-problem-{site.site}">
                {siteLine(site)}
                {#if site.pausedReason}
                  <button class="c-btn c-btn-ghost" on:click={() => resumeSite(site.site)}
                    >Resume</button
                  >
                {/if}
                {#if site.failed > 0}
                  <button
                    class="c-btn c-btn-ghost"
                    on:click={() => retrySite(site.site)}
                    data-testid="audio-site-retry-{site.site}">Ask again</button
                  >
                {/if}
              </p>
            {/each}
          {/if}
          <details
            open={detailsOpen[stage.stage]}
            on:toggle={(e) => stage && toggleDetails(stage.stage, e)}
            data-testid="audio-details-{stage.stage}"
          >
            <summary class="cursor-pointer text-sm text-c-muted">Details</summary>
            <div class="mt-2 flex flex-col gap-2 text-sm">
              <p class="text-c-muted">{hint(stage)}</p>
              {#if stage.mode !== 'off'}
                <div>
                  <button
                    class="c-btn c-btn-ghost"
                    disabled={analysing[stage.stage] || stage.state === 'analysing'}
                    title={stage.state === 'analysing'
                      ? 'The stage is running; switch it Off first to start over'
                      : null}
                    on:click={() => stage && analyseAgain(stage)}
                    data-testid="audio-analyse-again-{stage.stage}"
                    >{analysing[stage.stage] ? 'Starting…' : 'Run the analysis again'}</button
                  >
                </div>
              {/if}
              {#each views[stage.stage].lines as line}
                <p>{line}</p>
              {/each}
              {#each views[stage.stage].found as line}
                <p data-testid="audio-found-{stage.stage}">{line}</p>
              {/each}
              {#if stage.stage === 4 && s4 && stage.mode !== 'off'}
                <div class="flex flex-col gap-1" data-testid="audio-sites">
                  {#each s4.sites as site (site.site)}
                    <p data-testid="audio-site-{site.site}">{siteLine(site)}</p>
                  {/each}
                </div>
              {/if}
              {#if stage.stage === 4 && p4?.gate}
                <div class="flex flex-col gap-1" data-testid="audio-online-gate-card">
                  <p class="font-medium">
                    Checked on the labeled books: {p4.gate.passed ? '✓ passes' : '✗ not passed'}
                  </p>
                  {#each onlineGateLines(p4.gate) as line}<p>{line}</p>{/each}
                  {#each p4.gate.misses.slice(0, 10) as m (m.id)}
                    <p class="font-bold">{onlineMissLine(m)}</p>
                  {/each}
                </div>
              {/if}
              {#if stage.stage === 5 && p5?.gate}
                <div class="flex flex-col gap-1" data-testid="audio-meta-gate-card">
                  <p class="font-medium">
                    Checked on the labeled books: {p5.gate.passed ? '✓ passes' : '✗ not passed'}
                  </p>
                  {#each metaGateLines(p5.gate) as line}<p>{line}</p>{/each}
                  {#each p5.gate.misses.slice(0, 10) as m (`${m.id}:${m.field}`)}
                    <p class="font-bold">{metaMissLine(m)}</p>
                  {/each}
                </div>
              {/if}
              {#if stage.stage === 6 && p6}
                <div class="flex flex-wrap gap-2" data-testid="audio-build-downloads">
                  <button class="c-btn c-btn-ghost" on:click={() => downloadBuild('moves.csv')}
                    >Download the move list (CSV)</button
                  >
                  <button class="c-btn c-btn-ghost" on:click={() => downloadBuild('plan.csv')}
                    >Download the plan (CSV)</button
                  >
                  {#if p6.phase === 'done' && stage.mode !== 'on'}
                    <button
                      class="c-btn c-btn-ghost"
                      on:click={checkAgain}
                      data-testid="audio-build-check-again">Check again</button
                    >
                  {/if}
                </div>
                {#if p6.check}
                  <div class="flex flex-col gap-1" data-testid="audio-build-check-card">
                    <p class="font-medium">
                      The check: {p6.check.passed ? '✓ passed' : '✗ not passed'}
                    </p>
                    {#each checkLines(p6) as line}<p>{line}</p>{/each}
                    {#each labelDiffLines(p6).slice(0, 20) as line}<p class="text-c-muted">
                        {line}
                      </p>{/each}
                  </div>
                {/if}
                {#if sample.length}
                  <div class="flex flex-col gap-2" data-testid="audio-build-sample">
                    <p class="font-medium">{n(sample.length)} random books of the plan</p>
                    {#each sample as b (b.id)}
                      <div
                        class="flex flex-col gap-0.5 border-b pb-2"
                        style="border-color: var(--c-line)"
                      >
                        <span class="break-all font-medium">{bookLine(b)}</span>
                        <span class="break-all text-c-muted">{metadataLine(b.metadata)}</span>
                        {#each b.files.slice(0, 5) as f (f.to)}
                          <span class="break-all text-xs text-c-muted">{f.from} → {f.to}</span>
                        {/each}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
              {#if stage.stage === 3 && p3?.gate}
                <div class="flex flex-col gap-1" data-testid="audio-gate">
                  <p class="font-medium">
                    Checked on the labeled pairs: {p3.gate.passed ? '✓ passes' : '✗ not passed'}
                  </p>
                  {#each gateLines(p3.gate) as line}<p>{line}</p>{/each}
                  {#each p3.gate.misses.slice(0, 10) as m (m.n)}
                    <p class="font-bold">{missLine(m)}</p>
                  {/each}
                  {#if p3.gate.misses.length > 10}
                    <p class="text-c-muted">
                      And {n(p3.gate.misses.length - 10)} more (list “Checked on the labeled pairs” below).
                    </p>
                  {/if}
                </div>
              {/if}
            </div>
          </details>
        </div>
      {/if}
    {/each}

    {#if stage7 && status.stage7?.available}
      <CleanupAudioArrivals
        {api}
        {status}
        stage={stage7}
        stageBars={stage7Bars}
        detailsOpen={detailsOpen[7]}
        onToggle={(e) => toggleDetails(7, e)}
        onStatus={(next) => (status = next)}
      />
    {/if}

    {#if stage8 && status.stage8?.available}
      <CleanupAudioEbooks
        {api}
        {status}
        stage={stage8}
        detailsOpen={detailsOpen[8]}
        onToggle={(e) => toggleDetails(8, e)}
        onStatus={(next) => (status = next)}
      />
    {/if}
  </section>

  {#if stage8 && p8}
    <CleanupSection
      id="audio-ebooks"
      jp="電子書籍"
      title="Calibre ebooks"
      summary={p8.counts.review ? `${n(p8.counts.review)} pairs to review` : ''}
      testid="audio-ebooks-section"
    >
      <CleanupAudioEbooksLists {api} pass={pass8} />
    </CleanupSection>
  {/if}

  {#if stage7 && run7}
    <CleanupSection
      id="audio-arrivals"
      jp="新着"
      title="New arrivals"
      summary={status.stage7?.openReviews
        ? `${n(Object.values(status.stage7.openReviews).reduce((a, b) => a + b, 0))} to look at`
        : ''}
      testid="audio-arrivals-section"
    >
      <CleanupAudioArrivalsLists {api} run={analysis7} />
    </CleanupSection>
  {/if}

  {#if stage3 && p3}
    <CleanupSection
      id="audio-dups"
      jp="重複"
      title="Same recording"
      summary={status.stage3?.counts ? `${n(status.stage3.counts.review ?? 0)} to review` : ''}
      testid="audio-dups-section"
    >
      <CleanupAudioDups {api} analysis={analysis3} />
    </CleanupSection>
  {/if}

  {#if stage4 && p4}
    <CleanupSection
      id="audio-online"
      jp="照合"
      title="Online sources"
      summary={s4?.counts ? `${n(s4.counts.review ?? 0)} to review` : ''}
      testid="audio-online-section"
    >
      <CleanupAudioOnline {api} analysis={analysis4} />
    </CleanupSection>
  {/if}

  {#if stage5 && p5}
    <CleanupSection
      id="audio-meta"
      jp="書誌"
      title="Metadata"
      summary={p5.counts?.title?.flagged !== undefined
        ? `${n(p5.counts.title.flagged)} unconfirmed titles`
        : ''}
      testid="audio-meta-section"
    >
      <CleanupAudioMeta {api} analysis={analysis5} />
    </CleanupSection>
  {/if}

  {#if snapshot && snapshot.progress.length}
    <!-- The list is long (every user's progress): folded away so the stages stay at the top. -->
    <CleanupSection
      id="audio-progress"
      jp="進捗"
      title="Listening progress"
      summary={count(snapshot.progress.length, 'entry', 'entries')}
      testid="audio-progress"
    >
      <ul class="flex flex-col text-sm" data-testid="audio-progress-list">
        {#each snapshot.progress as row, i (i)}
          <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
            <span class="font-medium">
              {row.title ?? '(no title)'}
              {#if !row.inAbs}<span class="text-c-muted"> · no longer in Audiobookshelf</span>{/if}
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
    </CleanupSection>
  {/if}

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
