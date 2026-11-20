// A stand-in for the Anthropic and OpenAI APIs (WP21d tests and e2e): model lists, direct
// calls, and both Batch APIs, enough for the official SDKs. Answers come from `answer()`:
//   answer({ provider, model, system, user }) -> { kind: 'json', json } | { kind: 'text', text }
//     | { kind: 'refusal' } | { kind: 'content_filter' } | { kind: 'error', status, code? }
// Every request is logged in `calls` (path, provider, model, user text) for assertions.
import http from 'node:http';

const USAGE = { input: 4000, output: 500 };

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'application/x-jsonlines' : 'application/json',
    ...headers,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** The file part of a multipart/form-data body (OpenAI's file upload). */
function multipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) return null;
  const boundary = '--' + (m[1] ?? m[2]);
  const text = buf.toString('utf8');
  for (const part of text.split(boundary)) {
    if (!/name="file"/.test(part)) continue;
    const at = part.indexOf('\r\n\r\n');
    if (at < 0) continue;
    return part.slice(at + 4).replace(/\r\n$/, '');
  }
  return null;
}

export async function startAiStandin(opts: any = {}): Promise<any> {
  const models = opts.models ?? {
    anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    openai: ['gpt-6-luna', 'gpt-6.1-sol'],
  };
  const answer = opts.answer ?? (() => ({ kind: 'json', json: {} }));
  const usage = opts.usage ?? USAGE;
  /** Batch polls answered "in progress" before a batch ends (read at each poll: adjustable). */
  const pollsBeforeEnd = () => opts.batchPolls ?? 0;
  /** Models whose batches never run (as OpenAI did with gpt-6-luna on 2026-11-19). */
  const stalls = (bt) => {
    const r = bt.requests[0];
    const model = r?.params?.model ?? r?.body?.model;
    return (opts.stallModels ?? []).includes(model);
  };
  const calls = [];
  const batches = new Map();
  const files = new Map();
  let seq = 0;
  let base = '';

  const anthropicMessage = (model, user, system) => {
    const a = answer({ provider: 'anthropic', model, system, user });
    if (a.kind === 'error') return { error: a };
    const text = a.kind === 'json' ? JSON.stringify(a.json) : a.kind === 'text' ? a.text : '';
    return {
      message: {
        id: `msg_${++seq}`,
        type: 'message',
        role: 'assistant',
        model,
        content: text ? [{ type: 'text', text }] : [],
        stop_reason:
          a.kind === 'refusal' ? 'refusal' : a.kind === 'max_tokens' ? 'max_tokens' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  };

  const openaiCompletion = (model, messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const a = answer({ provider: 'openai', model, system, user });
    if (a.kind === 'error') return { error: a };
    const content =
      a.kind === 'json'
        ? JSON.stringify(a.json)
        : a.kind === 'text'
          ? a.text
          : a.kind === 'content_filter'
            ? ''
            : null;
    return {
      completion: {
        id: `chatcmpl-${++seq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              refusal: a.kind === 'refusal' ? 'I cannot help with that.' : null,
            },
            finish_reason: a.kind === 'content_filter' ? 'content_filter' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
        },
      },
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    const raw = await readBody(req);
    const json = () => (raw.length ? JSON.parse(raw.toString('utf8')) : {});
    try {
      // ---------------------------------------------------------------- Anthropic
      // The Anthropic SDK (1.x) sends the key as "authorization: Bearer", older ones as x-api-key.
      if (req.headers['anthropic-version'] !== undefined || p.startsWith('/anthropic')) {
        const ap = p.replace(/^\/anthropic/, '');
        const key =
          req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (opts.anthropicKey && key !== opts.anthropicKey)
          return send(res, 401, {
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          });
        if (req.method === 'GET' && ap === '/v1/models') {
          calls.push({ path: ap, provider: 'anthropic' });
          return send(res, 200, {
            data: models.anthropic.map((id) => ({
              id,
              type: 'model',
              display_name: id,
              created_at: '2026-10-01T00:00:00Z',
            })),
            has_more: false,
            first_id: models.anthropic[0] ?? null,
            last_id: models.anthropic[models.anthropic.length - 1] ?? null,
          });
        }
        if (req.method === 'POST' && ap === '/v1/messages') {
          const b = json();
          const user = b.messages?.[0]?.content ?? '';
          calls.push({ path: ap, provider: 'anthropic', model: b.model, user, body: b });
          const r = anthropicMessage(b.model, user, b.system);
          if (r.error)
            return send(res, r.error.status, {
              type: 'error',
              error: { type: r.error.code ?? 'api_error', message: 'stand-in error' },
            });
          return send(res, 200, r.message);
        }
        if (req.method === 'POST' && ap === '/v1/messages/batches') {
          const b = json();
          const id = `msgbatch_${++seq}`;
          calls.push({ path: ap, provider: 'anthropic', batch: id, n: b.requests.length, body: b });
          batches.set(id, {
            provider: 'anthropic',
            requests: b.requests,
            polls: 0,
            created: Date.now(),
          });
          return send(res, 200, {
            id,
            type: 'message_batch',
            processing_status: 'in_progress',
            request_counts: {
              processing: b.requests.length,
              succeeded: 0,
              errored: 0,
              canceled: 0,
              expired: 0,
            },
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            ended_at: null,
            archived_at: null,
            cancel_initiated_at: null,
            results_url: null,
          });
        }
        const bc = /^\/v1\/messages\/batches\/([^/]+)\/cancel$/.exec(ap);
        if (bc && req.method === 'POST') {
          const bt = batches.get(bc[1]);
          if (!bt)
            return send(res, 404, {
              type: 'error',
              error: { type: 'not_found_error', message: 'no batch' },
            });
          bt.cancelled = true;
          calls.push({ path: ap, provider: 'anthropic', batch: bc[1], cancel: true });
          return send(res, 200, {
            id: bc[1],
            type: 'message_batch',
            processing_status: 'canceling',
            request_counts: {
              processing: bt.requests.length,
              succeeded: 0,
              errored: 0,
              canceled: 0,
              expired: 0,
            },
            created_at: new Date(bt.created).toISOString(),
            expires_at: new Date(bt.created + 86400000).toISOString(),
            ended_at: null,
            archived_at: null,
            cancel_initiated_at: new Date().toISOString(),
            results_url: null,
          });
        }
        const bm = /^\/v1\/messages\/batches\/([^/]+)(\/results)?$/.exec(ap);
        if (bm && req.method === 'GET') {
          const bt = batches.get(bm[1]);
          if (!bt)
            return send(res, 404, {
              type: 'error',
              error: { type: 'not_found_error', message: 'no batch' },
            });
          if (bm[2]) {
            calls.push({ path: ap, provider: 'anthropic', batch: bm[1] });
            if (bt.cancelled)
              return send(
                res,
                200,
                bt.requests
                  .map((r) =>
                    JSON.stringify({ custom_id: r.custom_id, result: { type: 'canceled' } }),
                  )
                  .join('\n') + '\n',
              );
            const lines = bt.requests.map((r) => {
              const out = anthropicMessage(
                r.params.model,
                r.params.messages?.[0]?.content ?? '',
                r.params.system,
              );
              if (out.error)
                return JSON.stringify({
                  custom_id: r.custom_id,
                  result: {
                    type: 'errored',
                    error: {
                      type: 'error',
                      error: { type: out.error.code ?? 'api_error', message: 'stand-in' },
                    },
                  },
                });
              return JSON.stringify({
                custom_id: r.custom_id,
                result: { type: 'succeeded', message: out.message },
              });
            });
            return send(res, 200, lines.join('\n') + '\n');
          }
          calls.push({ path: ap, provider: 'anthropic', batch: bm[1], poll: true });
          bt.polls++;
          const ended = bt.cancelled || (!stalls(bt) && bt.polls > pollsBeforeEnd());
          const n = bt.requests.length;
          return send(res, 200, {
            id: bm[1],
            type: 'message_batch',
            processing_status: ended ? 'ended' : 'in_progress',
            request_counts: {
              processing: ended ? 0 : n,
              succeeded: ended && !bt.cancelled ? n : 0,
              errored: 0,
              canceled: bt.cancelled ? n : 0,
              expired: 0,
            },
            created_at: new Date(bt.created).toISOString(),
            expires_at: new Date(bt.created + 86400000).toISOString(),
            ended_at: ended ? new Date().toISOString() : null,
            archived_at: null,
            cancel_initiated_at: null,
            // The address the caller reached us at (in a container the listening one is 0.0.0.0).
            results_url: ended
              ? `http://${req.headers.host}/anthropic/v1/messages/batches/${bm[1]}/results`
              : null,
          });
        }
      }
      // ---------------------------------------------------------------- OpenAI
      const op = p.replace(/^\/openai/, '');
      if (opts.openaiKey && req.headers.authorization !== `Bearer ${opts.openaiKey}`)
        return send(res, 401, {
          error: {
            message: 'Incorrect API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
      if (req.method === 'GET' && op === '/v1/models') {
        calls.push({ path: op, provider: 'openai' });
        return send(res, 200, {
          object: 'list',
          data: models.openai.map((id) => ({
            id,
            object: 'model',
            created: 1,
            owned_by: 'openai',
          })),
        });
      }
      if (req.method === 'POST' && op === '/v1/chat/completions') {
        const b = json();
        const user = b.messages?.find((m) => m.role === 'user')?.content ?? '';
        calls.push({ path: op, provider: 'openai', model: b.model, user, body: b });
        const r = openaiCompletion(b.model, b.messages);
        if (r.error)
          return send(res, r.error.status, {
            error: {
              message: 'stand-in error',
              type: 'invalid_request_error',
              code: r.error.code ?? null,
            },
          });
        return send(res, 200, r.completion);
      }
      if (req.method === 'POST' && op === '/v1/files') {
        const text = multipartFile(raw, req.headers['content-type']);
        const id = `file-${++seq}`;
        files.set(id, text ?? '');
        calls.push({ path: op, provider: 'openai', file: id });
        return send(res, 200, {
          id,
          object: 'file',
          bytes: (text ?? '').length,
          created_at: 1,
          filename: 'batch.jsonl',
          purpose: 'batch',
          status: 'processed',
        });
      }
      if (req.method === 'POST' && op === '/v1/batches') {
        const b = json();
        const id = `batch_${++seq}`;
        const lines = (files.get(b.input_file_id) ?? '')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
        calls.push({ path: op, provider: 'openai', batch: id, n: lines.length });
        batches.set(id, { provider: 'openai', requests: lines, polls: 0, created: Date.now() });
        return send(res, 200, {
          id,
          object: 'batch',
          endpoint: b.endpoint,
          input_file_id: b.input_file_id,
          completion_window: '24h',
          status: 'validating',
          created_at: 1,
        });
      }
      const oc = /^\/v1\/batches\/([^/]+)\/cancel$/.exec(op);
      if (oc && req.method === 'POST') {
        const bt = batches.get(oc[1]);
        if (!bt) return send(res, 404, { error: { message: 'no batch' } });
        bt.cancelled = true;
        calls.push({ path: op, provider: 'openai', batch: oc[1], cancel: true });
        return send(res, 200, {
          id: oc[1],
          object: 'batch',
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          status: 'cancelling',
          created_at: 1,
        });
      }
      const ob = /^\/v1\/batches\/([^/]+)$/.exec(op);
      if (ob && req.method === 'GET') {
        const bt = batches.get(ob[1]);
        if (!bt) return send(res, 404, { error: { message: 'no batch' } });
        calls.push({ path: op, provider: 'openai', batch: ob[1], poll: true });
        bt.polls++;
        if (bt.cancelled)
          return send(res, 200, {
            id: ob[1],
            object: 'batch',
            endpoint: '/v1/chat/completions',
            completion_window: '24h',
            status: 'cancelled',
            output_file_id: null,
            error_file_id: null,
            request_counts: { total: bt.requests.length, completed: 0, failed: 0 },
            created_at: 1,
          });
        const ended = !stalls(bt) && bt.polls > pollsBeforeEnd();
        if (ended && !bt.output) {
          const out = bt.requests.map((r) => {
            const c = openaiCompletion(r.body.model, r.body.messages);
            if (c.error)
              return JSON.stringify({
                id: `r${++seq}`,
                custom_id: r.custom_id,
                response: {
                  status_code: c.error.status,
                  body: { error: { message: 'stand-in', code: c.error.code ?? null } },
                },
                error: null,
              });
            return JSON.stringify({
              id: `r${++seq}`,
              custom_id: r.custom_id,
              response: { status_code: 200, body: c.completion },
              error: null,
            });
          });
          bt.output = `file-${++seq}`;
          files.set(bt.output, out.join('\n') + '\n');
        }
        return send(res, 200, {
          id: ob[1],
          object: 'batch',
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          status: ended ? 'completed' : 'in_progress',
          output_file_id: ended ? bt.output : null,
          error_file_id: null,
          request_counts: {
            total: bt.requests.length,
            completed: ended ? bt.requests.length : 0,
            failed: 0,
          },
          created_at: 1,
        });
      }
      const fc = /^\/v1\/files\/([^/]+)\/content$/.exec(op);
      if (fc && req.method === 'GET') {
        calls.push({ path: op, provider: 'openai', file: fc[1] });
        return send(res, 200, files.get(fc[1]) ?? '');
      }
      send(res, 404, { error: { message: `stand-in: no route ${req.method} ${p}` } });
    } catch (err) {
      send(res, 500, { error: { message: String(err) } });
    }
  });
  await new Promise((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const port = server.address().port;
  base = `http://${opts.host ?? '127.0.0.1'}:${port}`;
  return {
    port,
    anthropicUrl: `${base}/anthropic`,
    openaiUrl: `${base}/openai/v1`,
    calls,
    batches,
    close: () => new Promise((r) => server.close(r)),
  };
}
