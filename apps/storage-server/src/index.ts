import { createApp } from './app';
import { FatalConfigError, loadConfig, LoadedConfig } from './config';

let loaded: LoadedConfig;
try {
  loaded = loadConfig(process.env);
} catch (err) {
  if (err instanceof FatalConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { config, warnings } = loaded;
for (const warning of warnings) console.warn(`Warning: ${warning}`);

const app = createApp(config);

app.listen(config.port, () => {
  console.log(`ttsu storage server running on port ${config.port}`);
  console.log(`Data root: ${config.dataRoot}`);
  console.log(
    `CORS origin: ${config.corsOrigins === '*' ? '*' : config.corsOrigins.join(', ') || '(none)'}`,
  );
});
