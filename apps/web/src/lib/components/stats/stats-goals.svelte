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

  const control = 'min-h-[3rem] rounded border-2 border-current bg-white px-3';
  /** A filled button: its own classes, never combined with `control` (bg-white would win). */
  const primary = 'min-h-[3rem] rounded border-2 border-gray-800 bg-gray-800 px-3 text-white';

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
    if (!(await stats.applyGoalWrites(planGoalEnd(goal, todayKey, weekStart)))) {
      saveError = 'The goal could not be ended.';
    }
  }

  function cancelOnEscape(ev: KeyboardEvent) {
    if (ev.key === 'Escape') editing = null;
  }

  function unitOf(metric: GoalMetric): string {
    return GOAL_METRICS.find((m) => m.metric === metric)?.unit ?? '';
  }
</script>

<section class="pt-4" data-testid="stats-goals">
  <div class="flex flex-wrap items-center justify-between gap-2 pb-2">
    <h2 class="text-lg font-medium">Goals</h2>
    {#if !editing}
      <button class={control} data-testid="stats-goal-add" on:click={startAdd}>Add goal</button>
    {/if}
  </div>
  {#if saveError}
    <p class="pb-2 text-sm" role="alert">{saveError}</p>
  {/if}
  {#if editing}
    <form
      class="flex flex-wrap items-end gap-2 pb-3"
      data-testid="stats-goal-form"
      on:submit|preventDefault={save}
    >
      <label class="flex flex-col text-sm">
        Goal
        <select
          class={control}
          bind:value={editing.metric}
          data-testid="stats-goal-metric"
          on:keydown={cancelOnEscape}
        >
          {#each GOAL_METRICS as m (m.metric)}
            <option value={m.metric}>{m.label}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col text-sm">
        Every
        <select
          class={control}
          bind:value={editing.period}
          data-testid="stats-goal-period"
          on:keydown={cancelOnEscape}
        >
          {#each GOAL_PERIODS as p (p.period)}
            <option value={p.period}>{p.label}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col text-sm">
        Target ({unitOf(editing.metric)})
        <input
          class="{control} w-36"
          inputmode="numeric"
          bind:value={editing.target}
          data-testid="stats-goal-target"
          on:keydown={cancelOnEscape}
        />
      </label>
      <button class={primary} type="submit">Save</button>
      <button class={control} type="button" on:click={() => (editing = null)}>Cancel</button>
      {#if editing.error}
        <p class="w-full text-sm" role="alert">{editing.error}</p>
      {/if}
      {#if editing.goal}
        <p class="w-full text-xs">
          Earlier {editing.goal.period === 'day'
            ? 'days'
            : editing.goal.period === 'week'
              ? 'weeks'
              : 'months'} keep the target they had.
        </p>
      {/if}
    </form>
  {/if}
  {#if !rows.length && !editing}
    <p class="text-sm" data-testid="stats-goals-empty">
      No goals yet. Goals count reading on every device.
    </p>
  {/if}
  {#each rows as row (row.goal.id)}
    <div class="border-t-2 border-current py-3" data-testid="stats-goal" data-goal-id={row.goal.id}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-medium" data-testid="stats-goal-title">{goalTitle(row.goal)}</h3>
        <div class="flex gap-2">
          <button
            class={control}
            data-testid="stats-goal-change"
            on:click={() => startEdit(row.goal)}
          >
            Change…
          </button>
          <button class={control} data-testid="stats-goal-end" on:click={() => end(row.goal)}>
            End goal
          </button>
        </div>
      </div>
      <p class="pt-1 text-sm" data-testid="stats-goal-current">
        {periodLabel(current(row).period)}: {currentText(row, speedMinMinutes)}
      </p>
      <div
        class="mt-1 h-4 w-full rounded border-2 border-current"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent(row)}
      >
        <div class="h-full bg-gray-800" style:width="{percent(row)}%" />
      </div>
      <ol
        class="flex flex-wrap gap-1 pt-2"
        aria-label="Last 12 periods"
        data-testid="stats-goal-history"
      >
        {#each row.history as h (h.period.from)}
          <li
            class="flex h-7 w-7 items-center justify-center rounded border border-current text-sm"
            class:font-bold={h.state === 'met'}
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
