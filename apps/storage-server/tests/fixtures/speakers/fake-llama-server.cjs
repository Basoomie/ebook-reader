/**
 * Season 2 Phase 12 session 5 tests: stands in for llama.cpp's server on 127.0.0.1:<port>.
 *   GET  /health          503 for the first "load-ms" ms (file in FAKE_DOCKER_STATE, default 200)
 *   POST /apply-template  { prompt }: the messages' text, one per line
 *   POST /completion      the stand-in model's answer (fake-model.cjs); "request-ms" (file)
 *                         is waited first; each request is kept in requests.jsonl
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const fake = require('./fake-model.cjs');

const port = Number(process.argv[2]);
const state = process.env.FAKE_DOCKER_STATE;
const num = (file, d) => {
  const f = state && path.join(state, file);
  return f && fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : d;
};
const started = Date.now();
const loadMs = num('load-ms', 200);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health') {
      return Date.now() - started < loadMs
        ? send(503, { error: { message: 'Loading model' } })
        : send(200, { status: 'ok' });
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/apply-template') {
      return send(200, { prompt: body.messages.map((m) => m.content).join('\n') });
    }
    if (req.url === '/completion') {
      await new Promise((r) => setTimeout(r, num('request-ms', 0)));
      if (state) {
        fs.appendFileSync(
          path.join(state, 'requests.jsonl'),
          JSON.stringify({
            n_probs: body.n_probs,
            temperature: body.temperature,
            grammar: !!body.grammar,
            schema: !!body.json_schema,
          }) + '\n',
        );
      }
      const a = fake.answer({
        prompt: body.prompt,
        grammar: body.grammar,
        json_schema: body.json_schema,
      });
      return send(200, {
        ...a,
        tokens_predicted: a.content.length,
        tokens_evaluated: body.prompt.length,
      });
    }
    send(404, { error: { message: 'not found' } });
  });
});
server.listen(port, '127.0.0.1');
