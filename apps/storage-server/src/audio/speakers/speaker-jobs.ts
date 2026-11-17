/**
 * Season 2 Phase 12 session 5: the speaker job ('attribute_speakers') in the GPU worker's
 * queue (subtitle-jobs.ts). Queued from the book page with a model from the list
 * (speaker-models.ts; chosen per run, the default preselected, like the TTS models).
 *
 * The server owns the prompts, the parsing and the merging (speaker-run.ts); the PC runs the
 * model (llama.cpp's server in Docker) and only answers requests:
 *   POST /worker/jobs/:id/speakers/next     → the next request, or done
 *   POST /worker/jobs/:id/speakers/:seq     ← the model's answer
 * Each answer is stored (speaker_steps), so a job that makes way (Pause, read-aloud, sentence
 * clips) or loses its PC continues from where it was. The book as the run reads it, and the
 * characters it starts from, are kept with the job (step -1), so a run reads one book even
 * when the EPUB or the user's list changes meanwhile. A finished run writes the model's
 * answers (speaker-store.ts; the user's corrections are never touched) and the steps go.
 */
import type Database from 'better-sqlite3';
import { DIALOGUE_RULE } from '../voice-map';
import { JobRequestError, type SubtitleJobService, type WorkerJob } from '../subtitle-jobs';
import type { TtsJobService } from '../tts-jobs';
import type { MergedCharacter } from './speaker-merge';
import type { SpeakerModelService } from './speaker-models';
import {
  PROMPT_VERSION,
  SpeakerRun,
  type LlmAnswer,
  type LlmRequest,
  type RunProgress,
} from './speaker-run';
import type { SpeakerStore } from './speaker-store';
import { speakerBook, type SpeakerBook } from './speaker-text';

/** The first PC program that runs speaker jobs. */
export const SPEAKERS_WORKER_VERSION = '1.4.0';

/** The context the PC gives the model (tokens; the longest prompt in step A was ~6k). */
export const SPEAKER_CONTEXT = 16384;

const KIND = 'attribute_speakers' as const;

export interface SpeakerJobParams {
  modelId: number;
  model: {
    repo: string;
    file: string;
    revision: string;
    size: number | null;
    sha256: string | null;
    label: string;
  };
  promptVersion: number;
  scriptVersion: number;
  dialogueRule: number;
  fileKey: string;
  quotes: number;
  requests: number;
}

/** What the PC gets when it claims a speaker job (in the claim's `tts` field). */
export interface SpeakerClaim {
  speakers: {
    model: SpeakerJobParams['model'];
    contextSize: number;
  };
}

interface Snapshot {
  book: SpeakerBook;
  seeds: MergedCharacter[];
}

interface Loaded {
  run: SpeakerRun;
  answers: Map<number, LlmAnswer>;
}

export interface SpeakerJobOptions {
  db: Database.Database;
  jobs: SubtitleJobService;
  tts: TtsJobService;
  store: SpeakerStore;
  models: SpeakerModelService;
  now?: () => number;
  log?: (message: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const MAX_ANSWER = 200_000;
const MAX_PROB_TOKENS = 4000;

/** The model's answer as stored: its text, and per token the alternatives (at most 10). */
function trimAnswer(body: unknown): LlmAnswer {
  const o = (body ?? {}) as Record<string, unknown>;
  if (typeof o.content !== 'string' || o.content.length > MAX_ANSWER) {
    throw new JobRequestError(400, 'invalid_answer', 'The answer has no text');
  }
  const out: LlmAnswer = { content: o.content };
  if (Array.isArray(o.probs)) {
    out.probs = o.probs.slice(0, MAX_PROB_TOKENS).map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const top = (Array.isArray(x.top_logprobs) ? x.top_logprobs : []).slice(0, 10).map((a) => {
        const y = (a ?? {}) as Record<string, unknown>;
        return {
          token: String(y.token ?? ''),
          logprob: typeof y.logprob === 'number' ? y.logprob : null,
        };
      });
      return {
        token: String(x.token ?? ''),
        logprob: typeof x.logprob === 'number' ? x.logprob : null,
        top_logprobs: top,
      };
    });
  }
  return out;
}

const STAGE_TEXT: Record<RunProgress['stage'], string> = {
  characters: 'Finding the characters',
  groups: 'Joining names of the same character',
  speakers: 'Working out who speaks',
  review: 'Taking a second look',
  done: 'Saving',
};

export class SpeakerJobService {
  private readonly db: Database.Database;
  private readonly jobs: SubtitleJobService;
  private readonly tts: TtsJobService;
  private readonly store: SpeakerStore;
  readonly models: SpeakerModelService;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly loaded = new Map<number, Loaded>();

  constructor(o: SpeakerJobOptions) {
    this.db = o.db;
    this.jobs = o.jobs;
    this.tts = o.tts;
    this.store = o.store;
    this.models = o.models;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? console.log;
    this.logError = o.logError ?? console.error;
    this.jobs.registerKind([KIND], {
      claim: (job) => this.prepareClaim(job),
      // A run that answered requests since it was handed out loses no attempt.
      countsAsAttempt: (job) => {
        const row = this.db
          .prepare('SELECT claim_chapters, chapters_done FROM worker_jobs WHERE id = ?')
          .get(job.id) as { claim_chapters: number | null; chapters_done: number } | undefined;
        return !row || row.chapters_done <= (row.claim_chapters ?? 0);
      },
    });
  }

  /** At start: the answers of jobs that ended are not needed any more. */
  sweep(): void {
    this.db
      .prepare(
        `DELETE FROM speaker_steps WHERE job_id NOT IN (
           SELECT id FROM worker_jobs WHERE kind = ? AND state IN ('queued', 'running'))`,
      )
      .run(KIND);
  }

  latest(userId: string, bookId: string): WorkerJob | null {
    return this.jobs.latestForBook(userId, bookId, [KIND]);
  }

  /** Whether the PC's program runs speaker jobs (null: no PC seen yet). */
  pcCanRun(): boolean | null {
    const kinds = this.jobs.claimedKinds();
    return kinds === null ? null : kinds.includes(KIND);
  }

  /** Queues a run over the user's book with the chosen model (default: the list's default). */
  async enqueue(userId: string, bookId: string, modelId?: unknown): Promise<WorkerJob> {
    const model =
      modelId === undefined || modelId === null
        ? this.models.defaultModel()
        : this.models.get(Number(modelId));
    if (!model || model.removedAt !== null) {
      throw new JobRequestError(
        400,
        'bad_model',
        'Choose a speaker model from the list in Settings > Audiobooks',
      );
    }
    const busy = this.db
      .prepare(
        `SELECT 1 FROM worker_jobs WHERE user_id = ? AND book_id = ? AND kind = ? AND state IN ('queued', 'running')`,
      )
      .get(userId, bookId, KIND);
    if (busy)
      throw new JobRequestError(
        409,
        'busy',
        'The speakers of this book are being worked out already',
      );
    const script = await this.tts.bookScript(userId, bookId);
    const book = speakerBook(script);
    if (!book.quotes.length) {
      throw new JobRequestError(422, 'no_quotes', 'This book has no dialogue in 「」');
    }
    const fileKey = (await this.tts.fileKey(userId, bookId)) ?? '';
    const seeds = this.store.seeds(userId, bookId);
    const run = new SpeakerRun(book, seeds);
    const params: SpeakerJobParams = {
      modelId: model.id,
      model: {
        repo: model.repo,
        file: model.file,
        revision: model.revision,
        size: model.size,
        sha256: model.sha256,
        label: model.label,
      },
      promptVersion: PROMPT_VERSION,
      scriptVersion: script.version,
      dialogueRule: DIALOGUE_RULE,
      fileKey,
      quotes: book.quotes.length,
      requests: run.total,
    };
    const now = this.now();
    const id = this.db.transaction(() => {
      const jobId = Number(
        this.db
          .prepare(
            `INSERT INTO worker_jobs (user_id, book_id, kind, state, params, chapters_total, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
          )
          .run(userId, bookId, KIND, JSON.stringify(params), run.total, now, now).lastInsertRowid,
      );
      const snapshot: Snapshot = { book, seeds };
      this.db
        .prepare(
          `INSERT INTO speaker_steps (job_id, seq, stage, answer, created_at) VALUES (?, -1, 'book', ?, ?)`,
        )
        .run(jobId, JSON.stringify(snapshot), now);
      return jobId;
    })();
    this.log(`GPU worker: speakers queued for book ${bookId} (job ${id}, ${model.label})`);
    this.jobs.notify();
    return this.jobs.get(id)!;
  }

  private params(job: WorkerJob): SpeakerJobParams | null {
    const p = job.params as SpeakerJobParams | null;
    return p && p.model && typeof p.model.repo === 'string' ? p : null;
  }

  private prepareClaim(job: WorkerJob): { tts: SpeakerClaim } | { error: string } {
    const p = this.params(job);
    if (!p) return { error: 'This job has no settings' };
    if (!this.db.prepare('SELECT 1 FROM speaker_steps WHERE job_id = ? AND seq = -1').get(job.id)) {
      return { error: 'This job lost its copy of the book' };
    }
    return { tts: { speakers: { model: p.model, contextSize: SPEAKER_CONTEXT } } };
  }

  /** The running speaker job the PC may work on. */
  private held(id: number): WorkerJob {
    const job = this.jobs.get(id);
    if (!job || job.kind !== KIND) throw new JobRequestError(404, 'not_found', 'No such job');
    if (job.state !== 'running')
      throw new JobRequestError(409, 'not_running', 'This job is not running');
    if (job.cancelRequested) throw new JobRequestError(409, 'cancelled', 'This job was stopped');
    return job;
  }

  private load(id: number): Loaded {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const rows = this.db
      .prepare('SELECT seq, answer FROM speaker_steps WHERE job_id = ? ORDER BY seq')
      .all(id) as { seq: number; answer: string }[];
    const snap = rows.find((r) => r.seq === -1);
    if (!snap) throw new JobRequestError(410, 'missing', 'This job lost its copy of the book');
    const { book, seeds } = JSON.parse(snap.answer) as Snapshot;
    const answers = new Map<number, LlmAnswer>();
    for (const r of rows) if (r.seq >= 0) answers.set(r.seq, JSON.parse(r.answer) as LlmAnswer);
    const loaded = { run: new SpeakerRun(book, seeds), answers };
    this.loaded.set(id, loaded);
    return loaded;
  }

  /** The next request for the PC; null when the run is complete (it is saved then). */
  next(id: number): { request: LlmRequest | null; progress: RunProgress } {
    const job = this.held(id);
    const { run, answers } = this.load(id);
    const { request, progress } = run.next(answers);
    if (!request) {
      this.finish(job, run, answers);
      return { request: null, progress };
    }
    return { request, progress };
  }

  /**
   * The PC's answer to request `seq` (it must be the one `next` gave). Returns the queue's
   * answer for the PC: stop, pause or make way.
   */
  answer(
    id: number,
    seq: number,
    body: unknown,
  ): { cancel: boolean; pause: boolean; yield: boolean } {
    this.held(id);
    const loaded = this.load(id);
    const expected = loaded.run.next(loaded.answers);
    if (!expected.request || expected.request.seq !== seq) {
      throw new JobRequestError(
        409,
        'wrong_step',
        'This is not the request the job is waiting for',
      );
    }
    const answer = trimAnswer(body);
    const ms = Number((body as { ms?: unknown })?.ms);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO speaker_steps (job_id, seq, stage, answer, ms, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seq,
        expected.request.stage,
        JSON.stringify(answer),
        Number.isFinite(ms) ? Math.round(ms) : null,
        this.now(),
      );
    loaded.answers.set(seq, answer);
    const p = expected.progress;
    const done = seq + 1;
    this.jobs.update(id, { chapters_done: done });
    return this.jobs.progress(id, {
      stage: 'generating',
      progress: Math.min(0.99, done / Math.max(done, p.total)),
      message: `${STAGE_TEXT[expected.request.stage]} (${done} of ${p.total})`,
    });
  }

  private finish(job: WorkerJob, run: SpeakerRun, answers: Map<number, LlmAnswer>): void {
    const p = this.params(job)!;
    try {
      const result = run.result(answers);
      this.store.saveRun(
        job.userId,
        job.bookId!,
        {
          jobId: job.id,
          modelId: p.modelId,
          promptVersion: p.promptVersion,
          scriptVersion: p.scriptVersion,
          dialogueRule: p.dialogueRule,
          fileKey: p.fileKey,
        },
        result,
        run.book.quotes,
      );
      this.jobs.update(job.id, {
        state: 'done',
        stage: null,
        progress: 1,
        message: null,
        finished_at: this.now(),
        lease_expires_at: null,
      });
      this.log(
        `GPU worker: job ${job.id} found ${result.characters.length} characters for ${run.book.quotes.length} quotes`,
      );
    } catch (err) {
      this.logError(`GPU worker: job ${job.id} could not save its speakers:`, err);
      this.jobs.update(job.id, {
        state: 'failed',
        error: 'The speakers could not be saved',
        finished_at: this.now(),
        lease_expires_at: null,
      });
    }
    this.db.prepare('DELETE FROM speaker_steps WHERE job_id = ?').run(job.id);
    this.loaded.delete(job.id);
  }

  /** The PC made way (Pause, read-aloud, sentence clips): back to the queue, no attempt used. */
  release(id: number): WorkerJob {
    this.held(id);
    return this.jobs.release(id);
  }

  /** Forgets cached runs of jobs that ended (stopped, failed). */
  forgetEnded(): void {
    for (const id of this.loaded.keys()) {
      const job = this.jobs.get(id);
      if (!job || (job.state !== 'running' && job.state !== 'queued')) this.loaded.delete(id);
    }
  }
}
