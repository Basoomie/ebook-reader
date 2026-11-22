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
    batchTestText,
    describeAiError,
    featureSplit,
    keyStateText,
    monthName,
    offeredText,
    priceText,
    providerLine,
    spendText,
    usd
  } from '$lib/ai/ai-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
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

  function setMode(model: string, mode: string) {
    if (!status || (mode !== 'batch' && mode !== 'direct')) return;
    void save({ modes: { ...status.settings.modes, [model]: mode } });
  }

  /** Deletes a model added before prices were built in (asks first). */
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
      <SettingRow id="ai-check" layout="stack">
        <svelte:fragment slot="description">
          {#each ['anthropic', 'openai'] as p (p)}
            <p class="mt-1 text-sm" data-testid="ai-provider-{p}">
              {providerLine(status, p === 'anthropic' ? 'anthropic' : 'openai')}
            </p>
          {/each}
        </svelte:fragment>
        <div>
          <button
            type="button"
            class="c-btn c-btn-secondary"
            disabled={checking}
            on:click={checkModels}
            data-testid="ai-check">{checking ? 'Checking…' : 'Check models'}</button
          >
        </div>
      </SettingRow>
      {#each status.models as m (m.model)}
        <SettingRow title={m.model} testid="ai-model-{m.model}">
          <svelte:fragment slot="description">
            <p class="mt-1 text-sm" data-testid="ai-price-{m.model}">
              {priceText(m.price)}{#if !m.builtIn}<span class="text-c-muted"
                  >{' '}· added in Settings earlier, not one of the app's models</span
                >{/if}
            </p>
            <p class="text-sm text-c-muted">
              {offeredText(m.offered, m.provider)} · {batchTestText(status, m.model)}
            </p>
          </svelte:fragment>
          <div class="flex flex-col gap-2 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="c-input w-64"
                aria-label="How {m.model} is asked"
                value={m.mode}
                on:change={(e) => setMode(m.model, e.currentTarget.value)}
                data-testid="ai-mode-{m.model}"
              >
                <option value="batch">Batches (half price)</option>
                <option value="direct">One call each (full price)</option>
              </select>
              <button
                type="button"
                class="c-btn c-btn-secondary"
                disabled={testing[m.model] || status.batchTests[m.model]?.state === 'open'}
                on:click={() => testBatch(m.model)}
                data-testid="ai-test-{m.model}">Test batch</button
              >
              {#if !m.builtIn}
                <button
                  type="button"
                  class="c-btn c-btn-ghost"
                  disabled={m.inUse.length > 0}
                  title={m.inUse.length ? `In use: ${m.inUse.join(', ')}` : undefined}
                  on:click={() => deleteModel(m.model)}
                  data-testid="ai-delete-{m.model}">Delete</button
                >
              {/if}
            </div>
            {#if !m.builtIn && m.inUse.length}
              <p class="text-c-muted">
                In use ({m.inUse.join(', ')}): choose another model there to delete it.
              </p>
            {/if}
          </div>
        </SettingRow>
      {/each}
      <p class="s-note" data-testid="ai-prices-note">
        The providers’ list prices as of {status.pricesChecked}, built into the app. They only count
        what is spent against the monthly limit; Anthropic and OpenAI bill their own prices. New
        models come with app updates.
      </p>
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

  .s-summary {
    cursor: pointer;
    padding: 0.875rem 1.25rem;
    font-weight: 600;
  }
</style>
