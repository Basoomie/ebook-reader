<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * "Tags you can pick" (Settings › Library › Editing; design 2026-11-23): the one list the
   * book edit form offers and the cleanup's tagging of new books picks from. Compact: one row
   * per group (its count and a one-line preview) with Edit; open, the group's tags with ×, and
   * the Add field on the right. Removing asks first. Changing the list writes nothing to any
   * book. The list is the library server's (one for every device).
   */
  import { onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faXmark } from '@fortawesome/free-solid-svg-icons';
  import { CalibreEditApi, editUnreachable } from '$lib/calibre-edit/api';
  import type { TagGroupId, TagList } from '$lib/calibre-edit/types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeTagFromListCopy, resetTagListCopy } from '$lib/confirm/confirm-copy';
  import { getLibraryStore } from '$lib/library/library-db';

  const NOTES: Record<TagGroupId, string> = {
    format: 'The cleanup adds one of these to every new book, from its decided format.',
    genre: 'Fiction genres (several per book).',
    subject: 'Nonfiction subjects.',
    tag: 'Story tags.',
    adaptation: 'Only from RanobeDB or a description that says so.',
    yours:
      'Your own tags: the cleanup never picks, removes or changes them. A trailing * matches any ending.'
  };

  let api: CalibreEditApi | null = null;
  let list: TagList | null = null;
  let error = '';
  let open = new Set<TagGroupId>();
  let drafts: Partial<Record<TagGroupId, string>> = {};
  let busy = false;
  let groupError: Partial<Record<TagGroupId, string>> = {};

  onMount(async () => {
    const conn = await getLibraryStore().getConnection();
    if (!conn) {
      error = 'Connect this device to the library server to see the list.';
      return;
    }
    api = new CalibreEditApi(conn.serverUrl, conn.token);
    try {
      list = await api.tags();
    } catch (err) {
      error = editUnreachable(err)
        ? 'The list needs the library server, which can’t be reached right now.'
        : (err as Error).message;
    }
  });

  function toggle(id: TagGroupId) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    open = next;
  }

  async function add(id: TagGroupId) {
    const label = (drafts[id] ?? '').trim();
    if (!api || !label) return;
    busy = true;
    groupError = { ...groupError, [id]: '' };
    try {
      list = await api.changeTags({ group: id, add: label });
      drafts = { ...drafts, [id]: '' };
    } catch (err) {
      groupError = { ...groupError, [id]: (err as Error).message };
    } finally {
      busy = false;
    }
  }

  async function remove(id: TagGroupId, label: string) {
    if (!api) return;
    const ok = await confirmDestructive({
      ...removeTagFromListCopy(label),
      testid: 'tag-remove-confirm',
      confirmTestid: 'tag-remove-confirm-yes'
    });
    if (!ok) return;
    busy = true;
    try {
      list = await api.changeTags({ group: id, remove: label });
    } catch (err) {
      groupError = { ...groupError, [id]: (err as Error).message };
    } finally {
      busy = false;
    }
  }

  async function reset() {
    if (!api) return;
    const ok = await confirmDestructive({
      ...resetTagListCopy(),
      testid: 'tag-reset-confirm',
      confirmTestid: 'tag-reset-confirm-yes'
    });
    if (!ok) return;
    try {
      list = await api.resetTags();
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<div data-testid="tag-list">
  {#if error}
    <p class="c-notice text-sm" role="alert">{error}</p>
  {:else if !list}
    <p class="text-sm text-c-muted">Loading…</p>
  {:else}
    <ul class="c-taglist">
      {#each list.groups as g (g.id)}
        <li class="c-taglist-row" data-testid="tag-group" data-group={g.id}>
          <div class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold">
                {g.title} <span class="font-normal text-c-muted">· {g.tags.length}</span>
              </p>
              {#if !open.has(g.id)}
                <p class="truncate text-sm text-c-muted" data-testid="tag-group-preview">
                  {g.tags.map((t) => t.label).join('、') || '(none)'}
                </p>
              {/if}
            </div>
            <button
              type="button"
              class="c-btn c-btn-sm {open.has(g.id) ? 'c-btn-primary' : 'c-btn-secondary'}"
              aria-expanded={open.has(g.id)}
              data-testid="tag-group-edit"
              on:click={() => toggle(g.id)}>{open.has(g.id) ? 'Done' : 'Edit'}</button
            >
          </div>
          {#if open.has(g.id)}
            <p class="mt-2 text-xs text-c-muted">{NOTES[g.id]}</p>
            <ul class="mt-2 flex flex-wrap gap-1.5">
              {#each g.tags as t (t.label)}
                <li class="c-chip c-chip-sm c-tagchip" data-testid="tag-chip">
                  <span>{t.label}</span>
                  <button
                    type="button"
                    class="c-tagchip-x"
                    aria-label="Remove {t.label} from the list"
                    disabled={busy}
                    data-testid="tag-chip-remove"
                    on:click={() => remove(g.id, t.label)}><Fa icon={faXmark} /></button
                  >
                </li>
              {/each}
            </ul>
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <input
                class="c-input min-w-0 flex-1 sm:max-w-[18rem]"
                placeholder="Add a tag to {g.title}"
                aria-label="Add a tag to {g.title}"
                value={drafts[g.id] ?? ''}
                data-testid="tag-add-input"
                on:input={(e) => (drafts = { ...drafts, [g.id]: e.currentTarget.value })}
                on:keydown={(e) => e.key === 'Enter' && (e.preventDefault(), add(g.id))}
              />
              <button
                type="button"
                class="c-btn c-btn-secondary"
                disabled={busy || !(drafts[g.id] ?? '').trim()}
                data-testid="tag-add"
                on:click={() => add(g.id)}>Add</button
              >
            </div>
            {#if groupError[g.id]}<p class="mt-1 text-sm text-c-seal" role="alert">
                {groupError[g.id]}
              </p>{/if}
          {/if}
        </li>
      {/each}
    </ul>
    <div class="mt-3 flex justify-end">
      <button
        type="button"
        class="c-btn c-btn-ghost c-btn-sm"
        data-testid="tag-reset"
        on:click={reset}>Reset to default</button
      >
    </div>
  {/if}
</div>

<style>
  .c-taglist {
    border: var(--c-border-width) solid var(--c-line);
    border-radius: 0.625rem;
  }

  .c-taglist-row {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--c-line);
  }

  .c-taglist-row:first-child {
    border-top: 0;
  }

  .c-tagchip {
    padding-right: 0.125rem;
  }

  .c-tagchip-x {
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: -0.625rem -0.25rem;
    border-radius: 999px;
    color: var(--c-muted);
  }

  .c-tagchip-x:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -8px;
  }
</style>
