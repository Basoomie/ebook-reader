<script lang="ts">
  /**
   * Settings > Data, "Copy settings from another device" (Season 2 §2): one tap brings over
   * all of another device's own settings, including whispersync's, from what that device
   * last synced (the local mirror, so it works offline). Not the AnkiConnect keys, which
   * never leave a device; shared settings are the same everywhere already. Pull only.
   * The reader's Aa panel keeps its own look-only copy (WP10e). E-ink plain.
   */
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import { copyAllSettingsCopy } from '$lib/confirm/confirm-copy';
  import { availableFontNames } from '$lib/data/fonts';
  import { customFontNames$ } from '$lib/fonts/server-fonts-browser';
  import { planSettingsCopy, type DeviceSettings } from '$lib/sync/copy-device-settings';
  import { formatWhen } from '$lib/sync/position-prompt';

  let devices: DeviceSettings[] | undefined;
  let loading = false;
  let busy = false;
  let confirming: DeviceSettings | undefined;
  let message = '';

  async function loadDevices() {
    loading = true;
    message = '';
    try {
      const { listOtherDevicesSettings } = await import('$lib/sync/sync-service');
      devices = await listOtherDevicesSettings();
    } catch {
      devices = [];
    } finally {
      loading = false;
    }
  }

  function deviceLabel(device: DeviceSettings) {
    return device.name ?? 'Another device';
  }

  function savedWhen(device: DeviceSettings) {
    return formatWhen(device.updatedAt, Date.now());
  }

  async function copyFrom(device: DeviceSettings) {
    if (busy) return;
    busy = true;
    try {
      const { applyDeviceSettings } = await import('$lib/sync/apply-device-settings');
      const plan = planSettingsCopy(device.values, availableFontNames($customFontNames$));
      const changed = applyDeviceSettings(plan.apply);
      message = changed.length
        ? `Copied ${changed.length === 1 ? '1 setting' : `${changed.length} settings`} from ${deviceLabel(device)}. Enter the AnkiConnect key again in Settings > Anki.`
        : `${deviceLabel(device)}'s settings are already the same here.`;
      if (plan.missingFonts.length) {
        message += ` Kept your font: ${plan.missingFonts.join(', ')} is not on this device.`;
      }
    } catch (error) {
      message = `Could not copy: ${(error as Error)?.message ?? error}`;
    } finally {
      busy = false;
      confirming = undefined;
    }
  }
</script>

<div class="flex flex-col items-start gap-2" data-testid="copy-device-settings">
  {#if !devices}
    <button
      class="c-btn c-btn-secondary"
      disabled={loading}
      data-testid="copy-device-settings-list"
      on:click={loadDevices}
    >
      {loading ? 'Looking…' : 'Choose a device'}
    </button>
  {:else if !devices.length}
    <p data-testid="copy-device-settings-none">No other device has synced its settings yet.</p>
  {:else}
    <p class="text-sm">
      A device's latest changes are here only after it has synced (its Settings > Data shows 0
      changes waiting).
    </p>
    <ul class="w-full">
      {#each devices as device (device.deviceId)}
        <li
          class="flex items-center justify-between gap-2 border-t border-current py-2"
          data-testid="copy-device-settings-device"
        >
          <span>
            <span class="block font-medium">{deviceLabel(device)}</span>
            <span class="block text-sm">settings saved {savedWhen(device)}</span>
          </span>
          <button
            class="c-btn c-btn-secondary"
            disabled={busy}
            data-testid="copy-device-settings-copy"
            on:click={() => {
              message = '';
              confirming = device;
            }}
          >
            Copy
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if confirming}
    <div class="w-full">
      <InlineConfirm
        {...copyAllSettingsCopy(deviceLabel(confirming), savedWhen(confirming))}
        {busy}
        testid="copy-device-settings-confirm"
        confirmTestid="copy-device-settings-confirm-button"
        on:confirm={() => confirming && copyFrom(confirming)}
        on:cancel={() => (confirming = undefined)}
      />
    </div>
  {/if}
  {#if message}
    <p role="status" data-testid="copy-device-settings-message">{message}</p>
  {/if}
</div>
