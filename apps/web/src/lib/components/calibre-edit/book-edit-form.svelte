<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * "Edit details" for a Calibre book (design calibre-metadata-editing.md, 2026-11-23): a side
   * panel or a modal (the device's setting). Every field the design lists: cover (upload, drop
   * or one of the book's illustrations), title and its sort, authors and their sort,
   * illustrators, series and number, publisher, published date, language, rating (half stars),
   * tags (only from "Tags you can pick"), description, and the links' ids and ISBN.
   *
   * The live "N / 255 bytes" under the title and the first author is Calibre's own naming rule
   * (lib/calibre-edit/names.ts); a save that is too long is refused here and by the server,
   * never shortened. The cleanup's best guesses are marked "Unconfirmed" with "Confirm as
   * right". A save goes to the library's writer at once; the page shows the new values until
   * the library has them.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faImage, faStore, faUpload, faXmark } from '@fortawesome/free-solid-svg-icons';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import RatingStars from './rating-stars.svelte';
  import { CalibreEditApi, EditApiError, editUnreachable } from '$lib/calibre-edit/api';
  import {
    LANGUAGES,
    changedFields,
    dateInputValue,
    descriptionText,
    fieldLabel
  } from '$lib/calibre-edit/format';
  import { NAME_MAX_BYTES, authorNameBytes, calibreNameBytes } from '$lib/calibre-edit/names';
  import type {
    CoverStore,
    EarlierCover,
    EarlierCovers,
    EditForm,
    EditValues,
    SharedRename,
    StoreCover,
    TagList
  } from '$lib/calibre-edit/types';
  import {
    STORE_NAMES,
    coverStoresOf,
    earlierCoverLabel,
    hasEarlierCovers,
    pictureSize,
    storeCoverText,
    storesWaiting
  } from '$lib/calibre-edit/covers';
  import { BOOK_LINKS } from '$lib/book-links/links';
  import { sharedRenameCopy } from '$lib/confirm/confirm-copy';
  import type { LibraryApi } from '$lib/library/api';

  export let api: CalibreEditApi;
  /** For the book's illustrations (the cover picker). */
  export let library: LibraryApi | undefined = undefined;
  export let bookId: string;
  export let title: string;
  export let libraryName = '';
  export let coverThumb = '';
  export let placement: 'side' | 'center' = 'side';

  const dispatch = createEventDispatcher<{
    close: void;
    saved: { values: Partial<EditValues>; cover: string | null };
    series: void;
  }>();

  let form: EditForm | null = null;
  let loadError = '';
  let start: EditValues | null = null;
  let vals: EditValues | null = null;
  let tagList: TagList | null = null;
  let confirm = new Set<string>();
  let saving = false;
  let saveError = '';
  let renames: SharedRename[] | null = null;
  let authorDraft = '';
  let illustratorDraft = '';
  let tagFilter = '';
  let pubdateText = '';
  let indexText = '';
  /** The new cover: its token on the server and a preview. */
  let cover: { token: string; preview: string; label: string } | null = null;
  let coverBusy = false;
  let coverError = '';
  let dragging = false;
  let pickingIllustration = false;
  let illustrations: { n: number; thumb: string; full: string }[] | null = null;
  let fileInput: HTMLInputElement;
  /** Book covers: the pictures the server kept (Earlier covers) and the stores' pictures. */
  let earlier: EarlierCovers | null = null;
  let earlierThumbs: Record<string, string> = {};
  let storesOpen = false;
  let stores: StoreCover[] | null = null;
  let fetcherOnline = true;
  let storeThumbs: Partial<Record<CoverStore, string>> = {};
  let storeTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  /** Object URLs made here (thumbnails), revoked when the form closes. */
  const madeUrls: string[] = [];

  onMount(async () => {
    try {
      const [f, t] = await Promise.all([api.form(bookId), api.tags().catch(() => null)]);
      form = f;
      tagList = t;
      const v: EditValues = {
        ...f.values,
        description: descriptionText(f.values.description)
      };
      start = structuredClone(v);
      vals = structuredClone(v);
      pubdateText = dateInputValue(v.pubdate);
      indexText = v.series.index !== null ? String(v.series.index) : '';
      void loadEarlierCovers();
    } catch (err) {
      loadError = editUnreachable(err)
        ? 'Editing needs the library server, which can’t be reached right now.'
        : (err as Error).message;
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (cover) URL.revokeObjectURL(cover.preview);
    if (storeTimer) clearTimeout(storeTimer);
    for (const u of madeUrls) URL.revokeObjectURL(u);
  });

  function objectUrl(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    madeUrls.push(u);
    return u;
  }

  // Book covers: the pictures the book's cover had (kept by the server). A failure only hides
  // the row: the rest of the form works without it.
  async function loadEarlierCovers() {
    try {
      const list = await api.earlierCovers(bookId);
      if (destroyed) return;
      earlier = list;
      for (const c of list.covers) {
        if (c.current) continue;
        const blob = await api.earlierCoverPicture(bookId, c.sha256).catch(() => null);
        if (destroyed) return;
        if (blob) earlierThumbs = { ...earlierThumbs, [c.sha256]: objectUrl(blob) };
      }
    } catch {
      earlier = null;
    }
  }

  async function pickEarlier(c: EarlierCover, label: string) {
    coverError = '';
    coverBusy = true;
    try {
      const blob = await api.earlierCoverPicture(bookId, c.sha256);
      const { token } = await api.useEarlierCover(bookId, c.sha256);
      if (cover) URL.revokeObjectURL(cover.preview);
      cover = {
        token,
        preview: URL.createObjectURL(blob),
        label: label === 'Original' ? 'Original cover' : `Earlier cover (${label})`
      };
    } catch (err) {
      coverError = (err as Error).message;
    } finally {
      coverBusy = false;
    }
  }

  // The stores' pictures: the server asks the stores through its fetch queue; the row asks
  // the server again every few seconds while a store is still being asked.
  async function loadStores(again = false) {
    storesOpen = true;
    if (storeTimer) clearTimeout(storeTimer);
    storeTimer = null;
    try {
      const r = await api.storeCovers(bookId, again);
      if (destroyed) return;
      stores = r.stores;
      fetcherOnline = r.fetcher;
      for (const s of r.stores) {
        if (s.state !== 'ready' || storeThumbs[s.store]) continue;
        const blob = await api.storeCoverPicture(bookId, s.store).catch(() => null);
        if (destroyed) return;
        if (blob) storeThumbs = { ...storeThumbs, [s.store]: objectUrl(blob) };
      }
    } catch (err) {
      coverError = editUnreachable(err)
        ? 'The library server can’t be reached right now.'
        : (err as Error).message;
    }
    if (!destroyed && storesWaiting(stores)) storeTimer = setTimeout(() => loadStores(), 3000);
  }

  async function pickStore(s: StoreCover) {
    coverError = '';
    coverBusy = true;
    try {
      const blob = await api.storeCoverPicture(bookId, s.store);
      const { token } = await api.useStoreCover(bookId, s.store);
      if (cover) URL.revokeObjectURL(cover.preview);
      cover = {
        token,
        preview: URL.createObjectURL(blob),
        label: `${STORE_NAMES[s.store]}’s cover`
      };
    } catch (err) {
      coverError = (err as Error).message;
    } finally {
      coverBusy = false;
    }
  }

  $: changed = start && vals ? changedFields(start, vals) : [];
  $: dirty = changed.length > 0 || !!cover || confirm.size > 0;
  $: firstAuthor = vals?.authors[0] ?? 'Unknown';
  $: titleBytes = form && vals ? calibreNameBytes(form.calibreId, vals.title, firstAuthor) : 0;
  $: authorBytes = form && vals ? authorNameBytes(form.calibreId, firstAuthor) : 0;
  $: tooLong = titleBytes > NAME_MAX_BYTES || authorBytes > NAME_MAX_BYTES;
  $: unconfirmed = new Map((form?.unconfirmed ?? []).map((u) => [u.field, u.reason]));
  $: yours = new Set((form?.yours ?? []).map((y) => y.field));
  $: pickable = pickableTags(tagList, vals?.tags ?? [], tagFilter);
  $: coverStores = start ? coverStoresOf(start.identifiers) : [];
  $: knownIds = new Set([...BOOK_LINKS.map((l) => l.key), 'isbn']);
  $: otherIds = vals ? Object.keys(vals.identifiers).filter((k) => !knownIds.has(k)) : [];
  $: canSave =
    !!vals && dirty && !tooLong && !saving && !!vals.title.trim() && vals.authors.length > 0;

  function pickableTags(list: TagList | null, have: string[], filter: string) {
    if (!list) return [];
    const own = new Set(have.map((t) => t.toLowerCase()));
    const f = filter.trim().toLowerCase();
    return list.groups
      .map((g) => ({
        title: g.title,
        tags: (g.id === 'yours' ? list.yoursInLibrary : g.tags.map((t) => t.label)).filter(
          (t) => !own.has(t.toLowerCase()) && (!f || t.toLowerCase().includes(f))
        )
      }))
      .filter((g) => g.tags.length > 0);
  }

  function addName(kind: 'authors' | 'illustrator') {
    if (!vals) return;
    const draft = (kind === 'authors' ? authorDraft : illustratorDraft).trim();
    if (!draft || vals[kind].includes(draft)) return;
    vals = { ...vals, [kind]: [...vals[kind], draft] };
    if (kind === 'authors') authorDraft = '';
    else illustratorDraft = '';
  }

  function removeName(kind: 'authors' | 'illustrator', i: number) {
    if (!vals) return;
    vals = { ...vals, [kind]: vals[kind].filter((_, j) => j !== i) };
  }

  function moveAuthor(i: number, by: number) {
    if (!vals) return;
    const list = [...vals.authors];
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    vals = { ...vals, authors: list };
  }

  function setPubdate(text: string) {
    pubdateText = text;
    if (!vals) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    vals = {
      ...vals,
      pubdate: m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null
    };
  }

  function setIndex(text: string) {
    indexText = text;
    if (!vals) return;
    const n = Number(text.replace(',', '.'));
    vals = {
      ...vals,
      series: { ...vals.series, index: text.trim() === '' || !Number.isFinite(n) ? null : n }
    };
  }

  function setSeriesName(name: string) {
    if (!vals) return;
    const n = name.trim() === '' ? null : name;
    vals = {
      ...vals,
      series: {
        name: n,
        index: n ? (vals.series.index ?? (indexText ? Number(indexText) : 1)) : null
      }
    };
  }

  function setId(key: string, value: string) {
    if (!vals) return;
    vals = { ...vals, identifiers: { ...vals.identifiers, [key]: value } };
  }

  // The app compiles with immutable updates: a field changes by a new values object, never by
  // mutating one (a bind:value on vals.title changed nothing the counter or Save could see).
  function setText(field: 'title' | 'sort' | 'author_sort' | 'description', value: string) {
    if (!vals) return;
    vals = { ...vals, [field]: value };
  }

  function confirmField(field: string) {
    confirm = new Set([...confirm, field]);
  }

  async function useCover(blob: Blob, label: string) {
    coverError = '';
    coverBusy = true;
    try {
      const { token } = await api.cover(bookId, blob);
      if (cover) URL.revokeObjectURL(cover.preview);
      cover = { token, preview: URL.createObjectURL(blob), label };
    } catch (err) {
      coverError = (err as Error).message;
    } finally {
      coverBusy = false;
    }
  }

  function onFile(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (file) void useCover(file, file.name);
    (ev.target as HTMLInputElement).value = '';
  }

  function onDrop(ev: DragEvent) {
    ev.preventDefault();
    dragging = false;
    const file = [...(ev.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) void useCover(file, file.name);
    else coverError = 'Drop a picture (JPEG, PNG, WebP or GIF)';
  }

  async function openIllustrations() {
    pickingIllustration = true;
    if (illustrations || !library) return;
    try {
      const list = await library.illustrations(bookId);
      illustrations =
        list.status === 'ready'
          ? list.items.map((i) => ({
              n: i.n,
              thumb: library!.absolute(i.thumbUrl),
              full: library!.absolute(i.url)
            }))
          : [];
    } catch (err) {
      coverError = (err as Error).message;
      illustrations = [];
    }
  }

  async function pickIllustration(item: { n: number; full: string }) {
    coverBusy = true;
    try {
      const res = await fetch(item.full);
      if (!res.ok) throw new Error(`The picture could not be read (${res.status})`);
      pickingIllustration = false;
      await useCover(await res.blob(), `Illustration ${item.n + 1}`);
    } catch (err) {
      coverError = (err as Error).message;
      coverBusy = false;
    }
  }

  async function save(acceptRenames = false) {
    if (!vals || !start || !form) return;
    saving = true;
    saveError = '';
    const values: Record<string, unknown> = {};
    const base: Record<string, unknown> = {};
    for (const f of changed) {
      values[f] = f === 'pubdate' ? pubdateText || null : vals[f];
      // The value the form showed; the description as Calibre holds it.
      base[f] = f === 'description' ? form.values.description : form.values[f];
    }
    if (values.identifiers) {
      values.identifiers = Object.fromEntries(
        Object.entries(vals.identifiers).filter(([, v]) => v.trim() !== '')
      );
    }
    try {
      await api.save(bookId, {
        base,
        values,
        coverToken: cover?.token ?? null,
        confirm: [...confirm],
        acceptRenames
      });
      renames = null;
      const shown: Partial<EditValues> = {};
      for (const f of changed) (shown as Record<string, unknown>)[f] = vals[f];
      if ('description' in shown) shown.description = vals.description;
      dispatch('saved', { values: shown, cover: cover?.preview ?? null });
      // The preview stays with the page now.
      cover = null;
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

  const labelClass = 'mb-1 flex items-baseline gap-1.5 text-xs text-c-muted';
</script>

<Modal
  title="Edit details"
  subtitle={`${title}${libraryName ? ` · Calibre · ${libraryName}` : ' · Calibre'}`}
  size="lg"
  {placement}
  {dirty}
  testid="edit-form"
  on:close={() => dispatch('close')}
>
  {#if loadError}
    <p class="c-notice my-4" role="alert" data-testid="edit-load-error">{loadError}</p>
  {:else if !vals || !form}
    <p class="py-6 text-c-muted">Loading…</p>
  {:else}
    {#if !form.writer.ready}
      <p class="c-notice mt-3 text-sm" data-testid="edit-writer-wait">{form.writer.wait}</p>
    {/if}

    <ModalSection title="表紙 Cover" testid="edit-cover">
      <div
        class="c-edit-drop"
        class:is-dragging={dragging}
        role="group"
        aria-label="Cover"
        data-testid="edit-cover-drop"
        on:dragover|preventDefault={() => (dragging = true)}
        on:dragleave={() => (dragging = false)}
        on:drop={onDrop}
      >
        {#if cover?.preview || coverThumb}
          <img
            class="c-edit-cover"
            src={cover?.preview ?? coverThumb}
            alt={cover ? `New cover: ${cover.label}` : 'Current cover'}
            data-testid="edit-cover-preview"
          />
        {:else}
          <div
            class="c-edit-cover grid place-items-center text-xs text-c-muted"
            data-testid="edit-cover-preview"
          >
            No cover
          </div>
        {/if}
        <div class="flex min-w-0 flex-col gap-2">
          <p class="text-sm" data-testid="edit-cover-text">
            {dragging
              ? 'Drop the picture to use it as the cover'
              : cover
                ? `New cover: ${cover.label}`
                : 'Drop a picture here, or choose one'}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="c-btn c-btn-secondary c-btn-sm"
              disabled={coverBusy}
              data-testid="edit-cover-upload"
              on:click={() => fileInput.click()}><Fa icon={faUpload} />Choose a picture</button
            >
            {#if library}
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                disabled={coverBusy}
                aria-expanded={pickingIllustration}
                data-testid="edit-cover-illustrations"
                on:click={openIllustrations}
                ><Fa icon={faImage} />Pick from the book’s illustrations</button
              >
            {/if}
            {#if coverStores.length > 0}
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                disabled={coverBusy}
                aria-expanded={storesOpen}
                data-testid="edit-cover-stores"
                on:click={() => loadStores()}><Fa icon={faStore} />From the stores</button
              >
            {/if}
            {#if cover}
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-sm"
                data-testid="edit-cover-keep"
                on:click={() => {
                  if (cover) URL.revokeObjectURL(cover.preview);
                  cover = null;
                }}>Keep the current cover</button
              >
            {/if}
          </div>
          <input
            bind:this={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            class="sr-only"
            tabindex="-1"
            aria-hidden="true"
            data-testid="edit-cover-file"
            on:change={onFile}
          />
          {#if coverBusy}<p class="text-sm text-c-muted" role="status">
              Getting the picture ready…
            </p>{/if}
          {#if coverError}<p class="text-sm text-c-seal" role="alert">{coverError}</p>{/if}
        </div>
      </div>
      {#if pickingIllustration}
        <div class="mt-3" data-testid="edit-illustrations">
          {#if illustrations === null}
            <p class="text-sm text-c-muted">Loading the illustrations…</p>
          {:else if illustrations.length === 0}
            <p class="text-sm text-c-muted">This book has no illustrations to pick from.</p>
          {:else}
            <div class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
              {#each illustrations as item (item.n)}
                <button
                  type="button"
                  class="c-edit-ill"
                  aria-label="Use illustration {item.n + 1} as the cover"
                  data-testid="edit-illustration"
                  on:click={() => pickIllustration(item)}
                  ><img src={item.thumb} alt="" loading="lazy" /></button
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if storesOpen}
        <div class="mt-3" data-testid="edit-store-covers">
          <p class={labelClass}>From the stores</p>
          {#if stores === null}
            <p class="text-sm text-c-muted">Asking the stores…</p>
          {:else}
            {#if !fetcherOnline && storesWaiting(stores)}
              <p class="c-notice mb-2 text-sm" data-testid="edit-store-fetcher">
                The stores are asked by the library’s fetcher, which isn’t running: the pictures
                come once it is.
              </p>
            {/if}
            <div class="c-edit-pics">
              {#each stores as s (s.store)}
                <div class="c-edit-pic" data-testid="edit-store-cover" data-store={s.store}>
                  {#if s.state === 'ready' && storeThumbs[s.store]}
                    <button
                      type="button"
                      class="c-edit-pic-btn"
                      disabled={coverBusy}
                      aria-label="Use {STORE_NAMES[s.store]}’s cover"
                      data-testid="edit-store-cover-use"
                      on:click={() => pickStore(s)}
                      ><img src={storeThumbs[s.store]} alt="" /></button
                    >
                  {:else}
                    <div class="c-edit-pic-empty">{storeCoverText(s)}</div>
                  {/if}
                  <p class="text-xs">{STORE_NAMES[s.store]}</p>
                  {#if s.state === 'ready'}
                    <p class="text-xs text-c-muted">{pictureSize(s.width, s.height)}</p>
                  {/if}
                  {#if s.same}<p class="text-xs text-c-muted" data-testid="edit-store-same">
                      ✓ Same as current
                    </p>{/if}
                  {#if s.state === 'failed'}
                    <button
                      type="button"
                      class="c-btn c-btn-ghost c-btn-sm"
                      data-testid="edit-store-again"
                      on:click={() => loadStores(true)}>Ask again</button
                    >
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if earlier && hasEarlierCovers(earlier.covers)}
        <div class="mt-3" data-testid="edit-earlier-covers">
          <p class={labelClass}>Earlier covers</p>
          <div class="c-edit-pics">
            {#each earlier.covers as c, i (c.sha256)}
              <div class="c-edit-pic" data-testid="edit-earlier-cover">
                {#if c.current}
                  {#if coverThumb}
                    <img class="c-edit-pic-empty" src={coverThumb} alt="The cover now" />
                  {:else}
                    <div class="c-edit-pic-empty">The cover now</div>
                  {/if}
                {:else if earlierThumbs[c.sha256]}
                  <button
                    type="button"
                    class="c-edit-pic-btn"
                    disabled={coverBusy}
                    aria-label={i === 0
                      ? 'Use the original cover'
                      : `Use the earlier cover from ${earlierCoverLabel(earlier.covers, i)}`}
                    data-testid="edit-earlier-cover-use"
                    on:click={() => earlier && pickEarlier(c, earlierCoverLabel(earlier.covers, i))}
                    ><img src={earlierThumbs[c.sha256]} alt="" /></button
                  >
                {:else}
                  <div class="c-edit-pic-empty">Loading…</div>
                {/if}
                <p class="text-xs">
                  {c.current
                    ? i === 0
                      ? 'Now · Original'
                      : 'Now'
                    : earlierCoverLabel(earlier.covers, i)}
                </p>
                <p class="text-xs text-c-muted">{pictureSize(c.width, c.height)}</p>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </ModalSection>

    <ModalSection title="書名 Title and people">
      <div class="flex flex-col gap-4">
        <div>
          <label class={labelClass} for="edit-title">Title</label>
          <input
            id="edit-title"
            class="c-input w-full"
            value={vals.title ?? ''}
            on:input={(e) => setText('title', e.currentTarget.value)}
            data-testid="edit-title"
          />
          <p
            class="mt-1 flex flex-wrap justify-between gap-x-3 text-xs"
            class:text-c-seal={titleBytes > NAME_MAX_BYTES}
            class:text-c-muted={titleBytes <= NAME_MAX_BYTES}
          >
            <span
              >{titleBytes > NAME_MAX_BYTES
                ? 'Too long for Calibre’s folder and file names: shorten the title (or the first author).'
                : 'Calibre’s folder and file names for this book (title, first author, id).'}</span
            >
            <span aria-live="polite" data-testid="edit-title-bytes"
              >{titleBytes} / {NAME_MAX_BYTES} bytes</span
            >
          </p>
          {#if unconfirmed.has('title') && !confirm.has('title') && !yours.has('title')}
            <p class="c-edit-unconf" data-testid="edit-unconfirmed-title">
              Unconfirmed: the cleanup’s best guess.
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                on:click={() => confirmField('title')}>Confirm as right</button
              >
            </p>
          {:else if yours.has('title') || confirm.has('title')}
            <p class="c-edit-mine">✓ Yours: no cleanup pass will change it.</p>
          {/if}
        </div>
        <div>
          <label class={labelClass} for="edit-sort">Title sort (reading)</label>
          <input
            id="edit-sort"
            class="c-input w-full"
            value={vals.sort ?? ''}
            on:input={(e) => setText('sort', e.currentTarget.value)}
            data-testid="edit-sort"
          />
        </div>
        <div>
          <span class={labelClass} id="edit-authors-label"
            >Authors (the first one is used in Calibre’s folder name)</span
          >
          <ul class="flex flex-wrap gap-2" aria-labelledby="edit-authors-label">
            {#each vals.authors as name, i (`${i}:${name}`)}
              <li class="c-chip c-edit-chip" data-testid="edit-author">
                {#if i > 0}<button
                    type="button"
                    class="c-edit-chip-btn"
                    aria-label="Move {name} first"
                    title="Move up"
                    on:click={() => moveAuthor(i, -1)}>↑</button
                  >{/if}
                <span>{name}</span>
                <button
                  type="button"
                  class="c-edit-chip-btn"
                  aria-label="Remove {name}"
                  on:click={() => removeName('authors', i)}><Fa icon={faXmark} /></button
                >
              </li>
            {/each}
          </ul>
          <div class="mt-2 flex gap-2">
            <input
              class="c-input min-w-0 flex-1"
              placeholder="Add an author"
              aria-label="Add an author"
              bind:value={authorDraft}
              data-testid="edit-author-new"
              on:keydown={(e) => e.key === 'Enter' && (e.preventDefault(), addName('authors'))}
            />
            <button
              type="button"
              class="c-btn c-btn-secondary"
              data-testid="edit-author-add"
              on:click={() => addName('authors')}>Add</button
            >
          </div>
          <p
            class="mt-1 text-right text-xs"
            class:text-c-seal={authorBytes > NAME_MAX_BYTES}
            class:text-c-muted={authorBytes <= NAME_MAX_BYTES}
            data-testid="edit-author-bytes"
          >
            First author: {authorBytes} / {NAME_MAX_BYTES} bytes
          </p>
          {#if unconfirmed.has('authors') && !confirm.has('authors') && !yours.has('authors')}
            <p class="c-edit-unconf">
              Unconfirmed: the cleanup’s best guess.
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                on:click={() => confirmField('authors')}>Confirm as right</button
              >
            </p>
          {/if}
        </div>
        <div>
          <label class={labelClass} for="edit-author-sort">Author sort (reading)</label>
          <input
            id="edit-author-sort"
            class="c-input w-full"
            value={vals.author_sort ?? ''}
            on:input={(e) => setText('author_sort', e.currentTarget.value)}
            data-testid="edit-author-sort"
          />
        </div>
        <div>
          <span class={labelClass} id="edit-ill-label">Illustrators</span>
          <ul class="flex flex-wrap gap-2" aria-labelledby="edit-ill-label">
            {#each vals.illustrator as name, i (`${i}:${name}`)}
              <li class="c-chip c-edit-chip" data-testid="edit-illustrator">
                <span>{name}</span>
                <button
                  type="button"
                  class="c-edit-chip-btn"
                  aria-label="Remove {name}"
                  on:click={() => removeName('illustrator', i)}><Fa icon={faXmark} /></button
                >
              </li>
            {/each}
          </ul>
          <div class="mt-2 flex gap-2">
            <input
              class="c-input min-w-0 flex-1"
              placeholder="Add an illustrator"
              aria-label="Add an illustrator"
              bind:value={illustratorDraft}
              data-testid="edit-illustrator-new"
              on:keydown={(e) => e.key === 'Enter' && (e.preventDefault(), addName('illustrator'))}
            />
            <button
              type="button"
              class="c-btn c-btn-secondary"
              on:click={() => addName('illustrator')}>Add</button
            >
          </div>
          {#if unconfirmed.has('illustrator') && !confirm.has('illustrator') && !yours.has('illustrator')}
            <p class="c-edit-unconf" data-testid="edit-unconfirmed-illustrator">
              Unconfirmed: the cleanup’s best guess.
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                data-testid="edit-confirm-illustrator"
                on:click={() => confirmField('illustrator')}>Confirm as right</button
              >
            </p>
          {:else if yours.has('illustrator') || confirm.has('illustrator')}
            <p class="c-edit-mine">✓ Yours: no cleanup pass will change it.</p>
          {/if}
        </div>
      </div>
    </ModalSection>

    <ModalSection title="叢書 Series and publication">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <div class="mb-1 flex items-baseline justify-between gap-3">
            <label class="text-xs text-c-muted" for="edit-series">Series</label>
            {#if vals.series.name}
              <button
                type="button"
                class="c-link min-h-[2.75rem] text-sm"
                data-testid="edit-whole-series"
                on:click={() => dispatch('series')}>Edit the whole series</button
              >
            {/if}
          </div>
          <input
            id="edit-series"
            class="c-input w-full"
            value={vals.series.name ?? ''}
            data-testid="edit-series"
            on:input={(e) => setSeriesName(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={labelClass} for="edit-index">Number in the series</label>
          <input
            id="edit-index"
            class="c-input w-full"
            inputmode="decimal"
            value={indexText}
            disabled={!vals.series.name}
            data-testid="edit-index"
            on:input={(e) => setIndex(e.currentTarget.value)}
          />
          {#if unconfirmed.has('series_index') && !confirm.has('series_index') && !yours.has('series_index')}
            <p class="c-edit-unconf" data-testid="edit-unconfirmed-index">
              Unconfirmed: the cleanup’s best guess.
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                data-testid="edit-confirm-index"
                on:click={() => confirmField('series_index')}>Confirm as right</button
              >
            </p>
          {:else if yours.has('series_index') || confirm.has('series_index')}
            <p class="c-edit-mine" data-testid="edit-mine-index">✓ Yours</p>
          {/if}
        </div>
        <div>
          <label class={labelClass} for="edit-publisher">Publisher</label>
          <input
            id="edit-publisher"
            class="c-input w-full"
            value={vals.publisher ?? ''}
            data-testid="edit-publisher"
            on:input={(e) =>
              vals &&
              (vals = {
                ...vals,
                publisher: e.currentTarget.value.trim() ? e.currentTarget.value : null
              })}
          />
        </div>
        <div>
          <label class={labelClass} for="edit-pubdate">Published</label>
          <input
            id="edit-pubdate"
            type="date"
            class="c-input w-full"
            value={pubdateText}
            data-testid="edit-pubdate"
            on:input={(e) => setPubdate(e.currentTarget.value)}
          />
        </div>
        <div>
          <label class={labelClass} for="edit-language">Language</label>
          <select
            id="edit-language"
            class="c-input w-full"
            value={vals.languages[0] ?? ''}
            data-testid="edit-language"
            on:change={(e) =>
              vals &&
              (vals = {
                ...vals,
                languages: e.currentTarget.value
                  ? [
                      e.currentTarget.value,
                      ...vals.languages.slice(1).filter((l) => l !== e.currentTarget.value)
                    ]
                  : []
              })}
          >
            <option value="">(none)</option>
            {#each LANGUAGES as l (l.code)}<option value={l.code}>{l.label}</option>{/each}
            {#each (start?.languages ?? []).filter((c) => !LANGUAGES.some((l) => l.code === c)) as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </select>
        </div>
        <div class="sm:col-span-2">
          <span class={labelClass}>Rating · tap a star again for a half star</span>
          <RatingStars
            rating={vals.rating}
            input
            testid="edit-rating"
            on:change={(e) => vals && (vals = { ...vals, rating: e.detail })}
          />
        </div>
      </div>
    </ModalSection>

    <ModalSection
      title="分類 Tags"
      hint="Only tags from the list in Settings › Library. A tag you remove by hand is never added back by the cleanup."
      testid="edit-tags"
    >
      <ul class="flex flex-wrap gap-2">
        {#each vals.tags as tag (tag)}
          <li class="c-chip c-edit-chip" data-testid="edit-tag">
            <span>{tag}</span>
            <button
              type="button"
              class="c-edit-chip-btn"
              aria-label="Remove {tag}"
              on:click={() =>
                vals && (vals = { ...vals, tags: vals.tags.filter((t) => t !== tag) })}
              ><Fa icon={faXmark} /></button
            >
          </li>
        {/each}
        {#if !vals.tags.length}<li class="text-sm text-c-muted">No tags</li>{/if}
      </ul>
      <input
        class="c-input mt-3 w-full"
        placeholder="Add a tag"
        aria-label="Find a tag to add"
        bind:value={tagFilter}
        data-testid="edit-tag-filter"
      />
      <div class="c-edit-picker mt-2" data-testid="edit-tag-picker">
        {#if !tagList}
          <p class="text-sm text-c-muted">The list of tags couldn’t be loaded.</p>
        {/if}
        {#each pickable as g (g.title)}
          <p class="mt-2 text-xs text-c-muted">{g.title}</p>
          <div class="mt-1 flex flex-wrap gap-1.5">
            {#each g.tags as tag (tag)}
              <button
                type="button"
                class="c-chip c-chip-sm"
                data-testid="edit-tag-pick"
                on:click={() => vals && (vals = { ...vals, tags: [...vals.tags, tag] })}
                >+ {tag}</button
              >
            {/each}
          </div>
        {/each}
      </div>
    </ModalSection>

    <ModalSection title="内容紹介 Description">
      <textarea
        class="c-input w-full py-2"
        rows="8"
        aria-label="Description"
        value={vals.description ?? ''}
        on:input={(e) => setText('description', e.currentTarget.value)}
        data-testid="edit-description"
      />
      <p class="mt-1 text-xs text-c-muted">A blank line starts a new paragraph.</p>
    </ModalSection>

    <ModalSection title="外部リンク Store and site ids (the book page’s links)">
      <div class="grid gap-3 sm:grid-cols-2">
        {#each [...BOOK_LINKS.map( (l) => ({ name: l.name, key: l.key }) ), { name: 'ISBN', key: 'isbn' }, ...otherIds.map( (k) => ({ name: k, key: k }) )] as d (d.key)}
          <div>
            <label class="{labelClass} justify-between" for="edit-id-{d.key}"
              >{d.name} <span class="font-mono">{d.key}</span></label
            >
            <input
              id="edit-id-{d.key}"
              class="c-input w-full"
              value={vals.identifiers[d.key] ?? ''}
              placeholder="no id: a search link is shown"
              data-testid="edit-id-{d.key}"
              on:input={(e) => setId(d.key, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    </ModalSection>

    {#if renames}
      <div class="my-3">
        <InlineConfirm
          {...sharedRenameCopy(renames)}
          busy={saving}
          testid="edit-rename-confirm"
          on:cancel={() => (renames = null)}
          on:confirm={() => save(true)}
        />
      </div>
    {/if}
  {/if}

  <svelte:fragment slot="status">
    {#if saveError}<span class="text-c-seal" role="alert" data-testid="edit-save-error"
        >{saveError}</span
      >
    {:else if tooLong}<span class="text-c-seal" data-testid="edit-too-long"
        >Too long for Calibre: shorten the title or the first author.</span
      >
    {:else if changed.length || cover || confirm.size}<span data-testid="edit-changed"
        >{[
          ...changed.map(fieldLabel),
          ...(cover ? ['Cover'] : []),
          ...(confirm.size ? [`${confirm.size} confirmed`] : [])
        ].join(', ')}</span
      >{/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    {#if vals}
      <button
        type="button"
        class="c-btn c-btn-primary"
        disabled={!canSave}
        data-testid="edit-save"
        on:click={() => save(false)}>{saving ? 'Saving…' : 'Save'}</button
      >
    {/if}
  </svelte:fragment>
</Modal>

<style>
  .c-edit-drop {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    border: var(--c-border-width) dashed var(--c-line-strong);
    border-radius: 0.625rem;
  }

  .c-edit-drop.is-dragging {
    background-color: var(--c-tint);
    border-color: var(--c-link);
  }

  .c-edit-cover {
    flex: none;
    width: 5.5rem;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 0.25rem;
    background-color: var(--c-tint);
  }

  .c-edit-ill {
    display: block;
    min-height: 2.75rem;
    border-radius: 0.375rem;
    overflow: hidden;
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-edit-ill img {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
  }

  .c-edit-ill:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }

  /* Book covers: Earlier covers and From the stores, one card per picture. */
  .c-edit-pics {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
    gap: 0.75rem;
  }

  .c-edit-pic {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
    min-width: 0;
  }

  .c-edit-pic-btn,
  .c-edit-pic-empty {
    display: block;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 0.375rem;
    overflow: hidden;
    border: var(--c-border-width) solid var(--c-line);
    background-color: var(--c-tint);
  }

  .c-edit-pic-btn img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .c-edit-pic-btn:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }

  .c-edit-pic-empty {
    display: grid;
    place-items: center;
    padding: 0.5rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--c-muted);
  }

  .c-edit-chip {
    padding-right: 0.25rem;
    gap: 0.25rem;
  }

  .c-edit-chip-btn {
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: -0.5rem -0.25rem;
    border-radius: 999px;
    color: var(--c-muted);
  }

  .c-edit-chip-btn:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -6px;
  }

  .c-edit-unconf {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 0.375rem 0.625rem;
    border-radius: 0.625rem;
    font-size: 0.8125rem;
    background-color: var(--c-tint);
    border: var(--c-border-width) solid var(--c-line-strong);
  }

  .c-edit-mine {
    margin-top: 0.375rem;
    font-size: 0.8125rem;
    color: var(--c-muted);
  }

  .c-edit-picker {
    max-height: 16rem;
    overflow-y: auto;
  }
</style>
