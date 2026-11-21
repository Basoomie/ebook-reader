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
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import { compareText, type ListSort } from '$lib/settings/paged-list';

  // Newest settings first (the order the list comes in), or by name.
  const deviceSorts: ListSort<DeviceSettings>[] = [
    { id: 'newest', label: 'Newest', compare: () => 0 },
    { id: 'name', label: 'Name', compare: (a, b) => compareText(deviceLabel(a), deviceLabel(b)) }
  ];

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
    <p class="text-sm text-c-muted">
      A device's latest changes are here only after it has synced (its Settings > Data shows 0
      changes waiting).
    </p>
    <div class="s-devices w-full">
      <PagedList
        items={devices}
        pageSize={6}
        text={deviceLabel}
        searchLabel="Search devices"
        sorts={deviceSorts}
        label="Devices"
        let:rows
      >
        <ul>
          {#each rows as device (device.deviceId)}
            <li class="s-item" data-testid="copy-device-settings-device">
              <div class="s-item-main">
                <span class="s-item-title block">{deviceLabel(device)}</span>
                <span class="s-item-meta block">settings saved {savedWhen(device)}</span>
              </div>
              <div class="s-item-actions">
                <button
                  class="c-btn c-btn-secondary c-btn-sm"
                  disabled={busy}
                  data-testid="copy-device-settings-copy"
                  on:click={() => {
                    message = '';
                    confirming = device;
                  }}
                >
                  Copy…
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </PagedList>
    </div>
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

<style>
  .s-devices {
    border: var(--c-border-width) solid var(--c-line);
    border-radius: 0.375rem;
    overflow: hidden;
  }
</style>
