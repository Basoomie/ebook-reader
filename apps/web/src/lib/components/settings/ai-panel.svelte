<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > AI (book summaries session 1): what every AI feature shares, kept on the
   * server. The two API keys (write-only), the one monthly spending limit for every feature
   * together with this month's spending per feature and the earlier months, the models with
   * their list prices (built into the app, shown read-only: they only count what is spent),
   * batch or one call each, Test batch and Check models, Delete for a model added before the
   * prices were built in, and the rarely needed tuning settings (folded). Which model does what
   * stays with each feature (the library cleanup's on /cleanup). Each change is saved at once.
   *
   * The app compiles with `immutable: true`: a changed value is always a new object.
   */
  import { onDestroy, onMount } from 'svelte';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import {
    AiApi,
    type AiKeyName,
    type AiSettings,
    type AiSettingsPatch,
    type AiStatus
  } from '$lib/ai/ai-api';
  import {
    describeAiError,
    featureSplit,
    keyStateText,
    monthName,
    batchTestShort,
    longTierText,
    priceShort,
    PROVIDER_NAMES,
    providerShort,
    spendText,
    usd
  } from '$lib/ai/ai-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { dialogManager } from '$lib/data/dialog-manager';
  import AddAiModelDialog from '$lib/components/settings/add-ai-model-dialog.svelte';
  import { removeAiKeyCopy, removeAiModelCopy } from '$lib/confirm/confirm-copy';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';

  let connection: LibraryConnection | null | undefined;
  let api: AiApi | undefined;
  let status: AiStatus | null = null;
  let loadError = '';
  let saveError = '';
  let saving = false;
  let savedAt = 0;
  let checking = false;
  let testing: Record<string, boolean> = {};
  let testTimer: ReturnType<typeof setInterval> | undefined;
  onDestroy(() => clearInterval(testTimer));

  // Write-only: never filled from the server.
  let keyValues: Record<AiKeyName, string> = { anthropicApiKey: '', openaiApiKey: '' };

  const KEYS: { name: AiKeyName; label: string; id: string }[] = [
    { name: 'anthropicApiKey', label: 'Anthropic API key', id: 'ai-key-anthropic' },
    { name: 'openaiApiKey', label: 'OpenAI API key', id: 'ai-key-openai' }
  ];

  type NumberKey = Exclude<
    {
      [K in keyof AiSettings]: AiSettings[K] extends number ? K : never;
    }[keyof AiSettings],
    undefined
  >;
  const ADVANCED: {
    key: NumberKey;
    id: string;
    unit: string;
    min: number;
    max: number;
    step: number | 'any';
  }[] = [
    { key: 'batchStallMinutes', id: 'ai-stall', unit: 'minutes', min: 0, max: 1440, step: 1 },
    {
      key: 'batchStallMinutesOpenai',
      id: 'ai-stall-openai',
      unit: 'minutes',
      min: 0,
      max: 1440,
      step: 1
    },
    { key: 'flexRetries', id: 'ai-flex-retries', unit: 'tries', min: 0, max: 10, step: 1 },
    {
      key: 'batchFailWaitMinutes',
      id: 'ai-fail-wait',
      unit: 'minutes',
      min: 1,
      max: 1440,
      step: 1
    },
    {
      key: 'batchFailMaxWaitMinutes',
      id: 'ai-fail-max-wait',
      unit: 'minutes',
      min: 1,
      max: 1440,
      step: 1
    },
    { key: 'batchFailPauseAfter', id: 'ai-fail-pause', unit: 'batches', min: 1, max: 100, step: 1 },
    {
      key: 'batchQueueTokensDefault',
      id: 'ai-queue-default',
      unit: 'tokens',
      min: 0,
      max: 1000000000,
      step: 1
    },
    {
      key: 'batchTurnaroundMinutes',
      id: 'ai-turnaround',
      unit: 'minutes',
      min: 0.1,
      max: 1440,
      step: 'any'
    },
    { key: 'connectAttemptMs', id: 'ai-connect', unit: 'ms', min: 250, max: 60000, step: 1 },
    { key: 'directWorkers', id: 'ai-workers', unit: 'calls', min: 1, max: 100, step: 1 },
    { key: 'batchSize', id: 'ai-batch-size', unit: 'questions', min: 1, max: 10000, step: 1 },
    { key: 'batchPollSeconds', id: 'ai-poll', unit: 'seconds', min: 5, max: 3600, step: 1 },
    { key: 'maxTokens', id: 'ai-max-tokens', unit: 'tokens', min: 1000, max: 64000, step: 1 },
    { key: 'requestTimeoutSeconds', id: 'ai-timeout', unit: 'seconds', min: 10, max: 900, step: 1 },
    { key: 'attempts', id: 'ai-attempts', unit: 'tries', min: 1, max: 10, step: 1 },
    {
      key: 'batchPriceFactor',
      id: 'ai-batch-price',
      unit: '× list price',
      min: 0,
      max: 1,
      step: 'any'
    }
  ];

  onMount(async () => {
    try {
      connection = (await getLibraryStore().getConnection()) ?? null;
      if (!connection) return;
      const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
      api = new AiApi(connection.serverUrl, connection.token, timeout);
      status = await api.status();
      watchTests();
    } catch (err) {
      loadError = describeAiError(err);
    }
  });

  async function run(fn: (a: AiApi) => Promise<AiStatus>): Promise<boolean> {
    if (!api) return false;
    saving = true;
    saveError = '';
    try {
      status = await fn(api);
      savedAt = Date.now();
      return true;
    } catch (err) {
      saveError = describeAiError(err);
      // Show what the server has, not what was typed.
      try {
        status = await api.status();
      } catch {
        // keep the last view
      }
      return false;
    } finally {
      saving = false;
    }
  }

  const save = (patch: AiSettingsPatch) => run((a) => a.update(patch));

  function setLimit(input: HTMLInputElement) {
    const v = input.value.trim();
    void save({ spendLimitUsd: v === '' ? null : Number(v) });
  }

  function setNumber(key: NumberKey, input: HTMLInputElement) {
    const n = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(n)) {
      if (status) input.value = String(status.settings[key]);
      return;
    }
    void save({ [key]: n } as AiSettingsPatch).then(() => {
      // A refused value leaves the saved one: show it.
      if (status) input.value = String(status.settings[key]);
    });
  }

  const QUEUE_HINT =
    "The most of this model's prompts (estimated tokens) in batches at the provider at once; more is sent as its batches end. Your account's own limit is on the provider's Limits page (OpenAI: enqueued tokens per model). 0 = no cap.";

  /** A model's batch queue cap, typed in millions of tokens. */
  function setQueueCap(model: string, input: HTMLInputElement) {
    const n = Number(input.value);
    if (!status) return;
    const cur = status.models.find((m) => m.model === model)?.batchQueueTokens ?? 0;
    if (input.value.trim() === '' || !Number.isFinite(n) || n < 0) {
      input.value = String(cur / 1e6);
      return;
    }
    void save({
      batchQueueTokens: { ...status.settings.batchQueueTokens, [model]: Math.round(n * 1e6) }
    }).then(() => {
      const now = status?.models.find((m) => m.model === model)?.batchQueueTokens;
      if (now !== undefined) input.value = String(now / 1e6);
    });
  }

  function setMode(model: string, mode: string) {
    if (!status || (mode !== 'batch' && mode !== 'direct' && mode !== 'flex')) return;
    void save({ modes: { ...status.settings.modes, [model]: mode } });
  }

  /** Add a model: the dialog lists what the providers offer the keys now. */
  async function openAdd() {
    if (!api) return;
    await dialogManager.open<AiStatus | null>(AddAiModelDialog, { api });
    // However the dialog closed, show the list as the server has it now.
    await run((a) => a.status());
  }

  /** Takes a model off the list (asks first). */
  async function deleteModel(model: string) {
    if (!(await confirmDestructive(removeAiModelCopy(model)))) return;
    await run((a) => a.deleteModel(model));
  }

  async function saveKey(name: AiKeyName) {
    const value = keyValues[name];
    if (!value.trim()) return;
    if (await run((a) => a.putKey(name, value))) keyValues = { ...keyValues, [name]: '' };
  }

  async function removeKey(name: AiKeyName, label: string) {
    if (!(await confirmDestructive(removeAiKeyCopy(label)))) return;
    await run((a) => a.removeKey(name));
  }

  async function checkModels() {
    checking = true;
    await run((a) => a.checkModels());
    checking = false;
  }

  /** Test batch: one tiny question as a batch; its result is checked every 20 s. */
  async function testBatch(model: string) {
    testing = { ...testing, [model]: true };
    await run((a) => a.testBatch(model));
    testing = { ...testing, [model]: false };
    watchTests();
  }

  function watchTests() {
    clearInterval(testTimer);
    if (!status || !Object.values(status.batchTests).some((t) => t.state === 'open')) return;
    testTimer = setInterval(async () => {
      if (!api) return;
      try {
        status = await api.status();
      } catch {
        return;
      }
      if (!Object.values(status.batchTests).some((t) => t.state === 'open'))
        clearInterval(testTimer);
    }, 20_000);
  }

  $: thisMonth = status?.months[0] ?? null;
  $: earlier = status?.months.slice(1) ?? [];

  const textField = 'c-input block w-full sm:w-80';
</script>

<div class="flex flex-col gap-10" data-testid="ai-panel">
  {#if connection === null || loadError || !status || saveError}
    <div>
      {#if connection === null}
        <p class="c-notice">
          This device isn’t connected to a library server. The AI settings are kept on the server.
        </p>
      {:else if loadError}
        <p class="c-notice" role="alert" data-testid="ai-load-error">{loadError}</p>
      {:else if !status}
        <p class="text-c-muted">Loading…</p>
      {/if}
      {#if saveError}
        <p class="c-notice" role="alert" data-testid="ai-save-error">{saveError}</p>
      {/if}
    </div>
  {/if}

  {#if status}
    <p class="s-intro">
      The AI models every feature shares: the library cleanup now, book summaries later. Which model
      does what is set with each feature (the library cleanup’s on its own page). Each change is
      saved at once.
      <span class="ml-1 font-medium" aria-live="polite" data-testid="ai-saved">
        {#if saving}
          Saving…
        {:else if savedAt}
          Saved.
        {/if}
      </span>
    </p>

    <SettingsGroup id="ai-keys" testid="ai-section-keys">
      {#each KEYS as k (k.name)}
        <SettingRow id={k.id} layout="stack">
          <svelte:fragment slot="description">
            <p class="mt-1 text-sm" data-testid="ai-key-state-{k.name}">
              {keyStateText(status.keys[k.name])}
            </p>
          </svelte:fragment>
          <div class="flex flex-col gap-3">
            <input
              class={textField}
              type="password"
              autocomplete="new-password"
              aria-label={k.label}
              placeholder={status.keys[k.name].set ? 'Saved; type a new one to change it' : ''}
              value={keyValues[k.name]}
              on:input={(e) => (keyValues = { ...keyValues, [k.name]: e.currentTarget.value })}
              on:change={() => saveKey(k.name)}
              data-testid="ai-key-{k.name}"
            />
            {#if status.keys[k.name].set}
              <div>
                <button
                  type="button"
                  class="c-btn c-btn-ghost"
                  on:click={() => removeKey(k.name, k.label)}
                  data-testid="ai-key-remove-{k.name}">Remove</button
                >
              </div>
            {/if}
          </div>
        </SettingRow>
      {/each}
    </SettingsGroup>

    <SettingsGroup id="ai-spending" testid="ai-section-spending">
      <SettingRow id="ai-limit" let:labelId>
        <SettingField unit="US$ a month">
          <input
            type="number"
            min="0"
            max="10000"
            step="any"
            aria-labelledby={labelId}
            value={status.settings.spendLimitUsd ?? ''}
            on:change={(e) => setLimit(e.currentTarget)}
            data-testid="ai-limit"
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="ai-month" layout="stack">
        <svelte:fragment slot="description">
          <p class="mt-1 text-sm" data-testid="ai-month-spent">{spendText(status.spend)}</p>
          <p class="mt-1 text-sm text-c-muted">
            A month starts on the 1st in {status.spend.timeZone} (the time zone of
            <a class="underline" href="?tab=notifications">Settings &gt; Notifications</a>).
          </p>
          {#each status.waiting as w (w.feature)}
            <p class="c-notice mt-2 text-sm" data-testid="ai-waiting-{w.feature}">
              {w.label} waits for room: {w.detail}
            </p>
          {/each}
        </svelte:fragment>
        {#if thisMonth && featureSplit(thisMonth.byFeature, status.features).length}
          <ul class="flex flex-col gap-1 text-sm" data-testid="ai-month-split">
            {#each featureSplit(thisMonth.byFeature, status.features) as f (f.name)}
              <li class="flex justify-between gap-4 sm:w-80">
                <span>{f.name}</span><span class="tabular-nums">{f.usd}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </SettingRow>
      {#if earlier.length}
        <SettingRow id="ai-history" layout="stack">
          <ul class="flex flex-col gap-3 text-sm" data-testid="ai-history">
            {#each earlier as m (m.month)}
              <li class="sm:w-80">
                <div class="flex justify-between gap-4 font-medium">
                  <span>{monthName(m.month)}</span><span class="tabular-nums"
                    >{usd(m.totalUsd)}</span
                  >
                </div>
                {#each featureSplit(m.byFeature, status.features) as f (f.name)}
                  <div class="flex justify-between gap-4 text-c-muted">
                    <span>{f.name}</span><span class="tabular-nums">{f.usd}</span>
                  </div>
                {/each}
              </li>
            {/each}
          </ul>
        </SettingRow>
      {/if}
    </SettingsGroup>

    <SettingsGroup id="ai-models" testid="ai-section-models">
      <div class="ai-toolbar">
        <p class="text-sm">
          {#each ['anthropic', 'openai'] as p, i (p)}
            {#if i}<span class="text-c-muted">{' · '}</span>{/if}<span data-testid="ai-provider-{p}"
              >{providerShort(status, p === 'anthropic' ? 'anthropic' : 'openai')}</span
            >
          {/each}
        </p>
        <button
          type="button"
          class="c-btn c-btn-secondary c-btn-sm"
          disabled={checking}
          on:click={checkModels}
          data-testid="ai-check">{checking ? 'Checking…' : 'Check models'}</button
        >
      </div>
      <div class="ai-table" role="table" aria-label="Models">
        <div class="ai-row ai-head" role="row">
          <span role="columnheader">Model</span>
          <span role="columnheader">In / out per 1M</span>
          <span role="columnheader">Asked</span>
          <span role="columnheader"><span class="sr-only">Actions</span></span>
        </div>
        {#each status.models as m (m.model)}
          <div class="ai-row" role="row" data-testid="ai-model-{m.model}">
            <div class="ai-name" role="cell">
              <span class="font-medium">{m.model}</span>
              {#if m.inUse.length}
                <span
                  class="ai-badge"
                  title="Used by {m.inUse.join('; ')}"
                  data-testid="ai-in-use-{m.model}">In use</span
                >
              {/if}
              {#if m.offered === false}
                <span
                  class="ai-badge ai-warn"
                  title="Not in {PROVIDER_NAMES[m.provider]}'s model list for your key"
                  >Not offered</span
                >
              {/if}
              {#if !m.builtIn}
                <span class="ai-badge" title="Typed in Settings before models were checked"
                  >Not verified</span
                >
              {/if}
              {#if batchTestShort(status, m.model)}
                <span class="ai-sub">{batchTestShort(status, m.model)}</span>
              {/if}
            </div>
            <span
              class="ai-price"
              role="cell"
              title={m.price ? longTierText(m.price) : ''}
              data-testid="ai-price-{m.model}">{m.price ? priceShort(m.price) : '–'}</span
            >
            <div role="cell">
              <select
                class="c-input ai-mode"
                aria-label="How {m.model} is asked"
                value={m.mode}
                on:change={(e) => setMode(m.model, e.currentTarget.value)}
                data-testid="ai-mode-{m.model}"
              >
                <option value="batch">Batches (half price)</option>
                <option value="direct">One call each</option>
                {#if m.flex}
                  <option value="flex">Flex (half price, normal price as backup)</option>
                {/if}
              </select>
              {#if m.mode === 'batch'}
                <label class="ai-queue" title={QUEUE_HINT}>
                  <span>Queue cap</span>
                  <input
                    type="number"
                    class="c-input"
                    min="0"
                    max="1000"
                    step="0.1"
                    value={m.batchQueueTokens / 1e6}
                    aria-label="Most tokens of {m.model} in batches at the provider, in millions (0 = no cap)"
                    on:change={(e) => setQueueCap(m.model, e.currentTarget)}
                    data-testid="ai-queue-{m.model}"
                  />
                  <span>M tokens</span>
                </label>
              {/if}
            </div>
            <div class="ai-actions" role="cell">
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-sm"
                disabled={testing[m.model] || status.batchTests[m.model]?.state === 'open'}
                on:click={() => testBatch(m.model)}
                data-testid="ai-test-{m.model}">Test batch</button
              >
              <button
                type="button"
                class="c-btn c-btn-danger-line c-btn-sm"
                disabled={m.inUse.length > 0}
                title={m.inUse.length ? `In use: ${m.inUse.join('; ')}` : undefined}
                on:click={() => deleteModel(m.model)}
                data-testid="ai-delete-{m.model}">Delete</button
              >
            </div>
            {#if m.batchFailing}
              <div class="ai-failing" role="cell" data-testid="ai-failing-{m.model}">
                <p class="c-notice text-sm" role="status">{m.batchFailing.text}</p>
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={saving}
                  on:click={() => run((a) => a.retryBatches(m.model))}
                  data-testid="ai-retry-{m.model}">Try now</button
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <div class="ai-foot">
        <button
          type="button"
          class="c-btn c-btn-secondary"
          on:click={openAdd}
          data-testid="ai-add-model">Add a model</button
        >
        <p class="text-sm text-c-muted" data-testid="ai-prices-note">
          List prices as of {status.pricesChecked}, used only to count spending.
        </p>
      </div>
    </SettingsGroup>

    <SettingsGroup id="ai-advanced" testid="ai-section-advanced">
      <details data-testid="ai-advanced">
        <summary class="s-summary">Show the advanced settings</summary>
        {#each ADVANCED as a (a.key)}
          <SettingRow id={a.id} let:labelId>
            <SettingField unit={a.unit}>
              <input
                type="number"
                min={a.min}
                max={a.max}
                step={a.step}
                aria-labelledby={labelId}
                value={status.settings[a.key]}
                on:change={(e) => setNumber(a.key, e.currentTarget)}
                data-testid="ai-{a.key}"
              />
            </SettingField>
          </SettingRow>
        {/each}
        <SettingRow id="ai-fail-fallback" let:labelId>
          <select
            class="c-input"
            aria-labelledby={labelId}
            value={status.settings.batchFailFallback}
            on:change={(e) =>
              save({
                batchFailFallback: e.currentTarget.value === 'direct' ? 'direct' : 'wait'
              })}
            data-testid="ai-batchFailFallback"
          >
            <option value="wait">Wait and try a batch now and then</option>
            <option value="direct">Ask one call each (full price)</option>
          </select>
        </SettingRow>
        <SettingRow id="ai-structured" let:labelId>
          <input
            type="checkbox"
            class="h-5 w-5"
            aria-labelledby={labelId}
            checked={status.settings.structuredOutputs}
            on:change={(e) => save({ structuredOutputs: e.currentTarget.checked })}
            data-testid="ai-structured"
          />
        </SettingRow>
      </details>
    </SettingsGroup>
  {/if}
</div>

<style>
  .s-intro {
    padding: 0.75rem 1rem;
    border: var(--c-border-width) solid var(--c-line);
    border-left: 3px solid var(--c-gold);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    font-size: 0.875rem;
  }

  .s-note {
    padding: 0.875rem 1.25rem;
    border-top: 1px solid var(--c-line);
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .ai-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    padding: 0.75rem 1.25rem;
  }

  .ai-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 8rem 13rem 11rem;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.625rem 1.25rem;
    border-top: 1px solid var(--c-line);
  }

  .ai-head {
    padding-block: 0.375rem;
    color: var(--c-muted);
    font-size: 0.8125rem;
  }

  .ai-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ai-sub {
    flex-basis: 100%;
    color: var(--c-muted);
    font-size: 0.8125rem;
  }

  .ai-price {
    font-variant-numeric: tabular-nums;
    font-size: 0.875rem;
  }

  .ai-mode {
    width: 100%;
  }

  .ai-queue {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    color: var(--c-muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  .ai-queue input {
    width: 5rem;
  }

  .ai-failing {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }

  .ai-failing p {
    flex: 1 1 20rem;
    margin: 0;
  }

  .ai-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .ai-badge {
    padding: 0.0625rem 0.5rem;
    border: 1px solid var(--c-line-strong);
    border-radius: 999px;
    color: var(--c-muted);
    font-size: 0.75rem;
    line-height: 1.25rem;
    white-space: nowrap;
  }

  .ai-warn {
    border-color: var(--c-danger);
    color: var(--c-danger);
  }

  .ai-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.875rem 1.25rem;
    border-top: 1px solid var(--c-line);
  }

  /* Phones: name and price on one line, the controls under them. */
  @media (max-width: 640px) {
    .ai-head {
      display: none;
    }

    .ai-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .ai-row > :nth-child(3) {
      grid-column: 1 / -1;
    }

    .ai-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }

  .s-summary {
    cursor: pointer;
    padding: 0.875rem 1.25rem;
    font-weight: 600;
  }
</style>
