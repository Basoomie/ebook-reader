<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings › Library › 読書メーター (Bookmeter sync, 2026-11-25, docs/design/bookmeter-sync.md).
   * Everything here is kept on the library server, the same for every device: the accounts
   * (a Bookmeter user, the libraries it covers, its two parts), how often the lists are read,
   * when changes ask first, and the lists to look at: changes waiting, Not matched, and books
   * finished here but not on 読書メーター (each with "Log on 読書メーター").
   */
  import { onDestroy, onMount } from 'svelte';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeBookmeterAccountCopy } from '$lib/confirm/confirm-copy';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import {
    LibraryApi,
    type BookmeterAccountStatus,
    type BookmeterFinishedBook,
    type BookmeterServerSettings,
    type BookmeterStatusAnswer
  } from '$lib/library/api';
  import { bookmeterApi, libraryViewApi } from '$lib/sync/sync-service';
  import BookmeterReviewDialog from '$lib/components/bookmeter/bookmeter-review-dialog.svelte';
  import BookmeterUnmatchedDialog from '$lib/components/bookmeter/bookmeter-unmatched-dialog.svelte';
  import { bookmeterBookUrl, checkingText } from '$lib/bookmeter/bookmeter-words';

  const view = bookmeterApi().view;

  let api: LibraryApi | null = null;
  let status: BookmeterStatusAnswer | null = null;
  let libraries: { id: string; name: string }[] = [];
  let draft: Pick<
    BookmeterServerSettings,
    'quickMinutes' | 'fullHours' | 'askAbove' | 'notifyArrived'
  > | null = null;
  let loadError = '';
  let saveError = '';
  let savedNote = '';
  let busy = false;
  let newUser = '';
  let newLibraries: string[] = [];
  let addError = '';
  let finished: BookmeterFinishedBook[] | null = null;
  let finishedShown = 10;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** The last finished check seen, so a newly finished one brings its records here at once. */
  let lastCheck = '';

  async function load() {
    if (!api) return;
    try {
      status = await api.bookmeterStatus();
      const seen = status.accounts.map((a) => `${a.account.id}:${a.quickAt}:${a.fullAt}`).join();
      if (lastCheck && seen !== lastCheck) {
        // A check finished on the server: pull its records now and plan again.
        void libraryViewApi()
          .syncSoon()
          .then(() => bookmeterApi().syncNow());
      }
      lastCheck = seen;
      if (!draft) {
        const s = status.settings;
        draft = {
          quickMinutes: s.quickMinutes,
          fullHours: s.fullHours,
          askAbove: s.askAbove,
          notifyArrived: s.notifyArrived
        };
      }
      loadError = '';
    } catch (err) {
      loadError = `読書メーター sync can't be shown: ${(err as Error).message}. It needs the library server.`;
    }
  }

  async function loadFinished() {
    if (!api) return;
    try {
      finished = (await api.bookmeterFinishedHere()).books;
    } catch {
      finished = null;
    }
  }

  onMount(async () => {
    const c = await getLibraryStore().getConnection();
    if (!c) {
      loadError = 'Connect this device to the library server to set up 読書メーター sync.';
      return;
    }
    const t = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
    api = new LibraryApi(c.serverUrl, c.token, t);
    try {
      libraries = (await api.libraries()).libraries
        .filter((l) => l.enabled)
        .map((l) => ({ id: l.id, name: l.name }));
    } catch {
      libraries = [];
    }
    await load();
    await loadFinished();
    void bookmeterApi().reload();
    timer = setInterval(() => void load(), 5_000);
  });

  onDestroy(() => clearInterval(timer));

  $: settings = status?.settings ?? null;
  $: pending = $view.pending;
  $: dirty =
    !!draft &&
    !!settings &&
    (draft.quickMinutes !== settings.quickMinutes ||
      draft.fullHours !== settings.fullHours ||
      draft.askAbove !== settings.askAbove ||
      draft.notifyArrived !== settings.notifyArrived);

  function libraryName(id: string): string {
    return libraries.find((l) => l.id === id)?.name ?? id;
  }

  function nameOf(a: BookmeterAccountStatus): string {
    return a.name ?? `User ${a.account.userId}`;
  }

  function ago(ms: number | null): string {
    if (ms === null) return 'never';
    const m = Math.round((Date.now() - ms) / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return new Date(ms).toLocaleDateString();
  }

  function num(e: Event, min: number, max: number, fallback: number): number {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  async function run(f: () => Promise<unknown>, onError: (m: string) => void) {
    busy = true;
    try {
      await f();
      await load();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      busy = false;
    }
  }

  function setEnabled(on: boolean) {
    void run(
      async () => {
        status = await api!.saveBookmeterSettings({ enabled: on });
      },
      (m) => (saveError = `Not saved: ${m}`)
    );
  }

  function save() {
    if (!draft) return;
    const d = draft;
    void run(
      async () => {
        status = await api!.saveBookmeterSettings(d);
        draft = null;
        savedNote = 'Saved.';
      },
      (m) => (saveError = `Not saved: ${m}`)
    );
  }

  function addAccount() {
    addError = '';
    const user = newUser.trim();
    if (!user) return;
    void run(
      async () => {
        await api!.addBookmeterAccount({ user, libraries: newLibraries });
        newUser = '';
        newLibraries = [];
      },
      (m) => (addError = m)
    );
  }

  function toggleNewLibrary(id: string, on: boolean) {
    newLibraries = on ? [...newLibraries, id] : newLibraries.filter((l) => l !== id);
  }

  function setAccount(a: BookmeterAccountStatus, patch: Record<string, unknown>) {
    void run(
      () => api!.updateBookmeterAccount(a.account.id, patch),
      (m) => (saveError = `Not saved: ${m}`)
    );
  }

  function toggleAccountLibrary(a: BookmeterAccountStatus, id: string, on: boolean) {
    const list = a.account.libraries;
    setAccount(a, { libraries: on ? [...list, id] : list.filter((l) => l !== id) });
  }

  async function removeAccount(a: BookmeterAccountStatus) {
    if (!(await confirmDestructive(removeBookmeterAccountCopy(nameOf(a))))) return;
    void run(
      () => api!.removeBookmeterAccount(a.account.id),
      (m) => (saveError = `Not removed: ${m}`)
    );
  }

  function checkNow(a?: BookmeterAccountStatus) {
    void run(
      () => api!.bookmeterCheckNow(a?.account.id),
      (m) => (saveError = `Can't check now: ${m}`)
    );
  }

  async function review() {
    await dialogManager.open(BookmeterReviewDialog, { changes: pending });
    await load();
    await loadFinished();
  }

  async function unmatched(a: BookmeterAccountStatus) {
    if (!api) return;
    const changed = await dialogManager.open<boolean>(BookmeterUnmatchedDialog, {
      api,
      accountId: a.account.id,
      accountName: nameOf(a)
    });
    // A book linked by hand: its record comes now, and its change with it.
    if (changed)
      void libraryViewApi()
        .syncSoon()
        .then(() => bookmeterApi().syncNow());
    await load();
  }
</script>

<div class="space-y-5" data-testid="bookmeter-settings">
  {#if loadError}
    <p class="text-sm text-c-muted" data-testid="bookmeter-settings-error">{loadError}</p>
  {:else if !status || !settings}
    <p class="text-sm text-c-muted">Loading…</p>
  {:else}
    {#if !status.available}
      <p class="text-sm text-c-muted">
        The library server reads 読書メーター through the library cleanup’s fetcher, which isn’t
        running there: nothing is read until it is.
      </p>
    {/if}

    <label class="flex items-center gap-3">
      <input
        type="checkbox"
        checked={settings.enabled}
        disabled={busy}
        data-testid="bookmeter-enabled"
        on:change={(e) => setEnabled(e.currentTarget.checked)}
      />
      <span>Read my 読書メーター lists</span>
    </label>

    {#if pending.length}
      <div
        class="flex flex-wrap items-center gap-3 rounded bg-c-tint p-3"
        data-testid="bookmeter-pending"
      >
        <span class="grow">
          {pending.length.toLocaleString()}
          {pending.length === 1 ? 'change waits' : 'changes wait'} for you to look at them.
        </span>
        <button type="button" class="c-btn c-btn-primary c-btn-sm" on:click={review}>
          Review…
        </button>
      </div>
    {/if}

    {#each status.accounts as a (a.account.id)}
      <section class="space-y-3 rounded border border-c-line p-3" data-testid="bookmeter-account">
        <div class="flex flex-wrap items-baseline gap-2">
          <a
            class="font-medium hover:underline"
            href="https://bookmeter.com/users/{a.account.userId}"
            target="_blank"
            rel="noopener noreferrer">{nameOf(a)}</a
          >
          <span class="text-sm text-c-muted">読書メーター user {a.account.userId}</span>
        </div>
        <p class="text-sm" data-testid="bookmeter-account-counts">
          読んだ本 {a.entries.read} · 読んでる本 {a.entries.reading} · 積読本 {a.entries.stacked} · 読みたい本
          {a.entries.wish}
          <span class="text-c-muted">
            · {a.matched.toLocaleString()} matched to your books{#if a.unmatched > 0}, {a.unmatched}
              not matched{/if}</span
          >
        </p>
        {#if a.checking}
          <div data-testid="bookmeter-checking">
            <div class="h-2 overflow-hidden rounded bg-c-track">
              <div
                class="h-full bg-c-fill"
                style="width: {a.checking.total ? (100 * a.checking.done) / a.checking.total : 0}%"
              />
            </div>
            <p class="mt-1 text-sm text-c-muted">{checkingText(a.checking, Date.now())}</p>
          </div>
        {:else}
          <p class="text-sm text-c-muted">
            Last read {ago(a.quickAt)}{#if a.fullAt !== a.quickAt}; every page {ago(a.fullAt)}{/if}.
            {#if a.result && (a.result.changed || a.result.removed)}
              {a.result.changed} new or changed{#if a.result.removed}, {a.result.removed} gone{/if}.
            {/if}
          </p>
        {/if}
        {#if a.error}
          <p class="text-sm text-red-500" role="alert">{a.error} ({ago(a.errorAt)})</p>
        {/if}

        <div class="flex flex-col gap-2">
          <label class="flex items-center gap-3">
            <input
              type="checkbox"
              checked={a.account.statuses}
              disabled={busy}
              on:change={(e) => setAccount(a, { statuses: e.currentTarget.checked })}
            />
            <span>Mark books Reading and Completed from 読んでる本 and 読んだ本</span>
          </label>
          <label class="flex items-center gap-3">
            <input
              type="checkbox"
              checked={a.account.wish}
              disabled={busy}
              on:change={(e) => setAccount(a, { wish: e.currentTarget.checked })}
            />
            <span>読みたい本 as a collection (search bookmeter:wish)</span>
          </label>
        </div>

        {#if libraries.length > 1}
          <fieldset>
            <legend class="text-sm text-c-muted">
              Libraries ({a.account.libraries.length ? 'only these' : 'all of them'})
            </legend>
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {#each libraries as l (l.id)}
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={a.account.libraries.includes(l.id)}
                    disabled={busy}
                    on:change={(e) => toggleAccountLibrary(a, l.id, e.currentTarget.checked)}
                  />
                  <span>{l.name}</span>
                </label>
              {/each}
            </div>
          </fieldset>
        {/if}

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            disabled={busy || !!a.checking || !settings.enabled}
            data-testid="bookmeter-check-now"
            on:click={() => checkNow(a)}
          >
            Check now
          </button>
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            data-testid="bookmeter-open-unmatched"
            on:click={() => unmatched(a)}
          >
            Not matched{a.unmatched ? ` (${a.unmatched})` : ''}…
          </button>
          <button
            type="button"
            class="c-btn c-btn-ghost c-btn-sm"
            disabled={busy}
            on:click={() => removeAccount(a)}
          >
            Stop syncing…
          </button>
        </div>
      </section>
    {/each}

    <section class="space-y-2" data-testid="bookmeter-add">
      <h4 class="font-medium">
        {status.accounts.length ? 'Add another account' : 'Add your account'}
      </h4>
      <p class="text-sm text-c-muted">
        Your 読書メーター profile link (bookmeter.com/users/…) or its number. Its lists must be
        public. With two accounts (for example one for books and one for manga), give each the
        libraries it covers.
      </p>
      <div class="flex flex-wrap gap-2">
        <input
          type="text"
          class="c-input min-w-0 grow"
          placeholder="https://bookmeter.com/users/1234567"
          aria-label="読書メーター profile link or number"
          data-testid="bookmeter-add-user"
          bind:value={newUser}
          on:keydown={(e) => e.key === 'Enter' && addAccount()}
        />
        <button
          type="button"
          class="c-btn c-btn-primary"
          disabled={busy || !newUser.trim()}
          data-testid="bookmeter-add-button"
          on:click={addAccount}
        >
          Add
        </button>
      </div>
      {#if libraries.length > 1}
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <span class="text-sm text-c-muted">Only these libraries (none ticked: all):</span>
          {#each libraries as l (l.id)}
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                checked={newLibraries.includes(l.id)}
                on:change={(e) => toggleNewLibrary(l.id, e.currentTarget.checked)}
              />
              <span>{l.name}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if addError}<p class="text-sm text-red-500" role="alert">{addError}</p>{/if}
    </section>

    {#if draft}
      <section class="space-y-3">
        <h4 class="font-medium">How often</h4>
        <label class="flex flex-wrap items-center gap-2">
          <span class="grow">Read the newest books every</span>
          <input
            type="number"
            min="10"
            max="1440"
            class="c-input w-24"
            value={draft.quickMinutes}
            on:change={(e) =>
              draft && (draft = { ...draft, quickMinutes: num(e, 10, 1440, draft.quickMinutes) })}
          />
          <span>minutes</span>
        </label>
        <label class="flex flex-wrap items-center gap-2">
          <span class="grow">Read every page (finds removed books) every</span>
          <input
            type="number"
            min="1"
            max="168"
            class="c-input w-24"
            value={draft.fullHours}
            on:change={(e) =>
              draft && (draft = { ...draft, fullHours: num(e, 1, 168, draft.fullHours) })}
          />
          <span>hours</span>
        </label>
        <label class="flex flex-wrap items-center gap-2">
          <span class="grow">Ask before making more than</span>
          <input
            type="number"
            min="0"
            max="10000"
            class="c-input w-24"
            value={draft.askAbove}
            on:change={(e) =>
              draft && (draft = { ...draft, askAbove: num(e, 0, 10000, draft.askAbove) })}
          />
          <span>changes at once</span>
        </label>
        <p class="text-sm text-c-muted">The first changes of a new account always ask first.</p>
        <label class="flex items-center gap-3">
          <input
            type="checkbox"
            checked={draft.notifyArrived}
            on:change={(e) =>
              draft && (draft = { ...draft, notifyArrived: e.currentTarget.checked })}
          />
          <span
            >Tell me when a book on 読みたい本 arrives in the library (Settings › Notifications)</span
          >
        </label>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="c-btn c-btn-secondary"
            disabled={busy || !dirty}
            on:click={save}
          >
            Save
          </button>
          {#if saveError}<span class="text-sm text-red-500" role="alert">{saveError}</span>{/if}
          {#if savedNote && !dirty}<span class="text-sm text-c-muted">{savedNote}</span>{/if}
        </div>
      </section>
    {/if}

    {#if finished && finished.length}
      <section class="space-y-2" data-testid="bookmeter-finished-here">
        <h4 class="font-medium">Finished here, not on 読書メーター ({finished.length})</h4>
        <ul class="flex flex-col divide-y divide-c-line">
          {#each finished.slice(0, finishedShown) as b (b.bookId)}
            <li class="flex items-center gap-3 py-2">
              <div class="min-w-0 grow">
                <a class="hover:underline" href="/library/book?id={encodeURIComponent(b.bookId)}"
                  >{b.title}</a
                >
                {#if b.finishedOn}
                  <div class="text-sm text-c-muted">
                    Finished {b.finishedOn.replaceAll('-', '/')}
                  </div>
                {/if}
              </div>
              <a
                class="c-btn c-btn-secondary c-btn-sm shrink-0"
                href={bookmeterBookUrl(b.listingId, b.title)}
                target="_blank"
                rel="noopener noreferrer">Log on 読書メーター</a
              >
            </li>
          {/each}
        </ul>
        {#if finished.length > finishedShown}
          <button
            type="button"
            class="c-btn c-btn-ghost c-btn-sm"
            on:click={() => (finishedShown += 20)}
          >
            Show more
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</div>
