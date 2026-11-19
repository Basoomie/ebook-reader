<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 4 of the Audiobooks tab (WP21c): what the online lookups found for each recording.
   * Every list shows the recording (its names, length, tags) next to the store record found,
   * and for each store record looked at, the five checks (title, author, volume, length,
   * narrator) with both sides' values, and the sample-audio score where editions were compared.
   * Nothing is changed: choosing the values is a later step.
   */
  import type {
    AudioOnlineGateBook,
    AudioOnlineItem,
    AudioOnlineRecordBrief,
    CleanupApi
  } from '$lib/cleanup/cleanup-api';
  import {
    ONLINE_LISTS,
    REASON_LABELS,
    checkLine,
    clock,
    recordName,
    storeName
  } from '$lib/cleanup/audio-online-text';
  import { n } from '$lib/cleanup/cleanup-text';

  export let api: CleanupApi;
  /** Changes when stage 4 finishes or starts again: the list is loaded again. */
  export let analysis = '';

  const PAGE = 50;
  const CHECKS = ['title', 'author', 'volume', 'runtime', 'narrator'];

  let list = ONLINE_LISTS[0].id;
  let total = 0;
  let offset = 0;
  let items: AudioOnlineItem[] = [];
  let gateRows: AudioOnlineGateBook[] = [];
  let error = '';
  let loadedFor: string | null = null;

  $: if (analysis !== loadedFor) {
    loadedFor = analysis;
    void load(0);
  }

  async function load(at: number) {
    error = '';
    try {
      const r = await api.audioOnline(list, at, PAGE);
      total = r.total;
      offset = at;
      items = list === 'gate' ? [] : (r.items as AudioOnlineItem[]);
      gateRows = list === 'gate' ? (r.items as AudioOnlineGateBook[]) : [];
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function headline(it: AudioOnlineItem): string {
    if (it.class === 'auto') return `Matched: ${recordName(it.source, it.storeId)}`;
    if (it.class === 'review')
      return `To review (${REASON_LABELS[it.reason ?? ''] ?? it.reason ?? '?'})${it.source ? `: best ${recordName(it.source, it.storeId)}` : ''}`;
    if (it.class === 'unknown')
      return `Not found${it.reason && it.reason !== 'not found' ? ` (${it.reason})` : ''}`;
    if (it.class === 'none_expected')
      return `No store record expected${it.reason ? ` (${it.reason})` : ''}`;
    if (it.state === 'error') return `The lookup failed: ${it.error ?? ''}`;
    return 'Still being looked up';
  }

  function fileLine(it: AudioOnlineItem): string {
    const f = it.file;
    return [
      f.authors.length ? `by ${f.authors.join(', ')}` : null,
      f.narrators.length ? `read by ${f.narrators.join(', ')} (tags)` : null,
      f.volume ? `volume ${f.volume}` : null,
      f.drama ? `drama CD${f.drama.number ? ` ${f.drama.number}` : ''}` : null,
      `${clock(f.seconds)}${f.files > 1 ? ` in ${n(f.files)} files` : ''}`,
      it.copies > 1 ? `${n(it.copies)} copies of one recording` : null
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function recordLine(r: AudioOnlineRecordBrief | null): string {
    if (!r) return '';
    const series = r.series
      .map(
        (s) =>
          `${s.name}${s.sequence ? ` ${s.sequence}` : ''}${s.sort ? ` (position ${s.sort})` : ''}`
      )
      .join('; ');
    return [
      r.authors.length ? `by ${r.authors.join(', ')}` : null,
      r.narrators.length ? `read by ${r.narrators.join(', ')}` : null,
      clock(r.seconds),
      r.publisher,
      r.releaseDate,
      series ? `series ${series}` : null
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function viaText(via: string): string {
    if (via === 'asin_name') return 'the ASIN in the file name';
    if (via === 'abs_asin') return 'the ASIN in Audiobookshelf';
    if (via === 'name_id') return 'the id in the folder name';
    if (via.startsWith('search:')) return `Audible search “${via.slice(7)}”`;
    if (via.startsWith('keywords:')) return `Audible keyword search “${via.slice(9)}”`;
    if (via === 'kikubon_search') return 'kikubon search';
    if (via === 'abjp_search') return 'audiobook.jp search';
    return via;
  }

  function checkLines(c: AudioOnlineItem['candidates'][number]): string[] {
    return CHECKS.filter((k) => c.checks[k]).map((k) => checkLine(k, c.checks[k]));
  }
</script>

<div class="flex flex-col gap-3" data-testid="audio-online">
  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">List</span>
    <select
      class="c-input"
      bind:value={list}
      on:change={() => load(0)}
      data-testid="audio-online-list"
    >
      {#each ONLINE_LISTS as l (l.id)}
        <option value={l.id}>{l.label}</option>
      {/each}
    </select>
  </label>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  <p class="text-sm text-c-muted" data-testid="audio-online-total">{n(total)} recordings</p>

  {#if list === 'gate'}
    <ul class="flex flex-col text-sm" data-testid="audio-online-gate">
      {#each gateRows as g (g.id)}
        <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
          <span class="font-medium {g.ok ? '' : 'font-bold'}">
            {g.ok ? '✓' : '✗'}
            {g.id}
            {g.title ?? ''}
          </span>
          <span class="text-c-muted">Labeled {g.expected} · found {g.got}</span>
          {#if g.note}<span class="text-c-muted">{g.note}</span>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="flex flex-col text-sm">
      {#each items as it (it.id)}
        <li
          class="flex flex-col gap-1 border-b py-3"
          style="border-color: var(--c-line)"
          data-testid="audio-online-item"
        >
          <span class="break-all font-medium">{it.name}{it.labeled ? ' · labeled' : ''}</span>
          <span class="font-medium" data-testid="audio-online-headline">{headline(it)}</span>
          <span class="text-c-muted">{fileLine(it)}</span>
          {#each it.file.paths.slice(0, 2) as p}<span class="break-all text-c-muted">{p}</span
            >{/each}
          {#if it.record}
            <span>{it.record.title}</span>
            <span class="text-c-muted">{recordLine(it.record)}</span>
          {/if}
          {#if it.detail}<span class="text-c-muted">{it.detail}</span>{/if}
          {#if it.candidates.length}
            <details>
              <summary class="cursor-pointer">
                {n(it.candidates.length)} store records looked at
              </summary>
              <ul class="mt-1 flex flex-col gap-2 pl-3">
                {#each it.candidates as c (`${c.source}:${c.storeId}`)}
                  <li class="flex flex-col gap-0.5" data-testid="audio-online-candidate">
                    <span class="font-medium">
                      {storeName(c.source)}
                      {c.storeId} · {c.verdict === 'pass' ? 'every check agrees' : 'not a match'} · from
                      {viaText(c.via)}{c.sampleScore !== null
                        ? ` · sample audio ${c.sampleScore}`
                        : ''}
                    </span>
                    {#if c.record}<span>{c.record.title}</span>{/if}
                    {#each checkLines(c) as line}<span class="text-c-muted">{line}</span>{/each}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
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
