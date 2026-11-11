/**
 * Bug-report redaction (WP18): vendor/redact.cjs, built by `pnpm build:server-redact` in
 * apps/web from the web app's own code, so both sides remove the same tokens and codes.
 * A web test fails when the committed file is out of date. Types mirror
 * apps/web/src/lib/data/redact.ts.
 */
import path from 'path';

export interface RedactOptions {
  secrets?: readonly (string | null | undefined)[];
}

interface RedactBundle {
  REDACTED: string;
  redactText(text: string, options?: RedactOptions): string;
  redactValue<T>(value: T, options?: RedactOptions): T;
}

/** From src/logs (ts-node) and dist/logs (Docker) alike: <package>/vendor. */
export const REDACT_BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'redact.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(REDACT_BUNDLE) as RedactBundle;

export const REDACTED = bundle.REDACTED;
export const redactText = bundle.redactText;
export const redactValue = bundle.redactValue;
