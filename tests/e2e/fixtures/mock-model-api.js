// Stand-in for a model API, for the opt-in real-CLI probe: it keeps every
// request body and answers each turn with one short streamed text. It speaks
// just enough of the Anthropic Messages API (Claude Code) and the OpenAI
// Responses API (Codex) for the CLI to finish a turn. Nothing leaves the machine.
const http = require('http');

function start() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
      requests.push({ url: req.url, body });
      const stream = (events) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.end();
      };
      if (req.method === 'POST' && /\/v1\/messages(\?|$)/.test(req.url)) {
        const message = { id: 'msg_probe', type: 'message', role: 'assistant', model: body.model || 'probe', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
        }
        return stream([
          ['message_start', { message: { ...message, content: [], stop_reason: null } }],
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'probe reply' } }],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
          ['message_stop', {}],
        ]);
      }
      if (req.method === 'POST' && /\/responses(\?|$)/.test(req.url)) {
        return stream([
          ['response.created', { response: { id: 'resp_probe' } }],
          ['response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'msg_probe', content: [{ type: 'output_text', text: 'probe reply' }] } }],
          ['response.completed', { response: { id: 'resp_probe', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }],
        ]);
      }
      if (req.method === 'POST' && /count_tokens/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"input_tokens":1}');
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"probe"}}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, requests,
    // Every text the user side of a request carries, in either API's shape.
    userTexts: () => requests.flatMap(({ body }) => [...(body.messages || []), ...(Array.isArray(body.input) ? body.input : [])]
      .filter((m) => m && m.role === 'user')
      .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => c && c.text).filter((t) => typeof t === 'string')))),
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
  })));
}

module.exports = { start };
