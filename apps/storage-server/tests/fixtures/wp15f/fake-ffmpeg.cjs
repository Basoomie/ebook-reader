/**
 * WP15f tests: stands in for ffmpeg (run as `node fake-ffmpeg.cjs <ffmpeg args>`).
 * FAKE_FFMPEG_MODE: 'hang' (no output at all, for the stall check), 'slow' (progress
 * forever, for cancelling a running merge), 'fail' (exits with an error). Each mode first
 * writes a partial output file, like a real ffmpeg stopped midway.
 */
const fs = require('fs');

const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('fake ffmpeg');
  process.exit(0);
}
const mode = process.env.FAKE_FFMPEG_MODE || 'hang';
fs.writeFileSync(args[args.length - 1], 'partial output');
if (mode === 'fail') {
  process.stderr.write('Invalid data found when processing input\n');
  process.exit(1);
} else if (mode === 'slow') {
  let us = 0;
  setInterval(() => {
    us += 100000;
    process.stdout.write(`out_time_us=${us}\nprogress=continue\n`);
  }, 100);
} else {
  setInterval(() => undefined, 1e6);
}
