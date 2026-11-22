/*
 * GENERATED FILE, DO NOT EDIT. The storage server copy of the Stats page code, bundled
 * from the web app (apps/web/src/lib/stats/server-entry.ts).
 * Rebuild with `pnpm build:server-stats` in apps/web after changing that code.
 * build: 498931e088698832
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

// src/lib/stats/server-entry.ts
var server_entry_exports = {};
__export(server_entry_exports, {
  addDays: () => addDays,
  bookStatesFrom: () => bookStatesFrom,
  buildStatsView: () => buildStatsView,
  changeLine: () => changeLine,
  formatDuration: () => formatDuration,
  formatNumber: () => formatNumber,
  isDayKey: () => isDayKey,
  normalizeWeekStart: () => normalizeWeekStart,
  periodContaining: () => periodContaining,
  periodLabel: () => periodLabel,
  periodToParam: () => periodToParam,
  readingSpeed: () => readingSpeed,
  statEntriesFromRecords: () => statEntriesFromRecords,
  stepPeriod: () => stepPeriod
});
module.exports = __toCommonJS(server_entry_exports);

// src/lib/sync/book-state.ts
var BOOK_STATUS_KIND = "book-status";
var BOOK_FAVORITE_KIND = "book-favorite";
var BOOK_BLUR_KIND = "book-blur";
var READ_THROUGH_KIND = "read-through";
var BOOK_STATUSES = ["unread", "reading", "completed", "dropped"];
var BOOK_BLURS = ["inherit", "always", "never"];
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDateKey(value) {
  return typeof value === "string" && DATE_RE.test(value);
}
function oneOf(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
function toReadThrough(record) {
  const number = Number(record.id.split(":")[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  const d = record.data ?? {};
  const charCount = d.charCount;
  return {
    id: record.id,
    number,
    origin: d.origin === "completion" ? "completion" : "start-over",
    startedOn: isDateKey(d.startedOn) ? d.startedOn : null,
    finished: d.finished === true,
    finishedOn: isDateKey(d.finishedOn) ? d.finishedOn : null,
    manual: d.manual === true,
    charCount: typeof charCount === "number" && Number.isInteger(charCount) && charCount >= 0 ? charCount : null
  };
}
function bookStateFrom(bookId, records) {
  const state = {
    bookId,
    status: "unread",
    statusAuto: false,
    favorite: false,
    blur: "inherit",
    readThroughs: []
  };
  for (const record of records) {
    if (record.deletedAt !== null) continue;
    switch (record.kind) {
      case BOOK_STATUS_KIND:
        if (record.id !== bookId) break;
        state.status = oneOf(record.data?.status, BOOK_STATUSES, "unread");
        state.statusAuto = record.data?.auto === true;
        break;
      case BOOK_FAVORITE_KIND:
        if (record.id === bookId) state.favorite = record.data?.favorite === true;
        break;
      case BOOK_BLUR_KIND:
        if (record.id === bookId) state.blur = oneOf(record.data?.blur, BOOK_BLURS, "inherit");
        break;
      case READ_THROUGH_KIND: {
        if (!record.id.startsWith(`${bookId}:`)) break;
        const rt = toReadThrough(record);
        if (rt) state.readThroughs.push(rt);
        break;
      }
    }
  }
  state.readThroughs.sort((a, b) => a.number - b.number);
  return state;
}
function bookStatesFrom(records) {
  const byBook = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (!record.bookId) continue;
    const list = byBook.get(record.bookId) ?? [];
    list.push(record);
    byBook.set(record.bookId, list);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [bookId, list] of byBook) out.set(bookId, bookStateFrom(bookId, list));
  return out;
}
function readThroughOfDay(readThroughs, dateKey) {
  let found = null;
  for (const rt of readThroughs) {
    const start = rt.startedOn ?? "";
    if (start <= dateKey && (!found || rt.number > found.number)) found = rt;
  }
  return found;
}

// src/lib/sync/record-statistics.ts
var STAT_DAY_KIND = "stat-day";

// src/lib/stats/stat-records.ts
var STAT_SESSION_KIND = "stat-session";
var STAT_SESSION_FIX_KIND = "stat-session-fix";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseStatSessionId(id) {
  const parts = id.split(":");
  if (parts.length !== 3 || !parts.every((p) => UUID_RE.test(p))) return null;
  return { bookId: parts[0], deviceId: parts[1], sessionId: parts[2] };
}

// src/lib/stats/aggregate.ts
var BEFORE_DEVICE_TRACKING = "before-device-tracking";
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function statEntriesFromRecords(records) {
  const fixes = /* @__PURE__ */ new Map();
  for (const r of records) {
    if (r.kind === STAT_SESSION_FIX_KIND && r.deletedAt === null) fixes.set(r.id, r.data ?? {});
  }
  const out = [];
  for (const r of records) {
    if (r.deletedAt !== null) continue;
    if (r.kind === STAT_SESSION_KIND) {
      const parsed = parseStatSessionId(r.id);
      const d = r.data ?? {};
      if (!parsed || typeof d.day !== "string" || !DAY_RE.test(d.day)) continue;
      const source = d.source === "completion" ? "completion" : "tracker";
      const seconds = source === "completion" ? 0 : count(d.seconds);
      const chars = count(d.chars);
      const fix = fixes.get(r.id);
      if (fix?.deleted === true) continue;
      const corrected = !!fix && (typeof fix.seconds === "number" || typeof fix.chars === "number");
      out.push({
        id: r.id,
        bookId: parsed.bookId,
        deviceId: parsed.deviceId,
        day: d.day,
        seconds: fix && typeof fix.seconds === "number" ? count(fix.seconds) : seconds,
        chars: fix && typeof fix.chars === "number" ? count(fix.chars) : chars,
        lookups: count(d.lookups),
        readThroughId: typeof d.readThroughId === "string" ? d.readThroughId : null,
        source,
        startedAt: typeof d.startedAt === "number" ? d.startedAt : null,
        endedAt: typeof d.endedAt === "number" ? d.endedAt : null,
        closed: d.closed === true,
        excluded: fix?.excluded === true,
        recorded: corrected ? { seconds, chars } : null
      });
    } else if (r.kind === STAT_DAY_KIND) {
      const [bookPart, day] = r.id.split(":");
      const bookId = r.bookId ?? bookPart;
      if (!bookId || !day || !DAY_RE.test(day)) continue;
      out.push({
        id: r.id,
        bookId,
        deviceId: BEFORE_DEVICE_TRACKING,
        day,
        seconds: count(r.data?.readingTime),
        chars: count(r.data?.charactersRead),
        lookups: 0,
        readThroughId: void 0,
        source: "frozen",
        startedAt: null,
        endedAt: null,
        closed: true,
        excluded: false,
        recorded: null
      });
    }
  }
  return out;
}
function emptyTotals() {
  return { seconds: 0, chars: 0, lookups: 0, speedSeconds: 0, speedChars: 0, entries: 0 };
}
function addToTotals(totals, entry) {
  if (entry.excluded) return totals;
  totals.entries += 1;
  totals.chars += entry.chars;
  totals.lookups += entry.lookups;
  if (entry.source !== "completion") {
    totals.seconds += entry.seconds;
    totals.speedSeconds += entry.seconds;
    totals.speedChars += entry.chars;
  }
  return totals;
}
function readingSpeed(totals) {
  return totals.speedSeconds > 0 ? Math.ceil(3600 * totals.speedChars / totals.speedSeconds) : 0;
}
function readThroughOfEntry(readThroughs, entry) {
  if (entry.readThroughId === void 0) return readThroughOfDay(readThroughs, entry.day);
  const number = entry.readThroughId === null ? 1 : Number(entry.readThroughId.split(":")[1]);
  return readThroughs.find((rt) => rt.number === number) ?? null;
}

// src/lib/stats/periods.ts
var DAY_RE2 = /^(\d{4})-(\d{2})-(\d{2})$/;
var MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function isDayKey(value) {
  if (typeof value !== "string") return false;
  const m = DAY_RE2.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function toUtc(day) {
  const m = DAY_RE2.exec(day);
  if (!m) throw new Error(`Not a day key: ${day}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fromUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${m}-${d}`;
}
function addDays(day, days) {
  const d = toUtc(day);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}
function weekdayOf(day) {
  return toUtc(day).getUTCDay();
}
function daysBetween(from, to) {
  const ms = toUtc(to).getTime() - toUtc(from).getTime();
  return ms < 0 ? 0 : Math.round(ms / 864e5) + 1;
}
function normalizeWeekStart(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}
function periodContaining(kind, day, weekStart) {
  const d = toUtc(day);
  switch (kind) {
    case "day":
      return { kind, from: day, to: day };
    case "week": {
      const back = (weekdayOf(day) - normalizeWeekStart(weekStart) + 7) % 7;
      const from = addDays(day, -back);
      return { kind, from, to: addDays(from, 6) };
    }
    case "month": {
      const from = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
      const to = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
      return { kind, from, to };
    }
    case "year":
      return { kind, from: `${day.slice(0, 4)}-01-01`, to: `${day.slice(0, 4)}-12-31` };
    case "all":
    default:
      return { kind: "all", from: null, to: null };
  }
}
function stepPeriod(period, direction, weekStart) {
  if (period.kind === "all" || !period.from || !period.to) return period;
  if (period.kind === "custom") {
    const length = daysBetween(period.from, period.to);
    return {
      kind: "custom",
      from: addDays(period.from, direction * length),
      to: addDays(period.to, direction * length)
    };
  }
  const anchor = direction < 0 ? addDays(period.from, -1) : addDays(period.to, 1);
  return periodContaining(period.kind, anchor, weekStart);
}
function inPeriod(day, period) {
  return (!period.from || day >= period.from) && (!period.to || day <= period.to);
}
function shortDate(day, withYear) {
  const d = toUtc(day);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}
function periodLabel(period) {
  if (period.kind === "all" || !period.from || !period.to) return "All time";
  const from = toUtc(period.from);
  switch (period.kind) {
    case "day":
      return `${WEEKDAYS[from.getUTCDay()]} ${shortDate(period.from, true)}`;
    case "month":
      return `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
    case "year":
      return String(from.getUTCFullYear());
    default: {
      if (period.from === period.to) return shortDate(period.from, true);
      const sameYear = period.from.slice(0, 4) === period.to.slice(0, 4);
      const sameMonth = sameYear && period.from.slice(5, 7) === period.to.slice(5, 7);
      const start = sameMonth ? String(from.getUTCDate()) : shortDate(period.from, !sameYear);
      return `${start} – ${shortDate(period.to, true)}`;
    }
  }
}
function periodToParam(period) {
  if (period.kind === "all" || !period.from) return "all";
  if (period.kind === "custom") return `custom:${period.from}~${period.to}`;
  return `${period.kind}:${period.from}`;
}

// src/lib/stats/stats-view.ts
function unknownBookTitle(bookId) {
  return `Unknown book (${bookId.slice(0, 8)})`;
}
function bookInfo(books, bookId) {
  return books.get(bookId) ?? {
    title: unknownBookTitle(bookId),
    libraryId: null,
    missing: false,
    charCount: null
  };
}
function passesBookFilters(bookId, input) {
  const { filter, books } = input;
  if (filter.book && bookId !== filter.book) return false;
  if (filter.library && books.get(bookId)?.libraryId !== filter.library) return false;
  return true;
}
function passesFilter(entry, input) {
  if (input.filter.device && entry.deviceId !== input.filter.device) return false;
  return passesBookFilters(entry.bookId, input);
}
function inManualCompletion(entry, readThroughs) {
  const rts = readThroughs.get(entry.bookId);
  if (!rts?.length) return false;
  const rt = readThroughOfEntry(rts, entry);
  return !!rt?.finished && rt.manual;
}
function addCounted(totals, entry, readThroughs) {
  if (entry.excluded) return;
  addToTotals(totals, inManualCompletion(entry, readThroughs) ? { ...entry, chars: 0 } : entry);
}
var byTime = (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id);
function buildStatsView(input) {
  const { entries, readThroughs, books, filter, period } = input;
  const filtered = entries.filter((e) => passesFilter(e, input));
  const heatmapDays = /* @__PURE__ */ new Map();
  const heatmapRowMap = /* @__PURE__ */ new Map();
  const dayMap = /* @__PURE__ */ new Map();
  const bookMap = /* @__PURE__ */ new Map();
  const summary = emptyTotals();
  const bookRow = (bookId) => {
    let row = bookMap.get(bookId);
    if (!row) {
      const info = bookInfo(books, bookId);
      row = {
        bookId,
        title: info.title,
        missing: info.missing,
        seconds: 0,
        chars: 0,
        speed: 0,
        lookups: 0,
        completed: false,
        manual: false,
        totals: emptyTotals()
      };
      bookMap.set(bookId, row);
    }
    return row;
  };
  for (const entry of filtered) {
    let heat = heatmapDays.get(entry.day);
    if (!heat) heatmapDays.set(entry.day, heat = emptyTotals());
    addCounted(heat, entry, readThroughs);
    if (!entry.excluded) {
      const key = `${entry.bookId}|${entry.day}`;
      let row = heatmapRowMap.get(key);
      if (!row) {
        row = {
          title: bookInfo(books, entry.bookId).title,
          dateKey: entry.day,
          readingTime: 0,
          charactersRead: 0
        };
        heatmapRowMap.set(key, row);
      }
      if (entry.source !== "completion") row.readingTime += entry.seconds;
      if (!inManualCompletion(entry, readThroughs)) row.charactersRead += entry.chars;
    }
    if (!inPeriod(entry.day, period)) continue;
    let day = dayMap.get(entry.day);
    if (!day) dayMap.set(entry.day, day = { day: entry.day, totals: emptyTotals(), entries: [] });
    day.entries.push(entry);
    addCounted(day.totals, entry, readThroughs);
    addCounted(summary, entry, readThroughs);
    if (!entry.excluded) addCounted(bookRow(entry.bookId).totals, entry, readThroughs);
  }
  let booksCompleted = 0;
  let manualChars = 0;
  for (const [bookId, rts] of readThroughs) {
    if (!passesBookFilters(bookId, input)) continue;
    for (const rt of rts) {
      if (!rt.finished) continue;
      const counts = rt.finishedOn ? inPeriod(rt.finishedOn, period) : period.kind === "all";
      if (!counts) continue;
      booksCompleted += 1;
      const row = bookRow(bookId);
      row.completed = true;
      if (rt.manual) {
        row.manual = true;
        if (!filter.device) {
          const chars = rt.charCount ?? bookInfo(books, bookId).charCount ?? 0;
          manualChars += chars;
          row.totals.chars += chars;
          if (rt.finishedOn) {
            let heat = heatmapDays.get(rt.finishedOn);
            if (!heat) heatmapDays.set(rt.finishedOn, heat = emptyTotals());
            heat.chars += chars;
            let day = dayMap.get(rt.finishedOn);
            if (!day) {
              day = { day: rt.finishedOn, totals: emptyTotals(), entries: [] };
              dayMap.set(rt.finishedOn, day);
            }
            day.totals.chars += chars;
          }
        }
      }
    }
  }
  if (!filter.device) {
    for (const [bookId, rts] of readThroughs) {
      if (!passesBookFilters(bookId, input)) continue;
      for (const rt of rts) {
        if (!rt.finished || !rt.manual || !rt.finishedOn || inPeriod(rt.finishedOn, period)) {
          continue;
        }
        let heat = heatmapDays.get(rt.finishedOn);
        if (!heat) heatmapDays.set(rt.finishedOn, heat = emptyTotals());
        heat.chars += rt.charCount ?? bookInfo(books, bookId).charCount ?? 0;
      }
    }
  }
  const days = [...dayMap.values()].map((d) => ({ ...d, entries: d.entries.sort(byTime) })).sort((a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : 0);
  const daysRead = days.filter(
    (d) => d.entries.some((e) => !e.excluded && (e.seconds > 0 || e.chars > 0))
  ).length;
  const bookRows = [...bookMap.values()].map(({ totals, ...row }) => ({
    ...row,
    seconds: totals.seconds,
    chars: totals.chars,
    speed: readingSpeed(totals),
    lookups: totals.lookups
  })).filter((row) => row.seconds > 0 || row.chars > 0 || row.completed || row.lookups > 0).sort((a, b) => b.seconds - a.seconds || b.chars - a.chars || a.title.localeCompare(b.title));
  return {
    summary: {
      seconds: summary.seconds,
      chars: summary.chars + manualChars,
      speed: readingSpeed(summary),
      lookups: summary.lookups,
      booksCompleted,
      daysRead,
      manualChars
    },
    books: bookRows,
    days,
    heatmapDays,
    heatmapRows: [...heatmapRowMap.values()].sort(
      (a, b) => a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0
    )
  };
}

// src/lib/stats/stats-format.ts
function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s ? `${s} s` : "0 min";
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${String(minutes % 60).padStart(2, "0")} min`;
}

// src/lib/stats/period-compare.ts
function formatSummaryValue(key, value) {
  if (key === "seconds") return formatDuration(value);
  if (key === "speed") return value ? `${formatNumber(value)} / h` : "–";
  return formatNumber(value);
}
var MINUS = "−";
function changeLine(key, current, previous, against) {
  const cur = current[key];
  const prev = previous[key];
  if (key === "speed" && (!cur || !prev)) {
    return !cur ? null : `${formatSummaryValue(key, cur)} vs no tracked reading ${against}`;
  }
  const diff = cur - prev;
  if (diff === 0) return `No change vs ${against}`;
  const sign = diff > 0 ? "+" : MINUS;
  const amount = key === "seconds" ? formatDuration(Math.abs(diff)) : key === "speed" ? `${formatNumber(Math.abs(diff))} / h` : formatNumber(Math.abs(diff));
  if (!prev) return `${sign}${amount} vs ${against} (none then)`;
  const percent = Math.abs(diff) / prev * 100;
  const pct = percent < 1 ? "<1" : String(Math.round(percent));
  return `${sign}${amount} (${sign}${pct}%) vs ${against}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addDays,
  bookStatesFrom,
  buildStatsView,
  changeLine,
  formatDuration,
  formatNumber,
  isDayKey,
  normalizeWeekStart,
  periodContaining,
  periodLabel,
  periodToParam,
  readingSpeed,
  statEntriesFromRecords,
  stepPeriod
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */
