// A fake OpenAI-compatible upstream for the local gateway (docker compose).
// It answers chat completions with token counts the request can choose, and
// fails on purpose, so budgets and fallbacks can be proved without a real
// provider:
//   - "fail-primary" in the last message: claude-haiku-5-5 answers 500;
//   - "tokens:<in>/<out>" in the last message: reports those token counts.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const read = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return send(res, 404, { error: 'not found' });
  const body = JSON.parse((await read(req)) || '{}');
  const last = String(body.messages?.at(-1)?.content ?? '');
  const model = String(body.model ?? '');
  if (last.includes('fail-primary') && model.includes('claude-haiku-5-5')) {
    return send(res, 500, { error: { message: 'The primary model is down (fake).', type: 'server_error' } });
  }
  const [, inTokens = '1000', outTokens = '100'] = /tokens:(\d+)\/(\d+)/.exec(last) ?? [];
  send(res, 200, {
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `Answered by ${model} (fake).` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: Number(inTokens), completion_tokens: Number(outTokens), total_tokens: Number(inTokens) + Number(outTokens) },
  });
}).listen(PORT, () => console.log(`fake upstream on :${PORT}`));
