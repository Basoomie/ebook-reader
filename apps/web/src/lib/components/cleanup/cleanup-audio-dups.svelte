<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 3 of the Audiobooks tab (WP21b): copies of the same recording side by side, with what
   * was heard (start, middle, end), the rule that picked the best copy, and your choice for the
   * items to review: keep all, or keep only one. A choice is only recorded; nothing is changed
   * until the library is rebuilt (a later step). Each copy can play a few seconds from its start
   * and its end; while the Calibre cleanup uses the disk the clip waits and tries again.
   */
  import { onDestroy } from 'svelte';
  import type {
    AudioDupCopy,
    AudioDupDifferent,
    AudioDupGroup,
    AudioGateResult,
    CleanupApi
  } from '$lib/cleanup/cleanup-api';
  import {
    DUP_LISTS,
    TEST_LABELS,
    copyFacts,
    damageLine,
    decisionText,
    groupHeadline,
    pairCopies,
    scoresLine
  } from '$lib/cleanup/audio-dup-text';
  import { n } from '$lib/cleanup/cleanup-text';

  export let api: CleanupApi;
  /** Changes when stage 3 finishes or starts again: the list is loaded again. */
  export let analysis = '';

  const PAGE = 50;
  const RETRY_MS = 15_000;

  let list = DUP_LISTS[0].id;
  let total = 0;
  let offset = 0;
  let groups: AudioDupGroup[] = [];
  let different: AudioDupDifferent[] = [];
  let excluded: AudioDupCopy[] = [];
  let gateRows: AudioGateResult['misses'] = [];
  let error = '';
  let busy = false;
  let loadedFor: string | null = null;

  /** The clip playing or waiting: copy id + end. */
  let clipKey = '';
  let clipUrl = '';
  let clipWaiting = false;
  let clipError = '';
  let retry: ReturnType<typeof setTimeout> | undefined;

  $: if (analysis !== loadedFor) {
    loadedFor = analysis;
    void load(0);
  }

  onDestroy(() => {
    clearTimeout(retry);
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  });

  async function load(at: number) {
    error = '';
    try {
      const r = await api.audioDups(list, at, PAGE);
      total = r.total;
      offset = at;
      groups = [];
      different = [];
      excluded = [];
      gateRows = [];
      if (list === 'different') different = r.items as unknown as AudioDupDifferent[];
      else if (list === 'excluded') excluded = r.items as unknown as AudioDupCopy[];
      else if (list === 'gate') gateRows = r.items as unknown as AudioGateResult['misses'];
      else groups = r.items as unknown as AudioDupGroup[];
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function decide(g: AudioDupGroup, decision: string) {
    busy = true;
    error = '';
    try {
      await api.decideAudioDup(g.id, decision);
      await load(offset);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function play(copy: AudioDupCopy, at: 'start' | 'end') {
    clearTimeout(retry);
    const key = `${copy.id}:${at}`;
    clipKey = key;
    clipError = '';
    clipWaiting = false;
    try {
      const blob = await api.audioClip(copy.id, at);
      if (clipKey !== key) return;
      if (!blob) {
        clipWaiting = true;
        retry = setTimeout(() => void play(copy, at), RETRY_MS);
        return;
      }
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      clipUrl = URL.createObjectURL(blob);
    } catch (err) {
      if (clipKey === key) clipError = (err as Error).message;
    }
  }

  function stopClip() {
    clearTimeout(retry);
    clipKey = '';
    clipWaiting = false;
    clipError = '';
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = '';
  }

  function chosen(g: AudioDupGroup, c: AudioDupCopy): boolean {
    return g.decision?.decision === `keep:${c.key}`;
  }

  function roleText(g: AudioDupGroup, c: AudioDupCopy): string {
    if (g.outcome === 'review') return c.id === g.bestCopyId ? 'best guess' : '';
    return c.role === 'keep' ? 'stays' : 'not needed';
  }
</script>

<div class="flex flex-col gap-3" data-testid="audio-dups">
  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">List</span>
    <select
      class="c-input"
      bind:value={list}
      on:change={() => load(0)}
      data-testid="audio-dup-list"
    >
      {#each DUP_LISTS as l (l.id)}
        <option value={l.id}>{l.label}</option>
      {/each}
    </select>
  </label>
  {#if list === 'review'}
    <p class="max-w-prose text-sm text-c-muted">
      Both copies stay in the library until you choose. Your choice is only recorded here; the
      library is rebuilt later, and every choice can still be changed then.
    </p>
  {/if}
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  <p class="text-sm text-c-muted" data-testid="audio-dup-total">{n(total)} in this list</p>

  {#if clipKey}
    <div
      class="c-tile flex flex-wrap items-center gap-2 rounded p-2 text-sm"
      data-testid="audio-clip"
    >
      {#if clipWaiting}
        <span data-testid="audio-clip-waiting"
          >Waiting: the Calibre cleanup is using the disk. The clip plays when it is free.</span
        >
      {:else if clipError}
        <span role="alert">{clipError}</span>
      {:else if clipUrl}
        <!-- svelte-ignore a11y-media-has-caption -->
        <audio src={clipUrl} controls autoplay data-testid="audio-clip-player" />
      {:else}
        <span>Cutting the clip…</span>
      {/if}
      <button class="c-btn c-btn-ghost" on:click={stopClip}>Close</button>
    </div>
  {/if}

  <ul class="flex flex-col gap-3">
    {#each groups as g (g.id)}
      <li class="c-tile flex flex-col gap-2 rounded p-3 text-sm" data-testid="audio-dup-group">
        <div class="flex flex-col gap-0.5">
          <span class="font-bold">{groupHeadline(g)}</span>
          {#if g.reviewReason}<span class="text-c-muted" data-testid="audio-dup-reason"
              >{g.reviewReason}</span
            >{/if}
        </div>
        <div class="grid gap-2 {g.copies.length === 2 ? 'sm:grid-cols-2' : ''}">
          {#each g.copies as c, i (c.id)}
            <div
              class="flex flex-col gap-0.5 border-t pt-2"
              style="border-color: var(--c-line)"
              data-testid="audio-dup-copy"
            >
              <div class="font-medium">
                Copy {i + 1}
                {#if roleText(g, c)}<span class="c-count">{roleText(g, c)}</span>{/if}
                {#if chosen(g, c)}<span class="c-count">your choice</span>{/if}
              </div>
              {#each c.paths.slice(0, 3) as p}<div class="break-all">{p}</div>{/each}
              {#if c.paths.length > 3}<div class="text-c-muted">
                  and {n(c.paths.length - 3)} more files
                </div>{/if}
              <div class="text-c-muted">{copyFacts(c)}</div>
              {#if damageLine(c)}<div class={c.damage === 'damaged' ? 'font-bold' : 'text-c-muted'}>
                  {damageLine(c)}
                </div>{/if}
              <div class="flex flex-wrap gap-2">
                <button
                  class="c-btn c-btn-secondary"
                  on:click={() => play(c, 'start')}
                  data-testid="audio-dup-play-start">Play the start</button
                >
                <button
                  class="c-btn c-btn-secondary"
                  on:click={() => play(c, 'end')}
                  data-testid="audio-dup-play-end">Play the end</button
                >
                {#if g.outcome === 'review'}
                  <button
                    class="c-btn c-btn-secondary"
                    disabled={busy}
                    on:click={() => decide(g, `keep:${c.key}`)}
                    data-testid="audio-dup-keep-one">Keep only this copy</button
                  >
                {/if}
              </div>
            </div>
          {/each}
        </div>
        {#each g.pairs.filter((p) => p.scores) as p}
          <p class="text-c-muted" data-testid="audio-dup-scores">
            {pairCopies(g, p)}{scoresLine(p)}{p.detail ? ` · ${p.detail}` : ''}
          </p>
        {/each}
        {#if decisionText(g)}<p class="font-medium" data-testid="audio-dup-decision">
            {decisionText(g)}
          </p>{/if}
        {#if g.outcome === 'review'}
          <div class="flex flex-wrap gap-2">
            <button
              class="c-btn c-btn-secondary"
              disabled={busy}
              on:click={() => decide(g, 'keep_all')}
              data-testid="audio-dup-keep-all"
              >{g.copies.length === 2 ? 'Keep both' : 'Keep all'}</button
            >
            {#if g.decision}
              <button
                class="c-btn c-btn-ghost"
                disabled={busy}
                on:click={() => decide(g, 'clear')}
                data-testid="audio-dup-clear">Forget my choice</button
              >
            {/if}
          </div>
        {/if}
      </li>
    {/each}
    {#each different as d (d.id)}
      <li class="c-tile flex flex-col gap-2 rounded p-3 text-sm" data-testid="audio-dup-different">
        <span class="font-bold">Different recordings ({TEST_LABELS[d.test] ?? d.test})</span>
        <div class="grid gap-2 sm:grid-cols-2">
          {#each d.copies as c, i (c.id)}
            <div class="flex flex-col gap-0.5">
              <div class="font-medium">Copy {i + 1}</div>
              {#each c.paths.slice(0, 2) as p}<div class="break-all">{p}</div>{/each}
              <div class="text-c-muted">{copyFacts(c)}</div>
            </div>
          {/each}
        </div>
        <p class="text-c-muted">
          {scoresLine({
            a_id: 0,
            b_id: 0,
            test: d.test,
            verdict: d.verdict,
            fp_verdict: null,
            length_diff: d.lengthDiff,
            detail: d.detail,
            scores: d.scores
          })}
        </p>
      </li>
    {/each}
    {#each excluded as c (c.id)}
      <li class="flex flex-col gap-0.5 border-b py-2 text-sm" style="border-color: var(--c-line)">
        {#each c.paths as p}<span class="break-all">{p}</span>{/each}
        <span class="text-c-muted">{c.excluded}</span>
      </li>
    {/each}
    {#each gateRows as r (r.n)}
      <li class="flex flex-col gap-0.5 border-b py-2 text-sm" style="border-color: var(--c-line)">
        <span class={r.ok ? '' : 'font-bold'}
          >{r.ok ? '✓' : '✗'} Pair {r.n} ({r.kind}): labeled {r.expected}, came out {r.got}</span
        >
        {#if r.note}<span class="text-c-muted">{r.note}</span>{/if}
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
