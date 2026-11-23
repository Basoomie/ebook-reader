/**
 * Stage 5 (WP20f): the fixed vocabulary of genres, nonfiction subjects, tags and format tags,
 * each with a fixed id and its Japanese and English labels (library-cleanup-plan.md section 7,
 * approved 2026-11-13; スポーツ added after the genre test). Calibre gets the Japanese labels, so
 * switching language later is one rename with no new analysis.
 *
 * Also the RanobeDB mapping (approved with the WP20f plan, 2026-11-21: the genre test's
 * `score_genre.py` is lost), the store-category rules and the tag removals (Appendix A of the
 * plan).
 */
import type { Format } from '../stage4/rules-v3';

export interface Term {
  id: string;
  ja: string;
  en: string;
  /** A hint for the models, as the genre test's prompt gave it. */
  hint?: string;
}

export const GENRES: readonly Term[] = [
  { id: 'fantasy', ja: 'ファンタジー', en: 'Fantasy' },
  {
    id: 'isekai',
    ja: '異世界',
    en: 'Isekai',
    hint: 'transported to or reborn in another world',
  },
  { id: 'romance', ja: '恋愛', en: 'Romance' },
  { id: 'romcom', ja: 'ラブコメ', en: 'Romantic comedy' },
  { id: 'comedy', ja: 'コメディ', en: 'Comedy' },
  { id: 'action', ja: 'バトル・アクション', en: 'Action' },
  { id: 'adventure', ja: '冒険', en: 'Adventure' },
  { id: 'school', ja: '学園', en: 'School', hint: 'school setting' },
  { id: 'slice', ja: '日常', en: 'Slice of life', hint: 'slice of life' },
  { id: 'drama', ja: 'ヒューマンドラマ', en: 'Drama' },
  { id: 'youth', ja: '青春', en: 'Coming of age', hint: 'coming of age' },
  { id: 'mystery', ja: 'ミステリー・サスペンス', en: 'Mystery & suspense' },
  { id: 'horror', ja: 'ホラー・怪異', en: 'Horror & supernatural' },
  { id: 'scifi', ja: 'SF', en: 'Sci-fi' },
  { id: 'historical', ja: '歴史・時代', en: 'Historical' },
  { id: 'war', ja: '戦記・ミリタリー', en: 'War & military' },
  { id: 'yuri', ja: '百合', en: "Girls' love", hint: 'girls love' },
  { id: 'bl', ja: 'ボーイズラブ', en: "Boys' love" },
  { id: 'tl', ja: 'ティーンズラブ', en: "Teens' love", hint: "women's erotic romance" },
  { id: 'ecchi', ja: 'お色気', en: 'Ecchi', hint: 'suggestive, not explicit' },
  { id: 'adult', ja: '官能', en: 'Adult', hint: 'sexually explicit' },
  { id: 'sports', ja: 'スポーツ', en: 'Sports' },
];

export const SUBJECTS: readonly Term[] = [
  { id: 'nf_business', ja: 'ビジネス・経済', en: 'Business & economics' },
  { id: 'nf_selfhelp', ja: '自己啓発', en: 'Self-help' },
  { id: 'nf_psych', ja: '心理', en: 'Psychology' },
  { id: 'nf_relationships', ja: '恋愛・人間関係', en: 'Love & relationships' },
  { id: 'nf_history', ja: '歴史', en: 'History' },
  { id: 'nf_philosophy', ja: '哲学・思想', en: 'Philosophy' },
  { id: 'nf_religion', ja: '宗教', en: 'Religion' },
  { id: 'nf_science', ja: '科学・技術', en: 'Science & technology' },
  { id: 'nf_society', ja: '社会', en: 'Society' },
  { id: 'nf_criticism', ja: '評論・文学研究', en: 'Criticism & literary studies' },
  { id: 'nf_essay', ja: 'エッセイ', en: 'Essays' },
  { id: 'nf_living', ja: '暮らし・健康・料理', en: 'Living, health & cooking' },
  { id: 'nf_hobby', ja: '趣味・実用', en: 'Hobbies & how-to' },
  { id: 'nf_study', ja: '学習・資格', en: 'Study & qualifications' },
];

export const TAGS: readonly Term[] = [
  { id: 'male_lead', ja: '男性主人公', en: 'Male protagonist' },
  { id: 'female_lead', ja: '女性主人公', en: 'Female protagonist' },
  { id: 'reincarnation', ja: '転生', en: 'Reincarnation' },
  { id: 'harem', ja: 'ハーレム', en: 'Harem' },
  { id: 'magic', ja: '魔法', en: 'Magic' },
  { id: 'op_lead', ja: '最強主人公', en: 'Overpowered protagonist' },
  { id: 'villainess', ja: '悪役令嬢', en: 'Villainess' },
  { id: 'otome_game', ja: '乙女ゲーム', en: 'Otome game' },
  {
    id: 'game_world',
    ja: 'ゲーム要素',
    en: 'Game elements',
    hint: 'game systems, levels, RPG',
  },
  { id: 'dungeon', ja: 'ダンジョン', en: 'Dungeon' },
  { id: 'sword_sorcery', ja: '剣と魔法', en: 'Sword and sorcery' },
  { id: 'dark', ja: 'ダーク', en: 'Dark' },
  { id: 'modern', ja: '現代', en: 'Modern day' },
  { id: 'nobility', ja: '貴族', en: 'Nobility' },
  { id: 'heartwarming', ja: 'ほのぼの', en: 'Heartwarming' },
  { id: 'family', ja: '家族', en: 'Family' },
  { id: 'strong_heroine', ja: '強いヒロイン', en: 'Strong female lead' },
  { id: 'monsters', ja: 'モンスター', en: 'Monsters' },
  { id: 'revenge', ja: '復讐', en: 'Revenge' },
  { id: 'time_travel', ja: 'タイムトラベル', en: 'Time travel' },
  { id: 'survival', ja: 'サバイバル', en: 'Survival' },
  { id: 'magic_academy', ja: '魔法学園', en: 'Magic academy' },
  { id: 'gender_bender', ja: '性転換', en: 'Gender bender' },
  { id: 'superpowers', ja: '超能力', en: 'Superpowers' },
  { id: 'animals', ja: '動物', en: 'Animals' },
  { id: 'childhood_friend', ja: '幼なじみ', en: 'Childhood friend' },
  { id: 'dragons', ja: 'ドラゴン', en: 'Dragons' },
  { id: 'knights', ja: '騎士', en: 'Knights' },
  { id: 'demons', ja: '悪魔・魔族・魔王', en: 'Demons and demon lords' },
  { id: 'business', ja: '商売・経営', en: 'Business' },
  { id: 'cooking', ja: '料理・グルメ', en: 'Food and cooking' },
  { id: 'elf', ja: 'エルフ', en: 'Elves' },
  { id: 'mecha', ja: 'ロボット・メカ', en: 'Mecha' },
  { id: 'witch', ja: '魔女', en: 'Witches' },
  { id: 'maid', ja: 'メイド', en: 'Maids' },
  { id: 'princess', ja: '姫', en: 'Princesses' },
  { id: 'marriage', ja: '結婚', en: 'Marriage' },
  { id: 'vampire', ja: '吸血鬼', en: 'Vampires' },
  { id: 'monster_girls', ja: 'モンスター娘', en: 'Monster girls' },
  { id: 'slow_life', ja: 'スローライフ', en: 'Slow life' },
  { id: 'crime', ja: '犯罪', en: 'Crime' },
  { id: 'personal_growth', ja: '成長', en: 'Personal growth' },
  { id: 'friendship', ja: '友情', en: 'Friendship' },
];

/** The adaptation tags (from RanobeDB's tie-ins or a description that states it; never guessed). */
export const ADAPTATIONS: readonly Term[] = [
  { id: 'anime', ja: 'アニメ化', en: 'Anime adaptation' },
  { id: 'manga', ja: 'コミカライズ', en: 'Manga adaptation' },
];

/** The format tags (decided with the user 2026-11-21). */
export const FORMAT_TAGS: Record<Format, Term> = {
  'light novel': { id: 'fmt_light_novel', ja: 'ライトノベル', en: 'Light novel' },
  novel: { id: 'fmt_novel', ja: '小説', en: 'Novel' },
  nonfiction: { id: 'fmt_nonfiction', ja: 'ノンフィクション', en: 'Nonfiction' },
  manga: { id: 'fmt_manga', ja: 'マンガ', en: 'Manga' },
  'image-only': { id: 'fmt_image_only', ja: '画像のみ', en: 'Image-only' },
};

export type Kind = 'genre' | 'subject' | 'tag' | 'adaptation' | 'format';

const ALL: [Kind, readonly Term[]][] = [
  ['genre', GENRES],
  ['subject', SUBJECTS],
  ['tag', TAGS],
  ['adaptation', ADAPTATIONS],
  ['format', Object.values(FORMAT_TAGS)],
];

/** Every term by its id. */
export const BY_ID: ReadonlyMap<string, Term & { kind: Kind }> = new Map(
  ALL.flatMap(([kind, list]) => list.map((t) => [t.id, { ...t, kind }] as const)),
);

export const GENRE_IDS = new Set(GENRES.map((t) => t.id));
export const SUBJECT_IDS = new Set(SUBJECTS.map((t) => t.id));
export const TAG_IDS = new Set(TAGS.map((t) => t.id));

/** The Japanese label Calibre gets. */
export function label(id: string): string {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`No such genre or tag: ${id}`);
  return t.ja;
}

/**
 * An answer's term as an id: the id itself, or its Japanese label (Luna answered with labels in
 * 174 of 235 books of the genre test; labels are unique), with or without the test prompt's hint
 * in brackets. Unknown = null (dropped and counted).
 */
export function termId(raw: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (allowed.has(s)) return s;
  const bare = s.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
  for (const id of allowed) {
    // A tag added to "Tags you can pick" has its label as its id (matched above).
    const t = BY_ID.get(id);
    if (!t) {
      if (id === bare) return id;
      continue;
    }
    if (t.ja === s || t.ja === bare || t.id === bare.toLowerCase()) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// RanobeDB (Appendix B of the WP20f plan; a series' tags are typed genre or tag)

/** RanobeDB genre/tag name → our ids. */
export const RANOBEDB_MAP: Readonly<Record<string, readonly string[]>> = {
  // genres
  fantasy: ['fantasy'],
  'high fantasy': ['fantasy'],
  'dark fantasy': ['fantasy', 'dark'],
  'historical fantasy': ['fantasy'],
  'romantic fantasy': ['fantasy'],
  isekai: ['isekai'],
  reincarnation: ['isekai', 'reincarnation'],
  romance: ['romance'],
  comedy: ['comedy'],
  action: ['action'],
  adventure: ['adventure'],
  school: ['school'],
  'high school': ['school'],
  'school life': ['school'],
  academy: ['school'],
  'slice of life': ['slice'],
  drama: ['drama'],
  mystery: ['mystery'],
  thriller: ['mystery'],
  horror: ['horror'],
  supernatural: ['horror'],
  'sci-fi': ['scifi'],
  historical: ['historical'],
  'period piece': ['historical'],
  war: ['war'],
  military: ['war'],
  'girls love': ['yuri'],
  'boys love': ['bl'],
  ecchi: ['ecchi'],
  hentai: ['adult'],
  // tags
  'male protagonist': ['male_lead'],
  'female protagonist': ['female_lead'],
  'past life': ['reincarnation'],
  'reincarnated as the villain': ['reincarnation', 'villainess'],
  harem: ['harem'],
  magic: ['magic'],
  'op protagonist': ['op_lead'],
  overpowered: ['op_lead'],
  'op power': ['op_lead'],
  villainess: ['villainess'],
  'otome game': ['otome_game'],
  'game elements': ['game_world'],
  rpg: ['game_world'],
  vrmmo: ['game_world'],
  dungeon: ['dungeon'],
  'dungeon diving': ['dungeon'],
  'sword and sorcery': ['sword_sorcery'],
  dark: ['dark'],
  'modern day': ['modern'],
  nobility: ['nobility'],
  aristocracy: ['nobility'],
  heartwarming: ['heartwarming'],
  family: ['family'],
  'strong female lead': ['strong_heroine'],
  monsters: ['monsters'],
  revenge: ['revenge'],
  'time travel': ['time_travel'],
  survival: ['survival'],
  'magic academy': ['magic_academy'],
  'gender bender': ['gender_bender'],
  superpowers: ['superpowers'],
  animals: ['animals'],
  'childhood friend': ['childhood_friend'],
  dragons: ['dragons'],
  knights: ['knights'],
  demons: ['demons'],
  'demon lord': ['demons'],
  business: ['business'],
  cooking: ['cooking'],
  food: ['cooking'],
  elf: ['elf'],
  mecha: ['mecha'],
  witch: ['witch'],
  maid: ['maid'],
  princess: ['princess'],
  marriage: ['marriage'],
  'political marriage': ['marriage'],
  'contract marriage': ['marriage'],
  vampire: ['vampire'],
  'monster girls': ['monster_girls'],
  'slow life': ['slow_life'],
  crime: ['crime'],
  'personal growth': ['personal_growth'],
  friendship: ['friendship'],
  'anime tie-in': ['anime'],
  'manga tie-in': ['manga'],
};

/** A RanobeDB series' tags as our ids (romance + comedy also make romcom: section 7's table). */
export function fromRanobedb(tags: readonly { name?: unknown; type?: unknown }[]): string[] {
  const names = new Set(
    tags.map((t) => (typeof t.name === 'string' ? t.name.trim().toLowerCase() : '')),
  );
  const out = new Set<string>();
  for (const n of names) for (const id of RANOBEDB_MAP[n] ?? []) out.add(id);
  if (names.has('romance') && names.has('comedy')) out.add('romcom');
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------
// Store categories (the identified Amazon record's menu path and ranking categories)

const BL_CATEGORIES =
  /^ボーイズラブ(ノベルス|マンガ|コミックス)?(\s*[(（](Kindleストア|本)[)）])?$/;
const TL_CATEGORIES = /^ティーンズラブ(\s*[(（](Kindleストア|本)[)）])?$/;
const ADULT_CATEGORIES = new Set([
  '二次元ドリーム文庫',
  '美少女文庫',
  'ぷちぱら文庫',
  'オトナ文庫',
  'アダルト',
  'アダルト (Kindleストア)',
  'アダルト小説・サブカルチャー',
]);

/** The genres a store category settles by itself: BL, TL and adult imprints. */
export function fromStoreCategories(categories: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of categories) {
    const c = raw.trim();
    if (BL_CATEGORIES.test(c)) out.add('bl');
    if (TL_CATEGORIES.test(c)) out.add('tl');
    if (ADULT_CATEGORIES.has(c)) out.add('adult');
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------
// Tags removed (Appendix A of the WP20f plan, approved by the user 2026-11-21)

/** The workflow tags (the four Google-run ones are recorded in calibre_marks before removal). */
export const WORKFLOW_TAGS = [
  'not_uploaded',
  'curated',
  'ln',
  'needs-metadata',
  'metadata-processed',
  'metadata-unmatched',
  'missing-metadata',
] as const;

/** The Google-run workflow marks whose books are recorded first (stage 2/4 rules read them). */
export const RECORDED_MARKS = [
  'needs-metadata',
  'metadata-processed',
  'metadata-unmatched',
  'missing-metadata',
] as const;

/**
 * The Google Books run's subject categories (BISAC-style English categories found only on books
 * the run touched; measured 2026-11-21 on the live snapshot, 274 tags on 8,189 books).
 */
export const GOOGLE_CATEGORIES: readonly string[] = [
  'Young Adult Fiction',
  'Light Novel (Ranobe)',
  'General',
  'Comics & Graphic Novels',
  'fiction',
  'Light Novel',
  'Romance',
  'Literary Collections',
  'Japanese',
  'Asian',
  'Manga',
  'Fantasy',
  'Reference',
  'Language Arts & Disciplines',
  'For boys',
  'Gay',
  'Erotica',
  'For men',
  'Encyclopedias',
  'Juvenile Fiction',
  'Mystery & Detective',
  'Library & Information Science',
  'For women',
  'Action & Adventure',
  'Science Fiction',
  'LGBT',
  'Journalism',
  'LGBTQ+',
  'Bibliographies & Indexes',
  'East Asian Style',
  'Drama',
  'Horror',
  'Comedy',
  'Business & Economics',
  'Social Science',
  'Essays',
  'Yaoi',
  'Philosophy',
  'Crafts & Hobbies',
  'Yearbooks & Annuals',
  'Self-Help',
  'Humorous',
  'Classics',
  'History',
  'For girls',
  'Suspense',
  'Occult & Supernatural',
  'Academic & Learning',
  'Biography & Autobiography',
  'Thrillers',
  'Language Study',
  'Cooking',
  "Yaoi (Boys' Love)",
  'Religion',
  'Literary',
  'Computers',
  'Isekai',
  'Education',
  'Cataloging & Classification',
  'Science',
  'Personal & Practical Guides',
  'Archives & Special Libraries',
  'Historical',
  'Health & Fitness',
  'Collections & Anthologies',
  'Buddhism',
  'Administration & Management',
  'Travel',
  'Political Science',
  'Media Tie-In',
  'Information Technology',
  'Foreign Language Study',
  'Family & Relationships',
  'Erotica & Hentai',
  'Asia',
  'Technology & Engineering',
  'Magazines',
  'Literary Criticism',
  'Juvenile Nonfiction',
  'Fashion & Accessories',
  'Everyday life',
  'Design',
  'Chinese',
  'Tie in',
  'Sociology',
  'Personal Growth',
  'Methods',
  'Medical',
  'Japan',
  'House & Home',
  'Ethics & Moral Philosophy',
  'Art',
  'Anthropology',
  'Sports & Recreation',
  'Sports',
  'School & Education',
  'Psychology',
  'Personal Finance',
  'Mysteries & Detective Stories',
  'Music',
  'Management',
  'Food',
  'European',
  'Epic',
  'Diet & Nutrition',
  'Dictionaries',
  'Crime & Mystery',
  'Contemporary',
  'Chemistry',
  'Body; Mind & Spirit',
  'World War II',
  'Study Aids',
  'Study & Teaching',
  'Science & Nature',
  'Regional & Ethnic',
  'Quick & Easy',
  'Public Speaking & Speech Writing',
  'Places',
  'Physics',
  'Miscellaneous',
  'Military',
  'Magical Realism',
  'Love & Romance',
  'Linguistics',
  'International Relations',
  'Humor',
  'Historical Fiction',
  'Health & Healing',
  'Hard Science Fiction',
  'Happiness',
  'Form',
  'Europe',
  'Environmental Science',
  'Cultural & Social',
  'Careers',
  "Yuri (Girls' Love)",
  'Young Adult',
  'World',
  'Wizards & Witches',
  'Witches & Wizards',
  'Witchcraft',
  'Weight Loss',
  'Water Supply',
  'Wars & Conflicts',
  'Vitamins & Supplements',
  'Violence in Society',
  'Video Game Art',
  'Video & Electronic',
  'United States',
  'Training',
  'Trade & Tariffs',
  'Theory',
  'Tests',
  'Telecommunications',
  'Teenagers',
  'Techniques',
  'Success',
  'Subjects & Themes',
  'Stories in Verse',
  'Spreadsheets',
  'Spanish & Portuguese',
  'Software Development & Engineering',
  'Social Themes',
  'Social Psychology',
  'Short Stories (single author)',
  'Security (National & International)',
  'Sea Stories',
  'Science Fiction & Fantasy',
  'School Media',
  'Religious',
  'Religion; Politics & State',
  'Real Estate',
  'Public Policy',
  'Programming',
  'Poverty & Homelessness',
  'Popular Culture',
  'Poetry',
  'Photography',
  'Personal Success',
  'Personal Memoirs',
  'Performing Arts',
  'Outdoor Skills',
  'Occupational & Industrial Medicine',
  'Occultism',
  'Nutrition',
  'Nonfiction',
  'Non-Alcoholic',
  'New Testament',
  'Nature',
  'Native American & Aboriginal',
  'Motivational & Inspirational',
  'Money Management',
  'Medieval',
  'Manufacturing',
  'Magick Studies',
  'Magic',
  'Literary Criticism & Collections',
  'Life Stages',
  'Lgbtq',
  'Legal History',
  'Law',
  'Latin',
  'Languages',
  'Judaism',
  'Investments & Securities',
  'Instruction & Study',
  'Industrial & Technical',
  'Hydrology',
  'Humour',
  'Healthy Living',
  'Health Care Issues',
  'Government & Business',
  'Gothic',
  'Ghost',
  'German',
  'General Epistles',
  'Games & Activities',
  'Friendship',
  'Film',
  'Fashion',
  'Fantasy & Magic',
  'Family',
  'Fairy Tales; Folk Tales; Legends & Mythology',
  'Expert Systems',
  'Environmental Conservation & Protection',
  'Environmental',
  'English; Irish; Scottish; Welsh',
  'English as a Second Language',
  'Engineering (General)',
  'Economic Policy',
  'Economic History',
  'Earth Sciences',
  'Divination',
  'Discrimination',
  'Diplomacy',
  'Diets',
  'Diaries & Journals',
  'Desktop Applications',
  'Databases',
  'Data Science',
  'Data Modeling & Design',
  'Cyberpunk',
  'Curiosities & Wonders',
  'Cultural',
  'Crime',
  'Courses & Dishes',
  'Cooking & Gourmet',
  'Confucianism',
  'Comic Strips & Cartoons',
  'Civil',
  'Christian Theology',
  'China',
  "Children's Books & Fairy Tales",
  'Certification Guides',
  'Cartooning',
  'Cakes',
  'Business Writing',
  'Business Communication',
  'Books & Reading',
  'Book Notes',
  'Body Art & Tattooing',
  'Boarding School & Prep School',
  'Biblical Studies',
  'Biblical Commentary',
  'Beverages',
  'Banks & Banking',
  'Astronomy',
  'Artificial Intelligence',
  'Animals',
  'Ancient & Classical',
  'Ancient',
  'Africa',
  'Adventure',
  '20th Century',
];

const REMOVED = new Set([...WORKFLOW_TAGS, ...GOOGLE_CATEGORIES].map((t) => t.toLowerCase()));

/** Whether stage 5 removes this tag (case-insensitive, as Calibre compares tags). */
export function isRemovedTag(tag: string): boolean {
  return REMOVED.has(tag.trim().toLowerCase());
}
