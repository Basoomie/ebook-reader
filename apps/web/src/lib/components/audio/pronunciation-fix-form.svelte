<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: the fields of one pronunciation fix (add or edit): a word or a
   * pattern, and how it should be read. The server checks it when it is saved; its message
   * is shown under the fields.
   */
  import { createEventDispatcher } from 'svelte';
  import type { FixInput, FixKind, FixLimits } from '$lib/audio/pronunciation/fix-types';

  export let initial: FixInput = { kind: 'word', match: '', reading: '' };
  export let limits: FixLimits | null = null;
  export let submitLabel = 'Add';
  export let busy = false;
  export let error = '';
  export let cancellable = false;
  export let testid = 'pron-fix-form';

  const dispatch = createEventDispatcher<{ submit: FixInput; cancel: void }>();
  const id = `pron-fix-${Math.random().toString(36).slice(2, 10)}`;

  let kind: FixKind = initial.kind;
  let match = initial.match;
  let reading = initial.reading;

  $: matchMax = (kind === 'pattern' ? limits?.patternMax : limits?.wordMax) || undefined;
  $: ready = !busy && match.trim() !== '' && reading.trim() !== '';

  /** Clears the fields (after an entry was added). */
  export function reset() {
    match = '';
    reading = '';
  }

  function submit() {
    if (!ready) return;
    dispatch('submit', { kind, match, reading });
  }
</script>

<form class="grid max-w-xl gap-3" data-testid={testid} on:submit|preventDefault={submit}>
  <div class="flex flex-wrap gap-3">
    <label class="grid gap-1 text-sm">
      <span class="text-c-muted">Kind</span>
      <select class="c-input text-base" bind:value={kind} data-testid="{testid}-kind">
        <option value="word">Word</option>
        <option value="pattern">Pattern (regex)</option>
      </select>
    </label>
    <label class="grid min-w-0 grow basis-40 gap-1 text-sm">
      <span class="text-c-muted">{kind === 'pattern' ? 'Pattern' : 'Word as written'}</span>
      <input
        class="c-input block w-full min-w-0 text-base"
        lang="ja"
        maxlength={matchMax}
        placeholder={kind === 'pattern' ? '日本(?!橋)' : '椎名'}
        bind:value={match}
        aria-describedby={error ? `${id}-error` : undefined}
        data-testid="{testid}-match"
      />
    </label>
    <label class="grid min-w-0 grow basis-40 gap-1 text-sm">
      <span class="text-c-muted">Read as</span>
      <input
        class="c-input block w-full min-w-0 text-base"
        lang="ja"
        maxlength={limits?.readingMax || undefined}
        placeholder={kind === 'pattern' ? 'にっぽん' : 'しいな'}
        bind:value={reading}
        aria-describedby={error ? `${id}-error` : undefined}
        data-testid="{testid}-reading"
      />
    </label>
  </div>
  {#if error}
    <p id="{id}-error" class="c-notice text-sm" role="alert" data-testid="{testid}-error">
      {error}
    </p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <button
      type="submit"
      class="c-btn c-btn-secondary c-round"
      disabled={!ready}
      data-testid="{testid}-submit"
    >
      {busy ? 'Saving…' : submitLabel}
    </button>
    {#if cancellable}
      <button
        type="button"
        class="c-btn c-btn-secondary c-round"
        data-testid="{testid}-cancel"
        on:click={() => dispatch('cancel')}
      >
        Cancel
      </button>
    {/if}
  </div>
</form>

<style>
  .c-round {
    border-radius: 0.75rem;
  }
</style>
