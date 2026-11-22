<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12 session 3: read-aloud's panel over the book (reader menu > Read aloud),
   * docked like the Pacer panel. Buttons only (no text fields), so the reader keys (V, "<",
   * ">") keep working; 48 px bordered controls, plain for e-ink; Esc or Close closes it and
   * read-aloud goes on.
   */
  import PanelDismiss from '$lib/components/modal/panel-dismiss.svelte';
  import { createEventDispatcher, onMount } from 'svelte';
  import PcVoiceChoice from '$lib/components/audio/pc-voice-choice.svelte';
  import { viewMode$, writingMode$ } from '$lib/data/store';
  import { ViewMode } from '$lib/data/view-mode';
  import type { LibraryApi } from '$lib/library/api';
  import type { ReadAloudView } from '$lib/read-aloud/session';
  import { readAloudSpeed$, stepSpeed, usableSpeed } from '$lib/read-aloud/settings';
  import { speedLabel } from '$lib/read-aloud/text';

  export let view: ReadAloudView;
  export let following = true;
  /** The sentence highlight works in this browser (CSS Custom Highlight API). */
  export let highlightSupported = true;
  export let api: LibraryApi | null = null;
  /** The library book id (null: a book outside the library). */
  export let bookId: string | null = null;

  const dispatch = createEventDispatcher<{
    close: void;
    toggle: void;
    stop: void;
    skip: 1 | -1;
    here: void;
    back: void;
    voiceChanged: void;
  }>();

  // The shared buttons (app.scss): soft for actions, ghost for Close, square ones for − and +.
  const stepButton = 'c-btn c-btn-secondary c-btn-icon text-xl';
  const button = 'c-btn c-btn-secondary';
  const closeButton = 'c-btn c-btn-ghost -mr-2 px-3';

  let panelEl: HTMLElement;
  let showVoice = false;

  $: dockLeft = $writingMode$ === 'vertical-rl';
  $: continuous = $viewMode$ === ViewMode.Continuous;
  $: playing = view.phase === 'playing' || view.phase === 'waiting' || view.phase === 'preparing';
  $: active = view.phase !== 'idle';
  $: speed = usableSpeed($readAloudSpeed$);
  $: if (view.needsVoice) showVoice = true;

  onMount(() => {
    panelEl?.focus();
  });
</script>

<!-- A tap outside the panel (or Esc) closes it without turning the page. -->
<PanelDismiss on:close={() => dispatch('close')} />

<section
  bind:this={panelEl}
  tabindex="-1"
  class="c-reader-panel writing-horizontal-tb fixed inset-x-0 bottom-0 z-[55] max-h-[65vh] overflow-y-auto rounded-t-2xl border-t p-4 outline-none md:inset-y-0 md:max-h-none md:w-[26rem] md:rounded-none md:border-t-0"
  class:md:left-auto={!dockLeft}
  class:md:right-0={!dockLeft}
  class:md:border-l={!dockLeft}
  class:md:right-auto={dockLeft}
  class:md:left-0={dockLeft}
  class:md:border-r={dockLeft}
  data-testid="read-aloud-panel"
  aria-label="Read aloud"
>
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-xl font-medium">Read aloud</h2>
    <button class={closeButton} on:click={() => dispatch('close')}>Close</button>
  </div>

  <p class="text-sm">The PC reads the book with its voice. It works while the PC is on.</p>

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <button
      class="c-btn c-btn-primary min-w-[7rem]"
      data-testid="read-aloud-toggle"
      on:click={() => dispatch('toggle')}>{playing ? 'Pause' : 'Play'}</button
    >
    <button
      class={stepButton}
      aria-label="Previous sentence"
      title="Previous sentence (<)"
      data-testid="read-aloud-prev"
      disabled={!active}
      on:click={() => dispatch('skip', -1)}>‹</button
    >
    <button
      class={stepButton}
      aria-label="Next sentence"
      title="Next sentence (>)"
      data-testid="read-aloud-next"
      disabled={!active}
      on:click={() => dispatch('skip', 1)}>›</button
    >
    {#if active}
      <button class={button} data-testid="read-aloud-stop" on:click={() => dispatch('stop')}
        >Stop</button
      >
    {/if}
  </div>
  <p class="mt-2" role="status" data-testid="read-aloud-status">{view.status}</p>

  {#if active && !following}
    <div class="mt-3 flex flex-wrap gap-2">
      <button class={button} data-testid="read-aloud-back" on:click={() => dispatch('back')}
        >Back to the voice</button
      >
      <button class={button} data-testid="read-aloud-here" on:click={() => dispatch('here')}
        >Read from here</button
      >
    </div>
  {:else if active}
    <div class="mt-3">
      <button class={button} data-testid="read-aloud-here" on:click={() => dispatch('here')}
        >Read from the screen</button
      >
    </div>
  {/if}

  <h3 class="mt-4 mb-1 font-medium">Speed</h3>
  <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2">
    <button
      class={stepButton}
      aria-label="Slower"
      data-testid="read-aloud-slower"
      on:click={() => readAloudSpeed$.next(stepSpeed(speed, -1))}>−</button
    >
    <span class="text-center text-lg" data-testid="read-aloud-speed">{speedLabel(speed)}</span>
    <button
      class={stepButton}
      aria-label="Faster"
      data-testid="read-aloud-faster"
      on:click={() => readAloudSpeed$.next(stepSpeed(speed, 1))}>+</button
    >
  </div>

  <h3 class="mt-4 mb-1 font-medium">Voice</h3>
  {#if view.voice}
    <p data-testid="read-aloud-voice">
      {view.voice}
      <span class="text-sm"
        >({view.voiceFrom === 'book' ? "this book's TTS voice" : 'from Settings > Anki'})</span
      >
    </p>
  {:else}
    <p class="text-sm">
      The book's TTS voice, else the one in Settings > Anki (the same voice Enrich uses).
    </p>
  {/if}
  {#if api && bookId}
    {#if showVoice}
      <div class="mt-2" data-testid="read-aloud-voice-choice">
        <PcVoiceChoice
          {api}
          {bookId}
          testid="read-aloud-pc-voice"
          on:changed={() => dispatch('voiceChanged')}
        />
        <p class="mt-1 text-sm">A new voice is used from the next Play (or Read from here).</p>
      </div>
    {:else}
      <button
        class="{button} mt-2"
        data-testid="read-aloud-change-voice"
        on:click={() => (showVoice = true)}>Change this book's TTS voice</button
      >
    {/if}
  {:else if view.needsVoice}
    <p class="mt-2 text-sm">Choose a TTS voice in Settings > Anki.</p>
  {/if}

  {#if !highlightSupported}
    <p class="mt-4 text-sm" data-testid="read-aloud-no-highlight">
      This browser can't highlight the sentence (it has no CSS Custom Highlight API); the voice
      still reads.
    </p>
  {/if}

  <p class="mt-4 text-sm">
    Keys: V play or pause, "&lt;" and "&gt;" the previous or next sentence.
    {continuous ? 'The page scrolls with the voice' : 'Pages turn with the voice'}; turn or scroll
    yourself and it stops following until the sentence is back on the screen. More settings (read
    ahead, after a lookup, the bottom-bar button) are in Settings > Reader; how long the PC keeps
    the voice loaded is in Settings > Audiobooks.
  </p>
</section>
