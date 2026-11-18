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
   * once it is set up. Each change is saved at once.
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeNotificationSecretCopy } from '$lib/confirm/confirm-copy';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import {
    NotificationsApi,
    type NotificationChannel,
    type NotificationSecretName,
    type NotificationsView,
    type SettingsPatch
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

  function toggleEvent(id: string, channel: NotificationChannel, on: boolean) {
    void save({ events: { [id]: { [channel]: on } } } as SettingsPatch);
  }

  const field = 'flex flex-col gap-1 text-sm';
  const labelCls = 'font-medium';
</script>

<div class="col-span-full" data-testid="notifications-panel">
  {#if connection === null}
    <p class="text-c-muted">
      This device isn’t connected to a library server. Notifications are sent by the server.
    </p>
  {:else if loadError}
    <p class="c-notice" role="alert" data-testid="notify-load-error">{loadError}</p>
  {:else if !view}
    <p class="text-c-muted">Loading…</p>
  {/if}
  {#if saveError}
    <p class="c-notice mb-4" role="alert" data-testid="notify-save-error">{saveError}</p>
  {/if}
</div>

{#if view}
  <SettingsSection
    jp="送信先"
    title="Channels"
    tooltip="Where messages go. Both are optional. The webhook address and the app password are kept encrypted on the server and never shown again."
    testid="notify-section-channels"
  />
  <div class="col-span-full grid max-w-3xl gap-8 pb-8 pt-4">
    <fieldset class="grid gap-3" data-testid="notify-discord">
      <legend class="mb-2 font-mincho text-lg font-bold">Discord</legend>
      <label class={field}>
        <span class={labelCls}>Webhook address</span>
        <input
          class="c-input"
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
      <span class="text-sm text-c-muted">
        In Discord: the channel’s settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.
      </span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span class="text-c-muted" data-testid="notify-webhook-state"
          >{secretStateText(view.secrets.discordWebhookUrl)}</span
        >
        {#if view.secrets.discordWebhookUrl.set}
          <button
            type="button"
            class="c-btn c-btn-ghost"
            on:click={() => removeSecret('discordWebhookUrl', 'Discord webhook address')}
            >Remove</button
          >
        {/if}
        <button
          type="button"
          class="c-btn c-btn-secondary"
          disabled={!view.channels.discord || testState.discord.busy}
          on:click={() => sendTest('discord')}
          data-testid="notify-test-discord">Send test</button
        >
        {#if testState.discord.text}
          <span
            class={testState.discord.ok ? 'text-c-ink' : 'text-c-seal'}
            role="status"
            data-testid="notify-test-discord-result">{testState.discord.text}</span
          >
        {/if}
      </div>
    </fieldset>

    <fieldset class="grid gap-3 sm:grid-cols-2" data-testid="notify-email">
      <legend class="mb-2 font-mincho text-lg font-bold">Email (Gmail)</legend>
      <label class={field}>
        <span class={labelCls}>Gmail address</span>
        <input
          class="c-input"
          type="email"
          autocomplete="off"
          placeholder="you@gmail.com"
          bind:value={emailFrom}
          on:change={() => save({ email: { from: emailFrom } })}
          data-testid="notify-email-from"
        />
      </label>
      <label class={field}>
        <span class={labelCls}>Send to</span>
        <input
          class="c-input"
          type="email"
          autocomplete="off"
          placeholder="you@gmail.com"
          bind:value={emailTo}
          on:change={() => save({ email: { to: emailTo } })}
          data-testid="notify-email-to"
        />
      </label>
      <label class="{field} sm:col-span-2">
        <span class={labelCls}>App password</span>
        <input
          class="c-input"
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
      <span class="text-sm text-c-muted sm:col-span-2">
        Not your Google password: an app password, made at myaccount.google.com/apppasswords (needs
        2-Step Verification on the account).
      </span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm sm:col-span-2">
        <span class="text-c-muted" data-testid="notify-app-password-state"
          >{secretStateText(view.secrets.gmailAppPassword)}</span
        >
        {#if view.secrets.gmailAppPassword.set}
          <button
            type="button"
            class="c-btn c-btn-ghost"
            on:click={() => removeSecret('gmailAppPassword', 'Gmail app password')}>Remove</button
          >
        {/if}
        <button
          type="button"
          class="c-btn c-btn-secondary"
          disabled={!view.channels.email || testState.email.busy}
          on:click={() => sendTest('email')}
          data-testid="notify-test-email">Send test</button
        >
        {#if testState.email.text}
          <span
            class={testState.email.ok ? 'text-c-ink' : 'text-c-seal'}
            role="status"
            data-testid="notify-test-email-result">{testState.email.text}</span
          >
        {/if}
      </div>
    </fieldset>
  </div>

  <SettingsSection
    jp="一般"
    title="When and how"
    tooltip="Alerts go out at once, at most one per problem. Everything else waits for one daily summary, sent only on days with something to say."
    testid="notify-section-general"
  />
  <div class="col-span-full grid max-w-3xl gap-6 pb-8 pt-4 sm:grid-cols-2">
    <label class={field}>
      <span class={labelCls}>Daily summary at</span>
      <input
        class="c-input"
        type="time"
        bind:value={digestTime}
        on:change={() => digestTime && save({ digest: { time: digestTime } })}
        data-testid="notify-digest-time"
      />
    </label>
    <label class={field}>
      <span class={labelCls}>Time zone</span>
      <select
        class="c-input"
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
    </label>
    <label class="{field} sm:col-span-2">
      <span class={labelCls}>Link address</span>
      <input
        class="c-input"
        type="url"
        bind:value={linkBase}
        on:change={() => save({ linkBase })}
        data-testid="notify-link-base"
      />
      <span class="text-c-muted">Messages link here, to the page where a problem is fixed.</span>
    </label>
    <label class={field}>
      <span class={labelCls}>Finished jobs</span>
      <select
        class="c-input"
        value={view.settings.finishedJobs}
        on:change={(e) => setFinished(e.currentTarget.value)}
        data-testid="notify-finished"
      >
        <option value="now">A message for each</option>
        <option value="digest">In the daily summary</option>
        <option value="off">Off</option>
      </select>
      <span class="text-c-muted">Subtitles and audiobooks made on the PC, merges on the NAS.</span>
    </label>
  </div>

  <SettingsSection
    jp="待ち時間"
    title="Wait before an alert"
    tooltip="Some problems fix themselves (the PC starting up, a helper restarting). These alert only after they have lasted this long."
    testid="notify-section-waits"
  />
  <div class="col-span-full grid max-w-3xl gap-4 pb-8 pt-4">
    {#each WAIT_FIELDS as w (w.key)}
      <label class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <span class="min-w-0 flex-1">{w.label}</span>
        <span class="flex items-center gap-2">
          <input
            class="c-input w-24"
            type="number"
            min={w.min}
            max={w.max}
            step="1"
            value={view.settings.waits[w.key]}
            on:change={(e) => setWait(w.key, e.currentTarget)}
            data-testid="notify-wait-{w.key}"
          />
          <span class="w-16 text-c-muted">{w.unit}</span>
        </span>
      </label>
    {/each}
  </div>

  {#each view.sections as section (section.id)}
    <SettingsSection jp="通知" title={section.label} testid="notify-section-{section.id}" />
    <div class="col-span-full max-w-3xl pb-8 pt-4" data-testid="notify-events-{section.id}">
      <label class="mb-4 flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          class="h-5 w-5"
          checked={view.settings.sections[section.id]}
          on:change={(e) => save({ sections: { [section.id]: e.currentTarget.checked } })}
          data-testid="notify-section-switch-{section.id}"
        />
        <span class={labelCls}>Notify about this section</span>
      </label>
      {#if channels.length === 0}
        <p class="text-sm text-c-muted">Set up Discord or email above to choose what goes where.</p>
      {:else}
        <table class="notify-table w-full text-sm">
          <thead>
            <tr>
              <th class="text-left font-normal text-c-muted">Event</th>
              {#each channels as ch (ch)}
                <th class="w-20 text-center font-normal text-c-muted">{CHANNEL_NAMES[ch]}</th>
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
      {/if}
    </div>
  {/each}

  <div
    class="col-span-full pb-8 text-sm text-c-muted"
    aria-live="polite"
    data-testid="notify-saved"
  >
    {#if saving}
      Saving…
    {:else if savedAt}
      Saved.
    {/if}
  </div>
{/if}

<style>
  .notify-table td,
  .notify-table th {
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid var(--c-rule, rgba(127, 127, 127, 0.25));
    vertical-align: middle;
  }
</style>
