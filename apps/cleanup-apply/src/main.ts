/**
 * The Calibre library cleanup's apply sidecar (WP20a). The only program that writes to
 * Calibre, only through the running content server with calibredb, and only for batches
 * the reader's server hands out. See README.md.
 */
import { ConfigError, loadConfig } from './config';
import { consoleLogger, Worker } from './worker';

function main(): void {
  let worker: Worker;
  try {
    worker = new Worker({ config: loadConfig(process.env) });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      // Wait instead of exiting, so a restart loop doesn't flood the log.
      setInterval(() => console.error(err.message), 3600_000);
      return;
    }
    throw err;
  }
  const stop = (signal: string) => {
    consoleLogger.info(`${signal}: stopping after the current step`);
    worker.stop();
    // A step in progress is safe to repeat; don't wait long for it.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  void worker.run().then(() => process.exit(0));
}

main();
