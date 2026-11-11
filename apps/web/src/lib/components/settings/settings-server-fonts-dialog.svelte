<script lang="ts">
  /**
   * WP13: custom fonts on the server. Upload a font once from any device; every device
   * downloads it and keeps it for offline use. Which font a device uses stays its own
   * setting (the font pickers). Plain for e-ink: no transitions, 48 px controls, Esc
   * closes.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { inputClasses } from '$lib/css-classes';
  import { fontNameProblem, formatFontSize, isFontFileName } from '$lib/fonts/font-names';
  import { customFontNames$, fontApi, serverFonts } from '$lib/fonts/server-fonts-browser';
  import { FONT_KIND, type FontStatus, type ServerFontState } from '$lib/fonts/server-fonts';
  import { LibraryApiError } from '$lib/library/api';

  const dispatch = createEventDispatcher<{ close: void }>();

  const fonts$ = serverFonts.fonts$;

  /** null: still checking; false: not connected; 'off': the server takes no fonts. */
  let server: { maxBytes: number } | false | 'off' | null = null;
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
      server = info ? { maxBytes: info.maxBytes } : 'off';
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

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (confirmDelete) confirmDelete = null;
      else close();
    }
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

  const button =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium disabled:opacity-50';
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[36rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="server-fonts-dialog"
>
  <h2 class="weight-medium mb-3 text-xl">Custom Fonts</h2>
  <div class="min-h-0 overflow-y-auto">
    <p class="mb-3 text-sm">
      Add a font once; every device gets it and keeps it for reading offline. Each device chooses
      its own font in the font lists.
    </p>

    {#if $fonts$.length}
      <ul class="mb-4" data-testid="server-font-list">
        {#each $fonts$ as font (font.id)}
          <li
            class="flex items-center gap-3 border-t border-gray-400 py-2"
            data-testid="server-font"
          >
            <div class="min-w-0 flex-1">
              <!-- Shown in its own font once it is on this device. -->
              <div class="break-words font-medium" style:font-family={`'${font.name}', sans-serif`}>
                {font.name}
              </div>
              <div class="break-words text-sm">
                {font.fileName} · {formatFontSize(font.size)} ·
                <span data-testid="server-font-status">{statusText[font.status]}</span>
              </div>
            </div>
            {#if confirmDelete?.id === font.id}
              <div class="flex flex-col items-end gap-2">
                <span class="text-sm">Delete "{font.name}" from every device?</span>
                <div class="flex gap-2">
                  <button class={button} on:click={() => deleteFont(font)}>Delete</button>
                  <button class={button} on:click={() => (confirmDelete = null)}>Keep</button>
                </div>
              </div>
            {:else}
              <button class={button} on:click={() => (confirmDelete = font)}>Delete</button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mb-4">No custom fonts yet.</p>
    {/if}

    <h3 class="mb-2 font-medium">Add a font</h3>
    {#if server === null}
      <p>Checking the library server…</p>
    {:else if server === false}
      <p data-testid="server-fonts-not-connected">
        Connect to your library server (Settings > Library) to add fonts. Fonts already on this
        device keep working.
      </p>
    {:else if server === 'off'}
      <p>The library server doesn't take fonts. Update the server to add fonts.</p>
    {:else}
      <label class="mb-1 block" for="server-font-name">Name</label>
      <input
        id="server-font-name"
        type="text"
        class="{inputClasses} mb-3 w-full"
        bind:value={name}
        disabled={busy}
        maxlength="64"
        data-testid="server-font-name"
      />
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <label class="{button} cursor-pointer">
          <input
            type="file"
            class="hidden"
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            bind:this={fileInput}
            on:change={onFileChange}
            disabled={busy}
            data-testid="server-font-file"
          />
          Choose File
        </label>
        <span class="min-w-0 break-words text-sm"
          >{file ? file.name : 'woff2, woff, ttf or otf'}</span
        >
      </div>
      <div class="flex items-center gap-3">
        <button class={button} on:click={upload} disabled={busy} data-testid="server-font-upload">
          Upload
        </button>
        {#if busy}
          <button class={button} on:click={() => abort?.abort()}>Cancel</button>
          <span class="text-sm">{progress}</span>
        {/if}
      </div>
    {/if}

    {#if problem}
      <p class="mt-3 text-red-700" role="alert" data-testid="server-font-problem">{problem}</p>
    {/if}
    {#if notice}
      <p class="mt-3" role="status" data-testid="server-font-notice">{notice}</p>
    {/if}
  </div>
  <footer class="flex justify-end pt-5">
    <button class={button} on:click={close}>Close</button>
  </footer>
</section>
