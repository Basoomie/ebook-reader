/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookSummaryRecord, SummaryJob, SummaryPhase } from './summary-api';
import type { SummaryBlur } from './settings';

/**
 * Book summaries on the book page (session 4): the words and decisions the Summary section
 * shows, kept pure so they are tested on their own.
 */

/** "claude-opus-5-5" → "Claude Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol"; else the id. */
export function modelName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    return `Claude ${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  const gpt = /^gpt-([\d.]+)(?:-([a-z][a-z0-9-]*))?$/.exec(id);
  if (gpt) {
    const rest = (gpt[2] ?? '')
      .split('-')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
    return `GPT-${gpt[1]}${rest ? ` ${rest}` : ''}`;
  }
  return id;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function summaryDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * The line under a summary (decided with the user 2026-11-23): the writer first, then the
 * models whose notes it wrote from ("Written by Claude Opus 5.5 from notes by Claude Sonnet 5.5
 * and GPT-6.1 Sol, on 23 Nov 2026"); one model alone, "Written by Claude Opus 5.5 on …"; a
 * summary the user wrote, "Written by you on …". The writer is the last model listed.
 */
export function madeLine(
  s: {
    origin: 'ai' | 'user' | 'import';
    models: string[];
    madeAt: number;
    setup?: string | null;
  },
  locale?: string
): string {
  const on = summaryDate(s.madeAt, locale);
  if (s.origin === 'user' || !s.models.length) return `Written by you on ${on}`;
  const models = [...new Set(s.models)];
  const w = writerOf(s.setup ?? null, models);
  const writer = modelName(w);
  const helpers = models.filter((m) => m !== w).map(modelName);
  return helpers.length
    ? `Written by ${writer} from notes by ${joinNames(helpers)}, on ${on}`
    : `Written by ${writer} on ${on}`;
}

/**
 * Which model wrote it. The server lists a summary's models once each, finders first and the
 * writer last unless the writer also read the book: the setup's name says which it was
 * (summaries/settings.ts `setupLabel`: "two" is Sonnet + Sol written by Sonnet; others name
 * the writer after ">").
 */
function writerOf(setup: string | null, models: string[]): string {
  if (setup === 'two') return 'claude-sonnet-5-5';
  const named = setup?.includes('>') ? setup.split('>').pop() : null;
  if (named && models.includes(named)) return named;
  return models[models.length - 1];
}

/** Whether the summary starts blurred (only the Overview, cut short, with "Show summary"). */
export function summaryHidden(blur: SummaryBlur | string, status: string | undefined): boolean {
  if (blur === 'always') return true;
  if (blur === 'never') return false;
  return status !== 'completed';
}

export interface LanguageChoice {
  lang: string;
  label: string;
  original: boolean;
}

function languageName(lang: string): string {
  try {
    const name = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
    if (name && name !== lang) return name[0].toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    /* an unknown tag */
  }
  return lang;
}

/**
 * The language buttons: the book's language first ("日本語 (original)"), then the summary
 * languages setting's ("English (translation)"), each once. Names are in their own language.
 */
export function languageChoices(bookLang: string, languages: string[]): LanguageChoice[] {
  const base = (l: string) => l.toLowerCase().split('-')[0];
  const out: LanguageChoice[] = [{ lang: bookLang, label: '', original: true }];
  for (const l of languages)
    if (l && !out.some((c) => base(c.lang) === base(l)))
      out.push({ lang: l, label: '', original: false });
  return out.map((c) => ({
    ...c,
    label: `${languageName(c.lang)} (${c.original ? 'original' : 'translation'})`
  }));
}

/** The language a book page opens in: this device's last choice when offered, else the book's. */
export function startLanguage(last: string, choices: LanguageChoice[]): string {
  return choices.find((c) => c.lang === last)?.lang ?? choices[0].lang;
}

const STEPS: { phase: SummaryPhase; text: string; value: number }[] = [
  { phase: 'reading', text: 'Step 1 of 3: reading the book', value: 15 },
  { phase: 'checking', text: 'Step 2 of 3: checking every item against the book', value: 50 },
  { phase: 'writing', text: 'Step 3 of 3: writing the summary', value: 85 }
];

export function minutesSince(since: number | null | undefined, now: number): number | null {
  if (!since) return null;
  return Math.max(0, Math.floor((now - since) / 60_000));
}

/**
 * What the section says while a summary is being made: the step, a bar by step, the time so
 * far and the usual time (the accuracy test measured 16–21 minutes end to end).
 */
export function makingProgress(
  r: Pick<BookSummaryRecord, 'making' | 'phase' | 'since'>,
  now: number,
  job?: Pick<SummaryJob, 'waiting' | 'afterVolume'> | null
): { text: string; value: number; detail: string } | null {
  if (!r.making) return null;
  if (r.making === 'queued')
    return {
      text: job?.afterVolume ? 'Waiting for the summary of an earlier volume' : 'Waiting to start',
      value: 0,
      detail: 'Usually 15–20 minutes once it starts.'
    };
  const step = STEPS.find((s) => s.phase === r.phase) ?? STEPS[0];
  const mins = minutesSince(r.since, now);
  const so = mins === null ? '' : mins < 1 ? 'Started just now · ' : `${mins} min so far · `;
  return {
    text: job?.waiting ? `${step.text} (waiting: ${job.waiting})` : step.text,
    value: step.value,
    detail: `${so}usually 15–20 minutes.`
  };
}

/** A chapter's own number or name at the start of its title (１章, 第三章, プロローグ, Chapter 3). */
const CHAPTER_MARK =
  /^(?:第?[0-9０-９一二三四五六七八九十百千]+[章話幕部節巻]|プロローグ|エピローグ|序章|終章|幕間|間章|あとがき|Prologue|Epilogue|Interlude|Afterword|(?:Chapter|Part)\s*[0-9IVXLC]+)/i;

/**
 * The text of a chapter button (Chapter by chapter): the chapter's mark when its title starts
 * with one ("１章 ちょっと嫁いでみませんか" → "１章"), else the title, cut with "…" past 12
 * characters (the whole title is the button's tooltip and the heading under it).
 */
export function chapterButtonLabel(title: string, index: number): string {
  const t = title.trim();
  if (!t) return `Chapter ${index + 1}`;
  const mark = CHAPTER_MARK.exec(t)?.[0];
  if (mark) return mark;
  const chars = [...t];
  return chars.length <= 12 ? t : `${chars.slice(0, 11).join('')}…`;
}

/** "Open the book here · 第三章 · 41 %": the link under a shown quote. */
export function quoteLinkText(
  position: number,
  charCount: number | null | undefined,
  chapterTitle: string | null | undefined
): string {
  const parts = ['Open the book here'];
  if (chapterTitle) parts.push(chapterTitle);
  if (charCount && charCount > 0)
    parts.push(`${Math.min(100, Math.round((position / charCount) * 100))} %`);
  return parts.join(' · ');
}

/** The section's state, in the order the page decides it. */
export type SummaryStateKind = 'making' | 'failed' | 'no_text' | 'none' | 'shown' | 'offline_none';

export function sectionState(o: {
  hasSummary: boolean;
  record: Pick<BookSummaryRecord, 'making' | 'outcome'> | null;
  offline: boolean;
}): SummaryStateKind[] {
  const out: SummaryStateKind[] = [];
  const making = !!o.record?.making;
  if (making) out.push('making');
  // A Regenerate that failed on every setup keeps the summary there was: its note shows above.
  else if (o.record?.outcome === 'failed') out.push('failed');
  if (o.hasSummary) out.push('shown');
  else if (!making) {
    if (o.record?.outcome === 'no_text') out.push('no_text');
    else if (o.record?.outcome !== 'failed') out.push(o.offline ? 'offline_none' : 'none');
  }
  return out;
}
