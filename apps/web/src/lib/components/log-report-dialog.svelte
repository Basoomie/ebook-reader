<script lang="ts">
  /**
   * Bug report (WP18): "Download report" saves one file with this device's report and the
   * server's recent log, tokens and pairing codes removed. Nothing is sent anywhere.
   */
  import DialogTemplate from '$lib/components/dialog-template.svelte';
  import Ripple from '$lib/components/ripple.svelte';
  import { buttonClasses } from '$lib/css-classes';
  import { collectBugReport } from '$lib/data/bug-report-browser';
  import { downloadBlob, localStamp } from '$lib/functions/download-blob';

  export let title = 'Error';

  export let message: string;

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

<DialogTemplate>
  <svelte:fragment slot="header">{title}</svelte:fragment>
  <svelte:fragment slot="content">
    <p>{message}</p>
    <p class="mt-4" data-testid="bug-report-about">
      The report has this device's log and the server's recent log. Tokens and pairing codes are
      removed. Nothing is sent anywhere; you choose who gets the file.
    </p>
    {#if notice}
      <p class="mt-4" data-testid="bug-report-notice">{notice}</p>
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <a
      class={buttonClasses}
      href="https://github.com/Basoomie/ebook-reader"
      target="_blank"
      rel="noreferrer"
    >
      Open Repository
      <Ripple />
    </a>
    <button
      class={buttonClasses}
      disabled={busy}
      data-testid="bug-report-download"
      on:click={download}
    >
      {busy ? 'Preparing…' : 'Download Report'}
      <Ripple />
    </button>
  </svelte:fragment>
</DialogTemplate>
