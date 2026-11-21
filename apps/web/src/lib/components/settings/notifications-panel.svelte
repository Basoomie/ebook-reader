<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > Notifications (N1, notifications-design.md): the server sends, so everything
   * here is stored on the server. Channels (Discord webhook, Gmail with an app password;
   * secrets can only be written), Send test, the daily digest time, the link address,
   * finished jobs (Now / Digest / Off), the wait times, and per section a switch for the
   * whole section plus a switch per event and set-up channel. A channel's column shows only
   * once it is set up. Each change is saved at once. N2 adds the Stats section (daily,
   * weekly and monthly stats messages, off by default) with its "no reading" choice and,
   * per message, whether it compares with the previous period.
   */
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeNotificationSecretCopy } from '$lib/confirm/confirm-copy';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import {
    NotificationsApi,
    type NotificationChannel,
    type NotificationSecretName,
    type NotificationsView,
    type SettingsPatch,
    type StatsReportKind
  } from '$lib/notifications/notifications-api';
  import {
    CHANNEL_NAMES,
    describeError,
    secretStateText,
    WAIT_FIELDS
  } from '$lib/notifications/notifications-text';
  import { onMount } from 'svelte';

  let connection: LibraryConnection | null | undefined;
  let api: NotificationsApi | undefined;
  let view: NotificationsView | null = null;
  let loadError = '';
  let saveError = '';
  let saving = false;
  let savedAt = 0;

  // Write-only fields: never filled from the server.
  let webhook = '';
  let appPassword = '';
  // Plain fields, edited here and saved on change.
  let emailFrom = '';
  let emailTo = '';
  let linkBase = '';
  let digestTime = '';
  let digestZone = '';

  let testState: Record<NotificationChannel, { busy: boolean; text: string; ok: boolean }> = {
    discord: { busy: false, text: '', ok: false },
    email: { busy: false, text: '', ok: false }
  };

  const deviceZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();
  const allZones: string[] = (() => {
    try {
      const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
        .supportedValuesOf;
      return fn ? fn('timeZone') : [];
    } catch {
      return [];
    }
  })();

  // "This device's" is offered first when it differs from the server's; the full list (when
  // the browser has one) follows, plus the saved zone if the list lacks it.
  $: showDeviceZone = !!deviceZone && !!view && deviceZone !== view.serverTimeZone;
  $: zoneList = (() => {
    const list = allZones.filter((z) => !(showDeviceZone && z === deviceZone));
    if (
      digestZone &&
      !list.includes(digestZone) &&
      !(showDeviceZone && digestZone === deviceZone)
    ) {
      list.unshift(digestZone);
    }
    return list;
  })();

  $: channels = view
    ? (['discord', 'email'] as NotificationChannel[]).filter((c) => view?.channels[c])
    : [];

  function adopt(v: NotificationsView) {
    view = v;
    emailFrom = v.settings.email.from;
    emailTo = v.settings.email.to;
    linkBase = v.settings.linkBase;
    digestTime = v.settings.digest.time;
    digestZone = v.settings.digest.timeZone ?? '';
  }

  onMount(async () => {
    try {
      connection = (await getLibraryStore().getConnection()) ?? null;
      if (!connection) return;
      const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
      api = new NotificationsApi(connection.serverUrl, connection.token, timeout);
      adopt(await api.get());
    } catch (err) {
      loadError = describeError(err);
    }
  });

  async function save(patch: SettingsPatch) {
    if (!api) return;
    saving = true;
    saveError = '';
    try {
      adopt(await api.update(patch));
      savedAt = Date.now();
    } catch (err) {
      saveError = describeError(err);
      // Show what the server has, not what was typed.
      try {
        adopt(await api.get());
      } catch {
        // keep the last view
      }
    } finally {
      saving = false;
    }
  }

  async function saveSecret(name: NotificationSecretName, value: string) {
    if (!api || !value.trim()) return;
    saving = true;
    saveError = '';
    try {
      adopt(await api.putSecret(name, value.trim()));
      if (name === 'discordWebhookUrl') webhook = '';
      else appPassword = '';
      savedAt = Date.now();
    } catch (err) {
      saveError = describeError(err);
    } finally {
      saving = false;
    }
  }

  async function removeSecret(name: NotificationSecretName, label: string) {
    if (!api) return;
    if (!(await confirmDestructive(removeNotificationSecretCopy(label)))) return;
    try {
      adopt(await api.removeSecret(name));
    } catch (err) {
      saveError = describeError(err);
    }
  }

  // The app compiles with `immutable: true`: a changed object must be a new object to show.
  function setTest(channel: NotificationChannel, state: (typeof testState)[NotificationChannel]) {
    testState = { ...testState, [channel]: state };
  }

  async function sendTest(channel: NotificationChannel) {
    if (!api) return;
    setTest(channel, { busy: true, text: 'Sending…', ok: false });
    try {
      const r = await api.test(channel);
      setTest(channel, {
        busy: false,
        ok: r.ok,
        text: r.ok ? 'Sent. Check that it arrived.' : `Not sent: ${r.error ?? 'unknown error'}`
      });
    } catch (err) {
      setTest(channel, { busy: false, ok: false, text: describeError(err) });
    }
  }

  async function setWait(key: (typeof WAIT_FIELDS)[number]['key'], input: HTMLInputElement) {
    const n = Number(input.value);
    if (Number.isInteger(n)) await save({ waits: { [key]: n } });
    // A refused value leaves the saved one unchanged, so nothing redraws the field: show it.
    if (view) input.value = String(view.settings.waits[key]);
  }

  function setFinished(value: string) {
    if (value === 'now' || value === 'digest' || value === 'off')
      void save({ finishedJobs: value });
  }

  function setNoReading(value: string) {
    if (value === 'skip' || value === 'send') void save({ stats: { noReading: value } });
  }

  const COMPARE_KINDS: { kind: StatsReportKind; label: string }[] = [
    { kind: 'day', label: 'Daily' },
    { kind: 'week', label: 'Weekly' },
    { kind: 'month', label: 'Monthly' }
  ];

  function setCompare(kind: StatsReportKind, on: boolean) {
    if (view) void save({ stats: { compare: { ...view.settings.stats.compare, [kind]: on } } });
  }

  function toggleEvent(id: string, channel: NotificationChannel, on: boolean) {
    void save({ events: { [id]: { [channel]: on } } } as SettingsPatch);
  }

  const textField = 'c-input block w-full sm:w-80';
</script>

<div class="flex flex-col gap-10" data-testid="notifications-panel">
  {#if connection === null || loadError || !view || saveError}
    <div>
      {#if connection === null}
        <p class="c-notice">
          This device isn’t connected to a library server. Notifications are sent by the server.
        </p>
      {:else if loadError}
        <p class="c-notice" role="alert" data-testid="notify-load-error">{loadError}</p>
      {:else if !view}
        <p class="text-c-muted">Loading…</p>
      {/if}
      {#if saveError}
        <p class="c-notice" role="alert" data-testid="notify-save-error">{saveError}</p>
      {/if}
    </div>
  {/if}

  {#if view}
    <p class="s-intro">
      The server sends these messages, so they arrive even when no device is open. Each change is
      saved at once.
      <span class="ml-1 font-medium" aria-live="polite" data-testid="notify-saved">
        {#if saving}
          Saving…
        {:else if savedAt}
          Saved.
        {/if}
      </span>
    </p>

    <SettingsGroup id="notify-channels" testid="notify-section-channels">
      <div data-testid="notify-discord">
        <SettingRow id="notify-discord" layout="stack">
          <svelte:fragment slot="description">
            <p class="mt-1 text-sm text-c-muted">
              In Discord: the channel’s settings, Integrations, Webhooks, New Webhook, Copy Webhook
              URL.
            </p>
            <p class="mt-1 text-sm" data-testid="notify-webhook-state">
              {secretStateText(view.secrets.discordWebhookUrl)}
            </p>
          </svelte:fragment>
          <div class="flex flex-col gap-3">
            <label class="grid gap-1 text-sm">
              <span class="font-medium">Webhook address</span>
              <input
                class={textField}
                type="password"
                autocomplete="new-password"
                placeholder={view.secrets.discordWebhookUrl.set
                  ? 'Saved; paste a new one to change it'
                  : 'https://discord.com/api/webhooks/…'}
                bind:value={webhook}
                on:change={() => saveSecret('discordWebhookUrl', webhook)}
                data-testid="notify-webhook"
              />
            </label>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <button
                type="button"
                class="c-btn c-btn-secondary"
                disabled={!view.channels.discord || testState.discord.busy}
                on:click={() => sendTest('discord')}
                data-testid="notify-test-discord">Send test</button
              >
              {#if view.secrets.discordWebhookUrl.set}
                <button
                  type="button"
                  class="c-btn c-btn-ghost"
                  on:click={() => removeSecret('discordWebhookUrl', 'Discord webhook address')}
                  >Remove…</button
                >
              {/if}
              {#if testState.discord.text}
                <span
                  class={testState.discord.ok ? 'text-c-ink' : 'font-semibold text-c-ink'}
                  role="status"
                  data-testid="notify-test-discord-result">{testState.discord.text}</span
                >
              {/if}
            </div>
          </div>
        </SettingRow>
      </div>
      <div data-testid="notify-email">
        <SettingRow id="notify-email" layout="stack">
          <svelte:fragment slot="description">
            <p class="mt-1 text-sm text-c-muted">
              Not your Google password: an app password, made at myaccount.google.com/apppasswords
              (needs 2-Step Verification on the account).
            </p>
            <p class="mt-1 text-sm" data-testid="notify-app-password-state">
              {secretStateText(view.secrets.gmailAppPassword)}
            </p>
          </svelte:fragment>
          <div class="flex flex-col gap-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="grid gap-1 text-sm">
                <span class="font-medium">Gmail address</span>
                <input
                  class="c-input w-full"
                  type="email"
                  autocomplete="off"
                  placeholder="you@gmail.com"
                  bind:value={emailFrom}
                  on:change={() => save({ email: { from: emailFrom } })}
                  data-testid="notify-email-from"
                />
              </label>
              <label class="grid gap-1 text-sm">
                <span class="font-medium">Send to</span>
                <input
                  class="c-input w-full"
                  type="email"
                  autocomplete="off"
                  placeholder="you@gmail.com"
                  bind:value={emailTo}
                  on:change={() => save({ email: { to: emailTo } })}
                  data-testid="notify-email-to"
                />
              </label>
            </div>
            <label class="grid gap-1 text-sm">
              <span class="font-medium">App password</span>
              <input
                class={textField}
                type="password"
                autocomplete="new-password"
                placeholder={view.secrets.gmailAppPassword.set
                  ? 'Saved; type a new one to change it'
                  : 'abcd efgh ijkl mnop'}
                bind:value={appPassword}
                on:change={() => saveSecret('gmailAppPassword', appPassword)}
                data-testid="notify-app-password"
              />
            </label>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <button
                type="button"
                class="c-btn c-btn-secondary"
                disabled={!view.channels.email || testState.email.busy}
                on:click={() => sendTest('email')}
                data-testid="notify-test-email">Send test</button
              >
              {#if view.secrets.gmailAppPassword.set}
                <button
                  type="button"
                  class="c-btn c-btn-ghost"
                  on:click={() => removeSecret('gmailAppPassword', 'Gmail app password')}
                  >Remove…</button
                >
              {/if}
              {#if testState.email.text}
                <span
                  class={testState.email.ok ? 'text-c-ink' : 'font-semibold text-c-ink'}
                  role="status"
                  data-testid="notify-test-email-result">{testState.email.text}</span
                >
              {/if}
            </div>
          </div>
        </SettingRow>
      </div>
    </SettingsGroup>

    <SettingsGroup id="notify-general" testid="notify-section-general">
      <SettingRow id="notify-digest-time" let:labelId>
        <input
          class="c-input"
          type="time"
          aria-labelledby={labelId}
          bind:value={digestTime}
          on:change={() => digestTime && save({ digest: { time: digestTime } })}
          data-testid="notify-digest-time"
        />
      </SettingRow>
      <SettingRow id="notify-zone" let:labelId>
        <select
          class={textField}
          aria-labelledby={labelId}
          bind:value={digestZone}
          on:change={() => save({ digest: { timeZone: digestZone || null } })}
          data-testid="notify-digest-zone"
        >
          <option value="">The server’s ({view.serverTimeZone})</option>
          {#if showDeviceZone}
            <option value={deviceZone}>This device’s ({deviceZone})</option>
          {/if}
          {#each zoneList as z (z)}
            <option value={z}>{z}</option>
          {/each}
        </select>
      </SettingRow>
      <SettingRow id="notify-link-base" let:labelId>
        <input
          class={textField}
          type="url"
          aria-labelledby={labelId}
          bind:value={linkBase}
          on:change={() => save({ linkBase })}
          data-testid="notify-link-base"
        />
      </SettingRow>
      <SettingRow id="notify-finished" let:labelId>
        <select
          class={textField}
          aria-labelledby={labelId}
          value={view.settings.finishedJobs}
          on:change={(e) => setFinished(e.currentTarget.value)}
          data-testid="notify-finished"
        >
          <option value="now">A message for each</option>
          <option value="digest">In the daily summary</option>
          <option value="off">Off</option>
        </select>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="notify-waits" testid="notify-section-waits">
      {#each WAIT_FIELDS as w (w.key)}
        <SettingRow title={w.label} let:labelId>
          <SettingField unit={w.unit}>
            <input
              type="number"
              min={w.min}
              max={w.max}
              step="1"
              aria-labelledby={labelId}
              value={view.settings.waits[w.key]}
              on:change={(e) => setWait(w.key, e.currentTarget)}
              data-testid="notify-wait-{w.key}"
            />
          </SettingField>
        </SettingRow>
      {/each}
    </SettingsGroup>

    {#each view.sections as section (section.id)}
      <SettingsGroup
        id="notify-events-{section.id}"
        jp="通知"
        title={section.label}
        testid="notify-section-{section.id}"
      >
        <div data-testid="notify-events-{section.id}">
          <SettingRow
            title="Send these messages"
            description={section.id === 'stats'
              ? ''
              : 'Off: nothing from this section is sent. Choose each message and where it goes below.'}
            layout="inline"
            let:labelId
          >
            <SettingSwitch
              checked={view.settings.sections[section.id]}
              labelledby={labelId}
              testid="notify-section-switch-{section.id}"
              on:change={({ detail }) => save({ sections: { [section.id]: detail } })}
            />
          </SettingRow>
          {#if section.id === 'stats'}
            <SettingRow title="When" layout="info">
              <span class="text-sm" data-testid="notify-stats-when">
                Sent when a day, week or month ends: at the day start set in Settings &gt;
                Statistics, in the time zone above.
              </span>
            </SettingRow>
            <SettingRow title="Periods with no reading" let:labelId>
              <select
                class={textField}
                aria-labelledby={labelId}
                value={view.settings.stats.noReading}
                on:change={(e) => setNoReading(e.currentTarget.value)}
                data-testid="notify-stats-no-reading"
              >
                <option value="skip">Skip</option>
                <option value="send">Send “No reading”</option>
              </select>
            </SettingRow>
            <SettingRow
              title="Compare with the previous period"
              description="Shows each number's change from the day, week or month before, e.g. (+2,140, +13%)."
              let:labelId
            >
              <div
                class="flex flex-wrap gap-x-5 gap-y-2 text-sm"
                role="group"
                aria-labelledby={labelId}
                data-testid="notify-stats-compare"
              >
                {#each COMPARE_KINDS as { kind, label } (kind)}
                  <label class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      class="h-5 w-5 disabled:opacity-40"
                      disabled={!view.settings.sections.stats}
                      checked={view.settings.stats.compare[kind]}
                      on:change={(e) => setCompare(kind, e.currentTarget.checked)}
                      data-testid="notify-stats-compare-{kind}"
                    />
                    {label}
                  </label>
                {/each}
              </div>
            </SettingRow>
          {/if}
          {#if channels.length === 0}
            <p class="s-note">Set up Discord or email above to choose what goes where.</p>
          {:else}
            <div class="s-matrix">
              <table class="notify-table w-full text-sm">
                <thead>
                  <tr>
                    <th class="text-left">Message</th>
                    {#each channels as ch (ch)}
                      <th class="w-20 text-center">{CHANNEL_NAMES[ch]}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each view.events.filter((e) => e.section === section.id) as ev (ev.id)}
                    <tr data-testid="notify-event-{ev.id}">
                      <td class={view.settings.sections[section.id] ? '' : 'text-c-muted'}>
                        {ev.label}{#if ev.kind === 'digest'}<span class="text-c-muted"
                            >{' (daily summary)'}</span
                          >{/if}
                      </td>
                      {#each channels as ch (ch)}
                        <td class="text-center">
                          <input
                            type="checkbox"
                            class="h-5 w-5 disabled:opacity-40"
                            aria-label="{ev.label}: {CHANNEL_NAMES[ch]}"
                            disabled={!view.settings.sections[section.id]}
                            checked={view.settings.events[ev.id]?.[ch] ?? true}
                            on:change={(e) => toggleEvent(ev.id, ch, e.currentTarget.checked)}
                            data-testid="notify-switch-{ev.id}-{ch}"
                          />
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      </SettingsGroup>
    {/each}
  {/if}
</div>

<style>
  .s-intro {
    padding: 0.75rem 1rem;
    border: var(--c-border-width) solid var(--c-line);
    border-left: 3px solid var(--c-gold);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    font-size: 0.875rem;
  }

  .s-note {
    padding: 0.875rem 1.25rem;
    border-top: 1px solid var(--c-line);
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .s-matrix {
    overflow-x: auto;
    border-top: 1px solid var(--c-line);
  }

  .notify-table th {
    padding: 0.625rem 1rem;
    color: var(--c-muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .notify-table td {
    padding: 0.625rem 1rem;
    border-top: 1px solid var(--c-line);
    vertical-align: middle;
  }

  @media (min-width: 640px) {
    .notify-table th,
    .notify-table td {
      padding-left: 1.25rem;
      padding-right: 1.25rem;
    }
  }
</style>
