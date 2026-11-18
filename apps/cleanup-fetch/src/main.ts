/**
 * WP20d: the library cleanup's fetch container. It runs inside gluetun's network (NordVPN), so
 * the stores see the VPN's address, and talks to the reader's server for its work.
 */
import { ConfigError, loadConfig } from './config';
import { Fetcher, VERSION } from './fetcher';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(2);
  }
  const fetcher = new Fetcher(config, (m) => console.log(`${new Date().toISOString()} ${m}`));
  console.log(`ttsu-cleanup-fetch ${VERSION} (${fetcher.id}) for ${config.serverUrl}`);
  const stop = () => {
    fetcher.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await fetcher.run();
}

void main();
