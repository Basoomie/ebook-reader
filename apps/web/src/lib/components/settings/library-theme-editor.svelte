<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * New or edit a library theme (2026-11-24): sections Start from, Colours (the 7 colours
   * you pick, with a preview of the pages in them), Name, and "Save theme" in the footer.
   * Copying a theme copies its exact shades; changing a colour works out again only the
   * shades made from it (library-themes.ts). Saving makes the theme this device's pick for
   * the row it was opened from; renaming moves the picks that named it. ✕, Esc or a click
   * outside cancel, asking first when something was changed (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import { libraryDarkTheme$, libraryLightTheme$, libraryThemes$ } from '$lib/library/settings';
  import {
    BASE_KEYS,
    BASE_LABELS,
    BUILT_IN_LIBRARY_THEMES,
    changeBase,
    copyTheme,
    isBuiltInLibraryTheme,
    libraryThemeName,
    normalizeTheme,
    pickedTheme,
    reservedNameError,
    themeKind,
    themeStyle,
    type BaseKey,
    type LibraryTheme
  } from '$lib/library-theme/library-themes';
  import { createEventDispatcher, onMount } from 'svelte';

  /** The theme of your own to edit; empty for a new one. */
  export let selected = '';
  /** The row it was opened from: a saved theme becomes this device's pick for it. */
  export let slot: 'light' | 'dark' = 'light';

  const dispatch = createEventDispatcher<{ close: void }>();
  const editing = !!selected && !isBuiltInLibraryTheme(selected) && !!$libraryThemes$[selected];

  $: sources = [
    ...Object.keys(BUILT_IN_LIBRARY_THEMES),
    ...Object.keys($libraryThemes$).filter((id) => !!normalizeTheme($libraryThemes$[id]))
  ];

  function sourceTheme(id: string): LibraryTheme {
    return copyTheme(
      BUILT_IN_LIBRARY_THEMES[id] ??
        normalizeTheme($libraryThemes$[id]) ??
        BUILT_IN_LIBRARY_THEMES[slot === 'dark' ? 'dark' : 'light']
    );
  }

  // A new theme starts as a copy of the row's current pick.
  const startId = editing
    ? selected
    : pickedTheme(slot === 'dark' ? $libraryDarkTheme$ : $libraryLightTheme$, slot, $libraryThemes$)
        .id;

  let theme: LibraryTheme = sourceTheme(startId);
  let themeToCopy = startId;
  let name = editing ? selected : '';
  let nameError = '';
  let saved = false;
  let initial = '';

  onMount(() => {
    initial = JSON.stringify([theme, name]);
  });

  $: dirty = !saved && !!initial && initial !== JSON.stringify([theme, name]);
  $: previewStyle = themeStyle(theme);
  $: kind = themeKind(theme);

  function setColour(key: BaseKey, ev: Event) {
    const value = (ev.target as HTMLInputElement).value;
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    theme = changeBase(theme, key, value.toLowerCase());
  }

  function handleCopy() {
    theme = sourceTheme(themeToCopy);
  }

  function handleSave() {
    const trimmed = name.trim();
    nameError = reservedNameError(trimmed);
    if (!nameError && trimmed !== selected && $libraryThemes$[trimmed]) {
      nameError = 'You already have a theme with this name.';
    }
    if (nameError) return;

    const next = { ...$libraryThemes$ };
    if (editing && selected !== trimmed) delete next[selected];
    next[trimmed] = copyTheme(theme);
    libraryThemes$.next(next);

    if (editing && selected !== trimmed) {
      if ($libraryLightTheme$ === selected) libraryLightTheme$.next(trimmed);
      if ($libraryDarkTheme$ === selected) libraryDarkTheme$.next(trimmed);
    }
    (slot === 'dark' ? libraryDarkTheme$ : libraryLightTheme$).next(trimmed);

    saved = true;
    dispatch('close');
  }
</script>

<Modal
  title={editing ? 'Edit library theme' : 'New library theme'}
  subtitle={editing ? selected : ''}
  size="md"
  {dirty}
  testid="library-theme-dialog"
  on:close={() => dispatch('close')}
>
  <ModalSection title="Start from" hint="Copy every colour of a theme, then change them below.">
    <div class="flex flex-wrap gap-2">
      <select
        class="c-input min-w-0 flex-1 pr-10"
        aria-label="Theme to copy"
        data-testid="library-theme-copy-from"
        bind:value={themeToCopy}
      >
        {#each sources as id (id)}
          <option value={id}>{libraryThemeName(id)}</option>
        {/each}
      </select>
      <button
        type="button"
        class="c-btn c-btn-secondary"
        data-testid="library-theme-copy"
        on:click={handleCopy}
      >
        Copy colours
      </button>
    </div>
  </ModalSection>

  <ModalSection
    title="Colours"
    hint="Shades such as lines, muted text and hover colours are worked out from these."
  >
    <div class="lt-grid">
      <div class="lt-rows">
        {#each BASE_KEYS as key (key)}
          <label class="lt-row">
            <span class="min-w-0">
              <span class="block text-sm">{BASE_LABELS[key].title}</span>
              <span class="block text-xs text-c-muted">{BASE_LABELS[key].hint}</span>
            </span>
            <input
              type="color"
              class="h-10 w-14 shrink-0 cursor-pointer rounded border border-c-strong bg-transparent p-0.5"
              data-testid="library-theme-colour-{key}"
              value={theme.base[key]}
              on:input={(ev) => setColour(key, ev)}
            />
          </label>
        {/each}
      </div>

      <div
        class="lt-preview"
        style={previewStyle}
        aria-label="Preview"
        role="img"
        data-testid="library-theme-preview"
      >
        <div class="lt-p-header">
          <span class="lt-p-brand">ッツ</span>
          <span class="lt-p-header-muted">Library</span>
        </div>
        <div class="lt-p-body">
          <div class="lt-p-card">
            <div class="lt-p-title">本のタイトル <span class="lt-p-seal">蔵</span></div>
            <div class="lt-p-muted">Author · 3 volumes</div>
            <div class="lt-p-link">See all</div>
            <div class="lt-p-track"><span class="lt-p-fill" /></div>
          </div>
          <div class="lt-p-buttons">
            <span class="lt-p-btn">Read</span>
            <span class="lt-p-sec">More</span>
            <span class="lt-p-on">Tag</span>
          </div>
        </div>
      </div>
    </div>
    <p class="mt-2 text-xs text-c-muted" data-testid="library-theme-kind">
      {kind === 'dark'
        ? 'A dark theme: shadows and native controls take the dark look.'
        : 'A light theme.'}
    </p>
  </ModalSection>

  <ModalSection title="Name" hint="Your library themes are shared with every device.">
    <input
      class="c-input w-full"
      type="text"
      aria-label="Theme name"
      placeholder="Theme name"
      data-testid="library-theme-name"
      bind:value={name}
      on:input={() => (nameError = '')}
    />
    {#if nameError}
      <p class="mt-1 text-sm text-c-seal" role="alert" data-testid="library-theme-name-error">
        {nameError}
      </p>
    {/if}
  </ModalSection>

  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      data-testid="library-theme-save"
      on:click={handleSave}
    >
      Save theme
    </button>
  </svelte:fragment>
</Modal>

<style>
  .lt-grid {
    display: grid;
    gap: 1rem;
  }

  @media (min-width: 640px) {
    .lt-grid {
      grid-template-columns: minmax(0, 1fr) 13rem;
      align-items: start;
    }
  }

  .lt-rows {
    display: grid;
    gap: 0.5rem;
  }

  .lt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  /* The preview uses the theme's own colours (inline --c-* variables). */
  .lt-preview {
    overflow: hidden;
    border-radius: 10px;
    border: 1px solid var(--c-line-strong);
    background-color: var(--c-bg);
    color: var(--c-ink);
    font-size: 0.8125rem;
  }

  .lt-p-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background-color: var(--c-header-bg);
    color: var(--c-header-ink);
    border-bottom: 1px solid var(--c-header-border);
  }

  .lt-p-brand {
    font-weight: 700;
  }

  .lt-p-header-muted {
    color: var(--c-header-muted);
  }

  .lt-p-body {
    display: grid;
    gap: 0.625rem;
    padding: 0.75rem;
  }

  .lt-p-card {
    display: grid;
    gap: 0.25rem;
    padding: 0.625rem;
    border-radius: 10px;
    background-color: var(--c-raised);
    border: 1px solid var(--c-line);
  }

  .lt-p-title {
    font-weight: 700;
  }

  .lt-p-seal {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 3px;
    background-color: var(--c-seal);
    color: #fff;
    font-size: 0.6875rem;
  }

  .lt-p-muted {
    color: var(--c-muted);
  }

  .lt-p-link {
    color: var(--c-link);
  }

  .lt-p-track {
    height: 0.375rem;
    border-radius: 999px;
    background-color: var(--c-track);
  }

  .lt-p-fill {
    display: block;
    width: 60%;
    height: 100%;
    border-radius: 999px;
    background-color: var(--c-fill);
  }

  .lt-p-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .lt-p-btn,
  .lt-p-sec,
  .lt-p-on {
    padding: 0.25rem 0.625rem;
    border-radius: 10px;
  }

  .lt-p-btn {
    background-color: var(--c-btn-bg);
    color: var(--c-btn-ink);
  }

  .lt-p-sec {
    background-color: var(--c-soft-bg);
    color: var(--c-sec-ink);
    border: 1px solid var(--c-soft-border);
  }

  .lt-p-on {
    background-color: var(--c-on-bg);
    color: var(--c-on-ink);
  }
</style>
