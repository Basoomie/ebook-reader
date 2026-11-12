# ッツ Reader GPU worker (WP16)

A small program for the PC with the GPU. It asks the reader's server for jobs ("Make subtitles on the PC" on a book's page), downloads the book's EPUB and its linked audio file into a temporary folder, runs SubPlz in Docker Desktop with the GPU, uploads the `.srt`, and deletes the temporary folder. The server saves the subtitles in `japanese-srt/_generated/` and links them to the book.

SubPlz runs like a manual run:

```
docker run --rm --gpus all --name ttsu-subplz-<job> -v C:\ttsu-worker\work\job-<job>:/sync -v C:\Data\Japanese\Books\SyncCache:/config kanjieater/subplz@sha256:58cddc13… sync -d /sync/book
```

The job folder uses plain names (`book\book.epub`, `book\audio.m4b`), because the real book and audio names have spaces and Japanese characters. `--name` lets "Stop" kill that one container. The cache folder is mounted at `/config`, not `/SyncCache` as in older SubPlz instructions: current SubPlz images keep their models, logs and job files under `/config` and stop at once when it isn't writable. SubPlz creates `cache`, `logs` and `jobs` folders inside the cache folder.

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

## Using it

- Use **Settings > Audiobooks > Subtitles made on the PC** in the reader to see whether the worker is online, any problem it reports (for example "Docker Desktop is not running"), and the waiting and running jobs. The **Pause** switch is also there. A paused worker takes no new job; a running job finishes unless you stop it.
- Jobs wait on the server while the PC is off. If the PC goes off in the middle of a job, the job goes back to the queue after two minutes and is tried again (up to 3 times).
- The log is `C:\ttsu-worker\logs\worker.log`.
- The first job downloads SubPlz's model into the cache folder, so it takes longer.

## Settings (`config.json`)

| Key           | Default                            | Meaning                                                    |
| ------------- | ---------------------------------- | ---------------------------------------------------------- |
| serverUrl     | (required)                         | The storage server, e.g. `http://192.168.1.5:3081`         |
| token         | (required)                         | The worker token from step 4                               |
| cacheDir      | `C:\Data\Japanese\Books\SyncCache` | SubPlz's model cache, mounted at `/config`                 |
| workDir       | `C:\ttsu-worker\work`              | Temporary job folders; plain ASCII, no spaces              |
| logDir        | `C:\ttsu-worker\logs`              | `worker.log`, rotated to `worker.log.1`                    |
| image         | the pinned digest above            | The SubPlz image                                           |
| maxRunHours   | 8                                  | SubPlz is stopped after this long                          |
| minFreeGB     | 5                                  | Free space kept on the work folder's drive besides the job |
| logMaxMB      | 5                                  | Log size before it is rotated                              |
| reportSeconds | 10                                 | How often a running job reports to the server              |

## Development

- `npx -y pnpm@9.15.9 --filter ttsu-gpu-worker build` compiles `src/` to `dist/` (Node 22 built-ins only, no dependencies).
- The tests are in the storage server, because they run the worker against a real server: `apps/storage-server/tests/wp16-worker.test.ts`. They use a fake `docker` (`tests/fixtures/wp16/fake-docker.cjs`).
