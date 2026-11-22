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
    ankiAutoEnrich$,
    ankiAutoEnrichSeconds$,
    ankiConnectKey$,
    ankiConnectTimeoutSeconds$,
    ankiConnectUrl$,
    ankiFieldMapping$,
    ankiLookBackDays$,
    ankiNoticeSeconds$,
    ankiTagPrefix$
  } from '$lib/anki/settings';
  import PcSentenceAudioSection from './pc-sentence-audio-section.svelte';
  import PendingClipsSection from './pending-clips-section.svelte';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';

  /**
   * WP14: Settings > Anki (its own tab since 2026-11-12), in sections: the connection to
   * AnkiConnect (this device), enriching cards and sentence audio (the same on every device,
   * tagged), the fields of each note type, the reader's Anki button, and the sentence audio
   * still waiting to be added.
   */

  const fieldClasses = 'c-input block w-full sm:w-72';
  const selectClasses = 'c-input block min-h-[3rem] w-full';
  const MODE_LABELS: Record<FieldMode, string> = {
    'fill-if-empty': 'Fill if empty',
    append: 'Add to the end',
    overwrite: 'Overwrite'
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

<p class="s-anki-intro" data-testid="anki-settings">
  <strong>Enrich last Anki card</strong> adds to the note you added to Anki most recently: the
  book's title as a tag and, in the fields chosen under Card fields, the card's sentence (the one in
  its Sentence field, or the text you select after making the card), its audio (from the linked
  audiobook's subtitles, or for a book without one read by the PC when a TTS voice is chosen under
  Sentence audio read by TTS), the cover and a link back to the passage. The card's own sentence is
  never replaced unless you select text. In a book: the Anki button in the menu at the top, the
  bottom bar button, or <kbd>E</kbd>.
</p>

<SettingsGroup id="anki-connection">
  <SettingRow id="anki-url" let:labelId>
    <p slot="description" class="mt-1 max-w-prose text-sm text-c-muted">
      Anki on this device: http://127.0.0.1:8765. Another device's Anki works too if AnkiConnect
      listens on the network. AnkiConnect's <code>webCorsOriginList</code> must include this
      reader's address ({origin}).
    </p>
    <input
      class={fieldClasses}
      type="url"
      inputmode="url"
      spellcheck="false"
      aria-labelledby={labelId}
      data-testid="anki-url"
      bind:value={$ankiConnectUrl$}
    />
  </SettingRow>
  <SettingRow id="anki-key" let:labelId>
    <input
      class={fieldClasses}
      type="password"
      autocomplete="off"
      aria-labelledby={labelId}
      data-testid="anki-key"
      bind:value={$ankiConnectKey$}
    />
  </SettingRow>
  <SettingRow id="anki-timeout" settingKey="ankiConnectTimeoutSeconds" let:labelId>
    <SettingField unit="seconds">
      <input
        type="number"
        min="1"
        step="1"
        aria-labelledby={labelId}
        data-testid="anki-timeout"
        bind:value={$ankiConnectTimeoutSeconds$}
      />
    </SettingField>
  </SettingRow>
  <SettingRow id="anki-check" layout="inline">
    <svelte:fragment slot="description">
      {#if status}
        <p
          class="mt-1 max-w-prose text-sm"
          class:font-bold={statusIsError}
          role="status"
          data-testid="anki-status"
        >
          {status}
        </p>
      {/if}
    </svelte:fragment>
    <button
      class="c-btn c-btn-secondary"
      data-testid="anki-check"
      disabled={checking}
      on:click={check}
    >
      {checking ? 'Connecting…' : 'Connect'}
    </button>
  </SettingRow>
</SettingsGroup>

<SettingsGroup id="anki-enrich">
  <SettingRow id="anki-auto-enrich" layout="inline" settingKey="ankiAutoEnrich" let:labelId>
    <SettingSwitch bind:checked={$ankiAutoEnrich$} labelledby={labelId} testid="anki-auto-enrich" />
  </SettingRow>
  {#if $ankiAutoEnrich$}
    <SettingRow id="anki-auto-enrich-seconds" child let:labelId>
      <SettingField unit="seconds">
        <input
          type="number"
          min="1"
          step="1"
          aria-labelledby={labelId}
          data-testid="anki-auto-enrich-seconds"
          bind:value={$ankiAutoEnrichSeconds$}
        />
      </SettingField>
    </SettingRow>
  {/if}
  <SettingRow id="anki-days" settingKey="ankiLookBackDays" let:labelId>
    <SettingField unit="days">
      <input
        type="number"
        min="1"
        step="1"
        aria-labelledby={labelId}
        data-testid="anki-days"
        bind:value={$ankiLookBackDays$}
      />
    </SettingField>
  </SettingRow>
  <SettingRow id="anki-tag-prefix" settingKey="ankiTagPrefix" let:labelId>
    <input
      class={fieldClasses}
      type="text"
      spellcheck="false"
      aria-labelledby={labelId}
      data-testid="anki-tag-prefix"
      bind:value={$ankiTagPrefix$}
    />
  </SettingRow>
</SettingsGroup>

<SettingsGroup id="anki-audio">
  <SettingRow id="anki-audio-max" settingKey="ankiAudioMaxSeconds" let:labelId>
    <SettingField unit="seconds">
      <input
        type="number"
        min="1"
        step="1"
        aria-labelledby={labelId}
        data-testid="anki-audio-max"
        bind:value={$ankiAudioMaxSeconds$}
      />
    </SettingField>
  </SettingRow>
  <SettingRow id="anki-audio-threshold" settingKey="ankiAudioMatchThreshold" let:labelId>
    <SettingField unit="0–1">
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        aria-labelledby={labelId}
        data-testid="anki-audio-threshold"
        bind:value={$ankiAudioMatchThreshold$}
      />
    </SettingField>
  </SettingRow>
  <PcSentenceAudioSection />
</SettingsGroup>

<SettingsGroup id="anki-fields">
  {#if !knownTypes.length}
    <p class="px-5 py-4">Connect to Anki under Connection to choose a note type.</p>
  {:else}
    <SettingRow id="anki-note-type" let:labelId>
      <svelte:fragment slot="description">
        <p class="mt-1 text-sm text-c-muted">✓ marks note types already set up.</p>
        {#if noteType && !noteTypes.includes(noteType)}
          <p class="mt-1 text-sm text-c-muted">
            Anki on this device doesn't have this note type (or isn't connected); its fields are
            kept.
          </p>
        {/if}
        {#if loadingFields}
          <p class="mt-1 text-sm">Loading fields…</p>
        {/if}
      </svelte:fragment>
      <select
        class="{selectClasses} sm:w-72"
        aria-labelledby={labelId}
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
    </SettingRow>
    {#if noteType}
      <div data-testid="anki-roles">
        {#each ENRICH_ROLES as role (role)}
          <fieldset class="s-anki-role" data-testid="anki-role-{role}">
            <legend class="sr-only">{ROLE_LABELS[role]}</legend>
            <span class="font-semibold" aria-hidden="true">{ROLE_LABELS[role]}</span>
            <label class="grid gap-1 text-sm text-c-muted">
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
            <label class="grid gap-1 text-sm text-c-muted">
              When the field has something already
              {#if current[role]}
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
              {:else}
                <span class="flex min-h-[3rem] items-center text-c-muted">Choose a field first</span
                >
              {/if}
            </label>
          </fieldset>
        {/each}
      </div>
      <p class="px-4 py-3 text-sm text-c-muted sm:px-5">
        The link field gets only the book and place, such as <code>/open?book=…&amp;pos=…</code>.
        Add the reader's address in the card template, for example
        <code
          >&lt;a href="{origin}{'{{'}text:ReaderLink{'}}'}"&gt;Open in ッツ Reader&lt;/a&gt;</code
        >.
      </p>
    {/if}
  {/if}
</SettingsGroup>

<SettingsGroup id="anki-reader">
  <SettingRow id="anki-notice-seconds" settingKey="ankiNoticeSeconds" let:labelId>
    <SettingField unit="seconds">
      <input
        type="number"
        min="0"
        step="1"
        aria-labelledby={labelId}
        data-testid="anki-notice-seconds"
        bind:value={$ankiNoticeSeconds$}
      />
    </SettingField>
  </SettingRow>
</SettingsGroup>

<PendingClipsSection />

<style>
  .s-anki-intro {
    padding: 0.75rem 1rem;
    border: var(--c-border-width) solid var(--c-line);
    border-left: 3px solid var(--c-gold);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    font-size: 0.875rem;
  }

  .s-anki-role {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem 1rem;
    align-items: end;
    padding: 0.875rem 1rem;
  }

  .s-anki-role + .s-anki-role {
    border-top: 1px solid var(--c-line);
  }

  @media (min-width: 640px) {
    .s-anki-role {
      grid-template-columns: 9rem minmax(0, 1fr) minmax(0, 1fr);
      padding: 0.875rem 1.25rem;
    }

    .s-anki-role > span {
      align-self: center;
    }
  }
</style>
