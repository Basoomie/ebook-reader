/**
 * Season 2 Phase 12 session 5: characters found by the speaker model, merged across windows.
 *
 * Names are compared after `normalizeName` (NFKC, no spaces or separators, one honorific
 * removed). Two entries are joined only when a name or alias is *equal* after that, never by
 * substring: siblings share a family name. Generic forms of address (彼, 少女, ご主人様, …) stay
 * as aliases for the prompts but never join two entries. The model's own "same person" groups
 * are applied afterwards (`applyGroups`), and the user's list always wins (`seedFrom`).
 */

/** Honorifics and titles removed from the end of a name (longest first, once). */
const HONORIFICS = [
  'お兄ちゃん',
  'お姉ちゃん',
  '兄ちゃん',
  '姉ちゃん',
  'お兄さん',
  'お姉さん',
  '兄さん',
  '姉さん',
  'ちゃん',
  'さん',
  'くん',
  'さま',
  'どの',
  'たん',
  'っち',
  '先輩',
  '先生',
  '兄貴',
  '姉貴',
  '兄ィ',
  '殿下',
  '陛下',
  '閣下',
  '師匠',
  '団長',
  '隊長',
  '様',
  '殿',
  '氏',
  '君',
  '卿',
  '嬢',
].sort((a, b) => b.length - a.length);

/** Forms of address that never join two characters (they still help the prompts). */
const GENERIC = new Set(
  [
    '彼',
    '彼女',
    'あいつ',
    'こいつ',
    'そいつ',
    'あの人',
    '奴',
    'やつ',
    '男',
    '女',
    '少年',
    '少女',
    '青年',
    '老人',
    '子供',
    '子ども',
    '主',
    '主人',
    'ご主人',
    'ご主人様',
    '主君',
    'マスター',
    'お嬢',
    'お嬢様',
    '兄',
    '姉',
    '弟',
    '妹',
    '父',
    '母',
    'お父さん',
    'お母さん',
    '親父',
    'お袋',
    '俺',
    '僕',
    '私',
    'わたし',
    'あたし',
    'わたくし',
    'ぼく',
    'おれ',
    '大将',
    'リーダー',
    '王',
    '王様',
    '姫',
    '姫様',
    '先生',
    '団長',
    '隊長',
    '店主',
    '旦那',
    '旦那様',
    'お前',
    'あなた',
    'あんた',
    '君',
    '貴様',
    'ぬし',
    'お主',
    '相棒',
    '小僧',
    '娘',
    'ガキ',
    '兵士',
    '騎士',
    '商人',
    '村人',
    'メイド',
  ].map((s) => s.normalize('NFKC')),
);

const SEPARATORS = /[\s・･=＝·.。、,，]/gu;

/** A name as compared: NFKC, no separators, lower case, one honorific removed. */
export function normalizeName(name: string): string {
  const s = name.normalize('NFKC').replace(SEPARATORS, '').toLowerCase();
  for (const h of HONORIFICS) {
    const hn = h.normalize('NFKC');
    if (s.endsWith(hn) && Array.from(s).length - Array.from(hn).length >= 2) {
      return s.slice(0, s.length - hn.length);
    }
  }
  return s;
}

/**
 * A character's own name as compared for "one entry per name": like normalizeName, but a
 * generic word (兵士, 男) counts too. Empty for a first-person word.
 */
export function sameNameKey(name: string): string {
  if (isPronoun(name)) return '';
  return normalizeName(name) || name.normalize('NFKC').replace(SEPARATORS, '');
}

/** Whether a name may join two characters (not empty, not a generic form of address). */
export function isJoiningName(name: string): boolean {
  const n = name.normalize('NFKC').replace(SEPARATORS, '');
  return !!n && !GENERIC.has(n) && !GENERIC.has(normalizeName(name));
}

/** First-person words a model may give as a name (never a character's name). */
const PRONOUNS = new Set(
  [
    '俺',
    '僕',
    '私',
    'わたし',
    'あたし',
    'わたくし',
    'ぼく',
    'おれ',
    'わっち',
    'わし',
    '儂',
    'あたい',
    'うち',
    'ウチ',
    '我輩',
    '吾輩',
    '我',
    '妾',
    '拙者',
    '某',
    '俺様',
    '僕様',
    'ボク',
    'オレ',
    'ワタシ',
    'アタシ',
    '小生',
    '余',
    '朕',
  ].map((s) => s.normalize('NFKC')),
);

/** Whether a name is a first-person word. */
export function isPronoun(name: string): boolean {
  return PRONOUNS.has(name.normalize('NFKC').replace(SEPARATORS, ''));
}

/** Whether two characters' names overlap: one name or alias inside another (2+ characters). */
export function namesOverlap(
  a: { name: string; aliases: string[] },
  b: { name: string; aliases: string[] },
): boolean {
  const forms = (c: { name: string; aliases: string[] }) =>
    [c.name, ...c.aliases]
      .filter(isJoiningName)
      .map(normalizeName)
      .filter((s) => Array.from(s).length >= 2);
  const fb = forms(b);
  return forms(a).some((x) => fb.some((y) => x.includes(y) || y.includes(x)));
}

export type Gender = '男' | '女' | '不明';

/** One character as one window of the book listed it. */
export interface FoundCharacter {
  name: string;
  aliases: string[];
  firstPerson: string[];
  gender: Gender;
  /** The stage-1 window it was found in. */
  window: number;
}

/** A merged character. */
export interface MergedCharacter {
  /** Stable within a run; C<id> in the prompts. */
  id: number;
  name: string;
  aliases: string[];
  firstPerson: string[];
  gender: Gender;
  /** The stage-1 windows it appears in. */
  windows: number[];
  narrator: boolean;
  /** Set for characters the user made or edited (seedFrom): never renamed by a run. */
  fixed?: boolean;
  /**
   * "Not a character" (the user): kept so its names still map to it, never offered as a
   * speaker in the prompts.
   */
  hidden?: boolean;
}

function uniq(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function mostCommon<T>(items: T[], fallback: T): T {
  const count = new Map<T, number>();
  let best = fallback;
  let bestN = 0;
  for (const it of items) {
    const n = (count.get(it) ?? 0) + 1;
    count.set(it, n);
    if (n > bestN) {
      best = it;
      bestN = n;
    }
  }
  return best;
}

/**
 * Merges what the windows found into one list. `seed` (the user's current characters, or an
 * earlier run's) keeps its ids, names and order; new characters get the next ids.
 */
export class CharacterMerger {
  private readonly list: MergedCharacter[] = [];
  /**
   * Per character, the names it was listed *as* (a window's `name`, and every name of the
   * user's own list), and separately the other names the model gave it. A new entry joins a
   * character when its name is one of those names, else one of its aliases; or when one of
   * its aliases is one of the character's names. Two aliases never join (the model gives
   * descriptions such as 旅の連れ to several people).
   */
  private readonly names = new Map<number, Set<string>>();
  private readonly aliasForms = new Map<number, Set<string>>();
  /** How often each id was listed under each name (the most common becomes the name). */
  private readonly nameVotes = new Map<number, string[]>();
  /** Every id joined into another (groups, same names): from -> into. */
  private readonly joinedInto = new Map<number, number>();
  private nextId = 1;

  constructor(seed: MergedCharacter[] = []) {
    for (const c of seed) {
      this.list.push({
        ...c,
        aliases: [...c.aliases],
        firstPerson: [...c.firstPerson],
        windows: [...c.windows],
      });
      this.nextId = Math.max(this.nextId, c.id + 1);
      for (const n of [c.name, ...c.aliases]) this.form(this.names, c.id, n);
    }
  }

  private form(map: Map<number, Set<string>>, id: number, name: string): void {
    if (!isJoiningName(name)) return;
    const set = map.get(id) ?? new Set<string>();
    set.add(normalizeName(name));
    map.set(id, set);
  }

  /** The one character whose `map` forms hold `name` (ambiguous or none: null). */
  private only(map: Map<number, Set<string>>, names: string[]): number | null {
    const hits = new Set<number>();
    for (const n of names) {
      if (!isJoiningName(n)) continue;
      const k = normalizeName(n);
      for (const [id, set] of map) if (set.has(k)) hits.add(id);
    }
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1 && map === this.names) {
      // Listed under the same name twice (should not happen): the more frequent one.
      return [...hits].sort(
        (a, b) => (this.byId(b)?.windows.length ?? 0) - (this.byId(a)?.windows.length ?? 0),
      )[0];
    }
    return null;
  }

  private find(name: string, aliases: string[] = []): number | null {
    return (
      this.only(this.names, [name]) ??
      this.only(this.aliasForms, [name]) ??
      (aliases.length ? this.only(this.names, aliases) : null) ??
      this.named(name)
    );
  }

  /**
   * The character called `name` now, generic words included (one entry per name, decided with
   * the user 2026-11-17: every unnamed 兵士 is one "兵士" with one voice).
   */
  private named(name: string): number | null {
    const k = sameNameKey(name);
    if (!k) return null;
    const hits = this.list.filter((c) => sameNameKey(c.name) === k);
    if (!hits.length) return null;
    return hits.sort((a, b) => b.windows.length - a.windows.length || a.id - b.id)[0].id;
  }

  /**
   * Joins characters with the same name (a rename by the most common name can make two),
   * keeping the user's one, else the one most windows list. Two of the user's characters stay
   * apart (the user decides). Returns the ids that were joined into another.
   */
  joinSameNames(): Map<number, number> {
    const moved = new Map<number, number>();
    const byKey = new Map<string, MergedCharacter[]>();
    for (const c of this.list) {
      const k = sameNameKey(c.name);
      if (!k) continue;
      byKey.set(k, [...(byKey.get(k) ?? []), c]);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort(
        (a, b) =>
          Number(!!(b.fixed || b.hidden)) - Number(!!(a.fixed || a.hidden)) ||
          b.windows.length - a.windows.length ||
          a.id - b.id,
      );
      const keep = group[0];
      for (const other of group.slice(1)) {
        if ((other.fixed || other.hidden) && (keep.fixed || keep.hidden)) continue;
        this.join(keep, other);
        moved.set(other.id, keep.id);
      }
    }
    return moved;
  }

  byId(id: number): MergedCharacter | undefined {
    return this.list.find((c) => c.id === id);
  }

  /**
   * Adds one window's character; returns its id (null: no usable name). A name that is a
   * first-person word (わっち, 我輩: step A found 'わっち' as Holo's name) gives way to the
   * first alias that is a name.
   */
  add(f: FoundCharacter): number | null {
    if (isPronoun(f.name) || f.firstPerson.some((w) => w.trim() === f.name.trim())) {
      const alias = f.aliases.find((a) => isJoiningName(a) && !isPronoun(a));
      if (!alias) return null;
      f = {
        ...f,
        name: alias,
        aliases: f.aliases.filter((a) => a !== alias),
        firstPerson: uniq([...f.firstPerson, f.name]),
      };
    }
    const names = uniq([f.name, ...f.aliases]);
    let id = this.find(f.name, f.aliases);
    let c = id === null ? undefined : this.byId(id);
    if (!c) {
      id = this.nextId++;
      c = {
        id,
        name: f.name.trim(),
        aliases: [],
        firstPerson: [],
        gender: f.gender,
        windows: [],
        narrator: false,
      };
      this.list.push(c);
    }
    const cid = c.id;
    c.aliases = uniq([...c.aliases, ...names]).filter((n) => n !== c!.name);
    c.firstPerson = uniq([...c.firstPerson, ...f.firstPerson]);
    if (c.gender === '不明') c.gender = f.gender;
    if (!c.windows.includes(f.window)) c.windows.push(f.window);
    if (!c.fixed) {
      const votes = this.nameVotes.get(cid) ?? [];
      votes.push(f.name.trim());
      this.nameVotes.set(cid, votes);
      const name = mostCommon(votes, c.name);
      if (name !== c.name) {
        c.aliases = uniq([...c.aliases, c.name]).filter((n) => n !== name);
        c.name = name;
      }
    }
    this.form(this.names, cid, f.name);
    for (const n of f.aliases) this.form(this.aliasForms, cid, n);
    return cid;
  }

  /**
   * Joins characters the model named as one person (the first id of a group stays), but only
   * two whose names overlap (ナツキ in ナツキ・スバル, ライト and its alias ダーク): in step A the
   * model's groups joined different people twice (ユーグ with フラン, エミリア with ベアトリス),
   * which would give them one voice. A missed join is one tap for the user; a wrong one isn't.
   */
  applyGroups(groups: number[][]): void {
    for (const g of groups) {
      const ids = g.filter((id) => this.byId(id));
      if (ids.length < 2) continue;
      // A fixed (user) character stays the one kept.
      ids.sort((a, b) => Number(!!this.byId(b)!.fixed) - Number(!!this.byId(a)!.fixed) || a - b);
      const keep = this.byId(ids[0])!;
      for (const id of ids.slice(1)) {
        const other = this.byId(id)!;
        if (other.fixed && keep.fixed) continue; // two of the user's characters: the user decides
        if (!namesOverlap(keep, other)) continue;
        this.join(keep, other);
      }
    }
  }

  /** `other` becomes part of `keep` (names, first-person words, windows, name votes). */
  private join(keep: MergedCharacter, other: MergedCharacter): void {
    const id = other.id;
    keep.aliases = uniq([...keep.aliases, other.name, ...other.aliases]).filter(
      (n) => n !== keep.name,
    );
    keep.firstPerson = uniq([...keep.firstPerson, ...other.firstPerson]);
    keep.windows = [...new Set([...keep.windows, ...other.windows])].sort((a, b) => a - b);
    keep.narrator = keep.narrator || other.narrator;
    if (keep.gender === '不明') keep.gender = other.gender;
    this.list.splice(this.list.indexOf(other), 1);
    for (const map of [this.names, this.aliasForms]) {
      const into = map.get(keep.id) ?? new Set<string>();
      for (const k of map.get(id) ?? []) into.add(k);
      map.set(keep.id, into);
      map.delete(id);
    }
    const votes = [...(this.nameVotes.get(keep.id) ?? []), ...(this.nameVotes.get(id) ?? [])];
    this.nameVotes.set(keep.id, votes);
    this.nameVotes.delete(id);
    this.joinedInto.set(id, keep.id);
    for (const [from, into] of this.joinedInto) if (into === id) this.joinedInto.set(from, keep.id);
    if (!keep.fixed) {
      const name = mostCommon(votes, keep.name);
      if (name !== keep.name) {
        keep.aliases = uniq([...keep.aliases, keep.name]).filter((n) => n !== name);
        keep.name = name;
      }
    }
  }

  /** Marks the narrator (by name; added when not found). Returns its id. */
  setNarrator(name: string): number | null {
    for (const c of this.list) c.narrator = false;
    const id =
      this.find(name) ??
      this.add({ name, aliases: [], firstPerson: [], gender: '不明', window: -1 });
    if (id === null) return null;
    this.byId(id)!.narrator = true;
    return id;
  }

  /** The id of a name, if known. */
  idOf(name: string): number | null {
    return this.find(name);
  }

  /** The ids joined into another, with the one each is part of now. */
  joined(): [number, number][] {
    return [...this.joinedInto];
  }

  characters(): MergedCharacter[] {
    return this.list.map((c) => ({ ...c, windows: [...c.windows].sort((a, b) => a - b) }));
  }
}
