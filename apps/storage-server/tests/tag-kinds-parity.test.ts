import { describe, expect, it } from 'vitest';
import { ADAPTATIONS, FORMAT_TAGS, GENRES, SUBJECTS, TAGS } from '../src/cleanup/stage5/vocab';

// The book page's tag kinds (apps/web/src/lib/library/tag-kinds.ts) are a copy of stage 5's
// Japanese labels: they must stay equal, in order.
describe('the web app tag kinds equal stage 5 vocabulary', () => {
  it('has every label of every kind, in order', async () => {
    const web = await import('../../web/src/lib/library/tag-kinds');
    expect(web.FORMAT_LABELS).toEqual(Object.values(FORMAT_TAGS).map((t) => t.ja));
    expect(web.GENRE_LABELS).toEqual(GENRES.map((t) => t.ja));
    expect(web.SUBJECT_LABELS).toEqual(SUBJECTS.map((t) => t.ja));
    expect(web.STORY_TAG_LABELS).toEqual(TAGS.map((t) => t.ja));
    expect(web.ADAPTATION_LABELS).toEqual(ADAPTATIONS.map((t) => t.ja));
  });
});
