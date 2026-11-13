// Runs the golden set through the real workflow (evals spec V2): the
// production gateway with a run key per attempt, search over the committed
// bge-m3 index with Workers AI query vectors, and the Python field check.
//
//   npm run evals
//   npm run evals -- --cases pa-bakery-0141,kb-cafe-0077 --repeat 1
//   npm run evals -- --compare evals/results/<earlier>.json
//   npm run evals -- --show evals/results/<file>.json     (no calls)
//
// Needs GATEWAY_URL, LITELLM_MASTER_KEY, WORKERS_AI_BASE_URL and
// CLOUDFLARE_AI_TOKEN in .env. With the Langfuse keys too, every attempt is
// traced in the environment `evals` with its four scores on its trace.
// A full run is about 60 attempts and $0.15 of the cities' gateway budgets.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LangfuseClient } from '@langfuse/client';
import { createTraceId } from '@langfuse/tracing';
import { GOLDEN, goldenCase } from '../src/evals/golden.ts';
import { compare, format, runEvals, summarize, type Attempt, type EvalServices } from '../src/evals/run.ts';
import { METRICS } from '../src/evals/score.ts';
import { chat, createRunKey, deleteKey, keyTail } from '../src/gateway/client.ts';
import { RUN_KEY } from '../src/gateway/config.ts';
import { validateFields } from '../src/permit/validate.ts';
import savedIndex from '../src/rag/index.json';
import { loadIndex, search, type SavedIndex } from '../src/rag/search.ts';
import { startLangfuse } from '../src/tracing/langfuse.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const read = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { attempts: Attempt[] }).attempts;

const shown = flag('show');
if (shown) {
  const attempts = read(shown);
  console.log(format(summarize(attempts), attempts));
  process.exit(0);
}

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env.`);
  return value;
};

const cases = flag('cases')?.split(',').map(goldenCase) ?? GOLDEN;
const repeat = Number(flag('repeat') ?? 3);
const commit = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim();
const dirty = execSync('git status --porcelain -- src data python', { encoding: 'utf8' }).trim() ? '-dirty' : '';

const saved = savedIndex as SavedIndex;
if (saved.embedder === 'hash-256') throw new Error('The evals need the bge-m3 index: run npm run index -- --embedder workers-ai.');
const index = loadIndex(saved);
const gateway = { baseUrl: env('GATEWAY_URL') };
const masterKey = env('LITELLM_MASTER_KEY');

// The query's bge-m3 vector, as src/trigger/permit.ts gets it.
async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(`${env('WORKERS_AI_BASE_URL')}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('CLOUDFLARE_AI_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: '@cf/baai/bge-m3', input: [text] }),
  });
  if (!response.ok) throw new Error(`Workers AI embeddings answered ${response.status}.`);
  return ((await response.json()) as { data: { embedding: number[] }[] }).data[0]!.embedding;
}

const services: EvalServices = {
  model: async (c, run) => {
    const key = await createRunKey(gateway, masterKey, { tenant: c.application.tenant, run, maxBudget: RUN_KEY.maxBudget });
    return { keyTail: keyTail(key), limitUsd: RUN_KEY.maxBudget, chat: (call) => chat(gateway, key, call), close: () => deleteKey(gateway, masterKey, key) };
  },
  search: async (tenant, query, k) => {
    const started = Date.now();
    const hits = search(index, query, { tenant, queryVector: await embedQuery(query), k });
    return { hits, ms: Date.now() - started };
  },
  validate: async (fields) => validateFields(fields),
};

// Wake the gateway first: a cold container takes about a minute, and the
// first attempts would otherwise time out waiting.
process.stdout.write('Waking the gateway… ');
for (let tries = 0; ; tries++) {
  const response = await fetch(`${gateway.baseUrl}/health/readiness`).catch(() => undefined);
  if (response?.ok) break;
  if (tries >= 60) throw new Error('The gateway did not get ready in 3 minutes.');
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
console.log('ready.');

const tracing = startLangfuse({ environment: 'evals', release: `${commit}${dirty}` });
const scores = tracing ? new LangfuseClient() : undefined;
const startedAt = new Date();
const sessionId = tracing ? `evals-${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}` : undefined;

console.log(`${cases.length} cases × ${repeat} on engine ${commit}${dirty}${sessionId ? `, traced as session ${sessionId}` : ''}`);
const attempts = await runEvals(cases, services, {
  repeat,
  concurrency: 3,
  ...(sessionId && { sessionId }),
  onAttempt: async (a) => {
    const marks = METRICS.map((m) => (a.scores[m] === null ? '·' : a.scores[m] ? '✓' : '✗')).join('');
    console.log(`  ${marks} ${a.case} #${a.attempt}: ${a.decision ?? 'no decision'} (expected ${a.expected.decision}) $${a.costUsd.toFixed(4)} ${(a.ms / 1000).toFixed(1)} s${a.guarded ? ' · guarded: the model approved over an unmet rule' : ''}${a.notes.length ? ` · ${a.notes.join('; ')}` : ''}`);
    if (scores && a.traceSeed) {
      const traceId = await createTraceId(a.traceSeed);
      for (const m of METRICS) {
        if (a.scores[m] === null) continue;
        scores.score.create({ id: `${traceId}-${m}`, traceId, name: `eval-${m}`, value: a.scores[m] ? 1 : 0, dataType: 'BOOLEAN', ...(a.notes.length && { comment: a.notes.join('; ').slice(0, 500) }) });
      }
    }
  },
});
await tracing?.shutdown();
await scores?.flush();

const summary = summarize(attempts);
mkdirSync('evals/results', { recursive: true });
const out = `evals/results/${startedAt.toISOString().slice(0, 10)}-${commit}${dirty}.json`;
const file = {
  engineCommit: `${commit}${dirty}`,
  ranAt: startedAt.toISOString(),
  repeat,
  cases: cases.map((c) => c.application.id),
  ...(sessionId && { langfuseSession: sessionId }),
  summary,
  attempts,
};
writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
console.log(`\n${format(summary, attempts)}\n\nWrote ${out}.`);

const before = flag('compare');
if (before) console.log(`\nAgainst ${before}:\n${compare(read(before), attempts)}`);
