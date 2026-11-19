<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 5 of the Audiobooks tab (WP21d): each recording's metadata as decided, every field
   * with its value, where it came from (the rules, both models, Luna's guess, ...) and the
   * "unconfirmed" mark. List only: nothing waits for you here (an unconfirmed field already has
   * its best guess); looking is optional. No editing in WP21d.
   */
  import type { AudioMetaField, AudioMetaItem, CleanupApi } from '$lib/cleanup/cleanup-api';
  import { FIELD_LABELS, META_LISTS, SOURCE_LABELS, valueText } from '$lib/cleanup/audio-meta-text';
  import { n } from '$lib/cleanup/cleanup-text';

  export let api: CleanupApi;
  /** Changes when stage 5 finishes or starts again: the list is loaded again. */
  export let analysis = '';

  const PAGE = 50;
  /** Fields shown in this order (the record's other fields follow). */
  const MAIN = ['title', 'authors', 'narrators', 'series', 'drama', 'multi_narr', 'record'];

  let list = META_LISTS[0].id;
  let total = 0;
  let offset = 0;
  let items: AudioMetaItem[] = [];
  let error = '';
  let loadedFor: string | null = null;

  $: if (analysis !== loadedFor) {
    loadedFor = analysis;
    void load(0);
  }

  async function load(at: number) {
    error = '';
    try {
      const r = await api.audioMeta(list, at, PAGE);
      total = r.total;
      offset = at;
      items = r.items;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function main(it: AudioMetaItem): AudioMetaField[] {
    return MAIN.map((f) => it.fields.find((x) => x.field === f)).filter(
      (x): x is AudioMetaField => !!x
    );
  }

  function rest(it: AudioMetaItem): AudioMetaField[] {
    return it.fields.filter((x) => !MAIN.includes(x.field));
  }

  function kindText(it: AudioMetaItem): string {
    if (it.kind === 'ai') return 'AI audiobook';
    if (it.kind === 'radio') return 'radio clip';
    if (it.kind === 'no_record') return 'no store record';
    return it.stage4Class === 'auto' ? 'store record matched' : 'store record to choose';
  }

  function answers(f: AudioMetaField): string {
    const parts = [
      f.rules !== null && f.rules !== undefined ? `rules: ${valueText(f.field, f.rules)}` : null,
      f.primary !== null && f.primary !== undefined
        ? `Haiku: ${valueText(f.field, f.primary)}`
        : null,
      f.secondary !== null && f.secondary !== undefined
        ? `Luna: ${valueText(f.field, f.secondary)}`
        : null
    ].filter(Boolean);
    return parts.join(' · ');
  }
</script>

<div class="flex flex-col gap-3" data-testid="audio-meta">
  <p class="text-sm text-c-muted">
    Nothing here waits for you: an unconfirmed field already has its best guess. Look whenever you
    like, or never.
  </p>
  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">List</span>
    <select
      class="c-input"
      bind:value={list}
      on:change={() => load(0)}
      data-testid="audio-meta-list"
    >
      {#each META_LISTS as l (l.id)}
        <option value={l.id}>{l.label}</option>
      {/each}
    </select>
  </label>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  <p class="text-sm text-c-muted" data-testid="audio-meta-total">{n(total)} recordings</p>

  <ul class="flex flex-col text-sm">
    {#each items as it (it.unitKey)}
      <li
        class="flex flex-col gap-1 border-b py-3"
        style="border-color: var(--c-line)"
        data-testid="audio-meta-item"
      >
        <span class="break-all font-medium">{it.name}{it.labeled ? ' · labeled' : ''}</span>
        <span class="text-c-muted">
          {kindText(it)}{it.flagged ? ` · ${n(it.flagged)} unconfirmed` : ''}
        </span>
        {#each it.gateMisses as m}
          <span class="font-bold" data-testid="audio-meta-miss">
            Label {m.id}: {FIELD_LABELS[m.field] ?? m.field} should be {valueText(
              m.field,
              m.expected
            )}
          </span>
        {/each}
        <dl
          class="grid gap-x-3 gap-y-0.5"
          style="grid-template-columns: minmax(6rem, max-content) 1fr"
        >
          {#each main(it) as f (f.field)}
            <dt class="text-c-muted">{FIELD_LABELS[f.field] ?? f.field}</dt>
            <dd class="break-words" data-testid="audio-meta-field-{f.field}">
              <span class={f.flagged ? 'font-bold' : ''}>{valueText(f.field, f.value)}</span>
              <span class="text-c-muted">
                · {SOURCE_LABELS[f.source] ?? f.source}{f.flagged ? ', unconfirmed' : ''}
              </span>
              {#if f.flagged && answers(f)}
                <span class="block text-c-muted">{answers(f)}</span>
              {/if}
            </dd>
          {/each}
        </dl>
        <details>
          <summary class="cursor-pointer">Publisher, year, description, cover…</summary>
          <dl
            class="mt-1 grid gap-x-3 gap-y-0.5"
            style="grid-template-columns: minmax(6rem, max-content) 1fr"
          >
            {#each rest(it) as f (f.field)}
              <dt class="text-c-muted">{FIELD_LABELS[f.field] ?? f.field}</dt>
              <dd class="break-words">
                {valueText(f.field, f.value)}
                <span class="text-c-muted">
                  · {SOURCE_LABELS[f.source] ?? f.source}{f.flagged ? ', unconfirmed' : ''}
                </span>
              </dd>
            {/each}
          </dl>
        </details>
      </li>
    {/each}
  </ul>
  {#if total > PAGE}
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="c-btn c-btn-secondary"
        disabled={offset === 0}
        on:click={() => load(Math.max(0, offset - PAGE))}>Previous</button
      >
      <span class="text-sm">{n(offset + 1)}–{n(Math.min(total, offset + PAGE))} of {n(total)}</span>
      <button
        class="c-btn c-btn-secondary"
        disabled={offset + PAGE >= total}
        on:click={() => load(offset + PAGE)}>Next</button
      >
    </div>
  {/if}
</div>
