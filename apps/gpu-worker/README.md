# ッツ Reader GPU worker (WP16, WP17)

A small program for the PC with the GPU. It asks the reader's server for jobs and runs them in Docker Desktop with the GPU:

- **Make subtitles on the PC** (WP16): downloads the book's EPUB and its linked audio file into a temporary folder, runs SubPlz, uploads the `.srt`, and deletes the temporary folder. The server saves the subtitles in `japanese-srt/_generated/` and links them to the book.
- **Make an audiobook on the PC** (WP17), its **Preview**, and **Describe a voice**: runs the TTS program (Irodori-TTS, see [TTS program](#tts-program-wp17)) on the book's text, which the server sends chapter by chapter. Each finished chapter is uploaded at once; the server puts the book together (an `.m4b` with one chapter per book chapter and an `.srt` with the exact timings) in `japanese-generated/<Author>/<Title>/` and links both to the book.
- **Sentence audio for Anki** (Season 2 Phase 12, worker 1.1.2): for a book without an audiobook, Enrich's sentence is read by the same TTS program; the sentences waiting for one book are read in one run (each is one "chapter"), so the model is loaded once for all of them. The server takes them before other waiting jobs, and a running audiobook stops after its current chapter to let them in, then continues. An older worker never asks for them, so it needs `install-local` again (no `build-tts`: the TTS image is unchanged).
- **Read aloud** (Season 2 Phase 12 session 3, worker 1.2.0, TTS image 2): the reader's read-aloud is read by the voice kept loaded (see [TTS program](#tts-program-wp17)), a few sentences at a time, as the reader asks for them. Updating to 1.2.0 needs `install-local` and `build-tts` (step 8) in each Windows account.
- **Narration and dialogue voices** (Season 2 Phase 12 session 4, worker 1.3.0, TTS image 3): when a book's PC voice has a dialogue voice, the server sends a sentence with dialogue in runs, each naming its voice; the TTS program reads each run with that voice's clip and seed (both voices in the same batches, the model loaded once) and joins a sentence's runs with a short pause, keeping one timing per sentence. The server gives two-voice work only to 1.3.0 or later; an older worker keeps reading one-voice work. Updating needs `install-local` and `build-tts` (step 8) in each Windows account.
- **Per-character voices** (Season 2 Phase 12 session 5, worker 1.4.0): "Find who speaks each quote" on a book's page runs a speaker model (a GGUF file from the reader's list in **Settings > Audiobooks**; Gemma 4 26B A4B to start) in llama.cpp's server, in Docker with the GPU, listening on 127.0.0.1 only. The server sends the requests one at a time and keeps each answer, so a job that makes way (Pause, read-aloud, sentence audio) continues later where it was. Updating needs `install-local` and `pull-speakers` (step 10) in each Windows account; an older worker never asks for speaker jobs.

The worker only asks for the kinds of job whose program is on this PC: without the TTS program it still makes subtitles, and the other way round.

SubPlz runs like a manual run:

```
docker run --rm --gpus all --name ttsu-subplz-<job> -v C:\ttsu-worker\work\job-<job>:/sync -v C:\Data\Japanese\Books\SyncCache:/config kanjieater/subplz@sha256:58cddc13… sync -d /sync/book
```

The job folder uses plain names (`book\book.epub`, `book\audio-<key>.m4b`), because the real book and audio names have spaces and Japanese characters. `--name` lets "Stop" kill that one container. The cache folder is mounted at `/config`, not `/SyncCache` as in older SubPlz instructions: current SubPlz images keep their models, logs and job files under `/config` and stop at once when it isn't writable. SubPlz creates `cache`, `logs` and `jobs` folders inside the cache folder.

SubPlz also keeps every chapter's transcript in `cache` as `<audio file name>.<chapter>.<model>.subs` and reuses it whenever a file of that name comes again. So `<key>` is made from the real audio file's name and size: each audiobook gets its own name, and a retry of the same audiobook reuses its own transcripts. Worker 1.1.0 and older named every audio `audio.m4b`, so a book got the transcripts of the book before it. The `audio.m4b.*.subs` files they left in `cache` are never read again and can be deleted.

The SubPlz image is pinned by digest: `kanjieater/subplz@sha256:58cddc13c51789d65edb2b81ef47b2dd76613e54f9c4726cc96d94f2aff7b310`. That digest is `kanjieater/subplz:latest` as published on 2025-10-24. It changes only on purpose (`image` in `config.json`).

## Set up on the PC

The worker works in whichever Windows account you are signed in to. Docker Desktop and the start at sign-in are per account, so steps 1–3 and 7 are done **in each account** that should run it. Steps 4–6 are done once: `C:\ttsu-worker` is shared by all accounts. If two accounts are signed in at the same time, only the first worker runs (a lock file in `C:\ttsu-worker`).

1. **Docker Desktop.** Open Settings > General. Turn on **Start Docker Desktop when you sign in**, and turn on **Use the WSL 2 based engine** (the Hyper-V engine can't use the GPU and is limited to its own small memory setting). The NVIDIA driver that is already installed gives WSL2 the GPU, so nothing else is needed: no CUDA toolkit and no Python on Windows.
2. **Pull the SubPlz image** (several GB):
   ```
   docker pull kanjieater/subplz@sha256:58cddc13c51789d65edb2b81ef47b2dd76613e54f9c4726cc96d94f2aff7b310
   ```
3. **Check the GPU.** This should print `True`:
   ```
   docker run --rm --gpus all --entrypoint python kanjieater/subplz@sha256:58cddc13c51789d65edb2b81ef47b2dd76613e54f9c4726cc96d94f2aff7b310 -c "import torch; print(torch.cuda.is_available())"
   ```
4. **Make a worker token on the NAS** (Unraid terminal) and copy the `ttsu_…` line it prints:
   ```
   docker exec ttsu-storage node dist/cli.js token worker "PC GPU worker"
   ```
   This token works only for the worker's own routes, not as a device.
5. **Install the worker.** From the repository folder on the PC:
   ```
   npx -y pnpm@9.15.9 --filter ttsu-gpu-worker run install-local
   ```
   This creates `C:\ttsu-worker\` (`app\`, `config.json`, `config.example.json`, `start-hidden.vbs`). Open `C:\ttsu-worker\config.json` and put in the server address (`http://192.168.1.5:3081`) and the token. Running it again later updates `app\` and keeps your `config.json`.
6. **Test it:**
   ```
   node C:\ttsu-worker\app\main.js check
   ```
   Every line should say `OK`.
7. **Start it at sign-in** (in each account; PowerShell, no admin needed). This puts a shortcut in that account's Startup folder:
   ```
   $s = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Startup'))\ttsu GPU worker.lnk"); $s.TargetPath = 'wscript.exe'; $s.Arguments = '"C:\ttsu-worker\start-hidden.vbs"'; $s.Save()
   ```
   To start it now without signing out: `wscript.exe "C:\ttsu-worker\start-hidden.vbs"`. To stop starting it, delete `ttsu GPU worker` from the Startup folder (Win+R, `shell:startup`).

If the worker can't reach the NAS while NordVPN is connected, turn on NordVPN's setting that allows the local network (LAN discovery).

## TTS program (WP17)

Audiobooks are read by the TTS program, an image built on this PC from `app\tts\` (Irodori-TTS pinned to commit `3822056`, PyTorch 2.10 with CUDA 12.8, SudachiPy for kanji readings). It runs like this:

```
docker run --rm --gpus all --name ttsu-tts-<job> -v C:\ttsu-worker\work\job-<job>:/work -v C:\Data\LLM\Models\ttsu-reader-tts:/models -e HF_HOME=/models/.shared -e HF_HUB_DISABLE_SYMLINKS=1 ttsu-irodori:3 run --job /work/job.json
```

**The voice kept loaded (1.2.0, Season 2 Phase 12 session 3).** Read-aloud in the reader and Enrich's sentence clips use one long-lived container of the same program instead, which loads the model once (1–2 minutes) and then reads a few sentences in seconds:

```
docker run --rm -i --gpus all --name ttsu-tts-live -v C:\ttsu-worker\work\live:/work -v C:\Data\LLM\Models\ttsu-reader-tts:/models -e HF_HOME=/models/.shared -e HF_HUB_DISABLE_SYMLINKS=1 ttsu-irodori:3 serve
```

It stays loaded for **Settings > Audiobooks > Keep the voice loaded** (default 10 minutes) after read-aloud's or a clip's last use, also when an audiobook or subtitle job waits; those start when the time is up. The worker lets it go then, on Pause, and before any other job. While read-aloud plays, a running audiobook, preview or voice sample is stopped at once and goes back to the queue (no try used); a running subtitle job finishes first.

Set up, after the steps above:

8. **Build the TTS program** (in **each** Windows account, because Docker Desktop keeps images per account; about 10 minutes and 9.4 GB the first time):
   ```
   node C:\ttsu-worker\app\main.js build-tts
   ```
   Then `node C:\ttsu-worker\app\main.js check` should also say `OK  TTS program on the PC`, `OK  GPU visible to the TTS program` and `OK  Models folder`.
9. **Nothing else.** The models folder `C:\Data\LLM\Models\ttsu-reader-tts` is made by the worker and shared by every Windows account (it inherits the "Authenticated Users: Modify" permission of `C:\Data\LLM\Models`). Each model is downloaded once, the first time a book, preview or described voice uses it: `<owner>--<name>/<version>/` per model (Irodori v4.1 Small about 2.9 GB), plus `.shared` (about 0.5 GB of parts every model uses). A model removed in **Settings > Audiobooks > Models on the PC** has its folder deleted by the worker.
10. **Download the speaker program** (in **each** Windows account; about 4.4 GB the first time):

```
node C:\ttsu-worker\app\main.js pull-speakers
```

Then `check` should also say `OK  Speaker program on the PC`, `OK  GPU visible to the speaker program` and `OK  Speaker models folder`. A speaker model is downloaded the first time a book uses it, into `C:\Data\LLM\Models\ttsu-reader-speakers\<owner>--<repo>\<version>\` (Gemma 4 26B A4B: 13.6 GB), and its sha256 is checked once. Loading it took 94 s, and books of 104,000–156,000 characters took 9–21 minutes (measured on the RTX 4070). It needs nearly all of the GPU and about 16 GB of Docker's memory while it runs, so it takes turns with the voice: read-aloud and sentence audio go first.

After a worker update that changes `tts\` (the image tag in `TTS_IMAGE` changes, e.g. `ttsu-irodori:3`), run step 8 again in each account; until then `check` and Settings say the TTS program is missing, and subtitle jobs keep working.

Speed on the RTX 4070 (measured): Irodori v4.1 Small reads about 7 times faster than real time, so a 10-hour audiobook takes about an hour and a half; the first chapter of a job waits 1–2 minutes while the model loads. The desktop's other programs share the GPU's memory; a model call that runs out of memory is retried in smaller batches (`ttsBatchSize`).

## Using it

- Use **Settings > Audiobooks > Subtitles made on the PC** in the reader to see whether the worker is online, any problem it reports (for example "Docker Desktop is not running"), and the waiting and running jobs. The **Pause** switch is also there. A paused worker takes no new job; a running subtitle job finishes unless you stop it, and an audiobook stops after its current chapter and continues later with the next one.
- Jobs wait on the server while the PC is off. If the PC goes off in the middle of a job, the job goes back to the queue after two minutes and is tried again (up to 3 times); an audiobook keeps the chapters it finished, and going back to the queue after a new chapter doesn't count as a try.
- **Voices** (Settings > Audiobooks > Voices) and **Models on the PC** are stored on the server. Your own recording needs the confirmation that it is your voice or its owner agreed (the models' terms forbid copying a voice without consent).
- The log is `C:\ttsu-worker\logs\worker.log`.
- The first job downloads SubPlz's model into the cache folder, so it takes longer.

## Settings (`config.json`)

| Key                      | Default                                   | Meaning                                                          |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------- |
| serverUrl                | (required)                                | The storage server, e.g. `http://192.168.1.5:3081`               |
| token                    | (required)                                | The worker token from step 4                                     |
| cacheDir                 | `C:\Data\Japanese\Books\SyncCache`        | SubPlz's model cache, mounted at `/config`                       |
| workDir                  | `C:\ttsu-worker\work`                     | Temporary job folders; plain ASCII, no spaces                    |
| logDir                   | `C:\ttsu-worker\logs`                     | `worker.log`, rotated to `worker.log.1`                          |
| image                    | the pinned digest above                   | The SubPlz image                                                 |
| maxRunHours              | 8                                         | SubPlz is stopped after this long                                |
| minFreeGB                | 5                                         | Free space kept on the work folder's drive besides the job       |
| logMaxMB                 | 5                                         | Log size before it is rotated                                    |
| reportSeconds            | 10                                        | How often a running job reports to the server                    |
| ttsImage                 | `ttsu-irodori:3`                          | The TTS program's image (built by `build-tts`)                   |
| ttsModelsDir             | `C:\Data\LLM\Models\ttsu-reader-tts`      | TTS models, shared by every Windows account                      |
| ttsBatchSize             | 8                                         | Sentences per model call (more is faster, needs more GPU memory) |
| ttsChapterMaxMinutes     | 120                                       | A TTS run that shows no progress for this long is stopped        |
| ttsPrecision             | `bf16`                                    | Model precision on the GPU (`bf16` or `fp32`)                    |
| idleWaitSeconds          | 25                                        | An idle check-in waits this long on the server for work (1.2.0)  |
| liveReadMaxSeconds       | 120                                       | A read-aloud batch not read in this long stops the voice process |
| speakerModelsDir         | `C:\Data\LLM\Models\ttsu-reader-speakers` | Speaker models (GGUF files), shared by every Windows account     |
| speakerPort              | 8791                                      | The local port of the speaker program (127.0.0.1 only)           |
| speakerLoadMaxMinutes    | 30                                        | Loading the speaker model may take this long                     |
| speakerRequestMaxMinutes | 10                                        | One request to the speaker model may take this long              |

## Development

- `npx -y pnpm@9.15.9 --filter ttsu-gpu-worker build` compiles `src/` to `dist/` (Node 22 built-ins only, no dependencies).
- The tests are in the storage server, because they run the worker against a real server: `apps/storage-server/tests/wp16-worker.test.ts` and `wp17-worker.test.ts`. They use a fake `docker` (`tests/fixtures/wp16/fake-docker.cjs`, `tests/fixtures/wp17/fake-tts-docker.cjs`).
- `tts/`: the TTS program (`Dockerfile`, `ttsu_tts.py`, `kana.py`). `ttsu_tts.py sample --spec` made the model-choice samples (step A); `run --job` is what the worker runs for a job; `serve` is the voice kept loaded (requests on stdin, see `cmd_serve`).
