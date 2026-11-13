/**
 * Copies the built worker to C:\ttsu-worker (or the folder given as the first argument):
 *   app\*.js              the worker (replaced on every install)
 *   config.example.json   the settings with their defaults (replaced)
 *   start-hidden.vbs      starts the worker without a window (for the sign-in task)
 *   app\tts\              the TTS program's build folder (WP17; `main.js build-tts`), replaced
 *   config.json           only created when missing (from the example); never overwritten
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(process.argv[2] || 'C:\\ttsu-worker');
const here = path.join(__dirname, '..');
const dist = path.join(here, 'dist');
if (!fs.existsSync(path.join(dist, 'main.js'))) {
  console.error('Build first: pnpm --filter ttsu-gpu-worker build');
  process.exit(1);
}
const app = path.join(target, 'app');
fs.mkdirSync(app, { recursive: true });
for (const name of fs.readdirSync(app)) {
  if (name.endsWith('.js')) fs.rmSync(path.join(app, name));
}
for (const name of fs.readdirSync(dist)) {
  if (name.endsWith('.js')) fs.copyFileSync(path.join(dist, name), path.join(app, name));
}
fs.writeFileSync(path.join(app, 'package.json'), '{ "type": "commonjs" }\n');
// WP17: the TTS program's build folder (Dockerfile, runner, kana conversion), for build-tts.
const ttsTarget = path.join(app, 'tts');
fs.rmSync(ttsTarget, { recursive: true, force: true });
fs.mkdirSync(ttsTarget);
for (const name of ['Dockerfile', 'ttsu_tts.py', 'kana.py']) {
  fs.copyFileSync(path.join(here, 'tts', name), path.join(ttsTarget, name));
}
fs.copyFileSync(path.join(here, 'config.example.json'), path.join(target, 'config.example.json'));
fs.copyFileSync(path.join(here, 'start-hidden.vbs'), path.join(target, 'start-hidden.vbs'));
const config = path.join(target, 'config.json');
if (!fs.existsSync(config)) {
  fs.copyFileSync(path.join(here, 'config.example.json'), config);
  console.log(`Created ${config}: put the server address and the worker token in it.`);
} else {
  console.log(`Kept your ${config}.`);
}
console.log(`Installed the GPU worker in ${target}.`);
console.log(`Test it with: node "${path.join(app, 'main.js')}" check`);
