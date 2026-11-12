<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { AnkiConnect } from '$lib/anki/anki-connect';
  import { FIELD_MODES, type FieldMode } from '$lib/anki/field-merge';
  import {
    ENRICH_ROLES,
    parseMapping,
    ROLE_LABELS,
    withTarget,
    type EnrichRole
  } from '$lib/anki/mapping';
  import {
    ankiAudioMatchThreshold$,
    ankiAudioMaxSeconds$,
    ankiBottomBarButton$,
    ankiConnectKey$,
    ankiConnectTimeoutSeconds$,
    ankiConnectUrl$,
    ankiFieldMapping$,
    ankiLookBackDays$,
    ankiTagPrefix$
  } from '$lib/anki/settings';

  /**
   * WP14: Settings > Reader > Anki. AnkiConnect on this device, and (the same on every
   * device) which fields of each note type "Enrich last card" fills.
   */

  const fieldClasses = 'c-input mt-1 block w-full max-w-[18rem] text-base';
  const selectClasses = 'c-input mt-1 block min-h-[3rem] w-full max-w-[18rem] text-base';
  const MODE_LABELS: Record<FieldMode, string> = {
    'fill-if-empty': 'Fill if empty',
    append: 'Add to the end'
  };

  const origin = typeof location === 'undefined' ? '' : location.origin;

  let noteTypes: string[] = [];
  let fields: string[] = [];
  let noteType = '';
  let status = '';
  let statusIsError = false;
  let checking = false;
  let loadingFields = false;

  $: mapping = parseMapping($ankiFieldMapping$);
  $: knownTypes = [...new Set([...noteTypes, ...Object.keys(mapping)])].sort((a, b) =>
    a.localeCompare(b)
  );
  // Start on a note type that has fields set up (also before Anki is connected).
  $: if (!noteType && knownTypes.length) {
    noteType = knownTypes.find((t) => Object.keys(mapping[t] ?? {}).length) ?? knownTypes[0];
  }
  $: current = mapping[noteType] ?? {};
  // Fields this device can't see (Anki closed) still show, so nothing is lost.
  $: fieldChoices = [
    ...new Set([
      ...fields,
      ...Object.values(current)
        .map((t) => t?.field)
        .filter((f): f is string => !!f)
    ])
  ];

  function client() {
    return new AnkiConnect({
      url: $ankiConnectUrl$,
      key: $ankiConnectKey$,
      timeoutSeconds: Number($ankiConnectTimeoutSeconds$) || 10
    });
  }

  async function check() {
    checking = true;
    status = '';
    try {
      const anki = client();
      noteTypes = await anki.noteTypes();
      status = `Connected${anki.isAndroid ? ' (AnkiConnect Android)' : ''}: ${noteTypes.length} note types.`;
      statusIsError = false;
      if (!noteType && noteTypes.length) {
        noteType = Object.keys(mapping).find((t) => noteTypes.includes(t)) ?? noteTypes[0];
      }
      await loadFields();
    } catch (error) {
      status = (error as Error)?.message ?? String(error);
      statusIsError = true;
    } finally {
      checking = false;
    }
  }

  async function loadFields() {
    fields = [];
    if (!noteType || !noteTypes.includes(noteType)) return;
    loadingFields = true;
    try {
      fields = await client().fieldNames(noteType);
    } catch (error) {
      status = (error as Error)?.message ?? String(error);
      statusIsError = true;
    } finally {
      loadingFields = false;
    }
  }

  function setField(role: EnrichRole, field: string) {
    const mode = current[role]?.mode ?? 'fill-if-empty';
    ankiFieldMapping$.next(withTarget(mapping, noteType, role, field ? { field, mode } : null));
  }

  function setMode(role: EnrichRole, mode: FieldMode) {
    const target = current[role];
    if (!target) return;
    ankiFieldMapping$.next(withTarget(mapping, noteType, role, { ...target, mode }));
  }

  function onField(role: EnrichRole, event: Event) {
    setField(role, (event.currentTarget as HTMLSelectElement).value);
  }

  function onMode(role: EnrichRole, event: Event) {
    setMode(role, (event.currentTarget as HTMLSelectElement).value as FieldMode);
  }
</script>

<div class="c-tile rounded-lg p-4 sm:px-7 sm:py-6" data-testid="anki-settings">
  <p class="mb-4 max-w-prose">
    <strong>Enrich last Anki card</strong> adds to the note you added to Anki most recently: the
    book's title as a tag, and, in the fields chosen below, the sentence of your last dictionary
    lookup (or the selected text), its audio when the book has a linked audiobook with subtitles,
    the cover and a link back to the passage. A field is filled only if it is empty, or added to at
    the end; it is never overwritten. In a book: the Anki button in the menu at the top, the bottom
    bar button, or <kbd>E</kbd>.
  </p>

  <div class="grid grid-cols-1 gap-y-6 lg:grid-cols-2 lg:gap-x-12">
    <div>
      <h3 class="font-mincho text-lg font-bold">This device</h3>
      <label class="mt-2 block text-sm text-c-muted">
        AnkiConnect address
        <input
          class={fieldClasses}
          type="url"
          inputmode="url"
          spellcheck="false"
          data-testid="anki-url"
          bind:value={$ankiConnectUrl$}
        />
      </label>
      <p class="mt-1 max-w-prose text-sm text-c-muted">
        Anki on this device: http://127.0.0.1:8765. Another device's Anki works too if AnkiConnect
        listens on the network. AnkiConnect's <code>webCorsOriginList</code> must include this
        reader's address ({origin}).
      </p>
      <label class="mt-4 block text-sm text-c-muted">
        AnkiConnect key (only if AnkiConnect asks for one; stays on this device)
        <input
          class={fieldClasses}
          type="password"
          autocomplete="off"
          data-testid="anki-key"
          bind:value={$ankiConnectKey$}
        />
      </label>
      <label class="mt-4 block text-sm text-c-muted">
        Wait for Anki (seconds)
        <input
          class={fieldClasses}
          type="number"
          min="1"
          step="1"
          data-testid="anki-timeout"
          bind:value={$ankiConnectTimeoutSeconds$}
        />
      </label>
      <label class="mt-4 flex min-h-[3rem] items-center gap-3">
        <input
          type="checkbox"
          class="h-6 w-6"
          data-testid="anki-bottom-bar"
          bind:checked={$ankiBottomBarButton$}
        />
        <span>Anki button in the reader's bottom bar</span>
      </label>
      <button
        class="c-btn c-btn-secondary mt-4 min-h-[3rem]"
        data-testid="anki-check"
        disabled={checking}
        on:click={check}
      >
        {checking ? 'Connecting…' : 'Connect to Anki'}
      </button>
      {#if status}
        <p
          class="mt-2 max-w-prose"
          class:font-bold={statusIsError}
          role="status"
          data-testid="anki-status"
        >
          {status}
        </p>
      {/if}
    </div>

    <div class="border-c-line border-t pt-6 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
      <h3 class="font-mincho text-lg font-bold">Every device</h3>
      <label class="mt-2 block text-sm text-c-muted">
        Enrich the newest note added in the last … days
        <input
          class={fieldClasses}
          type="number"
          min="1"
          step="1"
          data-testid="anki-days"
          bind:value={$ankiLookBackDays$}
        />
      </label>
      <label class="mt-4 block text-sm text-c-muted">
        Before the title tag (e.g. book::, empty for the title alone)
        <input
          class={fieldClasses}
          type="text"
          spellcheck="false"
          data-testid="anki-tag-prefix"
          bind:value={$ankiTagPrefix$}
        />
      </label>
      <label class="mt-4 block text-sm text-c-muted">
        Longest sentence audio (seconds)
        <input
          class={fieldClasses}
          type="number"
          min="1"
          step="1"
          data-testid="anki-audio-max"
          bind:value={$ankiAudioMaxSeconds$}
        />
      </label>
      <label class="mt-4 block text-sm text-c-muted">
        How close subtitle lines must be when the sentence isn't in them word for word (0-1)
        <input
          class={fieldClasses}
          type="number"
          min="0"
          max="1"
          step="0.05"
          data-testid="anki-audio-threshold"
          bind:value={$ankiAudioMatchThreshold$}
        />
      </label>
    </div>
  </div>

  <h3 class="mt-8 font-mincho text-lg font-bold">Fields per note type (every device)</h3>
  {#if !knownTypes.length}
    <p class="mt-2 max-w-prose">Connect to Anki above to choose a note type.</p>
  {:else}
    <label class="mt-2 block text-sm text-c-muted">
      Note type
      <select
        class={selectClasses}
        data-testid="anki-note-type"
        bind:value={noteType}
        on:change={loadFields}
      >
        {#each knownTypes as type (type)}
          <option value={type}>
            {type}{Object.keys(mapping[type] ?? {}).length ? ' ✓' : ''}
          </option>
        {/each}
      </select>
    </label>
    {#if noteType}
      {#if !noteTypes.includes(noteType)}
        <p class="mt-2 max-w-prose text-sm text-c-muted">
          Anki on this device doesn't have this note type (or isn't connected); its fields are kept.
        </p>
      {/if}
      {#if loadingFields}
        <p class="mt-2">Loading fields…</p>
      {/if}
      <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="anki-roles">
        {#each ENRICH_ROLES as role (role)}
          <fieldset class="rounded border border-c-line p-3" data-testid="anki-role-{role}">
            <legend class="px-1 font-bold">{ROLE_LABELS[role]}</legend>
            <label class="block text-sm text-c-muted">
              Field
              <select
                class={selectClasses}
                data-testid="anki-field-{role}"
                value={current[role]?.field ?? ''}
                on:change={(e) => onField(role, e)}
              >
                <option value="">Not used</option>
                {#each fieldChoices as field (field)}
                  <option value={field}>{field}</option>
                {/each}
              </select>
            </label>
            {#if current[role]}
              <label class="mt-2 block text-sm text-c-muted">
                When the field has something already
                <select
                  class={selectClasses}
                  data-testid="anki-mode-{role}"
                  value={current[role]?.mode ?? 'fill-if-empty'}
                  on:change={(e) => onMode(role, e)}
                >
                  {#each FIELD_MODES as mode (mode)}
                    <option value={mode}>{MODE_LABELS[mode]}</option>
                  {/each}
                </select>
              </label>
            {/if}
          </fieldset>
        {/each}
      </div>
      <p class="mt-4 max-w-prose text-sm text-c-muted">
        The link field gets only the book and place, such as <code>/open?book=…&amp;pos=…</code>.
        Add the reader's address in the card template, for example
        <code
          >&lt;a href="{origin}{'{{'}text:ReaderLink{'}}'}"&gt;Open in ッツ Reader&lt;/a&gt;</code
        >.
      </p>
    {/if}
  {/if}
</div>
