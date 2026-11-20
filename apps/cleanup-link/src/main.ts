/**
 * WP21e-1: the audiobook cleanup's linking sidecar. It mounts /mnt/disk1/data once, read-write,
 * and makes the new library's folders, hard links and metadata.json files the reader's server
 * hands out, through its writer module (the only code that writes audiobook files).
 */
import { ConfigError, loadConfig } from './config';
import { LinkWorker, VERSION } from './worker';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // Logged once an hour instead of exiting, so a restart loop doesn't flood the log.
    const message = err instanceof ConfigError ? err.message : String(err);
    for (;;) {
      console.error(message);
      await new Promise((r) => setTimeout(r, 3600_000));
    }
  }
  // Modes are set explicitly on what the writer makes; the umask must not reduce them.
  process.umask(0);
  const worker = new LinkWorker(config, (m) => console.log(`${new Date().toISOString()} ${m}`));
  console.log(`ttsu-cleanup-link ${VERSION} for ${config.serverUrl}, data ${config.dataDir}`);
  const stop = () => {
    worker.stop();
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await worker.run();
  process.exit(0);
}

void main();
