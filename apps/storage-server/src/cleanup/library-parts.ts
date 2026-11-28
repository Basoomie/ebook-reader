/**
 * Manga part B (manga-library.md, approved 2026-11-25): what the cleanup keeps per Calibre
 * library. Each library the cleanup works on has its own stage 1-5 analyses, stage 4's AI check,
 * stage 5, the one-time passes, and the in-memory state of their rounds (what is running, why a
 * stage waits, the status caches). The batches, the fetch queue, the disk lock, the AI runner,
 * the sidecar, the new arrivals, the move and the user's edits stay one for every library
 * (CleanupService): one writer at a time across all libraries.
 */
import type { Stage1Analysis } from './stage1';
import type { Stage2Analysis } from './stage2';
import type { Stage3Analysis } from './stage3';
import type { Stage4Analysis } from './stage4/analysis';
import type { Stage4Ai } from './stage4/ai-step';
import type { Stage5 } from './stage5/step';
import type { BookmeterMore } from './stage4/bookmeter-more';
import type { SeriesPairs } from './series-pairs/pass';
import type { LinkDiscovery } from './stage4/link-discovery';
import type { BookmeterListings } from './stage4/bookmeter-listing';
import type { FormatsPass } from './formats/pass';
import type { InheritPass } from './inherit/pass';

type Cache = { at: number; value: unknown } | null;

export class LibraryParts {
  analysing: Promise<void> | null = null;
  analysing2: Promise<void> | null = null;
  analysing3: Promise<void> | null = null;
  analysing4: Promise<void> | null = null;
  analysing5: Promise<void> | null = null;
  /** Why stage 1 is not applying right now (not a pause; it clears by itself). */
  waiting: string | null = null;
  waiting2: string | null = null;
  waiting3: string | null = null;
  waiting4: string | null = null;
  waiting5: string | null = null;
  bookmeterRunning: Promise<void> | null = null;
  seriesPairsRunning: Promise<void> | null = null;
  linksRunning: Promise<void> | null = null;
  listingsRunning: Promise<void> | null = null;
  /** Books without an EPUB: this library's pass (set once made) and its running loop. */
  formats: FormatsPass | null = null;
  formatsRunning: Promise<void> | null = null;
  /** Replaced books (inherit/pass.ts): this library's pass and its running loop. */
  inherit: InheritPass | null = null;
  inheritRunning: Promise<void> | null = null;
  status4Cache: Cache = null;
  status5Cache: Cache = null;
  bookmeterCache: Cache = null;
  linksCache: Cache = null;
  listingsCache: Cache = null;
  labeled4Cache: { at: number; value: { site: string; n: number }[] } | null = null;
  fields4Cache: { at: number; value: { field: string; class: string; n: number }[] } | null = null;
  /** Books written per finished stage-4 batch (counted once each; write-progress.ts). */
  batchBooks = new Map<string, number>();
  /** Stage 5's books written (each once) and the finished batches already counted. */
  batchBooks5: { analysisId: string | null; counted: Set<string>; books: number } = {
    analysisId: null,
    counted: new Set(),
    books: 0,
  };
  /** Books read at each status (the reading's measured rate over the last minutes). */
  readMarks: { at: number; n: number; analysisId: string }[] = [];

  constructor(
    readonly libraryId: string,
    readonly analysis: Stage1Analysis | null,
    readonly analysis2: Stage2Analysis | null,
    readonly analysis3: Stage3Analysis | null,
    readonly analysis4: Stage4Analysis | null,
    readonly stage4Ai: Stage4Ai | null,
    readonly stage5: Stage5 | null,
    readonly bookmeter: BookmeterMore | null,
    readonly seriesPairs: SeriesPairs | null,
    readonly links: LinkDiscovery | null,
    readonly listings: BookmeterListings | null,
  ) {}

  /** A library-wide analysis of this library is running (stage 1-5), as words for the page. */
  busy(): string | null {
    if (this.analysing) return "stage 1's analysis";
    if (this.analysing2) return "stage 2's analysis";
    if (this.analysing3) return "stage 3's analysis";
    if (this.analysing4) return "stage 4's analysis";
    if (this.analysing5) return "stage 5's analysis";
    return null;
  }
}
