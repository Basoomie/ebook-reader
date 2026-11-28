/*
 * GENERATED FILE, DO NOT EDIT. The storage server library search parser, bundled from
 * the web app (apps/web/src/lib/library/query/server-entry.ts).
 * Rebuild with `pnpm build:server-query` in apps/web after changing that code.
 * build: feb34807654c4a99
 */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/lib/library/query/server-entry.ts
var server_entry_exports = {};
__export(server_entry_exports, {
  DEFAULT_KEPT_RULES: () => DEFAULT_KEPT_RULES,
  DEFAULT_SCORE_PARAMS: () => DEFAULT_SCORE_PARAMS,
  QUERY_FIELDS: () => FIELDS,
  QUERY_LIMITS: () => QUERY_LIMITS,
  QUERY_STATUSES: () => QUERY_STATUSES,
  figureKey: () => figureKey,
  figureMatches: () => figureMatches,
  figureSortValue: () => figureSortValue,
  figureTermValue: () => figureTermValue,
  parseQuery: () => parseQuery,
  pickFigure: () => pickFigure,
  seriesFigures: () => seriesFigures,
  usesBookState: () => usesBookState,
  usesRegex: () => usesRegex,
  worksFigure: () => worksFigure
});
module.exports = __toCommonJS(server_entry_exports);

// src/lib/library/query/parse.ts
var QUERY_LIMITS = {
  /** Characters in the whole query. */
  maxLength: 500,
  /** Terms after parsing (empty terms don't count). */
  maxTerms: 16,
  /** Regular expressions in one query (each one costs a scan). */
  maxRegexes: 3,
  /** Characters in one regular expression body. */
  maxRegexLength: 200
};
var QUERY_STATUSES = ["unread", "reading", "completed", "dropped", "next"];
var QUERY_BOOKMETER_LISTS = ["read", "reading", "stacked", "wish"];
var QueryError = class extends Error {
  constructor(message, start, end) {
    super(message);
    this.start = start;
    this.end = end;
  }
};
var FIELDS = [
  "author",
  "illustrator",
  "series",
  "tag",
  "chars",
  "level",
  "rating",
  "ratings",
  "readers",
  "kept",
  "myrating",
  "status",
  "favorite",
  "on",
  "bookmeter"
];
var FIELD_RE = /^(author|illustrator|series|tag|chars|level|ratings|rating|readers|kept|myrating|status|favorite|on|bookmeter)[:：]/i;
var FIELD_LOOKAHEAD = Math.max(...FIELDS.map((f) => f.length)) + 1;
function isSpace(ch) {
  return ch !== void 0 && /\s/.test(ch);
}
function checkRegex(source, ignoreCase, start, end) {
  if (source.length > QUERY_LIMITS.maxRegexLength) {
    throw new QueryError(
      `A pattern can be at most ${QUERY_LIMITS.maxRegexLength} characters long.`,
      start,
      end
    );
  }
  try {
    new RegExp(source, ignoreCase ? "iu" : "u");
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : "";
    throw new QueryError(`That pattern isn't valid${detail ? `: ${detail}` : ""}.`, start, end);
  }
  return { kind: "regex", source, ignoreCase };
}
var Scanner = class {
  constructor(text) {
    this.text = text;
  }
  pos = 0;
  regexCount = 0;
  get done() {
    return this.pos >= this.text.length;
  }
  peek(offset = 0) {
    return this.text[this.pos + offset];
  }
  skipSpace() {
    while (!this.done && isSpace(this.peek())) this.pos += 1;
  }
  /** Reads until whitespace (or, with `stopAtComma`, a comma). */
  readBare(stopAtComma) {
    const from = this.pos;
    while (!this.done && !isSpace(this.peek()) && !(stopAtComma && this.peek() === ",")) {
      this.pos += 1;
    }
    return this.text.slice(from, this.pos);
  }
  /** At a '"': reads to the closing quote or the end of the query. */
  readQuoted() {
    this.pos += 1;
    const from = this.pos;
    while (!this.done && this.peek() !== '"') this.pos += 1;
    const value = this.text.slice(from, this.pos);
    if (!this.done) this.pos += 1;
    return value;
  }
  /**
   * At a '/': reads /body/flags when it is a complete pattern; otherwise returns null and
   * leaves the position unchanged (then it is plain text). `stopAtComma` ends the flags
   * at a comma (field value lists).
   */
  tryReadRegex(stopAtComma) {
    const start = this.pos;
    let i = this.pos + 1;
    let inClass = false;
    while (i < this.text.length) {
      const ch = this.text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) break;
      i += 1;
    }
    if (i >= this.text.length) return null;
    const source = this.text.slice(start + 1, i);
    let j = i + 1;
    while (j < this.text.length && !isSpace(this.text[j]) && !(stopAtComma && this.text[j] === ",")) {
      j += 1;
    }
    const flags = this.text.slice(i + 1, j);
    if (source === "") {
      if (flags !== "") return null;
      this.pos = j;
      return { kind: "text", value: "", exact: false };
    }
    if (flags !== "" && flags !== "i" && flags !== "I") {
      throw new QueryError(
        "Only the i flag (ignore case) can follow a /pattern/. To search for a slash, put the text in quotes.",
        start,
        j
      );
    }
    this.regexCount += 1;
    if (this.regexCount > QUERY_LIMITS.maxRegexes) {
      throw new QueryError(
        `A search can use at most ${QUERY_LIMITS.maxRegexes} patterns.`,
        start,
        j
      );
    }
    this.pos = j;
    return checkRegex(source, flags !== "", start, j);
  }
};
function parseCharsNumber(raw) {
  const thousands = /^(\d+(?:\.\d+)?)k$/i.exec(raw);
  if (thousands) return Math.round(Number(thousands[1]) * 1e3);
  if (!/^\d[\d,_]*$/.test(raw)) return null;
  const value = Number(raw.replace(/[,_]/g, ""));
  return Number.isSafeInteger(value) ? value : null;
}
var CHARS_HELP = "Use chars:<150000, chars:>=50k or chars:50000-150000.";
var LEVEL_HELP = "Use level:<25, level:>=30 or level:20-29.";
function parseLevelNumber(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
function parseRange(raw, start, end, field = "chars") {
  const HELP = field === "chars" ? CHARS_HELP : LEVEL_HELP;
  const parseNumber = field === "chars" ? parseCharsNumber : parseLevelNumber;
  if (raw === "") throw new QueryError(`${field}: needs a number. ${HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseNumber(range[1]);
    const high = parseNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a number range. ${HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError("The first number of a range must be the smaller one.", start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw);
  const op = compare[1] ?? "=";
  const value = parseNumber(compare[2]);
  if (value === null) throw new QueryError(`"${raw}" isn't a number. ${HELP}`, start, end);
  switch (op) {
    case "<":
      return { min: null, max: value - 1 };
    case "<=":
      return { min: null, max: value };
    case ">":
      return { min: value + 1, max: null };
    case ">=":
      return { min: value, max: null };
    default:
      return { min: value, max: value };
  }
}
var STARS_HELP = (f) => `Use ${f}:>=4, ${f}:<3.5 or ${f}:4-4.5.`;
var COUNT_HELP = (f) => `Use ${f}:>=100, ${f}:<50 or ${f}:1k-5k.`;
function parseStarsNumber(raw) {
  const m = /^(\d)(?:\.(\d))?$/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]) * 10 + Number(m[2] ?? 0);
  return v <= 50 ? v : null;
}
function parseStarsRange(raw, start, end, field) {
  const HELP = STARS_HELP(field);
  if (raw === "") throw new QueryError(`${field}: needs a number of stars. ${HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseStarsNumber(range[1]);
    const high = parseStarsNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a range of stars (0 to 5). ${HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError("The first number of a range must be the smaller one.", start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw);
  const value = parseStarsNumber(compare[2]);
  if (value === null)
    throw new QueryError(`"${raw}" isn't a number of stars (0 to 5). ${HELP}`, start, end);
  switch (compare[1]) {
    case "<":
      return { min: null, max: value - 1 };
    case "<=":
      return { min: null, max: value };
    case ">":
      return { min: value + 1, max: null };
    case ">=":
      return { min: value, max: null };
    case "=":
      return { min: value, max: value };
    default:
      return compare[2].includes(".") ? { min: value, max: value } : { min: value, max: Math.min(50, value + 9) };
  }
}
function parseCountRange(raw, start, end, field) {
  try {
    return parseRange(raw, start, end, "chars");
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    const reason = raw === "" ? `${field}: needs a number.` : `"${raw}" isn't a number.`;
    throw new QueryError(
      err.message.startsWith("The first number") ? err.message : `${reason} ${COUNT_HELP(field)}`,
      start,
      end
    );
  }
}
var KEPT_HELP = "Use kept:>=70, kept:<50 or kept:50-80 (percent).";
function parseKeptRange(raw, start, end) {
  const pct = (v) => {
    const m = /^(\d{1,3})[%％]?$/.exec(v);
    if (!m) return null;
    const n = Number(m[1]);
    return n <= 100 ? n : null;
  };
  if (raw === "") throw new QueryError(`kept: needs a percent. ${KEPT_HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = pct(range[1]);
    const high = pct(range[2]);
    if (low === null || high === null) {
      throw new QueryError(
        `"${raw}" isn't a range of percents (0 to 100). ${KEPT_HELP}`,
        start,
        end
      );
    }
    if (low > high) {
      throw new QueryError("The first number of a range must be the smaller one.", start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw);
  const value = pct(compare[2]);
  if (value === null)
    throw new QueryError(`"${raw}" isn't a percent (0 to 100). ${KEPT_HELP}`, start, end);
  switch (compare[1]) {
    case "<":
      return { min: null, max: value - 1 };
    case "<=":
      return { min: null, max: value };
    case ">":
      return { min: value + 1, max: null };
    case ">=":
      return { min: value, max: null };
    default:
      return { min: value, max: value };
  }
}
function parseWordList(raw) {
  return raw.split(",").map((w) => w.trim().toLowerCase()).filter((w) => w !== "");
}
function parseField(s, field, negated, start) {
  const valueStart = s.pos;
  if (field === "chars" || field === "level" || field === "rating" || field === "ratings" || field === "readers" || field === "kept" || field === "myrating" || field === "status" || field === "favorite" || field === "on" || field === "bookmeter") {
    const raw = s.readBare(false);
    const end = s.pos;
    if (field === "chars")
      return { type: "chars", negated, start, end, ...parseRange(raw, start, end) };
    if (field === "level")
      return { type: "level", negated, start, end, ...parseRange(raw, start, end, "level") };
    if (field === "rating" || field === "myrating")
      return { type: field, negated, start, end, ...parseStarsRange(raw, start, end, field) };
    if (field === "ratings" || field === "readers")
      return { type: field, negated, start, end, ...parseCountRange(raw, start, end, field) };
    if (field === "kept")
      return { type: "kept", negated, start, end, ...parseKeptRange(raw, start, end) };
    const words = parseWordList(raw);
    if (field === "on") {
      if (words.length === 1 && words[0] === "device") {
        return { type: "device", negated, start, end };
      }
      if (words.length === 1 && words[0] === "audio") {
        return { type: "deviceAudio", negated, start, end };
      }
      throw new QueryError(
        "Use on:device (the books on this device) or on:audio (their audio is on this device).",
        start,
        end
      );
    }
    if (field === "bookmeter") {
      const lists = QUERY_BOOKMETER_LISTS.join(", ");
      if (words.length === 0)
        throw new QueryError(`bookmeter: needs a list: ${lists}.`, start, end);
      const values = [];
      for (const w of words) {
        if (!QUERY_BOOKMETER_LISTS.includes(w)) {
          throw new QueryError(`"${w}" isn't a 読書メーター list. Use ${lists}.`, start, end);
        }
        if (!values.includes(w)) values.push(w);
      }
      return { type: "bookmeter", negated, start, end, values };
    }
    if (field === "status") {
      if (words.length === 0) {
        throw new QueryError(`status: needs a value: ${QUERY_STATUSES.join(", ")}.`, start, end);
      }
      const values = [];
      for (const w of words) {
        if (!QUERY_STATUSES.includes(w)) {
          throw new QueryError(
            `"${w}" isn't a status. Use ${QUERY_STATUSES.join(", ")}.`,
            start,
            end
          );
        }
        if (!values.includes(w)) values.push(w);
      }
      return { type: "status", negated, start, end, values };
    }
    if (words.length !== 1 || words[0] !== "yes" && words[0] !== "no") {
      throw new QueryError("Use favorite:yes or favorite:no.", start, end);
    }
    return { type: "favorite", negated, start, end, value: words[0] === "yes" };
  }
  let exact = false;
  if (s.peek() === "=") {
    exact = true;
    s.pos += 1;
  }
  const matchers = [];
  for (; ; ) {
    if (s.done || isSpace(s.peek())) break;
    if (s.peek() === ",") {
      s.pos += 1;
      continue;
    }
    if (s.peek() === '"') {
      const value2 = s.readQuoted();
      if (value2 !== "") matchers.push({ kind: "text", value: value2, exact });
      continue;
    }
    if (s.peek() === "/") {
      const regex = s.tryReadRegex(true);
      if (regex) {
        if (regex.kind === "regex") matchers.push(regex);
        continue;
      }
    }
    const value = s.readBare(true);
    if (value !== "") matchers.push({ kind: "text", value, exact });
  }
  if (matchers.length === 0) {
    throw new QueryError(
      `${field}: needs a value, e.g. ${field}:"name".`,
      start,
      Math.max(s.pos, valueStart)
    );
  }
  return { type: "field", field, negated, start, end: s.pos, matchers };
}
function parseTerm(s) {
  const start = s.pos;
  let negated = false;
  if (s.peek() === "-") {
    negated = true;
    s.pos += 1;
    if (s.done || isSpace(s.peek())) return null;
  }
  const fieldMatch = FIELD_RE.exec(s.text.slice(s.pos, s.pos + FIELD_LOOKAHEAD));
  if (fieldMatch) {
    s.pos += fieldMatch[0].length;
    return parseField(s, fieldMatch[1].toLowerCase(), negated, start);
  }
  if (s.peek() === '"') {
    const value2 = s.readQuoted();
    if (value2 === "") return null;
    return {
      type: "any",
      negated,
      start,
      end: s.pos,
      matcher: { kind: "text", value: value2, exact: false }
    };
  }
  if (s.peek() === "/") {
    const regex = s.tryReadRegex(false);
    if (regex) {
      if (regex.kind === "text") return null;
      return { type: "any", negated, start, end: s.pos, matcher: regex };
    }
  }
  const value = s.readBare(false);
  if (value === "") return null;
  return {
    type: "any",
    negated,
    start,
    end: s.pos,
    matcher: { kind: "text", value, exact: false }
  };
}
function parseQuery(text) {
  try {
    if (text.length > QUERY_LIMITS.maxLength) {
      throw new QueryError(
        `A search can be at most ${QUERY_LIMITS.maxLength} characters long.`,
        QUERY_LIMITS.maxLength,
        text.length
      );
    }
    const s = new Scanner(text);
    const terms = [];
    for (; ; ) {
      s.skipSpace();
      if (s.done) break;
      const before = s.pos;
      const term = parseTerm(s);
      if (s.pos === before) s.pos += 1;
      if (!term) continue;
      terms.push(term);
      if (terms.length > QUERY_LIMITS.maxTerms) {
        throw new QueryError(
          `A search can have at most ${QUERY_LIMITS.maxTerms} parts.`,
          term.start,
          term.end
        );
      }
    }
    return { ok: true, query: { terms } };
  } catch (error) {
    if (error instanceof QueryError) {
      return { ok: false, error: { message: error.message, start: error.start, end: error.end } };
    }
    throw error;
  }
}
function usesBookState(query) {
  return query.terms.some(
    (t) => t.type === "status" || t.type === "favorite" || t.type === "device" || t.type === "deviceAudio"
  );
}
function usesRegex(query) {
  return query.terms.some(
    (t) => t.type === "any" ? t.matcher.kind === "regex" : t.type === "field" && t.matchers.some((m) => m.kind === "regex")
  );
}

// src/lib/library/series-figures.ts
var DEFAULT_KEPT_RULES = {
  minReaders: 50,
  neighbourPercent: 70,
  maxPercent: 120,
  minMonths: 6
};
var DEFAULT_SCORE_PARAMS = { m: 4.1, c: 20 };
var MONTH = 30 * 24 * 60 * 60 * 1e3;
function figureKey(library, series) {
  return `${library}:${series}`;
}
function isVolume(index, n) {
  return Math.abs(index - n) < 1e-9;
}
function maxOf(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
function seriesFigures(volumes, rules, now) {
  const by = /* @__PURE__ */ new Map();
  for (const v of volumes) {
    let n;
    if (isVolume(v.index, 1)) n = 1;
    else if (isVolume(v.index, 2)) n = 2;
    else if (isVolume(v.index, 3)) n = 3;
    else continue;
    const key = figureKey(v.library, v.series);
    let c = by.get(key);
    if (!c) {
      c = { stars: null, r1: null, r2: null, r3: null, pub2: null };
      by.set(key, c);
    }
    if (n === 1) {
      c.r1 = maxOf(c.r1, v.readers);
      if (v.ratingCount !== null && v.ratingX10 !== null && v.ratingScore !== null) {
        const s = c.stars;
        if (!s || v.ratingCount > (s.ratingCount ?? 0) || v.ratingCount === s.ratingCount && v.id < s.id) {
          c.stars = v;
        }
      }
    } else if (n === 2) {
      c.r2 = maxOf(c.r2, v.readers);
      c.pub2 = maxOf(c.pub2, v.publishedAt);
    } else {
      c.r3 = maxOf(c.r3, v.readers);
    }
  }
  const out = /* @__PURE__ */ new Map();
  for (const [key, c] of by) {
    const s = c.stars;
    out.set(key, {
      rating: s && s.ratingX10 !== null && s.ratingCount !== null && s.ratingScore !== null ? { avg: s.ratingX10 / 10, count: s.ratingCount, score: s.ratingScore } : null,
      readers: c.r1,
      kept: keptOf(c, rules, now)
    });
  }
  return out;
}
function keptOf(c, rules, now) {
  if (c.r1 === null || c.r2 === null || c.r1 <= 0 || c.r1 < rules.minReaders) return null;
  if (c.pub2 !== null && c.pub2 > now - rules.minMonths * MONTH) return null;
  if (c.r3 !== null && c.r3 > 0 && c.r2 * 100 < rules.neighbourPercent * c.r3) return null;
  const percent = c.r2 * 100 / c.r1;
  if (percent > rules.maxPercent) return null;
  return Math.min(100, Math.round(percent));
}
function pickFigure(figures) {
  let best = null;
  for (const f of figures) {
    if (!f) continue;
    if (!best || (f.readers ?? -1) > (best.readers ?? -1) || (f.readers ?? -1) === (best.readers ?? -1) && (f.rating?.count ?? -1) > (best.rating?.count ?? -1)) {
      best = f;
    }
  }
  return best;
}
function worksFigure(works, params) {
  let count = 0;
  let weighted = 0;
  let readers = null;
  for (const w of works) {
    if (w.rating && w.rating.count > 0) {
      count += w.rating.count;
      weighted += w.rating.avg * w.rating.count;
    }
    if (w.readers !== null) readers = (readers ?? 0) + w.readers;
  }
  const rating = count > 0 ? {
    avg: Math.round(weighted * 10 / count) / 10,
    count,
    score: Math.round(1e3 * (params.c * params.m + weighted) / (params.c + count))
  } : null;
  return { rating, readers, kept: null };
}
function figureSortValue(f, key) {
  if (!f) return null;
  if (key === "rating") return f.rating?.score ?? null;
  if (key === "ratings") return f.rating?.count ?? null;
  if (key === "readers") return f.readers;
  return f.kept;
}
function figureTermValue(f, key) {
  if (!f) return null;
  if (key === "rating") return f.rating ? Math.round(f.rating.avg * 10) : null;
  return figureSortValue(f, key);
}
function figureMatches(value, min, max, negated) {
  if (value === null) return false;
  const inside = (min === null || value >= min) && (max === null || value <= max);
  return negated ? !inside : inside;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_KEPT_RULES,
  DEFAULT_SCORE_PARAMS,
  QUERY_FIELDS,
  QUERY_LIMITS,
  QUERY_STATUSES,
  figureKey,
  figureMatches,
  figureSortValue,
  figureTermValue,
  parseQuery,
  pickFigure,
  seriesFigures,
  usesBookState,
  usesRegex,
  worksFigure
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */
