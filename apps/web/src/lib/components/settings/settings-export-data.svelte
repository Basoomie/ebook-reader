<script lang="ts">
  /**
   * "Export my data" (WP18): one readable JSON file with everything synced for you,
   * downloaded from the library server. Writes nothing on this device. E-ink plain.
   */
  import { exportMyData, type ExportResult } from '$lib/export/export-my-data';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { fontApi } from '$lib/fonts/server-fonts-browser';
  import { formatFontSize } from '$lib/fonts/font-names';

  let busy = false;
  let result: ExportResult | null = null;

  async function run() {
    if (busy) return;
    busy = true;
    result = null;
    try {
      result = await exportMyData({ api: fontApi, save: (blob, name) => downloadBlob(blob, name) });
    } catch (error) {
      result = { ok: false, message: `Could not export: ${(error as Error)?.message ?? error}` };
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col items-start gap-2">
  <button
    class="min-h-[3rem] rounded-md border-2 border-gray-400 px-4 font-medium disabled:opacity-60"
    disabled={busy}
    data-testid="export-my-data"
    on:click={run}
  >
    {busy ? 'Preparing your data…' : 'Download my data'}
  </button>
  {#if result?.ok}
    <p data-testid="export-my-data-result">
      Saved {result.fileName} ({result.records} records, {formatFontSize(result.bytes)}).
    </p>
  {:else if result}
    <p data-testid="export-my-data-result">{result.message}</p>
  {/if}
</div>
