/**
 * WP21d tests: a cleanup.db with a finished stage 4 (units, candidates, store records, the
 * representative files' tags), as stage 5 reads it. Built from the live cases of the labeled
 * books (源氏物語, ホモ・デウス, 私が殺した少女, 本好き ドラマCD, imprint titles, ...).
 */
import type Database from 'better-sqlite3';
import { gzipSync } from 'zlib';
import type { SeriesRef, StoreRecord } from '../../src/cleanup/audio/online-pages';

export interface SeedUnit {
  key: string;
  /** The unit's name (also how the AI stand-in finds the unit in a prompt). */
  name: string;
  /** Torrent-relative path of the representative file. */
  path: string;
  minutes: number;
  labeled?: boolean;
  kind?: 'lookup' | 'none_expected';
  cls: 'auto' | 'review' | 'unknown' | 'none_expected';
  reason?: string | null;
  record?: StoreRecord | null;
  /** Review units: other candidates (verdict pass/fail). */
  candidates?: { record: StoreRecord; verdict: string }[];
  tags?: Record<string, string> | null;
  facts?: Partial<{
    title: string;
    authors: string[];
    narrators: string[];
    volume: string | null;
    drama: { number: string | null } | null;
  }>;
}

export function audible(
  asin: string,
  over: Partial<StoreRecord> & { description?: string; format?: string; series?: SeriesRef[] } = {},
): StoreRecord {
  const { description, format, ...rest } = over;
  return {
    source: 'audible',
    id: asin,
    title: 'Title',
    subtitle: null,
    authors: [],
    narrators: [],
    seconds: 600 * 60,
    publisher: 'KADOKAWA',
    releaseDate: '2021-05-20',
    series: [],
    ...rest,
    extra: {
      asin,
      language: 'japanese',
      format_type: format ?? 'unabridged',
      publisher_summary: description ?? '<p>あらすじ。</p>',
      product_images: { 500: `https://m.media-amazon.com/images/I/${asin}._SL500_.jpg` },
    },
  };
}

export function seedStage4(db: Database.Database, units: SeedUnit[], analysisId = 's4-test'): void {
  const now = Date.now();
  let fileId = 0;
  const putFile = db.prepare(
    `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, first_seen_at, seen_at)
     VALUES ('torrents', ?, ?, 'audio', 1000, 1, 1, ?, 1, ?, ?)`,
  );
  const putHealth = db.prepare(
    `INSERT INTO audio_file_health (file_id, size, mtime_ms, duration, tags_json, header_ok, checked_at)
     VALUES (?, 1000, 1, ?, ?, 1, ?)`,
  );
  const putUnit = db.prepare(
    `INSERT INTO audio_online_units (analysis_id, unit_key, copy_keys, book_keys, name, seconds, labeled, kind,
       state, inputs_json, class, source, store_id, review_reason, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'decided', ?, ?, ?, ?, ?, ?)`,
  );
  const putCand = db.prepare(
    `INSERT INTO audio_online_candidates (unit_id, source, store_id, via, checks_json, verdict)
     VALUES (?, ?, ?, 'test', '{}', ?)`,
  );
  const putRec = db.prepare(
    `INSERT OR REPLACE INTO audio_online_records (source, store_id, request_id, record, fetched_at)
     VALUES (?, ?, NULL, ?, ?)`,
  );
  db.transaction(() => {
    for (const u of units) {
      const id = putFile.run(u.path, u.path.split('.').pop() ?? 'm4b', ++fileId, now, now)
        .lastInsertRowid as number;
      putHealth.run(id, u.minutes * 60, u.tags ? JSON.stringify(u.tags) : null, now);
      const facts = {
        title: u.facts?.title ?? u.name,
        otherTitles: [],
        seriesTitles: [],
        authors: u.facts?.authors ?? [],
        narrators: u.facts?.narrators ?? [],
        volume: u.facts?.volume ?? null,
        drama: u.facts?.drama ?? null,
        seconds: u.minutes * 60,
        files: 1,
      };
      const inputs = {
        facts,
        queries: [],
        asins: [],
        absAsins: [],
        kikubon: null,
        audiobookJp: null,
        paths: [`torrents:${u.path}`],
        opening: [
          {
            id,
            root: 'torrents',
            rel: u.path,
            raw: null,
            size: 1000,
            mtime: 1,
            sha256: null,
            duration: u.minutes * 60,
          },
        ],
      };
      const unitId = putUnit.run(
        analysisId,
        u.key,
        JSON.stringify([`c${id}`]),
        u.name,
        u.minutes * 60,
        u.labeled ? 1 : 0,
        u.kind ?? (u.cls === 'none_expected' ? 'none_expected' : 'lookup'),
        JSON.stringify(inputs),
        u.cls,
        u.record?.source ?? null,
        u.record?.id ?? null,
        u.reason ?? null,
        now,
      ).lastInsertRowid as number;
      for (const r of [u.record, ...(u.candidates ?? []).map((c) => c.record)]) {
        if (r) putRec.run(r.source, r.id, gzipSync(Buffer.from(JSON.stringify(r))), now);
      }
      if (u.record && u.cls === 'review')
        putCand.run(unitId, u.record.source, u.record.id, 'fail:runtime');
      for (const c of u.candidates ?? [])
        putCand.run(unitId, c.record.source, c.record.id, c.verdict);
    }
    db.prepare(
      `UPDATE audio_stages SET mode = 'analyse', state = 'ready', progress_json = ? WHERE stage = 4`,
    ).run(JSON.stringify({ analysisId, phase: 'done', error: null, finishedAt: now }));
  })();
}

/** The live cases (names are unique so the AI stand-in can tell the units apart). */
export function liveCases(): SeedUnit[] {
  const tmw = 'TMW Japanese Audiobooks Collection (Part 17) - Literary';
  return [
    {
      key: 'u:genji',
      name: '源氏物語 第八帖 花宴',
      path: `${tmw}/[紫式部] 源氏物語/[08] 源氏物語 第八帖 花宴 [B0GENJI008].m4b`,
      minutes: 41,
      labeled: true,
      cls: 'auto',
      record: audible('B0GENJI008', {
        title: '源氏物語 第八帖 花宴',
        authors: ['与謝野 晶子', '紫式部'],
        narrators: ['岡崎 弥保'],
        publisher: 'パンローリング株式会社',
        description:
          '『源氏物語』全五十四帖 与謝野晶子による現代語訳をすべて朗読し、オーディオ化しました。',
        series: [{ name: '源氏物語', sequence: '8', sort: '8', id: 'S1' }],
      }),
      tags: { title: '源氏物語 第八帖 花宴', composer: '岡崎 弥保' },
    },
    {
      key: 'u:homo',
      name: 'ホモ・デウス 上',
      path: 'Discord/moved/ホモ・デウス 上 [B0HOMODEUS].m4b',
      minutes: 600,
      labeled: true,
      cls: 'auto',
      record: audible('B0HOMODEUS', {
        title: 'ホモ・デウス 上',
        authors: ['ユヴァル・ノア・ハラリ', '柴田 裕之'],
        narrators: ['金子 由之'],
        publisher: 'Audible Studios',
        series: [],
      }),
    },
    {
      key: 'u:sawazaki',
      name: '私が殺した少女',
      path: `${tmw}/[原 りょう] 探偵・沢崎シリーズ/[01] 私が殺した少女 [B07SGNWBMJ].m4b`,
      minutes: 700,
      labeled: true,
      cls: 'auto',
      record: audible('B07SGNWBMJ', {
        title: '私が殺した少女',
        authors: ['原 りょう'],
        narrators: ['大塚 明夫'],
        series: [
          { name: '探偵・沢崎シリーズ', sequence: '探偵・沢崎シリーズ', sort: '1', id: 'S2' },
        ],
      }),
    },
    {
      key: 'u:honzuki6',
      name: '[CD6]本好きの下剋上～司書になるためには手段を選んでいられません～ドラマCD6',
      path: 'TMW Japanese Audiobooks Collection (Part 12) - General Fiction (audiobook.jp)/[CD]本好きの剋/[CD6]本好きの下剋上～司書になるためには手段を選んでいられません～ドラマCD6.m4b',
      minutes: 69,
      labeled: true,
      cls: 'auto',
      record: audible('B09VP7VRQJ', {
        title: '[CD6] 本好きの下剋上～司書になるためには手段を選んでいられません～ドラマCD6',
        authors: ['香月 美夜'],
        narrators: ['井口 裕香', '速水 奨', '田村 睦心'],
        format: 'original_recording',
        series: [{ name: '[CD] 本好きの下剋上', sequence: '6', sort: '6', id: 'S3' }],
      }),
      facts: { drama: { number: '6' } },
    },
    {
      key: 'u:cop',
      name: 'コップクラフト５',
      path: 'Discord/moved/コップクラフト５ [B0COPCRAFT].m4b',
      minutes: 400,
      labeled: true,
      cls: 'auto',
      record: audible('B0COPCRAFT', {
        title: 'コップクラフト５ （ガガガ文庫）',
        subtitle: '（小学館）',
        authors: ['賀東 招二'],
        narrators: ['某 朗読者'],
        series: [{ name: 'ガガガ文庫', sequence: null, sort: null, id: 'S4' }],
      }),
    },
    {
      key: 'u:arslan2',
      name: 'アルスラーン戦記2 王子二人',
      path: 'TMW Japanese Audiobooks Collection (Part 8) - SF/[田中 芳樹] アルスラーン戦記/[02] アルスラーン戦記2 王子二人 [kikubon 19].m4b',
      minutes: 345,
      labeled: true,
      cls: 'review',
      reason: 'runtime',
      record: {
        source: 'kikubon',
        id: '19',
        title: 'アルスラーン戦記2 王子二人',
        subtitle: null,
        authors: ['田中芳樹'],
        narrators: ['下山吉光'],
        seconds: 349 * 60,
        publisher: 'らいおんbooks',
        releaseDate: null,
        series: [],
        extra: { description: 'パルス王国の王子アルスラーン。' },
      },
      candidates: [
        {
          verdict: 'fail:title',
          record: {
            source: 'kikubon',
            id: '20',
            title: 'アルスラーン戦記3 落日悲歌',
            subtitle: null,
            authors: ['田中芳樹'],
            narrators: ['下山吉光'],
            seconds: 345 * 60,
            publisher: 'らいおんbooks',
            releaseDate: null,
            series: [],
            extra: {},
          },
        },
      ],
    },
    {
      key: 'u:unsure',
      name: '迷子の録音',
      path: 'Discord/moved/迷子の録音.m4b',
      minutes: 300,
      cls: 'review',
      reason: 'volume',
      record: audible('B0MAYOIA01', {
        title: '迷子の録音 1',
        authors: ['作家 一'],
        narrators: ['声 一'],
      }),
      candidates: [
        {
          verdict: 'pass',
          record: audible('B0MAYOIA02', {
            title: '迷子の録音 2',
            authors: ['作家 一'],
            narrators: ['声 二'],
          }),
        },
      ],
    },
    {
      key: 'u:naomi',
      name: 'ナオミとカナコ',
      path: 'TMW Japanese Audiobooks Collection (Part 12) - General Fiction (audiobook.jp)/ナオミとカナコ/ナオミとカナコ.m4b',
      minutes: 900,
      labeled: true,
      cls: 'unknown',
      reason: 'not found',
      record: null,
      tags: { title: 'ナオミとカナコ', artist: '千衣子, 桜木繭子', album: 'ナオミとカナコ' },
    },
    {
      key: 'u:ai',
      name: '薬屋のひとりごと４',
      path: 'AI/薬屋のひとりごと/薬屋のひとりごと４.mp3',
      minutes: 564,
      labeled: true,
      cls: 'none_expected',
      reason: 'AI audiobook',
    },
    {
      key: 'u:radio',
      name: 'ざこラジ 第1回',
      path: 'Discord/moved/山田じぇみ子の ざこざこお兄さん取締ラジオ/ざこラジ 第1回.mp3',
      minutes: 5,
      cls: 'none_expected',
      reason: 'radio bonus clip',
    },
    {
      key: 'u:melos',
      name: '走れメロス ドラマCD',
      path: 'Discord/moved/走れメロス ドラマCD [B0MELOS001].m4b',
      minutes: 60,
      labeled: true,
      cls: 'auto',
      record: audible('B0MELOS001', {
        title: '名作文学（笑）シリーズ 走れメロス',
        authors: ['フロンティアワークス'],
        narrators: ['声優 甲', '声優 乙'],
        publisher: 'フロンティアワークス',
        description: '太宰治の「走れメロス」をドラマＣＤ化。',
      }),
    },
    {
      key: 'u:holmes',
      name: 'シャーロック・ホームズ 響き渡る鐘の音',
      path: 'Discord/moved/響き渡る鐘の音 [B00YTCB30Q].m4b',
      minutes: 50,
      cls: 'auto',
      record: audible('B00YTCB30Q', {
        title: 'ラジオドラマ傑作選 シャーロック・ホームズ「響き渡る鐘の音」',
        authors: ['アーサー・コナン・ドイル'],
        narrators: ['藤原 満', '佐々木 健'],
        description:
          '出演 ・シャーロック・ホームズ／藤原満 ・原作：アーサー・コナン・ドイル ・翻訳：大久保ゆう ・演出：志水良旺',
      }),
    },
    {
      key: 'u:hoshi',
      name: '星を編む',
      path: 'Discord/moved/27/星を編む [B0G299R1XS]/星を編む [B0G299R1XS].m4b',
      minutes: 661,
      labeled: true,
      cls: 'auto',
      record: audible('B0G299R1XS', {
        title: '星を編む',
        authors: ['凪良 ゆう'],
        narrators: ['柚木 尚子', '岩崎 了'],
        series: [{ name: '星', sequence: '2', sort: '2', id: 'S5' }],
      }),
    },
  ];
}

/** Labels for the labeled live cases (as labels.json "books"). */
export function liveLabels(units: SeedUnit[]) {
  const by = (k: string) => units.find((u) => u.key === k)!.path;
  return {
    books: [
      {
        id: 'L1',
        kind: 'book',
        torrent: by('u:genji'),
        title: '源氏物語 第八帖 花宴',
        authors: ['紫式部'],
        narrators: ['岡崎弥保'],
        series: [['源氏物語', '8', '8']],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L2',
        kind: 'book',
        torrent: by('u:homo'),
        title: 'ホモ・デウス 上',
        authors: ['ユヴァル・ノア・ハラリ'],
        narrators: ['金子由之'],
        series: [],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L3',
        kind: 'book',
        torrent: by('u:sawazaki'),
        title: '私が殺した少女',
        authors: ['原りょう'],
        narrators: ['大塚明夫'],
        series: [['探偵・沢崎シリーズ', '2', '2']],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L4',
        kind: 'book',
        torrent: by('u:honzuki6'),
        title: '本好きの下剋上～司書になるためには手段を選んでいられません～ドラマCD6',
        authors: ['香月美夜'],
        narrators: ['井口裕香', '速水奨', '田村睦心'],
        series: [
          ['本好きの下剋上 ドラマCD', '6', '6'],
          ['本好きの下剋上', null, 'drama'],
        ],
        drama: true,
        multi_narr: true,
      },
      {
        id: 'L5',
        kind: 'book',
        torrent: by('u:cop'),
        title: 'コップクラフト５',
        authors: ['賀東招二'],
        narrators: ['某朗読者'],
        series: [],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L6',
        kind: 'book',
        torrent: by('u:arslan2'),
        title: 'アルスラーン戦記2　王子二人',
        authors: ['田中芳樹'],
        narrators: ['下山吉光'],
        series: [['アルスラーン戦記', '2', '2']],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L7',
        kind: 'book',
        torrent: by('u:naomi'),
        title: 'ナオミとカナコ',
        authors: ['奥田英朗'],
        series: null,
        drama: false,
        multi_narr: true,
      },
      {
        id: 'L8',
        kind: 'ai',
        torrent: by('u:ai'),
        title: '薬屋のひとりごと4',
        authors: ['日向夏'],
        series: [['薬屋のひとりごと', '4', '4']],
        drama: false,
        multi_narr: false,
      },
      {
        id: 'L9',
        kind: 'book',
        torrent: by('u:melos'),
        title: '名作文学（笑）シリーズ 走れメロス',
        authors: [],
        series: null,
        drama: true,
        multi_narr: true,
      },
      {
        id: 'L10',
        kind: 'book',
        torrent: by('u:hoshi'),
        title: '星を編む',
        authors: ['凪良ゆう'],
        narrators: ['柚木尚子', '岩崎了'],
        series: [['星', '2', '2']],
        drama: false,
        multi_narr: true,
      },
    ],
  };
}
