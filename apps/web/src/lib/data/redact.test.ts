/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactValue } from './redact';

const TOKEN = 'ttsu_' + 'Ab9_-'.repeat(8) + 'xyz';
const UUID = '5e7d2c1a-8b4f-4c3e-9a6d-0f1b2c3d4e5f';

describe('redactText', () => {
  it('removes device tokens and authorization values', () => {
    expect(redactText(`token ${TOKEN} used`)).toBe(`token ttsu_${REDACTED} used`);
    expect(redactText('Authorization: Bearer abc.def-123')).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
    expect(redactText('header "Bearer s3cr3t", next')).toBe(`header "Bearer ${REDACTED}", next`);
    expect(redactText('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
  });

  it('removes secret URL parameters and keeps the others', () => {
    expect(redactText('GET /file?name=a.json&token=legacy-secret#x')).toBe(
      `GET /file?name=a.json&token=${REDACTED}#x`
    );
    expect(redactText('/api/v1/books/1/thumbnail?u=user&v=3&s=abcdef0123')).toBe(
      `/api/v1/books/1/thumbnail?u=user&v=3&s=${REDACTED}`
    );
    expect(redactText('/pair?code=ABCD-1234')).toBe(`/pair?code=${REDACTED}`);
  });

  it('removes secret keys in JSON and key: value text', () => {
    expect(redactText('{"token":"abc","label":"Boox"}')).toBe(
      `{"token":"${REDACTED}","label":"Boox"}`
    );
    expect(redactText('{"authToken": "x\\"y", "n": 1}')).toBe(
      `{"authToken": "${REDACTED}", "n": 1}`
    );
    expect(redactText('password=hunter2 next')).toBe(`password=${REDACTED} next`);
    expect(redactText("clientSecret: 'abc'")).toBe(`clientSecret: ${REDACTED}`);
    expect(redactText('Sync: token rejected (401)')).toBe('Sync: token rejected (401)');
  });

  it('removes pairing codes but keeps ids, dates, error codes and titles', () => {
    expect(redactText('Pairing: code 7K3M-Q9TZ redeemed')).toBe(
      `Pairing: code ${REDACTED} redeemed`
    );
    expect(redactText('{"code":"7k3m-q9tz"}')).toBe(`{"code":"${REDACTED}"}`);
    expect(redactText('code=7k3mq9tz')).toBe(`code=${REDACTED}`);
    expect(redactText(`book ${UUID} and ${UUID.toUpperCase()}`)).toBe(
      `book ${UUID} and ${UUID.toUpperCase()}`
    );
    expect(redactText('{"code":"cursor_reset"} {"code":"conflict"}')).toBe(
      '{"code":"cursor_reset"} {"code":"conflict"}'
    );
    expect(redactText('2026-11-10 薬屋のひとりごと 第1巻 | ッツ Ebook Reader')).toBe(
      '2026-11-10 薬屋のひとりごと 第1巻 | ッツ Ebook Reader'
    );
  });

  it('removes exact secrets, also URL-encoded, and ignores very short ones', () => {
    const secret = 'my legacy/secret';
    expect(redactText(`a ${secret} b ${encodeURIComponent(secret)}`, { secrets: [secret] })).toBe(
      `a ${REDACTED} b ${REDACTED}`
    );
    expect(redactText('abc', { secrets: ['abc', null, undefined] })).toBe('abc');
  });
});

describe('redactValue', () => {
  it('replaces secret keys at any depth and redacts strings', () => {
    const value = {
      connection: { serverUrl: 'http://nas:3001', token: TOKEN, label: 'Boox' },
      storage: [{ data: { clientSecret: 'cs', authToken: 'at' } }],
      log: [{ level: 'warn', args: [`Sync: failed with Bearer ${TOKEN}`] }],
      error: { code: 'cursor_reset', message: 'x' },
      pair: { code: '7K3M-Q9TZ' },
      emptyToken: '',
      count: 3
    };
    const out = redactValue(value, { secrets: [TOKEN] });
    expect(out).toEqual({
      connection: { serverUrl: 'http://nas:3001', token: REDACTED, label: 'Boox' },
      storage: [{ data: { clientSecret: REDACTED, authToken: REDACTED } }],
      log: [{ level: 'warn', args: [`Sync: failed with Bearer ${REDACTED}`] }],
      error: { code: 'cursor_reset', message: 'x' },
      pair: { code: REDACTED },
      emptyToken: '',
      count: 3
    });
    expect(JSON.stringify(out)).not.toContain(TOKEN.slice(5));
    expect(value.connection.token).toBe(TOKEN); // the input is not changed
  });

  it('survives cycles and odd values', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: '[cycle]' });
    const shared = { x: 1 };
    expect(redactValue({ p: shared, q: shared })).toEqual({ p: { x: 1 }, q: { x: 1 } });
    expect(redactValue(null)).toBeNull();
    expect(redactValue(5)).toBe(5);
  });
});
