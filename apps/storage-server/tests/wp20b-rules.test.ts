/**
 * WP20b: stage 2's title and name rules (the TS port of rules_v3) and the per-book decisions
 * (apply classes, covers, identifiers, publisher/language, illustrators). Cases are written
 * here; the 800 labeled books are measured by the opt-in wp20b-reference test.
 */
import { describe, expect, it } from 'vitest';
import {
  N,
  NA,
  cleanTitle,
  cleanTitleV3,
  lightNormalize,
  looksLikeImprint,
  looksLikeMojibake,
  normalizeName,
  titleSort,
} from '../src/cleanup/title-rules';
import {
  type CalibreFacts,
  type FileFacts,
  asinFromIdentifiers,
  authorGroup,
  proposeStage2,
  titleGroup,
} from '../src/cleanup/stage2-rules';
import { spellingLookup } from '../src/cleanup/stage2-snapshot';

const FW_SPACE = String.fromCharCode(0x3000);

function cal(over: Partial<CalibreFacts> = {}): CalibreFacts {
  return {
    title: 'Calibreの題名',
    titleSort: 'Calibreの題名',
    authors: ['Unknown'],
    authorSort: 'Unknown',
    tags: [],
    hasCover: false,
    cover: null,
    identifiers: {},
    publisher: null,
    languages: [],
    illustrators: [],
    ...over,
  };
}

function file(over: Partial<FileFacts> = {}): FileFacts {
  return {
    title: 'ファイルの題名',
    creators: [{ name: '著者一', role: 'aut' }],
    publishers: [],
    languages: [],
    identifiers: [],
    asin: null,
    cover: null,
    ...over,
  };
}

const byField = (props: ReturnType<typeof proposeStage2>, field: string) =>
  props.filter((p) => p.field === field);

describe('title cleaning', () => {
  it('removes store/bonus markers, labels, the [author] prefix; keeps volumes and subtitles', () => {
    expect(cleanTitle('【電子版限定特典付き】毒の王 3' + FW_SPACE + '最強の力に覚醒した俺は')).toBe(
      '毒の王 3 最強の力に覚醒した俺は',
    );
    expect(cleanTitle('妄想少女の観測する世壊【電子特典付き】 (MF文庫J)')).toBe(
      '妄想少女の観測する世壊',
    );
    expect(cleanTitle('[喬林知] まるマシリーズ11')).toBe('まるマシリーズ11');
    expect(cleanTitle('お前は俺のモノだろ？～俺様社長の独占溺愛～【3】 (チュールキス)')).toBe(
      'お前は俺のモノだろ？～俺様社長の独占溺愛～ 3',
    );
    // 【…】 that are part of the title stay.
    expect(cleanTitle('【急募】猜疑王の契約王妃（※短期のお仕事です）')).toBe(
      '【急募】猜疑王の契約王妃（※短期のお仕事です）',
    );
    expect(cleanTitle('ワイの本当の職業が【性騎士】とか言えない 2')).toBe(
      'ワイの本当の職業が【性騎士】とか言えない 2',
    );
  });

  it('keeps edition and omnibus markers (decided), unlike rules_v3', () => {
    expect(cleanTitle('天才クズ教師の悪堕ち令嬢育成論【電子特別版】')).toBe(
      '天才クズ教師の悪堕ち令嬢育成論【電子特別版】',
    );
    expect(cleanTitle('北の砦にて ： 1 【新装版】')).toBe('北の砦にて ： 1 【新装版】');
    expect(cleanTitle('魔法少女【合本版1-5巻】')).toBe('魔法少女【合本版1-5巻】');
    expect(cleanTitle('モテる男の条件（横書き版）')).toBe('モテる男の条件（横書き版）');
    expect(cleanTitleV3('天才クズ教師の悪堕ち令嬢育成論【電子特別版】')).toBe(
      '天才クズ教師の悪堕ち令嬢育成論',
    );
  });

  it('light normalization: full-width Latin, digits and spaces become half-width; Japanese punctuation stays', () => {
    expect(lightNormalize('ＮＯ推理')).toBe('NO推理');
    expect(lightNormalize('魔女の旅々２０')).toBe('魔女の旅々20');
    expect(lightNormalize(`題名${FW_SPACE}${FW_SPACE}副題`)).toBe('題名 副題');
    expect(lightNormalize('～ ― 〈〉 「」 ！ ？ ： （） 、')).toBe(
      '～ ― 〈〉 「」 ！ ？ ： （） 、',
    );
    // rules_v3's clean() turns the punctuation into ASCII (NFKC); stage 2 doesn't.
    expect(cleanTitleV3('くらしの！')).toBe('くらしの!');
    expect(cleanTitle('くらしの！')).toBe('くらしの！');
  });

  it('removes a trailing " - author" only when it names one of the authors', () => {
    expect(cleanTitle('魔法の本 - 山田太郎', ['山田太郎'])).toBe('魔法の本');
    expect(cleanTitle('魔法の本 - 第二部', ['山田太郎'])).toBe('魔法の本 - 第二部');
  });

  it('N and NA compare like rules_v3', () => {
    expect(N('魔女の旅々（２０）')).toBe(N('魔女の旅々 20'));
    expect(N('第06巻')).toBe(N('第6'));
    expect(NA('榊 一郎')).toBe(NA('榊一郎'));
  });

  it('calibre title sort: English leading articles only', () => {
    expect(titleSort('The 新しい題名 第1巻')).toBe('新しい題名 第1巻, The');
    expect(titleSort('新しい題名')).toBe('新しい題名');
  });
});

describe('names', () => {
  it('Japanese names lose the space; katakana names with a space get ・; Latin names keep it', () => {
    expect(normalizeName('榊 一郎')).toBe('榊一郎');
    expect(normalizeName(`榊${FW_SPACE}一郎`)).toBe('榊一郎');
    expect(normalizeName('ウィリアム シェークスピア')).toBe('ウィリアム・シェークスピア');
    expect(normalizeName('John  Smith')).toBe('John Smith');
    expect(normalizeName('ＡＢＣ')).toBe('ABC');
  });

  it('spots mojibake, labels and Unknown', () => {
    expect(looksLikeMojibake('縺ゅ≠繧後↑繝ｻ縺ｮ')).toBe(true);
    expect(looksLikeMojibake('魔法少女の本')).toBe(false);
    expect(looksLikeImprint('KADOKAWA 文庫')).toBe(true);
    expect(looksLikeImprint('株式会社 ディスカヴァー')).toBe(true);
    expect(looksLikeImprint('週刊少年サンデー編集部')).toBe(false);
  });

  it('reads the ASIN from the identifier forms files use', () => {
    expect(asinFromIdentifiers(['urn:uuid:1234', 'B00BB7DKVW'])).toBe('B00BB7DKVW');
    expect(asinFromIdentifiers(['urn:asin:B0ABCDEFGH'])).toBe('B0ABCDEFGH');
    expect(asinFromIdentifiers(['MOBI-ASIN:b0abcdefgh'])).toBe('B0ABCDEFGH');
    expect(asinFromIdentifiers(['9784040000000', 'isbn:4040000000'])).toBe(null);
  });
});

describe('apply classes (D6)', () => {
  it('Calibre "Unknown": the cleaned file title and the first file author, auto and unconfirmed', () => {
    const p = proposeStage2(
      cal(),
      file({
        title: '本の題名【電子特典付き】',
        creators: [
          { name: '山田 太郎', role: 'aut' },
          { name: '画家', role: 'aut' },
        ],
      }),
    );
    expect(byField(p, 'title')).toMatchObject([
      { new: '本の題名', class: 'auto', source: 'file-unconfirmed', group: 'unknown' },
    ]);
    expect(byField(p, 'title')[0].extra?.sort).toEqual({ old: 'Calibreの題名', new: '本の題名' });
    // Only the first file author (the second is often the illustrator).
    expect(byField(p, 'authors')).toMatchObject([
      { new: ['山田太郎'], class: 'auto', source: 'file-unconfirmed' },
    ]);
    // author_sort is sent empty so Calibre computes it from the new names (D5).
    expect(byField(p, 'authors')[0].extra?.author_sort).toEqual({ old: 'Unknown', new: '' });
  });

  it('metadata-processed: the file wins, even over a real-looking Calibre value', () => {
    const p = proposeStage2(
      cal({ authors: ['Google著者'], tags: ['metadata-processed'], title: 'Googleの題名' }),
      file({ title: '本当の題名' }),
    );
    expect(titleGroup(cal({ authors: ['Google著者'], tags: ['metadata-processed'] }), file())).toBe(
      'processed',
    );
    expect(byField(p, 'title')).toMatchObject([
      { new: '本当の題名', class: 'auto', source: 'file-unconfirmed' },
    ]);
    expect(byField(p, 'authors')).toMatchObject([{ new: ['著者一'], class: 'auto' }]);
  });

  it('agree: normalization only, of Calibre’s own text (cleaned, light-normalized)', () => {
    const c = cal({ authors: ['榊 一郎'], title: '魔女の旅々２０【電子特典付き】' });
    const f = file({ title: '魔女の旅々 20', creators: [{ name: '榊一郎', role: 'aut' }] });
    expect(titleGroup(c, f)).toBe('agree');
    expect(authorGroup(c, f)).toBe('agree');
    const p = proposeStage2(c, f);
    expect(byField(p, 'title')).toMatchObject([
      { new: '魔女の旅々20', class: 'auto', source: 'normalize' },
    ]);
    expect(byField(p, 'authors')).toMatchObject([
      { new: ['榊一郎'], class: 'auto', source: 'normalize' },
    ]);
  });

  it('nothing to do when Calibre already has the normalized values', () => {
    const p = proposeStage2(
      cal({ authors: ['榊一郎'], title: '題名' }),
      file({ title: '題名', creators: [{ name: '榊 一郎', role: 'aut' }] }),
    );
    expect(byField(p, 'title')).toEqual([]);
    expect(byField(p, 'authors')).toEqual([]);
  });

  it('conflict: the file value goes to review; Calibre’s own value is still normalized', () => {
    const c = cal({ authors: ['別人 太郎'], title: 'まったく別の本' });
    const p = proposeStage2(c, file({ title: '本の題名' }));
    expect(titleGroup(c, file({ title: '本の題名' }))).toBe('conflict');
    expect(byField(p, 'title')).toMatchObject([{ new: '本の題名', class: 'review' }]);
    expect(byField(p, 'authors')).toMatchObject([
      { new: ['別人太郎'], class: 'auto', source: 'normalize' },
      { new: ['著者一'], class: 'review' },
    ]);
  });

  it('an illustrator listed as Calibre’s second author is a conflict (names must be the same)', () => {
    const c = cal({ authors: ['著者一', '画家'], title: '題名' });
    expect(authorGroup(c, file({ title: '題名' }))).toBe('conflict');
  });

  it('mojibake or empty file titles, label creators and "Unknown" creators go to review', () => {
    const moji = proposeStage2(cal(), file({ title: '縺ゅ≠繧後↑繝ｻ縺ｮ' }));
    expect(byField(moji, 'title')[0]).toMatchObject({
      class: 'review',
      reason: expect.stringContaining('garbled'),
    });
    expect(byField(proposeStage2(cal(), file({ title: '' })), 'title')).toEqual([]);
    const label = proposeStage2(cal(), file({ creators: [{ name: '電撃文庫', role: 'aut' }] }));
    expect(byField(label, 'authors')[0]).toMatchObject({
      class: 'review',
      reason: expect.stringContaining('publisher or label'),
    });
    expect(
      byField(
        proposeStage2(cal(), file({ creators: [{ name: 'Unknown', role: 'aut' }] })),
        'authors',
      ),
    ).toEqual([]);
  });

  it('a file author holding two names ("A/B") goes to review', () => {
    for (const name of [
      'あずみ圭/マツモトミツアキ',
      '原作:志倉千代丸/MAGES./Nitroplus',
      '甲、乙',
    ]) {
      const p = proposeStage2(
        cal({ tags: ['metadata-processed'], authors: ['あずみ圭'] }),
        file({ creators: [{ name, role: 'aut' }] }),
      );
      expect(
        byField(p, 'authors').filter((x) => x.class === 'auto' && x.source === 'file-unconfirmed'),
      ).toEqual([]);
      expect(byField(p, 'authors').find((x) => x.class === 'review')?.reason).toContain(
        'more than one name',
      );
    }
  });

  it('translators and editors are never authors; role "none" counts as an author', () => {
    const p = proposeStage2(
      cal(),
      file({
        creators: [
          { name: '訳者', role: 'trl' },
          { name: '著者二', role: null },
        ],
      }),
    );
    expect(byField(p, 'authors')[0].new).toEqual(['著者二']);
  });

  it('keeps Calibre’s spelling of a name that differs only in case (D4)', () => {
    const names = {
      author: new Map([['abc def', 'Abc Def']]),
      publisher: new Map(),
      illustrator: new Map(),
    };
    const p = proposeStage2(cal(), file({ creators: [{ name: 'abc def', role: 'aut' }] }), {
      spelling: spellingLookup(names),
    });
    expect(byField(p, 'authors')[0].new).toEqual(['Abc Def']);
  });
});

describe('covers, identifiers, publisher, language, illustrators', () => {
  const cover = (w: number, h: number, dhash = 'ffffffffffffffff') => ({
    entry: 'OEBPS/cover.jpg',
    mediaType: 'image/jpeg',
    bytes: 1000,
    sha256: 'a'.repeat(64),
    width: w,
    height: h,
    dhash,
  });

  it('a cover when Calibre has none, or the file’s is larger, or (processed) a different picture (D2)', () => {
    expect(
      byField(proposeStage2(cal(), file({ cover: cover(800, 1200) })), 'cover')[0],
    ).toMatchObject({ class: 'auto', reason: 'Calibre has no cover' });
    const has = { hasCover: true, cover: { width: 500, height: 750, dhash: 'ffffffffffffffff' } };
    expect(
      byField(proposeStage2(cal(has), file({ cover: cover(800, 1200) })), 'cover')[0].reason,
    ).toContain('larger');
    expect(
      byField(
        proposeStage2(
          cal({ ...has, cover: { width: 800, height: 1200, dhash: 'ffffffffffffffff' } }),
          file({ cover: cover(800, 1200) }),
        ),
        'cover',
      ),
    ).toEqual([]);
    const processed = {
      ...has,
      tags: ['metadata-processed'],
      cover: { width: 800, height: 1200, dhash: '0000000000000000' },
    };
    expect(
      byField(proposeStage2(cal(processed), file({ cover: cover(800, 1200) })), 'cover')[0].reason,
    ).toContain('different picture');
    // Re-encoded (distance ≤ 5): left alone.
    const near = { ...processed, cover: { width: 800, height: 1200, dhash: 'fffffffffffffff0' } };
    expect(byField(proposeStage2(cal(near), file({ cover: cover(800, 1200) })), 'cover')).toEqual(
      [],
    );
  });

  it('ASIN as amazon_jp next to the other identifiers; another amazon_jp goes to review', () => {
    const p = proposeStage2(cal({ identifiers: { isbn: '978' } }), file({ asin: 'B0ABCDEFGH' }));
    expect(byField(p, 'identifiers')[0]).toMatchObject({
      class: 'auto',
      new: { isbn: '978', amazon_jp: 'B0ABCDEFGH' },
    });
    expect(
      byField(
        proposeStage2(
          cal({ identifiers: { amazon_jp: 'B0ZZZZZZZZ' } }),
          file({ asin: 'B0ABCDEFGH' }),
        ),
        'identifiers',
      )[0].class,
    ).toBe('review');
    expect(
      byField(
        proposeStage2(
          cal({ identifiers: { amazon_jp: 'b0abcdefgh' } }),
          file({ asin: 'B0ABCDEFGH' }),
        ),
        'identifiers',
      ),
    ).toEqual([]);
  });

  it('publisher and languages only when Calibre has none; illustrators from role ill', () => {
    const f = file({
      publishers: ['ＫＡＤＯＫＡＷＡ'],
      languages: ['ja'],
      creators: [
        { name: '著者一', role: 'aut' },
        { name: '画家 一', role: 'ill' },
      ],
    });
    const p = proposeStage2(cal(), f);
    expect(byField(p, 'publisher')[0].new).toBe('KADOKAWA');
    expect(byField(p, 'languages')[0].new).toEqual(['jpn']);
    expect(byField(p, 'illustrator')[0].new).toEqual(['画家一']);
    const full = proposeStage2(cal({ publisher: 'X', languages: ['jpn'], illustrators: ['Y'] }), f);
    expect(byField(full, 'publisher')).toEqual([]);
    expect(byField(full, 'languages')).toEqual([]);
    expect(byField(full, 'illustrator')).toEqual([]);
    // No #illustrator column in the library: nothing proposed.
    expect(byField(proposeStage2(cal({ illustrators: null }), f), 'illustrator')).toEqual([]);
  });
});
