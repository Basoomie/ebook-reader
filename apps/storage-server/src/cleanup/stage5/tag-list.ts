/**
 * "Tags you can pick" (Settings › Library › Editing; design 2026-11-23): one list, used by the
 * book edit form and by the cleanup's tagging of new books. It starts as stage 5's vocabulary
 * (formats, the 22 genres, 14 nonfiction subjects, 43 tags, アニメ化/コミカライズ) plus the
 * user's own tags (the cleanup's `customTags`: PeepoHappyBooks, alpindale, TMW-collection-*).
 *
 * Kept as what differs from the vocabulary (labels taken off, labels added per group), so the
 * vocabulary itself stays the code's. Changing the list writes nothing to any book: it only
 * changes what can be picked from now on. New books' stage 5 asks with the list right away
 * (option a); the library's own stage 5 keeps its fixed vocabulary (so changing the list never
 * re-asks or re-tags the library). The user's own tags are never in the models' question.
 */
import { createHash } from 'crypto';
import type { Format } from '../stage4/rules-v3';
import { ADAPTATIONS, FORMAT_TAGS, GENRES, SUBJECTS, TAGS, type Kind, type Term } from './vocab';

export const TAG_GROUPS = ['format', 'genre', 'subject', 'tag', 'adaptation', 'yours'] as const;
export type TagGroup = (typeof TAG_GROUPS)[number];
export type VocabGroup = Exclude<TagGroup, 'yours'>;

export interface TagListSetting {
  /** Labels of the vocabulary taken off the list. */
  removed: string[];
  /** Labels added, each to a group (its id is its label). */
  added: { group: VocabGroup; label: string }[];
}

export const DEFAULT_TAG_LIST: TagListSetting = { removed: [], added: [] };

export const GROUP_TITLES: Record<TagGroup, string> = {
  format: 'Formats',
  genre: 'Genres',
  subject: 'Nonfiction subjects',
  tag: 'Tags',
  adaptation: 'Adaptations',
  yours: 'Your tags',
};

const KIND_OF: Record<VocabGroup, Kind> = {
  format: 'format',
  genre: 'genre',
  subject: 'subject',
  tag: 'tag',
  adaptation: 'adaptation',
};

export interface Vocab {
  genres: Term[];
  subjects: Term[];
  tags: Term[];
  adaptations: Term[];
  formats: Partial<Record<Format, Term>>;
  byId: Map<string, Term & { kind: Kind }>;
  /** Differs from the code's vocabulary (then the arrivals' question has its own version). */
  isDefault: boolean;
  hash: string;
}

const lower = (s: string) => s.toLowerCase();

export function effectiveVocab(list: TagListSetting): Vocab {
  const off = new Set(list.removed.map(lower));
  const keep = (terms: readonly Term[]) => terms.filter((t) => !off.has(lower(t.ja)));
  const added = (g: VocabGroup): Term[] =>
    list.added
      .filter((a) => a.group === g && !off.has(lower(a.label)))
      .map((a) => ({ id: a.label, ja: a.label, en: a.label }));
  const formats: Partial<Record<Format, Term>> = {};
  for (const [f, t] of Object.entries(FORMAT_TAGS) as [Format, Term][])
    if (!off.has(lower(t.ja))) formats[f] = t;
  const v = {
    genres: [...keep(GENRES), ...added('genre')],
    subjects: [...keep(SUBJECTS), ...added('subject')],
    tags: [...keep(TAGS), ...added('tag')],
    adaptations: [...keep(ADAPTATIONS), ...added('adaptation')],
    formats,
  };
  const byId = new Map<string, Term & { kind: Kind }>();
  for (const [kind, terms] of [
    ['genre', v.genres],
    ['subject', v.subjects],
    ['tag', v.tags],
    ['adaptation', v.adaptations],
    ['format', [...Object.values(formats), ...added('format')]],
  ] as [Kind, Term[]][])
    for (const t of terms) byId.set(t.id, { ...t, kind });
  const isDefault = list.removed.length === 0 && list.added.length === 0;
  const hash = createHash('sha1')
    .update(
      JSON.stringify(
        [...list.removed].sort().concat(list.added.map((a) => `${a.group}:${a.label}`).sort()),
      ),
    )
    .digest('hex')
    .slice(0, 10);
  return { ...v, byId, isDefault, hash };
}

export interface TagListView {
  groups: { id: TagGroup; title: string; tags: { label: string; builtIn: boolean }[] }[];
}

/** The list as Settings shows it (the user's own tags as their patterns). */
export function tagListView(list: TagListSetting, customTags: string[]): TagListView {
  const v = effectiveVocab(list);
  const builtIn = (g: VocabGroup, label: string) =>
    !list.added.some((a) => a.group === g && lower(a.label) === lower(label));
  const group = (id: VocabGroup, terms: Term[]) => ({
    id,
    title: GROUP_TITLES[id],
    tags: terms.map((t) => ({ label: t.ja, builtIn: builtIn(id, t.ja) })),
  });
  const formats = [
    ...Object.values(v.formats),
    ...list.added
      .filter((a) => a.group === 'format' && !list.removed.some((r) => lower(r) === lower(a.label)))
      .map((a) => ({ id: a.label, ja: a.label, en: a.label })),
  ] as Term[];
  return {
    groups: [
      group('format', formats),
      group('genre', v.genres),
      group('subject', v.subjects),
      group('tag', v.tags),
      group('adaptation', v.adaptations),
      {
        id: 'yours',
        title: GROUP_TITLES.yours,
        tags: customTags.map((t) => ({ label: t, builtIn: false })),
      },
    ],
  };
}

export class TagListError extends Error {}

/**
 * One change to the list: a label added to a group or taken off. Your tags are the cleanup's
 * customTags (a trailing * matches any ending). Returns both settings to save.
 */
export function changeTagList(
  list: TagListSetting,
  customTags: string[],
  change: { group: TagGroup; add?: string; remove?: string },
): { tagList: TagListSetting; customTags: string[] } {
  const next: TagListSetting = { removed: [...list.removed], added: [...list.added] };
  let custom = [...customTags];
  const label = (change.add ?? change.remove ?? '').trim();
  if (label === '' || [...label].length > 100)
    throw new TagListError('A tag is 1 to 100 characters');
  if (label.includes(',')) throw new TagListError('A tag can’t contain a comma');
  if (!(TAG_GROUPS as readonly string[]).includes(change.group))
    throw new TagListError(`No such group: ${change.group}`);
  const all = tagListView(list, customTags).groups.flatMap((g) =>
    g.tags.map((t) => ({ group: g.id, label: t.label })),
  );
  if (change.add !== undefined) {
    const there = all.find((t) => lower(t.label) === lower(label));
    if (there) throw new TagListError(`${label} is already in ${GROUP_TITLES[there.group]}`);
    if (change.group === 'yours') custom.push(label);
    else {
      const wasOff = next.removed.findIndex((r) => lower(r) === lower(label));
      if (wasOff >= 0 && builtInGroup(label) === change.group) next.removed.splice(wasOff, 1);
      else {
        if (wasOff >= 0) next.removed.splice(wasOff, 1);
        next.added.push({ group: change.group, label });
      }
    }
  } else {
    if (change.group === 'yours') custom = custom.filter((t) => lower(t) !== lower(label));
    else {
      const i = next.added.findIndex(
        (a) => a.group === change.group && lower(a.label) === lower(label),
      );
      if (i >= 0) next.added.splice(i, 1);
      else if (builtInGroup(label) === change.group) next.removed.push(label);
      else throw new TagListError(`${label} is not in ${GROUP_TITLES[change.group]}`);
    }
  }
  return { tagList: next, customTags: custom };
}

function builtInGroup(label: string): VocabGroup | null {
  const l = lower(label);
  for (const [g, terms] of [
    ['format', Object.values(FORMAT_TAGS)],
    ['genre', GENRES],
    ['subject', SUBJECTS],
    ['tag', TAGS],
    ['adaptation', ADAPTATIONS],
  ] as [VocabGroup, readonly Term[]][])
    if (terms.some((t) => lower(t.ja) === l)) return g;
  return null;
}

export function validTagList(value: unknown): TagListSetting {
  const v = (value ?? {}) as { removed?: unknown; added?: unknown };
  if (
    !Array.isArray(v.removed) ||
    !Array.isArray(v.added) ||
    v.removed.length > 500 ||
    v.added.length > 500
  )
    throw new TagListError('Tags you can pick must be a list');
  const removed = v.removed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  const added: TagListSetting['added'] = [];
  for (const a of v.added as { group?: unknown; label?: unknown }[]) {
    if (
      typeof a?.label !== 'string' ||
      a.label.trim() === '' ||
      a.label.includes(',') ||
      !(TAG_GROUPS as readonly string[]).includes(a.group as string) ||
      a.group === 'yours'
    )
      throw new TagListError('Each added tag needs a group and a label');
    added.push({ group: a.group as VocabGroup, label: a.label.trim() });
  }
  return { removed: removed.map((r) => r.trim()), added };
}

export { KIND_OF };
