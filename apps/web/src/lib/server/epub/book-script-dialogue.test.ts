/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 Phase 12 session 4: which runs of a book are dialogue (book-script.ts
 * `dialogueSpans`, `parts`). The sentences are real ones from the books measured while
 * planning (decisions.md, "Narration and dialogue voices").
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from './node-dom';
import { bookScriptFromHtml, type ScriptSentence } from './book-script';

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

const wrap = (id: string, body: string) =>
  `<div id="ttu-${id}"><div class="ttu-book-html-wrapper"><div class="ttu-book-body-wrapper">${body}</div></div></div>`;

function script(paragraphs: string[], { raw = false } = {}) {
  const body = raw ? paragraphs.join('') : paragraphs.map((p) => `<p>${p}</p>`).join('');

  return bookScriptFromHtml(
    wrap('d', body),
    [{ reference: 'ttu-d', charactersWeight: 1, label: 'D' }],
    10_000,
    doc
  ).chapters[0].sentences;
}

/** A sentence with its dialogue marked ⟨…⟩ (and the quote number when asked). */
function marked(s: ScriptSentence, withQuote = false): string {
  let out = '';
  let at = 0;

  for (const p of s.parts ?? []) {
    out += s.text.slice(at, p.start) + '⟨' + s.text.slice(p.start, p.end);
    out += withQuote ? `⟩${p.quote}` : '⟩';
    at = p.end;
  }

  return out + s.text.slice(at);
}

const one = (p: string) => script([p]).map((s) => marked(s));

describe('dialogue in a book script', () => {
  it('reads a paragraph that is a quote as dialogue', () => {
    expect(one('「そうか。」')).toEqual(['⟨「そうか。」⟩']);
    expect(one('「もうええ」')).toEqual(['⟨「もうええ」⟩']);
  });

  it('carries a quote over the sentences it spans, with one quote number', () => {
    const s = script(['「おはよう。今日は晴れだね。行こう」', '地の文です。']);

    expect(s.map((x) => marked(x, true))).toEqual([
      '⟨「おはよう。⟩0',
      '⟨今日は晴れだね。⟩0',
      '⟨行こう」⟩0',
      '地の文です。'
    ]);
    expect(s[3].parts).toBeUndefined();
  });

  it('splits a quote that opens a sentence from the narration after it', () => {
    expect(one('「そのとおりだ」ダークが言った。')).toEqual(['⟨「そのとおりだ」⟩ダークが言った。']);
    expect(
      one('「まあ、あなた」スキーターは、ペンを握った私の手の節を親しげに軽く叩いた。')
    ).toEqual(['⟨「まあ、あなた」⟩スキーターは、ペンを握った私の手の節を親しげに軽く叩いた。']);
    expect(one('「よし」と、ムーディが言った。')).toEqual(['⟨「よし」⟩と、ムーディが言った。']);
  });

  it('finds speech inside a sentence by the と or って after it', () => {
    expect(
      one('再びぐずぐずと帰り支度をする桜子に、男は「あんた、年のわりにはまあまあやな」と言った。')
    ).toEqual([
      '再びぐずぐずと帰り支度をする桜子に、男は⟨「あんた、年のわりにはまあまあやな」⟩と言った。'
    ]);
    expect(one('蛇の尾がハリーの腹を強打し、ハリーは「ウッ」とうなって息が止まった。')).toEqual([
      '蛇の尾がハリーの腹を強打し、ハリーは⟨「ウッ」⟩とうなって息が止まった。'
    ]);
    expect(one('その答えにスバルが「口添え？」')).toEqual(['その答えにスバルが⟨「口添え？」⟩']);
  });

  it('reads names, titles and terms in 「」 as narration', () => {
    for (const p of [
      '本当のところは、ハーマイオニーは「死の秘宝」という考えが怖いのだ。',
      'ハリーは、「隠れ穴」の境界のすぐ外で音を聞いた。',
      'ハーマイオニーは、ふらふらと「マント」から出て、椅子に腰掛けた。',
      'ハリーは、知らないところに「姿くらまし」した。',
      '彼だけが見つけることのできた、秘められたあの「部屋」。',
      '本文中に「＊」が付されている箇所には注釈があります。',
      '「死の秘宝」という言葉が頭から離れない。',
      '「面白い人」だったら、努力次第でなれるかもしれないと思ったのだ。',
      '図書館で読んだ本に「貧乏神を追い払うための道具」として書かれていた。',
      'ロンの考えはせいぜい「出たとこ勝負さ、おい」だった。'
    ]) {
      expect(one(p)).toEqual([p]);
    }
  });

  it('gives a run of quotes the answer of the last one', () => {
    expect(one('心を込めて「頑張ります」「一緒にやっていきましょう」と言った。')).toEqual([
      '心を込めて⟨「頑張ります」⟩⟨「一緒にやっていきましょう」⟩と言った。'
    ]);
    expect(one('看板には「本日」「休業」の文字。')).toEqual(['看板には「本日」「休業」の文字。']);
  });

  it('keeps 『』 inside a quote, reads a whole-paragraph 『』 as dialogue and inline 『』 as narration', () => {
    expect(one('「魔法省は、いわゆる『マグル生まれ』の調査を始めた」')).toEqual([
      '⟨「魔法省は、いわゆる『マグル生まれ』の調査を始めた」⟩'
    ]);
    expect(one('『ありがとうございます、ご主人様』')).toEqual([
      '⟨『ありがとうございます、ご主人様』⟩'
    ]);
    expect(one('はようやく宿──『水の羽衣亭』に向き直った。')).toEqual([
      'はようやく宿──『水の羽衣亭』に向き直った。'
    ]);
    // A 「」 inside an inline 『』 (a title) stays narration with it.
    expect(one('彼は『「死」の研究』を読んだ。')).toEqual(['彼は『「死」の研究』を読んだ。']);
  });

  it('reads （） as narration', () => {
    expect(one('（よし、行くぞ）')).toEqual(['（よし、行くぞ）']);
  });

  it('ends every quote at the paragraph end and ignores a stray 」', () => {
    const s = script([
      '「長い話だ。まだ続く',
      '「ここで終わる」',
      'それで終わり。」と彼は笑った。'
    ]);

    expect(s.map((x) => marked(x, true))).toEqual([
      '⟨「長い話だ。⟩0',
      '⟨まだ続く⟩0',
      '⟨「ここで終わる」⟩1',
      // The reader's sentence split ends a sentence at 。」 (a stray 」 here).
      'それで終わり。」',
      'と彼は笑った。'
    ]);
  });

  it('keeps a speaker label of a script as narration', () => {
    const [s] = script(['医者　「レントゲン撮っても、自分が何の病気か分からへんねん」']);

    expect(s.text.slice(0, 2)).toBe('医者');
    expect(marked(s).slice(3)).toBe('⟨「レントゲン撮っても、自分が何の病気か分からへんねん」⟩');
  });

  it('never leaves a run of either voice that is only punctuation', () => {
    expect(one('「行こう」。')).toEqual(['⟨「行こう」。⟩']);
    // The ……。 after the quote has nothing to say: it joins the dialogue.
    expect(one('「はい」……。')).toEqual(['⟨「はい」……。⟩']);
    // A sentence that is a lone 」 left over joins nothing (no dialogue in it).
    expect(one('彼が「はい」と言うと、')).toEqual(['彼が⟨「はい」⟩と言うと、']);
  });

  it('numbers quotes through the book and counts in UTF-16 (astral characters)', () => {
    const s = script(['𠮟る彼は「𩸽だ」と言った。「次」']);

    expect(s.map((x) => marked(x, true))).toEqual(['𠮟る彼は⟨「𩸽だ」⟩0と言った。', '⟨「次」⟩1']);
    expect(s[0].parts).toEqual([{ start: 5, end: 10, role: 'dialogue', quote: 0 }]);
    expect(s[0].text.slice(5, 10)).toBe('「𩸽だ」');
  });

  it('marks dialogue inside a long sentence split after a 、', () => {
    const long = `「${'あ'.repeat(60)}、${'い'.repeat(60)}」と言った。`;
    const s = script([long]);

    expect(s.length).toBe(2);
    expect(s.map((x) => marked(x, true))).toEqual([
      `⟨「${'あ'.repeat(60)}、⟩0`,
      `⟨${'い'.repeat(60)}」⟩0と言った。`
    ]);
  });

  it('keeps the readings and positions it had (dialogue only adds parts)', () => {
    const s = script(['「<ruby>畢竟<rt>ひっきょう</rt></ruby>、そうだ」と彼は言った。']);

    expect(s[0].reading).toBe('「ひっきょう、そうだ」と彼は言った。');
    expect(s[0].ruby).toEqual([{ start: 1, end: 3, rt: 'ひっきょう' }]);
    expect(marked(s[0])).toBe('⟨「畢竟、そうだ」⟩と彼は言った。');
  });
});
