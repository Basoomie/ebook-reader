/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Copies text to the clipboard from a tap or click (Notes page "Copy text", 2026-11-21).
 * The Clipboard API exists only in a secure context (https or localhost), and the app is
 * served over plain http, so without it the text is copied the old way: selected in a
 * hidden text box and copied with `document.execCommand('copy')` (still supported by the
 * browsers in use, and allowed inside a user gesture). True when the browser says it
 * copied.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied (a permission or focus rule): try the old way below.
    }
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const active = document.activeElement as HTMLElement | null;
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  // Off screen but focusable; 16 px so iOS doesn't zoom in.
  box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px;';
  document.body.appendChild(box);
  let ok = false;
  try {
    box.select();
    box.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    box.remove();
    active?.focus?.({ preventScroll: true });
  }
  return ok;
}
