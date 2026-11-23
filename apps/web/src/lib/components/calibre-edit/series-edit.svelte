<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * "Edit the series" (the series page's Edit series, or Edit the whole series from a book's
   * form; design 2026-11-23): rename the series for all its books, each volume's title and
   * number (decimals: 3.5 a side story, 3.1 a store bonus), confirm unconfirmed numbers, and
   * the cleanup's suggested series name pair ("Move them into this series" / "Not the same
   * series"). One save writes every changed book; each gets its own history entry.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import { CalibreEditApi, EditApiError, editUnreachable } from '$lib/calibre-edit/api';
  import { calibreNameBytes, NAME_MAX_BYTES } from '$lib/calibre-edit/names';
  import type { SeriesPair, SeriesView, SharedRename } from '$lib/calibre-edit/types';
  import { sharedRenameCopy } from '$lib/confirm/confirm-copy';
  import { formatSeriesIndex } from '$lib/library/format';

  export let api: CalibreEditApi;
  export let name: string;
  export let libraryId: string | undefined = undefined;
  export let placement: 'side' | 'center' = 'side';

  const dispatch = createEventDispatcher<{ close: void; saved: { name: string; books: number } }>();

  interface Row {
    bookId: string;
    calibreId: number;
    firstAuthor: string;
    baseTitle: string;
    baseIndex: number | null;
    title: string;
    indexText: string;
    unconfirmed: string | null;
    confirmed: boolean;
    moved: string | null;
  }

  let view: SeriesView | null = null;
  let error = '';
  let rename = '';
  let rows: Row[] = [];
  let merge: SeriesPair | null = null;
  let notSame = new Set<string>();
  let saving = false;
  let saveError = '';
  let renames: SharedRename[] | null = null;
  let pairBusy = false;

  onMount(async () => {
    try {
      view = await api.series(name, libraryId);
      rename = view.name;
      rows = view.books.map((b) => ({
        bookId: b.bookId,
        calibreId: b.calibreId,
        firstAuthor: b.firstAuthor,
        baseTitle: b.title,
        baseIndex: b.index,
        title: b.title,
        indexText: b.index !== null ? formatSeriesIndex(b.index) : '',
        unconfirmed: b.unconfirmed,
        confirmed: false,
        moved: null
      }));
    } catch (err) {
      error = editUnreachable(err)
        ? 'Editing needs the library server, which can’t be reached right now.'
        : (err as Error).message;
    }
  });

  const indexOf = (t: string) => {
    const n = Number(t.replace(',', '.'));
    return t.trim() === '' || !Number.isFinite(n) ? null : n;
  };
  const rowChanged = (r: Row) =>
    !r.moved && (r.title !== r.baseTitle || indexOf(r.indexText) !== r.baseIndex || r.confirmed);
  $: renamed = !!view && rename.trim() !== '' && rename.trim() !== view.name;
  $: changedCount = rows.filter((r) => r.moved || rowChanged(r) || renamed).length;
  $: dirty = changedCount > 0;
  $: badIndex = rows.some((r) => r.indexText.trim() !== '' && indexOf(r.indexText) === null);
  $: tooLong = rows.filter(
    (r) => calibreNameBytes(r.calibreId, r.title, r.firstAuthor) > NAME_MAX_BYTES
  );
  $: pairs = (view?.pairs ?? []).filter((p) => !notSame.has(p.name) && p.name !== merge?.name);

  async function moveIn(p: SeriesPair) {
    pairBusy = true;
    try {
      const other = await api.series(p.name, view?.libraryId);
      merge = p;
      rows = [
        ...rows,
        ...other.books.map((b) => ({
          bookId: b.bookId,
          calibreId: b.calibreId,
          firstAuthor: b.firstAuthor,
          baseTitle: b.title,
          baseIndex: b.index,
          title: b.title,
          indexText: b.index !== null ? formatSeriesIndex(b.index) : '',
          unconfirmed: null,
          confirmed: false,
          moved: p.name
        }))
      ];
    } catch (err) {
      saveError = (err as Error).message;
    } finally {
      pairBusy = false;
    }
  }

  async function notTheSame(p: SeriesPair) {
    if (!view) return;
    try {
      await api.notSameSeries({ libraryId: view.libraryId, name: view.name, other: p.name });
      notSame = new Set([...notSame, p.name]);
    } catch (err) {
      saveError = (err as Error).message;
    }
  }

  async function save(acceptRenames = false) {
    if (!view) return;
    saving = true;
    saveError = '';
    try {
      const r = await api.saveSeries({
        libraryId: view.libraryId,
        name: view.name,
        rename: renamed ? rename.trim() : null,
        books: rows
          .filter(
            (x) => !x.moved && (x.title !== x.baseTitle || indexOf(x.indexText) !== x.baseIndex)
          )
          .map((x) => ({
            bookId: x.bookId,
            base: { title: x.baseTitle, index: x.baseIndex },
            ...(x.title !== x.baseTitle ? { title: x.title } : {}),
            ...(indexOf(x.indexText) !== x.baseIndex ? { index: indexOf(x.indexText) } : {})
          })),
        confirm: rows.filter((x) => x.confirmed).map((x) => x.bookId),
        merge: merge?.name ?? null,
        acceptRenames
      });
      renames = null;
      dispatch('saved', { name: renamed ? rename.trim() : view.name, books: r.books });
      dispatch('close');
    } catch (err) {
      if (err instanceof EditApiError && err.code === 'shared_rename') {
        renames = (err.details.renames as SharedRename[]) ?? [];
      } else {
        saveError = editUnreachable(err)
          ? 'The library server can’t be reached: nothing was saved.'
          : (err as Error).message;
      }
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  title="Edit the series"
  subtitle={view?.name ?? name}
  size="xl"
  {placement}
  {dirty}
  testid="series-edit"
  on:close={() => dispatch('close')}
>
  {#if error}
    <p class="c-notice my-4" role="alert">{error}</p>
  {:else if !view}
    <p class="py-6 text-c-muted">Loading…</p>
  {:else}
    <ModalSection title="叢書 Series name">
      <label class="mb-1 block text-xs text-c-muted" for="series-name"
        >Renames it on all {rows.filter((r) => !r.moved).length} books</label
      >
      <input
        id="series-name"
        class="c-input w-full"
        bind:value={rename}
        data-testid="series-name"
      />
    </ModalSection>

    {#if pairs.length || merge}
      <ModalSection
        title="Same series under another name?"
        hint="The cleanup found a name that may be this series. Moving them changes their series name only; their numbers stay as they are."
        testid="series-pairs"
      >
        {#if merge}
          <p class="text-sm" data-testid="series-merged">
            Moving the books of “{merge.name}” into this series ({merge.books}).
            <button
              type="button"
              class="c-link min-h-[2.75rem]"
              on:click={() => {
                rows = rows.filter((r) => !r.moved);
                merge = null;
              }}>Don’t move them</button
            >
          </p>
        {/if}
        {#each pairs as p (p.name)}
          <div class="flex flex-wrap items-center gap-2 py-1" data-testid="series-pair">
            <span class="c-chip c-chip-sm">{p.name} · {p.books} book{p.books === 1 ? '' : 's'}</span
            >
            {#if !merge}
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                disabled={pairBusy}
                data-testid="series-pair-move"
                on:click={() => moveIn(p)}>Move them into this series</button
              >
            {/if}
            <button
              type="button"
              class="c-btn c-btn-ghost c-btn-sm"
              data-testid="series-pair-not-same"
              on:click={() => notTheSame(p)}>Not the same series</button
            >
          </div>
        {/each}
      </ModalSection>
    {/if}

    <ModalSection
      title="Volumes"
      hint="Numbers may be decimals (side stories 3.5, store bonuses 3.1). Every change you save here counts as yours, so the cleanup never changes it again."
    >
      <div class="c-vol-head" aria-hidden="true"><span>Title</span><span>Number</span></div>
      <ul data-testid="series-rows">
        {#each rows as r (r.bookId)}
          <li class="c-vol" class:is-changed={r.moved || rowChanged(r)} data-testid="series-row">
            <div class="min-w-0">
              <input
                class="c-input w-full"
                aria-label="Title of volume {r.indexText || '?'}"
                bind:value={r.title}
                disabled={!!r.moved}
                data-testid="series-row-title"
              />
              {#if r.moved}<p class="mt-1 text-xs text-c-muted">from {r.moved}</p>{/if}
              {#if calibreNameBytes(r.calibreId, r.title, r.firstAuthor) > NAME_MAX_BYTES}
                <p class="mt-1 text-xs text-c-seal">Too long for Calibre’s folder and file names</p>
              {/if}
            </div>
            <div>
              <input
                class="c-input w-full"
                inputmode="decimal"
                aria-label="Number of {r.title}"
                bind:value={r.indexText}
                disabled={!!r.moved}
                data-testid="series-row-index"
              />
              {#if r.unconfirmed && !r.confirmed && indexOf(r.indexText) === r.baseIndex}
                <p class="c-vol-unconf">
                  Unconfirmed
                  <button
                    type="button"
                    class="c-btn c-btn-secondary c-btn-sm"
                    data-testid="series-row-confirm"
                    on:click={() => {
                      r.confirmed = true;
                      rows = rows;
                    }}>Confirm</button
                  >
                </p>
              {:else if r.confirmed}
                <p class="mt-1 text-xs text-c-muted">✓ Yours</p>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </ModalSection>

    {#if renames}
      <div class="my-3">
        <InlineConfirm
          {...sharedRenameCopy(renames)}
          busy={saving}
          testid="series-rename-confirm"
          on:cancel={() => (renames = null)}
          on:confirm={() => save(true)}
        />
      </div>
    {/if}
  {/if}

  <svelte:fragment slot="status">
    {#if saveError}<span class="text-c-seal" role="alert" data-testid="series-save-error"
        >{saveError}</span
      >
    {:else if badIndex}<span class="text-c-seal">A number must be like 3 or 3.5</span>
    {:else if tooLong.length}<span class="text-c-seal"
        >Shorten {tooLong.length} title{tooLong.length === 1 ? '' : 's'}</span
      >
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    {#if view}
      <button
        type="button"
        class="c-btn c-btn-primary"
        disabled={!dirty || saving || badIndex || tooLong.length > 0 || rename.trim() === ''}
        data-testid="series-save"
        on:click={() => save(false)}
        >{saving
          ? 'Saving…'
          : changedCount
            ? `Save changes to ${changedCount} book${changedCount === 1 ? '' : 's'}`
            : 'Save'}</button
      >
    {/if}
  </svelte:fragment>
</Modal>

<style>
  .c-vol-head,
  .c-vol {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 7rem;
    gap: 0.75rem;
  }

  .c-vol-head {
    font-size: 0.75rem;
    color: var(--c-muted);
    padding-bottom: 0.25rem;
  }

  .c-vol {
    align-items: start;
    padding: 0.625rem 0;
    border-top: 1px solid var(--c-line);
  }

  .c-vol.is-changed {
    background-color: var(--c-tint);
  }

  .c-vol-unconf {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    font-size: 0.75rem;
  }
</style>
