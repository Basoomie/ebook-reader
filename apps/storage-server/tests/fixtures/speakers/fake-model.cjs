/**
 * Season 2 Phase 12 session 5 tests: a stand-in for the speaker model. It answers the three
 * kinds of request the server makes (speaker-run.ts) the way llama.cpp's /completion does:
 * `content` and `completion_probabilities` ({token, logprob, top_logprobs}).
 *
 * - characters (a JSON schema with `characters`): the people of CHARACTERS named in the text.
 * - groups (a JSON schema with `same`): none.
 * - speakers (a grammar with "Q<n>="): each quote's speaker from SPEAKERS by its text, the id
 *   read from the prompt's character list; "?" when unknown. The id's last digit has the
 *   probability SURE (an alternative digit the rest), so "how sure" can be checked.
 * The answers can be changed for a test (`setSpeakers`, or FAKE_SPEAKERS as JSON).
 */
const CHARACTERS = [
  { name: 'ホロ', aliases: ['賢狼'], firstPerson: ['わっち'], gender: '女' },
  { name: 'ロレンス', aliases: [], firstPerson: ['俺'], gender: '男' },
];
let SPEAKERS = {
  '「行こう」': 'ホロ',
  '「どこへ？」': 'ロレンス',
  '「北へ」': 'ホロ',
  '「最後だ」': 'ロレンス',
};
if (process.env.FAKE_SPEAKERS) SPEAKERS = JSON.parse(process.env.FAKE_SPEAKERS);
const SURE = 0.7;

function setSpeakers(map) {
  SPEAKERS = { ...SPEAKERS, ...map };
}

/** Tokens of `content`, one per character, the digits of each id with a probability. */
function probsFor(content) {
  const out = [];
  const chars = Array.from(content);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isIdDigit = /[0-9]/.test(ch) && chars[i - 1] === 'C';
    if (isIdDigit) {
      // The other listed character (the tests have C1 and C2): a valid alternative.
      const other = ch === '1' ? '2' : '1';
      out.push({
        token: ch,
        logprob: Math.log(SURE),
        top_logprobs: [
          { token: ch, logprob: Math.log(SURE) },
          { token: other, logprob: Math.log(1 - SURE) },
        ],
      });
    } else {
      out.push({ token: ch, logprob: 0, top_logprobs: [{ token: ch, logprob: 0 }] });
    }
  }
  return out;
}

function answer({ prompt, grammar, json_schema: schema }) {
  const props = (schema && schema.properties) || {};
  if (props.characters) {
    const found = CHARACTERS.filter((c) => prompt.includes(c.name));
    return {
      content: JSON.stringify({
        characters: found,
        narrator: { firstPerson: false, name: 'ロレンス' },
      }),
      completion_probabilities: [],
    };
  }
  if (props.same) return { content: '{"same":[]}', completion_probabilities: [] };
  const quotes = [...String(grammar || '').matchAll(/"Q(\d+)="/g)].map((m) => Number(m[1]));
  let content = '';
  for (const q of quotes) {
    const m = new RegExp(`［Q${q}］(「[^」]*」)`).exec(prompt);
    const name = m ? SPEAKERS[m[1]] : undefined;
    // The character's line: its name or one of its other names.
    const line = name
      ? prompt
          .split('\n')
          .map((l) => /^C(\d+) (.*)$/.exec(l))
          .find((x) => x && x[2].split(/[（）、\s:]+/).includes(name))
      : null;
    content += `Q${q}=${line ? `C${line[1]}` : '?'}\n`;
  }
  return { content, completion_probabilities: probsFor(content) };
}

module.exports = { answer, setSpeakers, SURE };
