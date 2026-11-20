<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Settings tab of /cleanup (WP20a). Everything is kept on the server: the Calibre
   * content server with its user and password, the library to clean (the content server's
   * id for it is found automatically from the server's own list; asked only when it can't
   * be told), your own tags, the pace and checks shared by every stage, covers, and the AI
   * keys and models
   * (stored now, used by later stages). One Save saves all of it. The password and keys are
   * write-only: the page never gets them back, only whether one is saved (and the last
   * 4 characters of an API key).
   *
   * The app compiles with `immutable: true`, so values the template shows are always
   * replaced, never changed in place.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import type {
    CleanupApi,
    CleanupSettings,
    CleanupStatus,
    SecretInfo,
    SecretName
  } from '$lib/cleanup/cleanup-api';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeCleanupSecretCopy } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/notes/notes-format';
  import { SITE_NAMES } from '$lib/cleanup/stage4-text';
  import { DUP_FIELDS } from '$lib/cleanup/audio-dup-text';
  import { ONLINE_FIELDS, SITE_LABELS, foldersFromText } from '$lib/cleanup/audio-online-text';
  import type { AiStatus } from '$lib/cleanup/cleanup-api';

  export let api: CleanupApi;
  export let libraries: { id: string; name: string; folder: string }[] = [];
  /** The content server's libraries and the one in use (from the status). */
  export let calibre: CleanupStatus['calibre'] | null = null;

  const dispatch = createEventDispatcher<{ saved: void }>();

  const KEYS: { name: SecretName; label: string }[] = [
    { name: 'anthropicApiKey', label: 'Anthropic API key' },
    { name: 'openaiApiKey', label: 'OpenAI API key' }
  ];

  const MODEL_LABELS: Record<string, string> = {
    'stage4.primary': 'Online sources: first model',
    'stage4.secondary': 'Online sources: second model',
    'stage4.upgradePrimary': 'Online sources: upgrade, first model',
    'stage4.upgradeSecondary': 'Online sources: upgrade, second model',
    'stage5.primary': 'Genres and tags: first model',
    'stage5.secondary': 'Genres and tags: second model',
    'audio5.primary': 'Audiobook metadata: first model',
    'audio5.secondary': 'Audiobook metadata: second model',
    'audio5.upgradePrimary': 'Audiobook metadata: upgrade, first model',
    'audio5.upgradeSecondary': 'Audiobook metadata: upgrade, second model'
  };

  /** The AI's spending, the models' checks (WP21d); null on an older server. */
  let ai: AiStatus | null = null;
  let aiError = '';
  let checking = false;
  /** The spending limit as typed ('' = not set: nothing is asked). */
  let limitText: number | '' = '';

  async function loadAi() {
    try {
      ai = await api.aiStatus();
      aiError = '';
    } catch {
      ai = null;
    }
  }

  async function checkModels() {
    checking = true;
    aiError = '';
    try {
      ai = await api.checkAiModels();
    } catch (err) {
      aiError = (err as Error).message;
    } finally {
      checking = false;
    }
  }

  /** Every configured model once (the models map's values). */
  $: aiModels = settings ? [...new Set(Object.values(settings.models).filter(Boolean))] : [];
  let testing: Record<string, boolean> = {};
  let testTimer: ReturnType<typeof setInterval> | undefined;
  onDestroy(() => clearInterval(testTimer));

  function setModelMode(model: string, mode: string) {
    if (!settings?.ai) return;
    settings = {
      ...settings,
      ai: { ...settings.ai, modes: { ...settings.ai.modes, [model]: mode as 'batch' | 'direct' } }
    };
    saved = false;
  }

  /** "Test batch": one tiny question as a batch; the result shows below (checked every 20 s). */
  async function testBatch(model: string) {
    testing = { ...testing, [model]: true };
    aiError = '';
    try {
      ai = await api.testAiBatch(model);
      clearInterval(testTimer);
      testTimer = setInterval(async () => {
        await loadAi();
        if (!ai || !Object.values(ai.batchTests).some((t) => t.state === 'open'))
          clearInterval(testTimer);
      }, 20_000);
    } catch (err) {
      aiError = (err as Error).message;
    } finally {
      testing = { ...testing, [model]: false };
    }
  }

  function batchTestText(status: AiStatus | null, model: string): string {
    const t = status?.batchTests?.[model];
    if (!t) return 'Batch not tested yet';
    const when = formatWhen(t.submittedAt);
    if (t.state === 'open') return `Batch test running since ${when}`;
    if (t.state === 'answered') return `Batch test ${when}: ${t.detail ?? 'answered'} ✓`;
    if (t.state === 'nothing') return `Batch test ${when}: ${t.detail ?? 'nothing answered'}`;
    return `Batch test ${when}: failed (${t.detail ?? ''})`;
  }

  function taskState(t: AiStatus['tasks'][number]): string {
    const where = t.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    if (t.checked === null) return `${where}: not checked yet`;
    return t.checked ? `${where}: offered ✓` : `${where}: NOT offered`;
  }

  let settings: CleanupSettings | null = null;
  let secrets: Record<SecretName, SecretInfo> | null = null;
  let loadError = '';
  let saveError = '';
  let saved = false;
  let saving = false;
  let secretValues: Record<SecretName, string> = {
    calibrePassword: '',
    anthropicApiKey: '',
    openaiApiKey: '',
    absApiKey: ''
  };
  let customTagsText = '';
  /** Audiobook stage 4: folders with no store record, one per line. */
  let noRecordText = '';
  /** The titles' own bar ('' = the bar for every field). */
  let titleBar: number | '' = '';
  /** The content server library chosen by hand ('' = found automatically). */
  let serverLibrary = '';
  /** Stage 3's limits for extra text inside the chapters, in % ('' = not set yet). */
  let spreadKeepBoth: number | '' = '';
  let spreadIgnore: number | '' = '';

  const percentOf = (v: number | null | undefined): number | '' =>
    typeof v === 'number' ? Math.round(v * 10000) / 100 : '';
  const shareOf = (v: number | '' | null): number | null =>
    v === '' || v === null || v === undefined ? null : Number(v) / 100;

  $: needsServerLibrary =
    !!calibre && calibre.libraries.length > 1 && (calibre.id === null || !calibre.auto);

  onMount(load);

  async function load() {
    try {
      const answer = await api.settings();
      settings = answer.settings;
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      noRecordText = (settings.audiobooks?.noStoreRecordFolders ?? []).join('\n');
      titleBar = settings.gate.fieldPercent.title ?? '';
      serverLibrary = settings.calibreLibraryId;
      spreadKeepBoth = percentOf(settings.duplicates?.spreadKeepBoth);
      spreadIgnore = percentOf(settings.duplicates?.spreadIgnore);
      limitText = settings.ai?.spendLimitUsd ?? '';
      void loadAi();
      loadError = '';
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  function setSecretValue(name: SecretName, value: string) {
    secretValues = { ...secretValues, [name]: value };
    saved = false;
  }

  /** The per-field bars: the shown title bar (empty = the shared bar), the others kept. */
  function fieldBars(): Record<string, number> {
    const { title: _title, ...rest } = settings?.gate.fieldPercent ?? {};
    return titleBar === '' || titleBar === null ? rest : { ...rest, title: Number(titleBar) };
  }

  /** Saves the settings and every password or key that was typed. */
  async function save() {
    if (!settings) return;
    saving = true;
    saveError = '';
    saved = false;
    try {
      const answer = await api.saveSettings({
        contentServerUrl: settings.contentServerUrl,
        calibreLibraryId: serverLibrary,
        calibreUsername: settings.calibreUsername,
        targetLibraryId: settings.targetLibraryId || null,
        models: settings.models,
        pacing: {
          readMbPerSecond: Number(settings.pacing.readMbPerSecond),
          itemDelaySeconds: Number(settings.pacing.itemDelaySeconds),
          batchSize: Number(settings.pacing.batchSize),
          maxBatchPercent: Number(settings.pacing.maxBatchPercent),
          lookupChunk: Number(settings.pacing.lookupChunk)
        },
        customTags: customTagsText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean),
        gate: {
          defaultPercent: Number(settings.gate.defaultPercent),
          fieldPercent: fieldBars(),
          marginPoints: Number(settings.gate.marginPoints),
          minBooks: Number(settings.gate.minBooks),
          labeledBooksFile: settings.gate.labeledBooksFile,
          duplicatePairsFile: settings.gate.duplicatePairsFile ?? '',
          ...(settings.gate.audiobookPairsFile !== undefined
            ? { audiobookPairsFile: settings.gate.audiobookPairsFile }
            : {}),
          ...(settings.gate.audiobookMetaPercent !== undefined
            ? { audiobookMetaPercent: Number(settings.gate.audiobookMetaPercent) }
            : {})
        },
        reviewAlarmPercent: Number(settings.reviewAlarmPercent),
        libraryChangedPausePercent: Number(settings.libraryChangedPausePercent),
        failedPausePercent: Number(settings.failedPausePercent),
        covers: {
          maxMb: Number(settings.covers.maxMb),
          maxSide: Number(settings.covers.maxSide),
          sameDistance: Number(settings.covers.sameDistance),
          largerPercent: Number(settings.covers.largerPercent)
        },
        ...(settings.duplicates
          ? {
              duplicates: {
                bothWays: Number(settings.duplicates.bothWays),
                superset: Number(settings.duplicates.superset),
                reviewFloor: Number(settings.duplicates.reviewFloor),
                spreadKeepBoth: shareOf(spreadKeepBoth),
                spreadIgnore: shareOf(spreadIgnore),
                imageOnlyMaxChars: Number(settings.duplicates.imageOnlyMaxChars),
                imageMatchDistance: Number(settings.duplicates.imageMatchDistance),
                commonWindowBooks: Number(settings.duplicates.commonWindowBooks),
                textTimeoutSeconds: Number(settings.duplicates.textTimeoutSeconds),
                textWorkers: Number(settings.duplicates.textWorkers)
              }
            }
          : {}),
        ...(settings.audiobooks
          ? {
              audiobooks: {
                absUrl: settings.audiobooks.absUrl,
                readMbPerSecond: Number(settings.audiobooks.readMbPerSecond),
                healthWorkers: Number(settings.audiobooks.healthWorkers),
                decodeSeconds: Number(settings.audiobooks.decodeSeconds),
                toolTimeoutSeconds: Number(settings.audiobooks.toolTimeoutSeconds),
                copyHintMinMinutes: Number(settings.audiobooks.copyHintMinMinutes),
                copyHintPercent: Number(settings.audiobooks.copyHintPercent),
                absTimeoutSeconds: Number(settings.audiobooks.absTimeoutSeconds),
                // Stage 3 (WP21b): only when the server knows them.
                ...(settings.audiobooks.dupSameScore !== undefined
                  ? Object.fromEntries(
                      DUP_FIELDS.map((d) => [d.key, Number(settings?.audiobooks?.[d.key])])
                    )
                  : {}),
                // Stage 4 (WP21c): only when the server knows them.
                ...(settings.audiobooks.onlineRuntimeMinutes !== undefined
                  ? {
                      ...Object.fromEntries(
                        ONLINE_FIELDS.map((d) => [d.key, Number(settings?.audiobooks?.[d.key])])
                      ),
                      noStoreRecordFolders: foldersFromText(noRecordText)
                    }
                  : {}),
                // Stage 5 (WP21d): only when the server knows it.
                ...(settings.audiobooks.multiNarratorMin !== undefined
                  ? { multiNarratorMin: Number(settings.audiobooks.multiNarratorMin) }
                  : {})
              }
            }
          : {}),
        ...(settings.fetch
          ? {
              fetch: {
                ...settings.fetch,
                sites: Object.fromEntries(
                  Object.entries(settings.fetch.sites).map(([k, v]) => [
                    k,
                    { enabled: v.enabled, intervalSeconds: Number(v.intervalSeconds) }
                  ])
                ),
                challengeBackoffSeconds: Number(settings.fetch.challengeBackoffSeconds),
                challengeBackoffMaxSeconds: Number(settings.fetch.challengeBackoffMaxSeconds),
                challengePauseAfter: Number(settings.fetch.challengePauseAfter),
                slowDownPercent: Number(settings.fetch.slowDownPercent),
                slowDownWindow: Number(settings.fetch.slowDownWindow),
                retrySeconds: Number(settings.fetch.retrySeconds),
                maxAttempts: Number(settings.fetch.maxAttempts),
                leaseSeconds: Number(settings.fetch.leaseSeconds),
                requestTimeoutSeconds: Number(settings.fetch.requestTimeoutSeconds),
                maxPageMb: Number(settings.fetch.maxPageMb),
                ndlNamesPerQuery: Number(settings.fetch.ndlNamesPerQuery),
                ndlOutageMinutes: Number(settings.fetch.ndlOutageMinutes),
                nativelyRereadDays: Number(settings.fetch.nativelyRereadDays),
                smallCoverPx: Number(settings.fetch.smallCoverPx),
                offlineSeconds: Number(settings.fetch.offlineSeconds)
              }
            }
          : {}),
        ...(settings.ai
          ? {
              ai: {
                ...settings.ai,
                spendLimitUsd: limitText === '' || limitText === null ? null : Number(limitText),
                directWorkers: Number(settings.ai.directWorkers),
                batchSize: Number(settings.ai.batchSize),
                batchStallMinutes: Number(settings.ai.batchStallMinutes),
                batchPollSeconds: Number(settings.ai.batchPollSeconds),
                maxTokens: Number(settings.ai.maxTokens),
                requestTimeoutSeconds: Number(settings.ai.requestTimeoutSeconds),
                attempts: Number(settings.ai.attempts),
                batchPriceFactor: Number(settings.ai.batchPriceFactor),
                prices: Object.fromEntries(
                  Object.entries(settings.ai.prices).map(([k, v]) => [
                    k,
                    { inputPerMTok: Number(v.inputPerMTok), outputPerMTok: Number(v.outputPerMTok) }
                  ])
                )
              }
            }
          : {})
      });
      settings = answer.settings;
      titleBar = settings.gate.fieldPercent.title ?? '';
      spreadKeepBoth = percentOf(settings.duplicates?.spreadKeepBoth);
      spreadIgnore = percentOf(settings.duplicates?.spreadIgnore);
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      noRecordText = (settings.audiobooks?.noStoreRecordFolders ?? []).join('\n');
      limitText = settings.ai?.spendLimitUsd ?? '';
      for (const name of Object.keys(secretValues) as SecretName[]) {
        const value = secretValues[name];
        if (!value.trim()) continue;
        secrets = (await api.saveSecret(name, value)).secrets;
        secretValues = { ...secretValues, [name]: '' };
      }
      saved = true;
      dispatch('saved');
    } catch (err) {
      saveError = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  async function removeSecret(name: SecretName, label: string) {
    if (!(await confirmDestructive(removeCleanupSecretCopy(label)))) return;
    try {
      secrets = (await api.removeSecret(name)).secrets;
      dispatch('saved');
    } catch (err) {
      saveError = (err as Error).message;
    }
  }

  function secretState(info: SecretInfo | undefined): string {
    if (!info?.set) return 'Not saved yet';
    const when = info.updatedAt ? ` ${formatWhen(info.updatedAt)}` : '';
    return info.hint ? `Saved${when} · ends in ${info.hint}` : `Saved${when}`;
  }

  const field = 'flex flex-col gap-1 text-sm';
  const label = 'font-medium';
  const legend = 'mb-2 font-mincho text-lg font-bold';
</script>

{#if loadError}
  <p class="c-notice" role="alert">{loadError}</p>
{:else if settings && secrets}
  <form class="flex flex-col gap-10" on:submit|preventDefault={save} data-testid="cleanup-settings">
    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Calibre content server</legend>
      <label class="{field} sm:col-span-2">
        <span class={label}>Address</span>
        <input
          class="c-input"
          type="url"
          placeholder="http://192.168.1.5:8083"
          bind:value={settings.contentServerUrl}
          data-testid="cleanup-content-server"
        />
      </label>
      <label class={field}>
        <span class={label}>User</span>
        <input
          class="c-input"
          autocomplete="off"
          bind:value={settings.calibreUsername}
          data-testid="cleanup-username"
        />
      </label>
      <div class={field}>
        <label class={field}>
          <span class={label}>Password</span>
          <input
            class="c-input"
            type="password"
            autocomplete="new-password"
            placeholder={secrets.calibrePassword.set ? 'Saved; type a new one to change it' : ''}
            value={secretValues.calibrePassword}
            on:input={(e) => setSecretValue('calibrePassword', e.currentTarget.value)}
            data-testid="cleanup-secret-calibrePassword"
          />
        </label>
        <span
          class="flex flex-wrap items-center gap-x-2 text-c-muted"
          data-testid="cleanup-secret-state-calibrePassword"
        >
          {secretState(secrets.calibrePassword)}
          {#if secrets.calibrePassword.set}
            <button
              type="button"
              class="c-btn c-btn-ghost"
              on:click={() => removeSecret('calibrePassword', 'Calibre password')}>Remove</button
            >
          {/if}
        </span>
      </div>
      <p class="text-sm text-c-muted sm:col-span-2">
        The user needs permission to make changes (not read-only) in Calibre’s sharing settings.
      </p>
    </fieldset>

    {#if settings.audiobooks}
      <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-audiobooks-settings">
        <legend class={legend}>Audiobooks</legend>
        <label class="{field} sm:col-span-2">
          <span class={label}>Audiobookshelf address</span>
          <input
            class="c-input"
            type="url"
            placeholder="http://192.168.1.5:13378"
            bind:value={settings.audiobooks.absUrl}
            data-testid="cleanup-abs-url"
          />
        </label>
        <div class="{field} sm:col-span-2">
          <label class={field}>
            <span class={label}>Audiobookshelf API key</span>
            <input
              class="c-input"
              type="password"
              autocomplete="off"
              placeholder={secrets.absApiKey?.set ? 'Saved; type a new one to change it' : ''}
              value={secretValues.absApiKey}
              on:input={(e) => setSecretValue('absApiKey', e.currentTarget.value)}
              data-testid="cleanup-secret-absApiKey"
            />
          </label>
          <span
            class="flex flex-wrap items-center gap-x-2 text-c-muted"
            data-testid="cleanup-secret-state-absApiKey"
          >
            {secretState(secrets.absApiKey)}
            {#if secrets.absApiKey?.set}
              <button
                type="button"
                class="c-btn c-btn-ghost"
                on:click={() => removeSecret('absApiKey', 'Audiobookshelf API key')}>Remove</button
              >
            {/if}
          </span>
          <span class="text-c-muted">
            Make the key in Audiobookshelf (Settings › API Keys) for an admin user, so every user’s
            listening progress can be read. Audiobookshelf is only read, never changed.
          </span>
        </div>
        <label class={field}>
          <span class={label}>Reading speed for comparing files (MB/s, 0 = no limit)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            step="1"
            bind:value={settings.audiobooks.readMbPerSecond}
            data-testid="cleanup-audio-read-mbps"
          />
        </label>
        <label class={field}>
          <span class={label}>Files checked at the same time</span>
          <input
            class="c-input"
            type="number"
            min="1"
            max="16"
            step="1"
            bind:value={settings.audiobooks.healthWorkers}
            data-testid="cleanup-audio-workers"
          />
        </label>
        <label class={field}>
          <span class={label}>Seconds played at the start and the end of each file</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.audiobooks.decodeSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Time limit for checking one file (s)</span>
          <input
            class="c-input"
            type="number"
            min="5"
            step="1"
            bind:value={settings.audiobooks.toolTimeoutSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Copies in one folder: each file at least (minutes)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            step="1"
            bind:value={settings.audiobooks.copyHintMinMinutes}
          />
        </label>
        <label class={field}>
          <span class={label}>Copies in one folder: lengths within (%)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            step="0.5"
            bind:value={settings.audiobooks.copyHintPercent}
          />
        </label>
        <label class={field}>
          <span class={label}>Audiobookshelf time limit (s)</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.audiobooks.absTimeoutSeconds}
          />
        </label>
        {#if settings.audiobooks.dupSameScore !== undefined}
          <p class="text-c-muted sm:col-span-2" data-testid="cleanup-audio-dup-settings">
            Same recording (stage 3). The line and the length limits were set from the labeled
            pairs; a change compares again from what was already heard (nothing is read twice).
          </p>
          {#each DUP_FIELDS as d (d.key)}
            <label class={field}>
              <span class={label}>{d.label}</span>
              <input
                class="c-input"
                type="number"
                min={d.min}
                max={d.max}
                step={d.step}
                bind:value={settings.audiobooks[d.key]}
                data-testid="cleanup-audio-{d.key}"
              />
            </label>
          {/each}
          {#if settings.audiobooks.onlineRuntimeMinutes !== undefined}
            <p class="text-c-muted sm:col-span-2" data-testid="cleanup-audio-online-settings">
              Online sources (stage 4). A store record matches only when the title, the author (when
              the names or tags give one), the printed volume and the length all agree; a change
              decides again from the answers already fetched (nothing is asked twice).
            </p>
            {#each ONLINE_FIELDS as d (d.key)}
              <label class={field}>
                <span class={label}>{d.label}</span>
                <input
                  class="c-input"
                  type="number"
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  bind:value={settings.audiobooks[d.key]}
                  data-testid="cleanup-audio-{d.key}"
                />
              </label>
            {/each}
            <label class="{field} sm:col-span-2">
              <span class={label}
                >Folders with no store record (radio clips; one per line, under the torrents)</span
              >
              <textarea
                class="c-input"
                rows="2"
                bind:value={noRecordText}
                data-testid="cleanup-audio-no-record-folders"
              />
            </label>
          {/if}
          {#if settings.audiobooks.multiNarratorMin !== undefined}
            <p class="text-c-muted sm:col-span-2" data-testid="cleanup-audio-meta-settings">
              Metadata (stage 5). A change decides again from the answers already given (the models
              are not asked again).
            </p>
            <label class={field}>
              <span class={label}>複数ナレーター from (narrators)</span>
              <input
                class="c-input"
                type="number"
                min="2"
                max="20"
                step="1"
                bind:value={settings.audiobooks.multiNarratorMin}
                data-testid="cleanup-audio-multiNarratorMin"
              />
            </label>
            {#if settings.gate.audiobookMetaPercent !== undefined}
              <label class={field}>
                <span class={label}>Metadata: bar per field on the labeled books (%)</span>
                <input
                  class="c-input"
                  type="number"
                  min="50"
                  max="100"
                  step="0.5"
                  bind:value={settings.gate.audiobookMetaPercent}
                  data-testid="cleanup-audio-meta-percent"
                />
              </label>
            {/if}
          {/if}
          {#if settings.gate.audiobookPairsFile !== undefined}
            <label class="{field} sm:col-span-2">
              <span class={label}
                >Labeled audiobook pairs file (empty = reference-sample/audio/labels.json)</span
              >
              <input
                class="c-input"
                placeholder="/db/cleanup/reference-sample/audio/labels.json"
                bind:value={settings.gate.audiobookPairsFile}
                data-testid="cleanup-audio-pairs-file"
              />
            </label>
          {/if}
        {/if}
      </fieldset>
    {/if}

    {#if settings.fetch}
      <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-fetch-settings">
        <legend class={legend}>Online sources (stage 4)</legend>
        <p class="text-sm text-c-muted sm:col-span-2">
          The fetch container asks each site at most once per the seconds below (from the start of
          one request to the next). When Amazon refuses (a bot check page, or HTTP 503 or 429), the
          request is never pushed through: every Amazon request waits, longer each time it refuses
          again, and is asked again.
        </p>
        {#each Object.keys(settings.fetch.sites) as site (site)}
          <div class="flex flex-wrap items-end gap-3" data-testid="cleanup-fetch-site-{site}">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" bind:checked={settings.fetch.sites[site].enabled} />
              <span class={label}>{SITE_NAMES[site] ?? SITE_LABELS[site] ?? site}</span>
            </label>
            {#if site !== 'sudachi'}
              <label class="flex flex-col gap-1 text-sm">
                <span>Seconds between requests</span>
                <input
                  class="c-input w-28"
                  type="number"
                  min="1"
                  step="1"
                  bind:value={settings.fetch.sites[site].intervalSeconds}
                />
              </label>
            {/if}
          </div>
        {/each}
        <label class={field}>
          <span class={label}>Amazon product pages and searches</span>
          <select class="c-input" bind:value={settings.fetch.amazonPace}>
            <option value="trial"
              >Measure both on the labeled books (shared first, then separate)</option
            >
            <option value="shared">One shared slot (the reference run's rate)</option>
            <option value="separate">Each at its own pace</option>
          </select>
        </label>
        <label class={field}>
          <span class={label}>First wait after Amazon refuses (s)</span>
          <input
            class="c-input"
            type="number"
            min="10"
            step="1"
            bind:value={settings.fetch.challengeBackoffSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Longest wait (s)</span>
          <input
            class="c-input"
            type="number"
            min="10"
            step="1"
            bind:value={settings.fetch.challengeBackoffMaxSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Pause after refusals in a row</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.fetch.challengePauseAfter}
          />
        </label>
        <label class={field}>
          <span class={label}>Slow Amazon down above this share of refusals (%)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            step="1"
            bind:value={settings.fetch.slowDownPercent}
          />
        </label>
        <label class={field}>
          <span class={label}>… over the last (requests)</span>
          <input
            class="c-input"
            type="number"
            min="10"
            step="1"
            bind:value={settings.fetch.slowDownWindow}
          />
        </label>
        <label class={field}>
          <span class={label}>Ask a failed request again after (s, doubling)</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.fetch.retrySeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Give a request up after (attempts)</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.fetch.maxAttempts}
          />
        </label>
        <label class={field}>
          <span class={label}>Time limit for one request (s)</span>
          <input
            class="c-input"
            type="number"
            min="5"
            step="1"
            bind:value={settings.fetch.requestTimeoutSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Names per NDL query</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.fetch.ndlNamesPerQuery}
          />
        </label>
        <label class={field}>
          <span class={label}>NDL's daily outage starts (Japan time, HH:MM)</span>
          <input class="c-input" type="text" bind:value={settings.fetch.ndlOutageStartJst} />
        </label>
        <label class={field}>
          <span class={label}>… and lasts (minutes)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            step="1"
            bind:value={settings.fetch.ndlOutageMinutes}
          />
        </label>
        <label class={field}>
          <span class={label}>Read Natively’s list again after (days)</span>
          <input
            class="c-input"
            type="number"
            min="1"
            step="1"
            bind:value={settings.fetch.nativelyRereadDays}
          />
        </label>
        <label class={field}>
          <span class={label}>A file cover is small below (px)</span>
          <input
            class="c-input"
            type="number"
            min="100"
            step="1"
            bind:value={settings.fetch.smallCoverPx}
          />
        </label>
      </fieldset>
    {/if}

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Library</legend>
      <label class={field}>
        <span class={label}>Library to clean</span>
        <select class="c-input" bind:value={settings.targetLibraryId} data-testid="cleanup-target">
          <option value={null}>The library in “japanese-library”</option>
          {#each libraries as lib (lib.id)}
            <option value={lib.id}>{lib.name} ({lib.folder || 'root'})</option>
          {/each}
        </select>
      </label>
      <div class={field} data-testid="cleanup-server-library">
        <span class={label}>On the content server</span>
        {#if needsServerLibrary && calibre}
          <select class="c-input" bind:value={serverLibrary} data-testid="cleanup-library-id">
            <option value="">Choose…</option>
            {#each calibre.libraries as id (id)}
              <option value={id}>{id}</option>
            {/each}
          </select>
        {:else if calibre?.id}
          <span class="flex min-h-[3rem] items-center">
            {calibre.id}{calibre.auto ? ' (found automatically)' : ''}
          </span>
        {:else}
          <span class="flex min-h-[3rem] items-center text-c-muted">
            Found automatically once the sidecar has reached the content server.
          </span>
        {/if}
      </div>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Your tags</legend>
      <label class="{field} sm:col-span-2">
        <span class={label}
          >Your own Calibre tags (one per line, * at the end matches any ending)</span
        >
        <textarea
          class="c-input min-h-[8rem] py-2"
          bind:value={customTagsText}
          data-testid="cleanup-tags"
        ></textarea>
        <span class="text-c-muted"
          >Of identical copies, the one with more of these tags stays; the removed copy’s tags from
          this list are added to it.</span
        >
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-pacing">
      <legend class={legend}>Pace (all stages)</legend>
      <label class={field}>
        <span class={label}>Reading speed for book files (MB/s, 0 = no limit)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          step="1"
          bind:value={settings.pacing.readMbPerSecond}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause between two changes in Calibre (seconds)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          step="0.1"
          bind:value={settings.pacing.itemDelaySeconds}
          data-testid="cleanup-item-delay"
        />
      </label>
      <label class={field}>
        <span class={label}>Changes per batch (copies or books, at most 500)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="500"
          step="1"
          bind:value={settings.pacing.batchSize}
          data-testid="cleanup-batch-size"
        />
      </label>
      <label class={field}>
        <span class={label}>Largest batch (% of the library)</span>
        <input
          class="c-input"
          type="number"
          min="0.1"
          max="10"
          step="0.1"
          bind:value={settings.pacing.maxBatchPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Books looked up in Calibre at once</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="100"
          step="1"
          bind:value={settings.pacing.lookupChunk}
        />
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-checks">
      <legend class={legend}>Checks (all stages)</legend>
      <label class={field}>
        <span class={label}>A field must be right on the labeled books at least (%)</span>
        <input
          class="c-input"
          type="number"
          min="50"
          max="100"
          step="0.5"
          bind:value={settings.gate.defaultPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Titles: at least (%, empty = as above)</span>
        <input
          class="c-input"
          type="number"
          min="50"
          max="100"
          step="0.5"
          bind:value={titleBar}
          data-testid="cleanup-title-bar"
        />
      </label>
      <label class={field}>
        <span class={label}>Titles: better than Calibre’s by at least (points)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="1"
          bind:value={settings.gate.marginPoints}
        />
      </label>
      <label class={field}>
        <span class={label}>Check a group only from this many labeled books</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="800"
          step="1"
          bind:value={settings.gate.minBooks}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause a field when its share for review is higher by (points)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="1"
          bind:value={settings.reviewAlarmPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause when this share of a batch changed in Calibre (%)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="1"
          data-testid="cleanup-changed-pause"
          bind:value={settings.libraryChangedPausePercent}
        />
      </label>
      <label class={field}>
        <span class={label}
          >Pause only when more than this share of a batch failed (%, 0 = any failure)</span
        >
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="0.5"
          data-testid="cleanup-failed-pause"
          bind:value={settings.failedPausePercent}
        />
      </label>
      <label class="{field} sm:col-span-2">
        <span class={label}
          >Labeled books file (empty = the one in the reader’s database folder)</span
        >
        <input
          class="c-input"
          placeholder="/db/cleanup/reference-sample/gold800.json"
          bind:value={settings.gate.labeledBooksFile}
        />
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-covers">
      <legend class={legend}>Covers</legend>
      <label class={field}>
        <span class={label}>Covers passed on unchanged up to (MB)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="32"
          step="1"
          bind:value={settings.covers.maxMb}
        />
      </label>
      <label class={field}>
        <span class={label}>Longest cover side, larger ones are scaled down (px)</span>
        <input
          class="c-input"
          type="number"
          min="500"
          max="20000"
          step="1"
          bind:value={settings.covers.maxSide}
        />
      </label>
      <label class={field}>
        <span class={label}>Same cover picture up to this difference (0-32)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="32"
          step="1"
          bind:value={settings.covers.sameDistance}
        />
      </label>
      <label class={field}>
        <span class={label}>The file’s cover counts as larger by (%)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="500"
          step="1"
          bind:value={settings.covers.largerPercent}
        />
      </label>
    </fieldset>

    {#if settings.duplicates}
      <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-duplicates">
        <legend class={legend}>Same text in other files (stage 3)</legend>
        <label class={field}>
          <span class={label}>Same text when both copies share at least (0-1)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={settings.duplicates.bothWays}
          />
        </label>
        <label class={field}>
          <span class={label}>One copy holds the other from (0-1)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={settings.duplicates.superset}
          />
        </label>
        <label class={field}>
          <span class={label}>Different books below (0-1)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="1"
            step="0.01"
            bind:value={settings.duplicates.reviewFloor}
          />
        </label>
        <label class={field}>
          <span class={label}
            >Both copies stay from this much extra text inside the chapters (%; empty = not set yet)</span
          >
          <input
            class="c-input"
            type="number"
            min="0"
            max="100"
            step="0.1"
            data-testid="cleanup-spread-keep-both"
            bind:value={spreadKeepBoth}
          />
        </label>
        <label class={field}>
          <span class={label}
            >Extra text inside the chapters ignored below (%; empty = not set yet)</span
          >
          <input
            class="c-input"
            type="number"
            min="0"
            max="100"
            step="0.1"
            data-testid="cleanup-spread-ignore"
            bind:value={spreadIgnore}
          />
        </label>
        <label class={field}>
          <span class={label}>Picture books: fewer characters than</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="100000"
            step="1"
            bind:value={settings.duplicates.imageOnlyMaxChars}
          />
        </label>
        <label class={field}>
          <span class={label}>Same picture up to this difference (0-32)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="32"
            step="1"
            bind:value={settings.duplicates.imageMatchDistance}
          />
        </label>
        <label class={field}>
          <span class={label}>Text found in more books than this is ignored (notices)</span>
          <input
            class="c-input"
            type="number"
            min="2"
            max="10000"
            step="1"
            bind:value={settings.duplicates.commonWindowBooks}
          />
        </label>
        <label class={field}>
          <span class={label}>Books read at the same time</span>
          <input
            class="c-input"
            type="number"
            min="1"
            max="8"
            step="1"
            bind:value={settings.duplicates.textWorkers}
          />
        </label>
        <label class={field}>
          <span class={label}>Time limit to read one book (s)</span>
          <input
            class="c-input"
            type="number"
            min="10"
            max="3600"
            step="1"
            bind:value={settings.duplicates.textTimeoutSeconds}
          />
        </label>
        <label class="{field} sm:col-span-2">
          <span class={label}
            >Measured duplicate pairs file (empty = stage3-pairs.json beside the labeled books)</span
          >
          <input
            class="c-input"
            placeholder="/db/cleanup/reference-sample/stage3-pairs.json"
            bind:value={settings.gate.duplicatePairsFile}
          />
        </label>
      </fieldset>
    {/if}

    <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-secrets">
      <legend class={legend}>AI keys</legend>
      {#each KEYS as k (k.name)}
        <div class={field}>
          <label class={field}>
            <span class={label}>{k.label}</span>
            <input
              class="c-input"
              type="password"
              autocomplete="new-password"
              placeholder={secrets[k.name].set ? 'Saved; type a new one to change it' : ''}
              value={secretValues[k.name]}
              on:input={(e) => setSecretValue(k.name, e.currentTarget.value)}
              data-testid="cleanup-secret-{k.name}"
            />
          </label>
          <span
            class="flex flex-wrap items-center gap-x-2 text-c-muted"
            data-testid="cleanup-secret-state-{k.name}"
          >
            {secretState(secrets[k.name])}
            {#if secrets[k.name].set}
              <button
                type="button"
                class="c-btn c-btn-ghost"
                on:click={() => removeSecret(k.name, k.label)}>Remove</button
              >
            {/if}
          </span>
        </div>
      {/each}
      <p class="text-sm text-c-muted sm:col-span-2">
        Kept encrypted on the server and never shown again; type a new one to change it.
      </p>
    </fieldset>

    {#if settings.ai}
      <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-ai">
        <legend class={legend}>AI</legend>
        <p class="text-sm text-c-muted sm:col-span-2">
          The models are asked only while the cleanup's AI spending stays under this limit (every
          stage together); when it is reached the stage pauses and says so. Empty = no limit set:
          nothing is asked.
        </p>
        <label class={field}>
          <span class={label}>Spending limit (US$)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="10000"
            step="any"
            bind:value={limitText}
            data-testid="cleanup-ai-limit"
          />
        </label>
        <div class="flex flex-col gap-1 text-sm" data-testid="cleanup-ai-spent">
          {#if ai}
            <span>Spent so far: ${ai.spend.spentUsd.toFixed(4)}</span>
            {#if ai.spend.reservedUsd > 0}
              <span class="text-c-muted"
                >Held for batches at the providers: ${ai.spend.reservedUsd.toFixed(4)}</span
              >
            {/if}
          {/if}
        </div>
        <div class="flex flex-col gap-2 text-sm sm:col-span-2" data-testid="cleanup-ai-modes">
          <span class={label}>How each model is asked</span>
          <p class="text-c-muted">
            Batches cost half and are answered when the provider runs them; one call each is
            answered at once at full price. Test batch sends one tiny question as a batch and shows
            whether and how fast it was answered. Measured 2026-11-19: OpenAI ran no batch for
            gpt-6-luna (nothing answered in over an hour), so it is asked one call each; Claude
            Haiku's and gpt-6.1-sol's batches were answered in 2 min and 80 s.
          </p>
          {#each aiModels as model (model)}
            <div class="flex flex-wrap items-center gap-2" data-testid="cleanup-ai-mode-{model}">
              <span class="w-40 break-all">{model}</span>
              <select
                class="c-input w-44"
                value={settings.ai.modes[model] ?? 'batch'}
                on:change={(e) => setModelMode(model, e.currentTarget.value)}
              >
                <option value="batch">Batches (half price)</option>
                <option value="direct">One call each</option>
              </select>
              <button
                type="button"
                class="c-btn c-btn-ghost"
                disabled={testing[model]}
                on:click={() => testBatch(model)}
                data-testid="cleanup-ai-test-{model}">Test batch</button
              >
              <span class="text-c-muted" data-testid="cleanup-ai-test-result-{model}"
                >{batchTestText(ai, model)}</span
              >
            </div>
          {/each}
        </div>
        <label class={field}>
          <span class={label}>Cancel a batch with no answers after (minutes; 0 = never)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="1440"
            bind:value={settings.ai.batchStallMinutes}
            data-testid="cleanup-ai-stall"
          />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            bind:checked={settings.ai.labeledOnly}
            data-testid="cleanup-ai-labeled-only"
          />
          Ask only about the labeled books (a check before the whole library)
        </label>
        <label class={field}>
          <span class={label}>Calls at the same time (one call each)</span>
          <input
            class="c-input"
            type="number"
            min="1"
            max="20"
            bind:value={settings.ai.directWorkers}
          />
        </label>
        <label class={field}>
          <span class={label}>Requests per batch</span>
          <input
            class="c-input"
            type="number"
            min="1"
            max="10000"
            bind:value={settings.ai.batchSize}
          />
        </label>
        <label class={field}>
          <span class={label}>Check a batch every (s)</span>
          <input
            class="c-input"
            type="number"
            min="5"
            max="3600"
            bind:value={settings.ai.batchPollSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Claude max_tokens (thinking included)</span>
          <input
            class="c-input"
            type="number"
            min="1000"
            max="64000"
            bind:value={settings.ai.maxTokens}
          />
        </label>
        <label class={field}>
          <span class={label}>Time limit per call (s)</span>
          <input
            class="c-input"
            type="number"
            min="10"
            max="900"
            bind:value={settings.ai.requestTimeoutSeconds}
          />
        </label>
        <label class={field}>
          <span class={label}>Tries per call (busy or server errors only)</span>
          <input class="c-input" type="number" min="1" max="10" bind:value={settings.ai.attempts} />
        </label>
        <label class={field}>
          <span class={label}>Batch price (share of the list price)</span>
          <input
            class="c-input"
            type="number"
            min="0"
            max="1"
            step="any"
            bind:value={settings.ai.batchPriceFactor}
          />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={settings.ai.structuredOutputs} />
          Ask for the answer in the stage's JSON format (structured outputs)
        </label>
        <div class="flex flex-col gap-2 text-sm sm:col-span-2" data-testid="cleanup-ai-prices">
          <span class={label}>List prices (US$ per million tokens: input / output)</span>
          {#each Object.keys(settings.ai.prices) as model (model)}
            <div class="flex flex-wrap items-center gap-2">
              <span class="w-44 break-all">{model}</span>
              <input
                class="c-input w-24"
                type="number"
                min="0"
                step="any"
                bind:value={settings.ai.prices[model].inputPerMTok}
              />
              <input
                class="c-input w-24"
                type="number"
                min="0"
                step="any"
                bind:value={settings.ai.prices[model].outputPerMTok}
              />
            </div>
          {/each}
        </div>
        <div class="flex flex-col gap-2 text-sm sm:col-span-2" data-testid="cleanup-ai-models">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="c-btn c-btn-secondary"
              disabled={checking}
              on:click={checkModels}
              data-testid="cleanup-ai-check"
            >
              {checking ? 'Checking…' : 'Check models'}
            </button>
            <span class="text-c-muted">Reads each provider's model list with the saved key.</span>
          </div>
          {#if aiError}<p class="c-notice" role="alert">{aiError}</p>{/if}
          {#if ai}
            {#each ai.tasks.filter((t) => MODEL_LABELS[t.task]) as t (t.task)}
              <p data-testid="cleanup-ai-task-{t.task}">
                {MODEL_LABELS[t.task]}: {t.model} · {taskState(t)}{t.price ? '' : ' · no price'}
              </p>
            {/each}
            {#each Object.entries(ai.checks) as [provider, c] (provider)}
              {#if c.error}
                <p class="c-notice">
                  {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}: {c.error}
                </p>
              {/if}
            {/each}
          {/if}
        </div>
      </fieldset>
    {/if}

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Models</legend>
      {#each Object.keys(MODEL_LABELS) as task (task)}
        <label class={field}>
          <span class={label}>{MODEL_LABELS[task]}</span>
          <input class="c-input" bind:value={settings.models[task]} />
        </label>
      {/each}
    </fieldset>

    <div class="flex flex-wrap items-center gap-4">
      <button
        class="c-btn c-btn-primary"
        type="submit"
        disabled={saving}
        data-testid="cleanup-save"
      >
        Save settings
      </button>
      {#if saved}<span class="text-sm" role="status">Saved.</span>{/if}
      {#if saveError}<span class="text-sm font-bold" role="alert">{saveError}</span>{/if}
    </div>
  </form>
{:else}
  <p class="c-rule-text text-sm text-c-muted">Loading…</p>
{/if}
