/**
 * WP14 tests: stands in for ffmpeg when cutting a clip (run as `node fake-ffmpeg-clip.cjs <args>`).
 * It never writes a file (the real cut writes only to stdout). FAKE_CLIP_MODE: 'hang' (no
 * output, for the timeout and busy checks), 'fail' (exits with an error naming the input
 * path, to check that server folders are hidden), 'big' (endless output, for the size cap).
 */
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLIP_MODE || 'hang';
const input = args[args.indexOf('-i') + 1] || '';
if (mode === 'fail') {
  process.stderr.write(`${input}: Invalid data found when processing input\n`);
  process.exit(1);
} else if (mode === 'big') {
  const chunk = Buffer.alloc(64 * 1024, 1);
  const pump = () => {
    while (process.stdout.write(chunk)) {
      /* keep writing */
    }
    process.stdout.once('drain', pump);
  };
  process.stdout.on('error', () => process.exit(0));
  pump();
} else {
  setInterval(() => undefined, 1e6);
}
