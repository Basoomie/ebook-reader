<script lang="ts">
  import { logger } from '$lib/data/logger';
  import { randomId } from '$lib/functions/secure-context';
  import type { StatEntry } from '$lib/stats/aggregate';
  import {
    activeGoals,
    GOAL_METRICS,
    GOAL_PERIODS,
    goalHistory,
    goalProgressText,
    goalTitle,
    planGoalEnd,
    planGoalSave,
    type GoalInput,
    type GoalMetric,
    type GoalPeriod,
    type GoalPeriodState,
    type StatGoal
  } from '$lib/stats/goals';
  import { parseCount } from '$lib/stats/stats-format';
  import { periodLabel } from '$lib/stats/periods';
  import type { StatsBookInfo } from '$lib/stats/stats-view';
  import type { ReadThrough } from '$lib/sync/book-state';
  import type { StatsApi } from '$lib/sync/sync-service';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { endGoalCopy } from '$lib/confirm/confirm-copy';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';

  /**
   * WP12c: reading goals on the Stats page. Several goals can be active; each shows the
   * current period's progress and the last 12 periods (met ✓, missed ✗, in progress ○,
   * before the goal ·). Values use every device and book, whatever the page's filters.
   * E-ink plain: bordered bars and 48 px controls, no transitions.
   */

  export let stats: StatsApi;
  export let goals: StatGoal[];
  export let entries: StatEntry[];
  export let readThroughs: Map<string, ReadThrough[]>;
  export let books: Map<string, StatsBookInfo>;
  export let todayKey: string;
  export let weekStart: number;
  export let speedMinMinutes: number;

  let editing: {
    goal: StatGoal | null;
    metric: GoalMetric;
    period: GoalPeriod;
    target: string;
    error: string;
  } | null = null;
  let saveError = '';

  $: input = {
    entries,
    readThroughs,
    books,
    speedMinSeconds: Math.max(0, Number(speedMinMinutes) || 0) * 60
  } as GoalInput;
  $: active = activeGoals(goals, todayKey);
  $: rows = active.map((goal) => ({
    goal,
    history: goalHistory(goal, todayKey, weekStart, input, 12, goals)
  }));

  function current(row: (typeof rows)[number]) {
    return row.history[row.history.length - 1];
  }

  function percent(row: (typeof rows)[number]): number {
    const progress = current(row).progress;
    return progress ? Math.min(100, Math.round(progress.ratio * 100)) : 0;
  }

  function currentText(row: (typeof rows)[number], minMinutes: number): string {
    const progress = current(row).progress;
    return progress ? goalProgressText(row.goal, progress, minMinutes) : '';
  }

  function stateMark(state: GoalPeriodState): string {
    return state === 'met' ? '✓' : state === 'missed' ? '✗' : state === 'current' ? '○' : '·';
  }

  function stateLabel(state: GoalPeriodState): string {
    return state === 'met'
      ? 'met'
      : state === 'missed'
        ? 'missed'
        : state === 'current'
          ? 'in progress'
          : 'no goal yet';
  }

  function targetText(metric: GoalMetric, target: number): string {
    return String(metric === 'time' ? Math.round(target / 60) : target);
  }

  function startAdd() {
    saveError = '';
    editing = { goal: null, metric: 'time', period: 'day', target: '60', error: '' };
  }

  function startEdit(goal: StatGoal) {
    saveError = '';
    editing = {
      goal,
      metric: goal.metric,
      period: goal.period,
      target: targetText(goal.metric, goal.target),
      error: ''
    };
  }

  async function save() {
    if (!editing) return;
    const n = parseCount(editing.target);
    if (!n) {
      editing = { ...editing, error: 'Enter a number of 1 or more.' };
      return;
    }
    const target = editing.metric === 'time' ? n * 60 : n;
    const writes = planGoalSave(
      editing.goal,
      { metric: editing.metric, period: editing.period, target },
      todayKey,
      weekStart,
      randomId,
      Date.now()
    );
    if (!(await stats.applyGoalWrites(writes))) {
      saveError = 'The goal could not be saved.';
      logger.warn('Stats: a goal could not be saved');
      return;
    }
    editing = null;
  }

  async function end(goal: StatGoal) {
    saveError = '';
    const writes = planGoalEnd(goal, todayKey, weekStart);
    // WP19: ask first (a goal that began in this period is removed outright).
    const confirmed = await confirmDestructive({
      ...endGoalCopy(
        goalTitle(goal),
        writes.some((w) => w.op === 'remove')
      ),
      testid: 'goal-end-confirm',
      confirmTestid: 'goal-end-confirm-button'
    });
    if (!confirmed) return;
    if (!(await stats.applyGoalWrites(writes))) {
      saveError = 'The goal could not be ended.';
    }
  }

  function cancelOnEscape(ev: KeyboardEvent) {
    if (ev.key === 'Escape') editing = null;
  }

  function unitOf(metric: GoalMetric): string {
    return GOAL_METRICS.find((m) => m.metric === metric)?.unit ?? '';
  }

  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
</script>

<!-- 2026-11-22 redesign: one card; a goal's Change… and End goal sit in its ⋯ menu. -->
<section class="c-stats-card" data-testid="stats-goals" aria-labelledby="stats-goals-title">
  <div class="c-stats-card-head">
    <h2 id="stats-goals-title" class="font-mincho text-lg font-bold sm:text-xl">Goals</h2>
    {#if !editing}
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-sm px-3"
        data-testid="stats-goal-add"
        on:click={startAdd}
      >
        + Add goal
      </button>
    {/if}
  </div>
  {#if saveError}
    <p class="px-4 pt-3 text-sm font-semibold sm:px-5" role="alert">{saveError}</p>
  {/if}
  {#if editing}
    <form
      class="grid gap-3 border-b border-c-line px-4 py-4 sm:px-5"
      data-testid="stats-goal-form"
      on:submit|preventDefault={save}
    >
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm text-c-muted">
          Goal
          <select
            class="c-input w-full"
            bind:value={editing.metric}
            data-testid="stats-goal-metric"
            on:keydown={cancelOnEscape}
          >
            {#each GOAL_METRICS as m (m.metric)}
              <option value={m.metric}>{m.label}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm text-c-muted">
          Every
          <select
            class="c-input w-full"
            bind:value={editing.period}
            data-testid="stats-goal-period"
            on:keydown={cancelOnEscape}
          >
            {#each GOAL_PERIODS as p (p.period)}
              <option value={p.period}>{p.label}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm text-c-muted">
          Target ({unitOf(editing.metric)})
          <input
            class="c-input w-full"
            inputmode="numeric"
            bind:value={editing.target}
            data-testid="stats-goal-target"
            on:keydown={cancelOnEscape}
          />
        </label>
      </div>
      {#if editing.error}
        <p class="text-sm font-semibold" role="alert">{editing.error}</p>
      {/if}
      {#if editing.goal}
        <p class="text-xs text-c-muted">
          Earlier {editing.goal.period === 'day'
            ? 'days'
            : editing.goal.period === 'week'
              ? 'weeks'
              : 'months'} keep the target they had.
        </p>
      {/if}
      <div class="flex flex-wrap gap-2">
        <button class="c-btn c-btn-primary px-4" type="submit">Save</button>
        <button class="c-btn c-btn-secondary px-4" type="button" on:click={() => (editing = null)}>
          Cancel
        </button>
      </div>
    </form>
  {/if}
  {#if !rows.length && !editing}
    <p class="px-4 py-5 text-center text-sm text-c-muted sm:px-5" data-testid="stats-goals-empty">
      No goals yet. A goal counts reading on every device, by day, week or month.
    </p>
  {/if}
  {#each rows as row (row.goal.id)}
    <div class="c-goal px-4 py-3 sm:px-5" data-testid="stats-goal" data-goal-id={row.goal.id}>
      <div class="flex items-start gap-2">
        <h3 class="min-w-0 flex-1 pt-2 font-semibold" data-testid="stats-goal-title">
          {goalTitle(row.goal)}
        </h3>
        <DropdownMenu
          buttonClass="c-btn c-btn-ghost c-btn-icon c-btn-sm"
          align="right"
          panelWidth="w-48"
          label="Goal: {goalTitle(row.goal)}"
          testid="stats-goal-menu"
          let:close
        >
          <span slot="button" aria-label="Goal options">⋯</span>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class={menuItem}
              data-testid="stats-goal-change"
              on:click={() => {
                close();
                startEdit(row.goal);
              }}
            >
              Change…
            </button>
            <button
              type="button"
              class={menuItem}
              data-testid="stats-goal-end"
              on:click={() => {
                close();
                void end(row.goal);
              }}
            >
              End goal…
            </button>
          </div>
        </DropdownMenu>
      </div>
      <div
        class="c-progress mt-1 h-2.5 w-full overflow-hidden rounded-full bg-c-track"
        role="progressbar"
        aria-label={goalTitle(row.goal)}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent(row)}
      >
        <div class="h-full rounded-full bg-c-fill" style:width="{percent(row)}%" />
      </div>
      <p class="pt-1.5 text-sm" data-testid="stats-goal-current">
        {periodLabel(current(row).period)}: {currentText(row, speedMinMinutes)}
      </p>
      <ol
        class="flex flex-wrap gap-1 pt-2"
        aria-label="Last 12 periods"
        data-testid="stats-goal-history"
      >
        {#each row.history as h (h.period.from)}
          <li
            class="c-goal-mark flex h-6 w-6 items-center justify-center rounded text-xs"
            class:c-goal-met={h.state === 'met'}
            title="{periodLabel(h.period)}: {stateLabel(h.state)}"
            aria-label="{periodLabel(h.period)}: {stateLabel(h.state)}"
            data-state={h.state}
          >
            {stateMark(h.state)}
          </li>
        {/each}
      </ol>
    </div>
  {/each}
</section>

<style>
  .c-goal + .c-goal {
    border-top: 1px solid var(--c-line);
  }

  .c-goal-mark {
    border: var(--c-border-width) solid var(--c-line-strong);
    color: var(--c-muted);
  }

  .c-goal-met {
    background-color: var(--c-fill);
    border-color: var(--c-fill);
    color: var(--c-raised);
    font-weight: 700;
  }

  :global(html.eink) .c-progress {
    outline: 1px solid #000;
  }
</style>
