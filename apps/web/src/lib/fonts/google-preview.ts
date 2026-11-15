/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Samples in the Google Fonts list (Phase 10, decided 2026-11-15): while the list is open,
 * this device asks Google for a tiny font holding only the sample's characters (the CSS
 * API's `text=` parameter; CORS verified 2026-11-15) and draws the sample in it. Each
 * sample font has its own family name (`ttu-preview-…`), so it never stands in for a
 * saved font of the same name. A sample that can't load stays in the normal font.
 */
export const PREVIEW_TEXT = '吾輩は猫である。';

const CSS_API = 'https://fonts.googleapis.com/css2';
const FILE_ORIGIN = 'https://fonts.gstatic.com';

export function previewFamilyName(family: string): string {
  return `ttu-preview-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function previewCssUrl(family: string, text = PREVIEW_TEXT): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  return `${CSS_API}?family=${name}&text=${encodeURIComponent(text)}`;
}

/** The sample font's address from Google's CSS, only when it is on fonts.gstatic.com. */
export function previewFontUrl(css: string): string | null {
  const match = /src:\s*url\(([^)\s]+)\)/.exec(css);
  if (!match) return null;
  const url = match[1].replace(/^['"]|['"]$/g, '');
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === FILE_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

export interface PreviewDeps {
  fetchCss(url: string, signal: AbortSignal): Promise<string>;
  /** Registers the font under `name` from `url`; throws when it can't load. */
  addFace(name: string, url: string): Promise<{ remove(): void }>;
}

function browserDeps(): PreviewDeps | null {
  if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
    return null;
  }
  return {
    async fetchCss(url, signal) {
      const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`);
      return res.text();
    },
    async addFace(name, url) {
      const face = new FontFace(name, `url(${url})`, { display: 'swap' });
      await face.load();
      document.fonts.add(face);
      return { remove: () => document.fonts.delete(face) };
    }
  };
}

/**
 * Loads samples on request, at most a few at a time, each once. `close()` removes them
 * all from the page and stops what is still loading.
 */
export class GooglePreviews {
  private readonly loaded = new Map<string, Promise<string | null>>();
  private readonly faces: { remove(): void }[] = [];
  private readonly abort = new AbortController();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly deps: PreviewDeps | null = browserDeps(),
    private readonly parallel = 4
  ) {}

  /** The sample's family name once it loaded, or null when it can't be shown. */
  load(family: string): Promise<string | null> {
    let promise = this.loaded.get(family);
    if (!promise) {
      promise = this.run(() => this.fetchOne(family));
      this.loaded.set(family, promise);
    }
    return promise;
  }

  private async fetchOne(family: string): Promise<string | null> {
    const deps = this.deps;
    if (!deps || this.abort.signal.aborted) return null;
    try {
      const url = previewFontUrl(await deps.fetchCss(previewCssUrl(family), this.abort.signal));
      if (!url || this.abort.signal.aborted) return null;
      const name = previewFamilyName(family);
      const face = await deps.addFace(name, url);
      if (this.abort.signal.aborted) {
        face.remove();
        return null;
      }
      this.faces.push(face);
      return name;
    } catch {
      return null;
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      const start = () => {
        this.running++;
        void task()
          .then(resolve)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < this.parallel) start();
      else this.queue.push(start);
    });
  }

  close(): void {
    this.abort.abort();
    for (const face of this.faces.splice(0)) {
      try {
        face.remove();
      } catch {
        // Already gone.
      }
    }
  }
}
