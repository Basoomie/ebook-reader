/*
 * GENERATED FILE, DO NOT EDIT. The storage server bug-report redaction, bundled from
 * the web app (apps/web/src/lib/data/redact.ts).
 * Rebuild with `pnpm build:server-redact` in apps/web after changing that code.
 * build: 6b1f3388f166d5c6
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

// src/lib/data/redact.ts
var redact_exports = {};
__export(redact_exports, {
  REDACTED: () => REDACTED,
  redactText: () => redactText,
  redactValue: () => redactValue
});
module.exports = __toCommonJS(redact_exports);
var REDACTED = "[removed]";
var SECRET_KEYS = /* @__PURE__ */ new Set([
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apitoken",
  "devicetoken",
  "authorization",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "apikey",
  "pairingcode"
]);
var CODE_KEYS = /* @__PURE__ */ new Set(["code", "pairingcode"]);
var normalizeKey = (key) => key.toLowerCase().replace(/[-_]/g, "");
var CROCKFORD = "0-9A-HJKMNP-TV-Z";
var TYPED_CODE_RE = /^\s*[0-9a-z]{4}[\s-]?[0-9a-z]{4}\s*$/i;
function looksLikePairingCode(value) {
  if (!TYPED_CODE_RE.test(value)) return false;
  return /\d/.test(value) || /[\s-]/.test(value.trim()) || value === value.toUpperCase();
}
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var KEY_NAMES = "token|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?token|device[-_]?token|authorization|password|passwd|secret|client[-_]?secret|api[-_]?key|pairing[-_]?code";
var TEXT_RULES = [
  // Device tokens.
  [/ttsu_[A-Za-z0-9_-]{8,}/g, `ttsu_${REDACTED}`],
  // Authorization header values.
  [
    /\b(Bearer|Basic)(\s+)(?!\[removed\])[^\s"',;)}\]]+/gi,
    (_m, scheme, space) => `${scheme}${space}${REDACTED}`
  ],
  // URL parameters.
  [
    /([?&](?:token|access_token|auth|code|key|s|sig|signature)=)[^&#\s"'<>]*/gi,
    (_m, head) => `${head}${REDACTED}`
  ],
  // JSON text: "token": "…" (and the other secret keys).
  [
    new RegExp(`("(?:${KEY_NAMES})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"),
    (_m, head) => `${head}"${REDACTED}"`
  ],
  // key: value / key=value text ("Authorization: Bearer …" is handled above).
  [
    new RegExp(
      `\\b((?:${KEY_NAMES})\\s*[:=]\\s*)(?!\\[removed\\]|(?:Bearer|Basic)\\s)["']?[^\\s"'&,;)}\\]]+["']?`,
      "gi"
    ),
    (_m, head) => `${head}${REDACTED}`
  ],
  // A pairing code after the word code ("code": "abcd-1234", code=ABCD1234).
  [
    /(\bcode["']?\s*[:=]\s*["']?)([0-9a-z]{4}[\s-]?[0-9a-z]{4})(?![0-9a-z_-])/gi,
    (m, head, code) => looksLikePairingCode(code) ? `${head}${REDACTED}` : m
  ],
  // Pairing codes as shown: XXXX-XXXX in capitals (not part of a longer id).
  [
    new RegExp(`(?<![0-9A-Za-z-])[${CROCKFORD}]{4}-[${CROCKFORD}]{4}(?![0-9A-Za-z-])`, "g"),
    REDACTED
  ]
];
function secretList(options) {
  const out = /* @__PURE__ */ new Set();
  for (const secret of options.secrets ?? []) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out.add(secret);
    try {
      out.add(encodeURIComponent(secret));
    } catch {
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
function redactWith(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replace(new RegExp(escapeRe(secret), "g"), REDACTED);
  }
  for (const [re, replacement] of TEXT_RULES) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}
function redactText(text, options = {}) {
  return redactWith(String(text), secretList(options));
}
function redactValue(value, options = {}) {
  const secrets = secretList(options);
  const seen = /* @__PURE__ */ new WeakSet();
  const walk = (v, key, depth) => {
    if (key !== null) {
      const k = normalizeKey(key);
      if (SECRET_KEYS.has(k) && v !== null && v !== void 0 && v !== "") return REDACTED;
      if (CODE_KEYS.has(k) && typeof v === "string" && looksLikePairingCode(v)) return REDACTED;
    }
    if (typeof v === "string") return redactWith(v, secrets);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[cycle]";
    if (depth > 50) return "[too deep]";
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, null, depth + 1));
      const out = {};
      for (const [k, item] of Object.entries(v)) {
        out[k] = walk(item, k, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  try {
    return walk(value, null, 0);
  } catch {
    return REDACTED;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  REDACTED,
  redactText,
  redactValue
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */
