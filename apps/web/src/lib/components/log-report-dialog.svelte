<script lang="ts">
  /**
   * Bug report (WP18): "Download report" saves one file with this device's report and the
   * server's recent log, tokens and pairing codes removed. Nothing is sent anywhere.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { collectBugReport } from '$lib/data/bug-report-browser';
  import { downloadBlob, localStamp } from '$lib/functions/download-blob';
  import { createEventDispatcher } from 'svelte';

  export let title = 'Error';

  export let message: string;

  const dispatch = createEventDispatcher<{ close: void }>();

  let busy = false;
  let notice = '';

  async function download() {
    if (busy) return;
    busy = true;
    notice = '';
    try {
      const report = await collectBugReport(title, message);
      const fileName = `ttsu-bug-report-${localStamp(new Date(), true)}.json`;
      downloadBlob(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
        fileName
      );
      const server = report.server as { included?: boolean; reason?: string } | undefined;
      notice = server?.included
        ? `Saved ${fileName}.`
        : `Saved ${fileName}, without the server's log: ${server?.reason ?? 'not available'}.`;
    } catch (error) {
      notice = `Could not make the report: ${(error as Error)?.message ?? error}`;
    } finally {
      busy = false;
    }
  }
</script>

<Modal {title} size="md" testid="bug-report-dialog" on:close={() => dispatch('close')}>
  <div class="space-y-3 pt-3">
    {#if message}
      <p class="whitespace-pre-line [overflow-wrap:anywhere]">{message}</p>
    {/if}
    <p class="text-sm text-c-muted" data-testid="bug-report-about">
      The report has this device's log and the server's recent log. Tokens and pairing codes are
      removed. Nothing is sent anywhere; you choose who gets the file.
    </p>
  </div>
  <svelte:fragment slot="status">
    {#if notice}<span data-testid="bug-report-notice">{notice}</span>{/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <a
      class="c-btn c-btn-secondary"
      href="https://github.com/Basoomie/ebook-reader"
      target="_blank"
      rel="noreferrer"
    >
      Open repository
    </a>
    <button
      type="button"
      class="c-btn c-btn-primary"
      disabled={busy}
      data-testid="bug-report-download"
      on:click={download}
    >
      {busy ? 'Preparing…' : 'Download report'}
    </button>
  </svelte:fragment>
</Modal>
