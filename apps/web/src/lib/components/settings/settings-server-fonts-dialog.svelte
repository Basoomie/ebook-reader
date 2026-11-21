<script lang="ts">
  /**
   * WP13: custom fonts on the server. Upload a font once from any device; every device
   * downloads it and keeps it for offline use. Which font a device uses stays its own
   * setting (the font pickers). Sections: Your fonts, From Google Fonts, Upload a font
   * file. ✕, Esc or a click outside close it, asking first when a name or file was chosen
   * (modal.svelte); closing stops an upload.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import {
    fontNameProblem,
    formatFontSize,
    isFontFileName,
    licenseName,
    weightsLabel
  } from '$lib/fonts/font-names';
  import SettingsGoogleFonts from '$lib/components/settings/settings-google-fonts.svelte';
  import { customFontNames$, fontApi, serverFonts } from '$lib/fonts/server-fonts-browser';
  import { FONT_KIND, type FontStatus, type ServerFontState } from '$lib/fonts/server-fonts';
  import { LibraryApiError } from '$lib/library/api';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import { deleteFontCopy } from '$lib/confirm/confirm-copy';

  const dispatch = createEventDispatcher<{ close: void }>();

  const fonts$ = serverFonts.fonts$;

  /** null: still checking; false: not connected; 'off': the server takes no fonts. */
  let server: { maxBytes: number; google: boolean } | false | 'off' | null = null;
  let name = '';
  let file: File | null = null;
  let fileInput: HTMLInputElement;
  let busy = false;
  let progress = '';
  let problem = '';
  let notice = '';
  let confirmDelete: ServerFontState | null = null;
  let abort: AbortController | null = null;

  const statusText: Record<FontStatus, string> = {
    saved: 'Saved on this device',
    queued: 'Downloading…',
    downloading: 'Downloading…',
    waiting: 'Not on this device yet',
    failed: 'Not on this device yet (will try again)'
  };

  onMount(async () => {
    try {
      const api = await fontApi();
      if (!api) {
        server = false;
        return;
      }
      const info = await api.fontInfo();
      server = info ? { maxBytes: info.maxBytes, google: info.google === true } : 'off';
      void serverFonts.retry();
    } catch (error) {
      server = false;
      problem = `Could not reach the library server: ${(error as Error)?.message ?? error}`;
    }
  });

  onDestroy(() => abort?.abort());

  function close() {
    if (busy) abort?.abort();
    dispatch('close');
  }

  /** A name from the file name, when it makes a valid one. */
  function suggestName(fileName: string): string {
    const base = fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^\p{L}\p{M}\p{N}_ -]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return fontNameProblem(base) ? '' : base;
  }

  function onFileChange(ev: Event) {
    problem = '';
    notice = '';
    const chosen = (ev.target as HTMLInputElement).files?.[0] ?? null;
    file = null;
    if (!chosen) return;
    if (!isFontFileName(chosen.name)) {
      problem = 'Choose a woff2, woff, ttf or otf file.';
      fileInput.value = '';
      return;
    }
    if (server && server !== 'off' && chosen.size > server.maxBytes) {
      problem = `The file is larger than the server takes (${formatFontSize(server.maxBytes)}).`;
      fileInput.value = '';
      return;
    }
    file = chosen;
    if (!name) name = suggestName(chosen.name);
  }

  /** The browser tries the file first: refuses files it can't draw text with. */
  async function canUseAsFont(blob: Blob): Promise<boolean> {
    if (typeof FontFace !== 'function') return true;
    try {
      const face = new FontFace(`ttu-font-check-${Date.now()}`, await blob.arrayBuffer());
      await face.load();
      return true;
    } catch {
      return false;
    }
  }

  async function syncSoon() {
    try {
      const { getSyncRunner } = await import('$lib/sync/sync-service');
      void getSyncRunner()?.syncNow();
    } catch {
      // The record reaches the server with the next sync.
    }
  }

  async function upload() {
    problem = '';
    notice = '';
    const trimmed = name.trim();
    const taken = $customFontNames$;
    const nameProblem = fontNameProblem(trimmed, taken);
    if (nameProblem) {
      problem = nameProblem;
      return;
    }
    if (!file) {
      problem = 'Choose a font file.';
      return;
    }
    const chosen = file;
    busy = true;
    progress = 'Checking the file…';
    try {
      if (!(await canUseAsFont(chosen))) {
        problem = "This file can't be used as a font.";
        return;
      }
      const api = await fontApi();
      if (!api) {
        server = false;
        return;
      }
      abort = new AbortController();
      progress = 'Uploading… 0%';
      const result = await api.uploadFont(chosen, trimmed, chosen.name, {
        signal: abort.signal,
        onProgress: (loaded, total) => {
          progress = `Uploading… ${total ? Math.floor((loaded / total) * 100) : 0}%`;
        }
      });
      if (result.existing) {
        notice = `This file is already on the server as "${result.font.name}".`;
      } else {
        await serverFonts.addUploaded(result.font.id, result.font, chosen);
        notice = `Added "${result.font.name}". Every device downloads it on its next sync. Choose it in the font lists.`;
      }
      name = '';
      file = null;
      fileInput.value = '';
      void syncSoon();
    } catch (error) {
      if (error instanceof LibraryApiError && error.kind === 'aborted') {
        problem = 'Upload cancelled.';
      } else {
        problem = (error as Error)?.message ?? String(error);
      }
    } finally {
      busy = false;
      progress = '';
      abort = null;
    }
  }

  async function deleteFont(font: ServerFontState) {
    confirmDelete = null;
    problem = '';
    notice = '';
    try {
      const { getSyncEngine } = await import('$lib/sync/sync-service');
      const engine = await getSyncEngine();
      if (!(await engine.remove(FONT_KIND, font.id))) throw new Error('could not save the change');
      notice = `Deleted "${font.name}". Other devices remove it on their next sync.`;
    } catch (error) {
      problem = `Could not delete "${font.name}": ${(error as Error)?.message ?? error}`;
    }
  }
</script>

<Modal
  title="Custom fonts"
  subtitle="Every device gets them and keeps them for reading offline."
  size="lg"
  dirty={!!(name.trim() || file)}
  testid="server-fonts-dialog"
  on:close={close}
>
  {#if problem || notice}
    <div class="sticky top-0 z-10 pt-3">
      {#if problem}
        <p class="c-notice c-modal-error !my-0" role="alert" data-testid="server-font-problem">
          <span aria-hidden="true">⚠</span>{problem}
        </p>
      {/if}
      {#if notice}
        <p class="c-notice !my-0" role="status" data-testid="server-font-notice">{notice}</p>
      {/if}
    </div>
  {/if}

  <ModalSection
    title="Your fonts"
    count={$fonts$.length}
    hint="Each device chooses its own font in the font lists."
  >
    {#if $fonts$.length}
      <PagedList
        items={$fonts$}
        pageSize={8}
        text={(f) => f.name}
        searchLabel="Search fonts"
        label="Fonts"
        let:rows
      >
        <ul data-testid="server-font-list">
          {#each rows as font (font.id)}
            {#if confirmDelete?.id === font.id}
              <li class="c-modal-row">
                <div class="w-full py-1">
                  <InlineConfirm
                    {...deleteFontCopy(font.name)}
                    testid="server-font-delete-confirm"
                    confirmTestid="server-font-delete-confirm-button"
                    on:confirm={() => deleteFont(font)}
                    on:cancel={() => (confirmDelete = null)}
                  />
                </div>
              </li>
            {:else}
              <li class="c-modal-row" data-testid="server-font">
                <div class="c-modal-row-main">
                  <!-- Shown in its own font once it is on this device. -->
                  <div
                    class="c-modal-row-title text-base"
                    style:font-family={`'${font.name}', sans-serif`}
                  >
                    {font.name}
                  </div>
                  {#if font.source === 'google'}
                    <div class="c-modal-row-meta" data-testid="server-font-google">
                      Google Fonts{licenseName(font.licenseUrl)
                        ? ` · ${licenseName(font.licenseUrl)}`
                        : ''} · {weightsLabel(font.weights)} · {formatFontSize(font.size)} ·
                      <span data-testid="server-font-status">{statusText[font.status]}</span>
                    </div>
                    {#if font.copyright}
                      <div class="c-modal-row-meta text-xs" data-testid="server-font-copyright">
                        {font.copyright}
                      </div>
                    {/if}
                  {:else}
                    <div class="c-modal-row-meta">
                      {font.fileName} · {formatFontSize(font.size)} ·
                      <span data-testid="server-font-status">{statusText[font.status]}</span>
                    </div>
                  {/if}
                </div>
                <div class="c-modal-row-actions">
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    data-testid="server-font-delete"
                    on:click={() => (confirmDelete = font)}
                  >
                    Delete…
                  </button>
                </div>
              </li>
            {/if}
          {/each}
        </ul>
      </PagedList>
    {:else}
      <p class="text-sm text-c-muted">No custom fonts yet.</p>
    {/if}
  </ModalSection>

  {#if server && server !== 'off' && server.google}
    <ModalSection
      title="From Google Fonts"
      hint="Free Japanese fonts. The library server downloads the one you choose, then every device gets it."
    >
      <SettingsGoogleFonts on:added={() => void syncSoon()} />
    </ModalSection>
  {/if}

  <ModalSection title="Upload a font file" hint="From this device. Every device gets it.">
    {#if server === null}
      <p class="text-sm text-c-muted">Checking the library server…</p>
    {:else if server === false}
      <p data-testid="server-fonts-not-connected">
        Connect to your library server (Settings > Library) to add fonts. Fonts already on this
        device keep working.
      </p>
    {:else if server === 'off'}
      <p>The library server doesn't take fonts. Update the server to add fonts.</p>
    {:else}
      <label class="c-modal-field" for="server-font-name">
        <span class="c-modal-label">Name</span>
        <input
          id="server-font-name"
          type="text"
          class="c-input w-full"
          placeholder="As it should appear in the font lists"
          bind:value={name}
          disabled={busy}
          maxlength="64"
          data-testid="server-font-name"
        />
      </label>
      <div class="c-modal-field">
        <span class="c-modal-label">File</span>
        <div class="flex flex-wrap items-center gap-3">
          <label class="c-btn c-btn-secondary cursor-pointer">
            <input
              type="file"
              class="hidden"
              accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
              bind:this={fileInput}
              on:change={onFileChange}
              disabled={busy}
              data-testid="server-font-file"
            />
            Choose file…
          </label>
          <span class="min-w-0 break-words text-sm text-c-muted"
            >{file ? file.name : 'woff2, woff, ttf or otf'}</span
          >
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="c-btn c-btn-primary"
          on:click={upload}
          disabled={busy}
          data-testid="server-font-upload"
        >
          Upload font
        </button>
        {#if busy}
          <button type="button" class="c-btn c-btn-ghost" on:click={() => abort?.abort()}>
            Stop upload
          </button>
          <span class="text-sm text-c-muted">{progress}</span>
        {/if}
      </div>
    {/if}
  </ModalSection>
</Modal>
