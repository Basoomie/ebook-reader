/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Tests only: a 2D context that records calls; every character is as wide as the font size. */
export function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = {
    font: '10px x',
    measureText: (t: string) => {
      const px = Number(/(\d+)px/.exec(String(state.font))?.[1] ?? 10);
      return { width: [...t].length * px };
    }
  };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      calls.push({ name: `set:${prop}`, args: [value] });
      return true;
    }
  }) as unknown as CanvasRenderingContext2D;
  const texts = () => calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
  return { ctx, calls, texts };
}
