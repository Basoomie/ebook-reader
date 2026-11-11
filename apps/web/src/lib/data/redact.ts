/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Removes tokens and pairing codes from what goes into a bug report (WP18). Used by the
 * web app on its report and, bundled as apps/storage-server/vendor/redact.cjs
 * (`pnpm build:server-redact`), by the server on its log lines, so both sides remove the
 * same things. Pure, no imports. Book titles, device names and record ids stay in.
 *
 * Removed:
 * - device tokens (`ttsu_…`) and anything after `Bearer ` / `Basic `;
 * - the values of `token=`, `code=`, `s=` (signed thumbnails) and similar in URLs;
 * - the values of keys such as token, authToken, password, secret, authorization, in
 *   objects and in JSON or `key: value` text;
 * - pairing codes: `XXXX-XXXX` in capitals (the way they are shown), and under a `code`
 *   or `pairingCode` key in any case;
 * - any exact secret passed in (the server's AUTH_TOKEN, this device's stored tokens).
 */

export const REDACTED = '[removed]';

export interface RedactOptions {
  /** Exact values to remove wherever they appear (shorter than 4 characters: ignored). */
  secrets?: readonly (string | null | undefined)[];
}

/** Keys whose values are always removed (compared without case, `-` and `_`). */
const SECRET_KEYS = new Set([
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apitoken',
  'devicetoken',
  'authorization',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'apikey',
  'pairingcode'
]);

/** Keys whose values are removed when they look like a pairing code. */
const CODE_KEYS = new Set(['code', 'pairingcode']);

const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

const CROCKFORD = '0-9A-HJKMNP-TV-Z';

/** A pairing code as typed: 8 letters/digits, maybe split 4-4 (any case). */
const TYPED_CODE_RE = /^\s*[0-9a-z]{4}[\s-]?[0-9a-z]{4}\s*$/i;

/**
 * Looks like a pairing code rather than an error code ("cursor_reset", "conflict"):
 * the right shape, and a digit, a separator or capitals.
 */
function looksLikePairingCode(value: string): boolean {
  if (!TYPED_CODE_RE.test(value)) return false;
  return /\d/.test(value) || /[\s-]/.test(value.trim()) || value === value.toUpperCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const KEY_NAMES =
  'token|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?token|' +
  'device[-_]?token|authorization|password|passwd|secret|client[-_]?secret|api[-_]?key|' +
  'pairing[-_]?code';

const TEXT_RULES: [RegExp, string | ((...m: string[]) => string)][] = [
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
    new RegExp(`("(?:${KEY_NAMES})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    (_m, head) => `${head}"${REDACTED}"`
  ],
  // key: value / key=value text ("Authorization: Bearer …" is handled above).
  [
    new RegExp(
      `\\b((?:${KEY_NAMES})\\s*[:=]\\s*)(?!\\[removed\\]|(?:Bearer|Basic)\\s)["']?[^\\s"'&,;)}\\]]+["']?`,
      'gi'
    ),
    (_m, head) => `${head}${REDACTED}`
  ],
  // A pairing code after the word code ("code": "abcd-1234", code=ABCD1234).
  [
    /(\bcode["']?\s*[:=]\s*["']?)([0-9a-z]{4}[\s-]?[0-9a-z]{4})(?![0-9a-z_-])/gi,
    (m, head, code) => (looksLikePairingCode(code) ? `${head}${REDACTED}` : m)
  ],
  // Pairing codes as shown: XXXX-XXXX in capitals (not part of a longer id).
  [
    new RegExp(`(?<![0-9A-Za-z-])[${CROCKFORD}]{4}-[${CROCKFORD}]{4}(?![0-9A-Za-z-])`, 'g'),
    REDACTED
  ]
];

/** Exact secrets of at least 4 characters, longest first, also URL-encoded. */
function secretList(options: RedactOptions): string[] {
  const out = new Set<string>();
  for (const secret of options.secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out.add(secret);
    try {
      out.add(encodeURIComponent(secret));
    } catch {
      // a lone surrogate: the raw value is enough
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function redactWith(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replace(new RegExp(escapeRe(secret), 'g'), REDACTED);
  }
  for (const [re, replacement] of TEXT_RULES) {
    re.lastIndex = 0;
    out = out.replace(re, replacement as never);
  }
  return out;
}

/** A text (a log line, a message) with secrets removed. */
export function redactText(text: string, options: RedactOptions = {}): string {
  return redactWith(String(text), secretList(options));
}

/**
 * A copy of a JSON-like value with secrets removed: strings are redacted, values under
 * secret keys replaced. Cycles become "[cycle]"; non-plain objects are copied by their
 * own enumerable fields. Never throws.
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  const secrets = secretList(options);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (key !== null) {
      const k = normalizeKey(key);
      if (SECRET_KEYS.has(k) && v !== null && v !== undefined && v !== '') return REDACTED;
      if (CODE_KEYS.has(k) && typeof v === 'string' && looksLikePairingCode(v)) return REDACTED;
    }
    if (typeof v === 'string') return redactWith(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[cycle]';
    if (depth > 50) return '[too deep]';
    seen.add(v as object);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, null, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(item, k, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v as object);
    }
  };
  try {
    return walk(value, null, 0) as T;
  } catch {
    return REDACTED as unknown as T;
  }
}
