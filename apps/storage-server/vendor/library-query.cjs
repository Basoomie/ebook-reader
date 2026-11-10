/*
 * GENERATED FILE, DO NOT EDIT. The storage server library search parser, bundled from
 * the web app (apps/web/src/lib/library/query/server-entry.ts).
 * Rebuild with `pnpm build:server-query` in apps/web after changing that code.
 * build: d017d844b982467e
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
  QUERY_FIELDS: () => FIELDS,
  QUERY_LIMITS: () => QUERY_LIMITS,
  QUERY_STATUSES: () => QUERY_STATUSES,
  parseQuery: () => parseQuery,
  usesBookState: () => usesBookState,
  usesRegex: () => usesRegex
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
var QUERY_STATUSES = ["unread", "reading", "completed", "dropped"];
var QueryError = class extends Error {
  constructor(message, start, end) {
    super(message);
    this.start = start;
    this.end = end;
  }
};
var FIELDS = ["author", "series", "tag", "chars", "status", "favorite"];
var FIELD_RE = /^(author|series|tag|chars|status|favorite)[:：]/i;
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
function parseNumber(raw) {
  const thousands = /^(\d+(?:\.\d+)?)k$/i.exec(raw);
  if (thousands) return Math.round(Number(thousands[1]) * 1e3);
  if (!/^\d[\d,_]*$/.test(raw)) return null;
  const value = Number(raw.replace(/[,_]/g, ""));
  return Number.isSafeInteger(value) ? value : null;
}
var CHARS_HELP = "Use chars:<150000, chars:>=50k or chars:50000-150000.";
function parseChars(raw, start, end) {
  if (raw === "") throw new QueryError(`chars: needs a number. ${CHARS_HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseNumber(range[1]);
    const high = parseNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a number range. ${CHARS_HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError("The first number of a range must be the smaller one.", start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw);
  const op = compare[1] ?? "=";
  const value = parseNumber(compare[2]);
  if (value === null) throw new QueryError(`"${raw}" isn't a number. ${CHARS_HELP}`, start, end);
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
function parseWordList(raw) {
  return raw.split(",").map((w) => w.trim().toLowerCase()).filter((w) => w !== "");
}
function parseField(s, field, negated, start) {
  const valueStart = s.pos;
  if (field === "chars" || field === "status" || field === "favorite") {
    const raw = s.readBare(false);
    const end = s.pos;
    if (field === "chars")
      return { type: "chars", negated, start, end, ...parseChars(raw, start, end) };
    const words = parseWordList(raw);
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
  const fieldMatch = FIELD_RE.exec(s.text.slice(s.pos, s.pos + 9));
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
  return query.terms.some((t) => t.type === "status" || t.type === "favorite");
}
function usesRegex(query) {
  return query.terms.some(
    (t) => t.type === "any" ? t.matcher.kind === "regex" : t.type === "field" && t.matchers.some((m) => m.kind === "regex")
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QUERY_FIELDS,
  QUERY_LIMITS,
  QUERY_STATUSES,
  parseQuery,
  usesBookState,
  usesRegex
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */
