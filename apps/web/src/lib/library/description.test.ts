/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { descriptionParagraphs } from './description';

describe('descriptionParagraphs', () => {
  it('turns Calibre HTML into paragraphs and lines', () => {
    expect(
      descriptionParagraphs(
        '<div><p>港町の灯台守を継いだ澪は、<b>満月</b>の夜に…</p><p>第三巻。<br/>書き下ろし短編を収録。</p></div>'
      )
    ).toEqual(['港町の灯台守を継いだ澪は、満月の夜に…', '第三巻。\n書き下ろし短編を収録。']);
  });

  it('decodes entities and keeps the result as text', () => {
    expect(
      descriptionParagraphs('<p>Tom &amp; Jerry &lt;3 &#12354;&#x3044; &nbsp;x&hellip;</p>')
    ).toEqual(['Tom & Jerry <3 あい x…']);
    // Markup inside the text never comes back as tags.
    expect(descriptionParagraphs('<p>&lt;img src=x onerror=alert(1)&gt;</p>')).toEqual([
      '<img src=x onerror=alert(1)>'
    ]);
  });

  it('drops scripts, styles, comments and empty paragraphs', () => {
    expect(
      descriptionParagraphs(
        '<style>p{}</style><script>alert(1)</script><!-- x --><p> </p><p>本文</p>'
      )
    ).toEqual(['本文']);
    expect(descriptionParagraphs(null)).toEqual([]);
    expect(descriptionParagraphs('plain text\n\nsecond')).toEqual(['plain text', 'second']);
  });
});
