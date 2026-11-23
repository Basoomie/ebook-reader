<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 8's lists (WP21g): the pairs by class (with the candidates and, in review, your choice:
   * one of the candidates or "No ebook"), the genres and tags per book, the series from Calibre
   * (to review: "Use Calibre's series" / "No series"), the store series that differ, and the
   * Preview's changes to books in the library. Choices are applied by the next run. Reloads when
   * `pass` changes.
   */
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import { EBOOK_LISTS, SOURCE_LABELS } from '$lib/cleanup/audio-ebooks-text';
  import { fieldLabel } from '$lib/cleanup/audio-arrivals-text';
  import { n } from '$lib/cleanup/cleanup-text';

  export let api: CleanupApi;
  /** The pass and its phase: the list reloads when it changes. */
  export let pass: string;

  const PAGE = 50;
  let list = EBOOK_LISTS[0].id;
  let data: { total: number; items: Record<string, unknown>[] } | null = null;
  let offset = 0;
  let error = '';
  let loadedFor = '';

  $: if (pass !== loadedFor) {
    loadedFor = pass;
    void load(offset);
  }

  async function load(at: number) {
    error = '';
    try {
      data = await api.audioEbooks(list, at, PAGE);
      offset = at;
    } catch (err) {
      data = null;
      error = (err as Error).message;
    }
  }

  async function choose(
    unit: string,
    field: 'pair' | 'series',
    value: number | null | 'calibre' | 'none'
  ) {
    error = '';
    try {
      await api.audioEbookChoice(unit, field, value);
      await load(offset);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  const s = (v: unknown) =>
    typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(s) : []);
  type Candidate = { id: number; title: string; outcome: string; why: string };
  const cands = (v: unknown): Candidate[] => (Array.isArray(v) ? (v as Candidate[]) : []);
  type Ebook = {
    title: string;
    series: string | null;
    index: number | null;
    terms?: { genres: string[]; tags: string[] };
  };
  const ebook = (v: unknown): Ebook | null => (v && typeof v === 'object' ? (v as Ebook) : null);
  function seriesText(series: unknown): string {
    if (!Array.isArray(series) || !series.length) return 'none';
    return (series as { name: string; position: number | null }[])
      .map((x) => (x.position === null ? x.name : `${x.name} #${x.position}`))
      .join(', ');
  }
  function fieldText(f: { field: string; to: unknown }): string {
    const v = Array.isArray(f.to) ? f.to.map(s).join(', ') || '(none)' : s(f.to) || '(none)';
    return `${fieldLabel(f.field)}: ${v}`;
  }
</script>

<label class="flex flex-col gap-1 text-sm">
  <span class="font-medium">List</span>
  <select
    class="c-input"
    bind:value={list}
    on:change={() => load(0)}
    data-testid="audio-ebooks-list"
  >
    {#each EBOOK_LISTS as l (l.id)}
      <option value={l.id}>{l.label}</option>
    {/each}
  </select>
</label>
{#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
{#if data}
  <p class="text-sm text-c-muted" data-testid="audio-ebooks-total">{n(data.total)}</p>
  <ul class="flex flex-col text-sm" data-testid="audio-ebooks-items">
    {#each data.items as it, i (i)}
      <li class="flex min-w-0 flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
        {#if list === 'auto' || list === 'review' || list === 'none' || list === 'excluded'}
          <span class="break-words font-medium"
            >{s(it.title)}{arr(it.authors).length ? ` · ${arr(it.authors).join(', ')}` : ''}</span
          >
          <span class="text-c-muted"
            >{SOURCE_LABELS[s(it.source)] ?? s(it.source)} · {s(it.reason)}</span
          >
          {#if ebook(it.ebook)}
            <span class="break-words"
              >→ {ebook(it.ebook)?.title}{ebook(it.ebook)?.series
                ? ` (${ebook(it.ebook)?.series} #${ebook(it.ebook)?.index})`
                : ''}</span
            >
          {/if}
          {#if list === 'review'}
            <div class="flex flex-col gap-1">
              {#each cands(it.candidates).filter((c) => c.outcome !== 'fail') as c (c.id)}
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={it.choice === c.id}
                    on:click={() => choose(s(it.unitKey), 'pair', c.id)}
                    data-testid="audio-ebooks-choose">This ebook</button
                  >
                  <span class="break-words"
                    >{c.title} <span class="text-c-muted">({c.why})</span></span
                  >
                </div>
              {/each}
              <div>
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  aria-pressed={it.choice === null}
                  on:click={() => choose(s(it.unitKey), 'pair', null)}
                  data-testid="audio-ebooks-none">No ebook</button
                >
              </div>
            </div>
          {/if}
        {:else if list === 'terms'}
          <span class="break-words font-medium">{s(it.title)}</span>
          <span class="text-c-muted break-words">→ {s(it.ebookTitle)}</span>
          <span>Genres: {arr(it.genres).join(', ') || 'none'}</span>
          <span>Tags: {arr(it.tags).join(', ') || 'none'}</span>
        {:else if list.startsWith('series-')}
          <span class="break-words font-medium">{s(it.title)}</span>
          <span
            >Calibre: {s(it.calibreSeries)}{it.calibreIndex !== null
              ? ` #${it.calibreIndex}`
              : ''}{it.name && it.name !== it.calibreSeries ? ` (written as ${s(it.name)})` : ''} · now:
            {seriesText(it.current)}</span
          >
          {#if it.reason}<span class="text-c-muted">{s(it.reason)}</span>{/if}
          {#if list === 'series-review'}
            <div class="flex flex-wrap gap-2">
              <button
                class="c-btn c-btn-secondary c-btn-sm"
                aria-pressed={it.choice === 'calibre'}
                on:click={() => choose(s(it.unitKey), 'series', 'calibre')}
                data-testid="audio-ebooks-series-use">Use Calibre’s series</button
              >
              <button
                class="c-btn c-btn-ghost c-btn-sm"
                aria-pressed={it.choice === 'none'}
                on:click={() => choose(s(it.unitKey), 'series', 'none')}
                data-testid="audio-ebooks-series-none">No series</button
              >
            </div>
          {/if}
        {:else if list === 'preview'}
          <span class="break-all font-medium">{s(it.folderFrom)}</span>
          {#if it.folderTo}<span class="break-all">→ {s(it.folderTo)}</span>{/if}
          {#each Array.isArray(it.fields) ? it.fields : [] as f}
            <span class="break-words text-c-muted">{fieldText(f)}</span>
          {/each}
          {#each Array.isArray(it.reviews) ? it.reviews : [] as r}
            <span class="break-words">{s(r.text)}</span>
          {/each}
        {/if}
      </li>
    {/each}
  </ul>
  {#if data.total > PAGE}
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="c-btn c-btn-secondary"
        disabled={offset === 0}
        on:click={() => load(Math.max(0, offset - PAGE))}>Previous</button
      >
      <span class="text-sm"
        >{n(offset + 1)}–{n(Math.min(data.total, offset + PAGE))} of {n(data.total)}</span
      >
      <button
        class="c-btn c-btn-secondary"
        disabled={offset + PAGE >= data.total}
        on:click={() => load(offset + PAGE)}>Next</button
      >
    </div>
  {/if}
{/if}
