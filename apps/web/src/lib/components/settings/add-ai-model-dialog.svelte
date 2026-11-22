<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > AI "Add a model": the chat models Anthropic and OpenAI offer your keys, read from
   * the providers each time the dialog opens, each with its list price when the app knows it
   * (models it doesn't know the price of show "Price not known yet" and can't be added: their
   * cost couldn't be counted). Adding one runs the server's checks (offered to the key, a known
   * price, one tiny test request answered); a failed check says which. Several can be added;
   * the dialog resolves with the latest status when it closes.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import type { AiApi, AiAvailable, AiProvider, AiStatus } from '$lib/ai/ai-api';
  import { describeAiError, PROVIDER_NAMES, priceText, usd } from '$lib/ai/ai-text';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';

  export let api: AiApi;
  export let resolver: (status: AiStatus | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let latest: AiStatus | null = null;
  let answered = false;
  let available: AiAvailable | null = null;
  let loadError = '';
  let query = '';
  /** Per model: being checked, or the outcome of the last try. */
  let rowState: Record<string, { busy: boolean; error: string; added: string }> = {};

  function finish() {
    if (answered) return;
    answered = true;
    resolver(latest);
  }
  onDestroy(finish);

  onMount(async () => {
    try {
      available = (await api.availableModels()).providers;
    } catch (err) {
      loadError = describeAiError(err);
    }
  });

  const PROVIDERS: AiProvider[] = ['anthropic', 'openai'];

  $: needle = query.trim().toLowerCase();
  $: groups = available
    ? PROVIDERS.map((p) => ({
        provider: p,
        error: available?.[p].error ?? null,
        models: (available?.[p].models ?? []).filter((m) => !needle || m.model.includes(needle))
      }))
    : [];

  async function add(model: string) {
    rowState = { ...rowState, [model]: { busy: true, error: '', added: '' } };
    try {
      const r = await api.addModel(model);
      latest = r;
      rowState = {
        ...rowState,
        [model]: {
          busy: false,
          error: '',
          added: `Added: it answered the test request in ${(r.test.ms / 1000).toFixed(1)} s (${usd(r.test.costUsd)})`
        }
      };
      if (available) {
        const p = PROVIDERS.find((x) => available?.[x].models.some((m) => m.model === model));
        if (p)
          available = {
            ...available,
            [p]: {
              ...available[p],
              models: available[p].models.map((m) =>
                m.model === model ? { ...m, listed: true } : m
              )
            }
          };
      }
    } catch (err) {
      rowState = { ...rowState, [model]: { busy: false, error: describeAiError(err), added: '' } };
    }
  }

  function close() {
    finish();
    dispatch('close');
  }
</script>

<Modal
  title="Add a model"
  subtitle="The models your API keys can use, read from Anthropic and OpenAI now"
  size="md"
  testid="ai-add-dialog"
  initialFocus="[data-ai-add-search]"
  on:close={close}
>
  <div class="flex flex-col gap-4 pt-3">
    <input
      class="c-input w-full"
      type="search"
      placeholder="Search models"
      aria-label="Search models"
      bind:value={query}
      data-ai-add-search
      data-testid="ai-add-search"
    />
    {#if loadError}
      <p class="c-notice" role="alert">{loadError}</p>
    {:else if !available}
      <p class="text-sm text-c-muted" role="status">Reading the providers’ model lists…</p>
    {:else}
      {#each groups as g (g.provider)}
        <section class="flex flex-col gap-1" data-testid="ai-add-group-{g.provider}">
          <h3 class="text-sm font-semibold">{PROVIDER_NAMES[g.provider]}</h3>
          {#if g.error}
            <p class="text-sm text-c-muted">Can’t read the model list: {g.error}</p>
          {:else if !g.models.length}
            <p class="text-sm text-c-muted">No model matches.</p>
          {/if}
          {#each g.models as m (m.model)}
            <div class="ai-add-row" data-testid="ai-add-row-{m.model}">
              <div class="min-w-0">
                <p class="break-all font-medium">{m.model}</p>
                <p class="text-sm {m.price ? '' : 'text-c-muted'}">
                  {m.price ? priceText(m.price) : 'Price not known yet: it can’t be added'}
                </p>
                {#if rowState[m.model]?.error}
                  <p
                    class="text-sm font-semibold"
                    role="alert"
                    data-testid="ai-add-error-{m.model}"
                  >
                    {rowState[m.model].error}
                  </p>
                {:else if rowState[m.model]?.added}
                  <p class="text-sm" role="status">{rowState[m.model].added}</p>
                {/if}
              </div>
              <div class="shrink-0">
                {#if m.listed}
                  <span class="text-sm text-c-muted" data-testid="ai-add-listed-{m.model}"
                    >In the list</span
                  >
                {:else if rowState[m.model]?.busy}
                  <span class="text-sm" role="status">Checking…</span>
                {:else}
                  <button
                    type="button"
                    class="c-btn c-btn-secondary c-btn-sm"
                    disabled={!m.price}
                    on:click={() => add(m.model)}
                    data-testid="ai-add-{m.model}">Add</button
                  >
                {/if}
              </div>
            </div>
          {/each}
        </section>
      {/each}
      <p class="text-sm text-c-muted">
        Adding checks that the provider offers the model to your key and sends it one tiny test
        request (a fraction of a cent, counted in this month’s spending).
      </p>
    {/if}
  </div>
</Modal>

<style>
  .ai-add-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.625rem 0;
    border-top: 1px solid var(--c-line);
  }
</style>
