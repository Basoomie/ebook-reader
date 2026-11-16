<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: one pronunciation fix list (a book's, or the global one) with add,
   * edit and remove. On a book page, `checks` says where each fix matches in the book.
   * Removing asks first (in place). Changes fire `changed`, so the page can check again.
   */
  import { createEventDispatcher } from 'svelte';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import PronunciationFixForm from '$lib/components/audio/pronunciation-fix-form.svelte';
  import { kindText, placesText } from '$lib/audio/pronunciation/fix-text';
  import type {
    FixCheck,
    FixInput,
    FixLimits,
    PronunciationFix
  } from '$lib/audio/pronunciation/fix-types';
  import { removePronunciationFixCopy } from '$lib/confirm/confirm-copy';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  /** null = the global list. */
  export let bookId: string | null;
  export let entries: PronunciationFix[] = [];
  export let limits: FixLimits | null = null;
  export let checks: Map<number, FixCheck> | null = null;
  /** Read-only rows (the global fixes shown on a book page). */
  export let readonly = false;
  export let emptyText = 'No fixes yet.';
  export let testid = 'pron-fix-list';

  const dispatch = createEventDispatcher<{ changed: void }>();

  let addForm: PronunciationFixForm;
  let adding = false;
  let addError = '';
  let editing: number | null = null;
  let editError = '';
  let saving = false;
  let confirming: number | null = null;
  let removing = false;
  let rowError = '';

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function add(ev: CustomEvent<FixInput>) {
    adding = true;
    addError = '';
    try {
      await api.addPronunciationFix(bookId, ev.detail);
      addForm?.reset();
      dispatch('changed');
    } catch (err) {
      addError = describe(err);
    } finally {
      adding = false;
    }
  }

  async function save(fix: PronunciationFix, ev: CustomEvent<FixInput>) {
    saving = true;
    editError = '';
    try {
      await api.updatePronunciationFix(fix.id, ev.detail);
      editing = null;
      dispatch('changed');
    } catch (err) {
      editError = describe(err);
    } finally {
      saving = false;
    }
  }

  async function remove(fix: PronunciationFix) {
    removing = true;
    rowError = '';
    try {
      await api.removePronunciationFix(fix.id);
      confirming = null;
      dispatch('changed');
    } catch (err) {
      rowError = describe(err);
    } finally {
      removing = false;
    }
  }

  function startEdit(fix: PronunciationFix) {
    confirming = null;
    editError = '';
    editing = fix.id;
  }
</script>

<div data-testid={testid}>
  {#if rowError}
    <p class="c-notice mt-2 text-sm" role="alert" data-testid="{testid}-error">{rowError}</p>
  {/if}
  {#if entries.length === 0}
    <p class="mt-2 text-sm text-c-muted" data-testid="{testid}-empty">{emptyText}</p>
  {:else}
    <ul class="mt-1 max-w-3xl">
      {#each entries as fix (fix.id)}
        <li
          class="c-frow py-3"
          data-testid="pron-fix"
          data-id={fix.id}
          data-kind={fix.kind}
          data-match={fix.match}
        >
          {#if editing === fix.id}
            <PronunciationFixForm
              initial={{ kind: fix.kind, match: fix.match, reading: fix.reading }}
              {limits}
              submitLabel="Save"
              busy={saving}
              error={editError}
              cancellable
              testid="pron-fix-edit"
              on:submit={(ev) => save(fix, ev)}
              on:cancel={() => (editing = null)}
            />
          {:else}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div class="min-w-0 grow basis-60">
                <div class="break-words text-[15px]">
                  <span class="font-bold" lang="ja" data-testid="pron-fix-match">{fix.match}</span>
                  <span aria-hidden="true">→</span><span class="sr-only">read as</span>
                  <span lang="ja" data-testid="pron-fix-reading">{fix.reading}</span>
                </div>
                <div class="text-xs text-c-muted">{kindText(fix)}</div>
                {#if checks}
                  <div class="text-sm" data-testid="pron-fix-places">
                    {placesText(checks.get(fix.id))}
                  </div>
                {/if}
              </div>
              {#if !readonly}
                <div class="flex shrink-0 gap-2">
                  <button
                    class="c-btn c-btn-secondary c-round"
                    data-testid="pron-fix-edit-button"
                    on:click={() => startEdit(fix)}
                  >
                    Edit
                  </button>
                  <button
                    class="c-btn c-btn-secondary c-round"
                    data-testid="pron-fix-remove"
                    on:click={() => ((confirming = fix.id), (editing = null))}
                  >
                    Remove
                  </button>
                </div>
              {/if}
            </div>
            {#if checks && (checks.get(fix.id)?.examples.length ?? 0) > 0}
              <details class="mt-1 text-sm" data-testid="pron-fix-examples">
                <summary class="min-h-[2.75rem] cursor-pointer leading-[2.75rem]">
                  Where, and what the PC is given
                </summary>
                <ul class="grid gap-2 pb-1">
                  {#each checks.get(fix.id)?.examples ?? [] as ex}
                    <li lang="ja" class="break-words">
                      <div>{ex.text}</div>
                      <div class="text-c-muted">→ {ex.reading}</div>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if confirming === fix.id}
              <div class="mt-2">
                <InlineConfirm
                  {...removePronunciationFixCopy(fix.match, fix.bookId === null)}
                  busy={removing}
                  testid="pron-fix-remove-confirm"
                  confirmTestid="pron-fix-remove-confirm-button"
                  on:confirm={() => remove(fix)}
                  on:cancel={() => (confirming = null)}
                />
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if !readonly}
    <div class="mt-3">
      <PronunciationFixForm
        bind:this={addForm}
        {limits}
        busy={adding}
        error={addError}
        testid="pron-fix-add"
        on:submit={add}
      />
    </div>
  {/if}
</div>

<style>
  .c-frow + .c-frow {
    border-top: 1px dashed var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
  }
</style>
