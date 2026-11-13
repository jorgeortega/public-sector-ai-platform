// Records a scenario on trigger.dev and writes it into the site as a replay
// (engine spec E9). Runs from a clean checkout, so the replay names the
// engine commit it came from.
//
//   node --env-file=.env --import ./scripts/register.mjs scripts/record.ts <scenario> --site <latitude10 checkout>
//
// `--out <file>` writes the replay there instead, to check a run before it
// goes into the site.
//
// Needs TRIGGER_SECRET_KEY in .env (the environment the tasks run in), the
// bge-m3 index, and the gateway deployed with the project's environment set.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runs, tasks, wait } from '@trigger.dev/sdk';
import { SCENARIOS, type ScenarioId } from '../src/events/events';
import savedIndex from '../src/rag/index.json';
import { recordScenario, serialize, type TriggerClient } from '../src/recorder.ts';
import type { permitRun } from '../src/trigger/permit.ts';

const scenario = process.argv[2] as ScenarioId;
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const site = flag('--site');
const outFile = flag('--out');
if (!SCENARIOS.includes(scenario)) throw new Error(`Name a scenario: ${SCENARIOS.join(', ')}.`);
if (!site && !outFile) throw new Error('Pass --site <path to the latitude10 checkout>, or --out <file>.');
if (!process.env.TRIGGER_SECRET_KEY) throw new Error('Set TRIGGER_SECRET_KEY in .env.');
if ((savedIndex as { embedder: string }).embedder !== '@cf/baai/bge-m3') throw new Error('A replay needs the bge-m3 index: npm run index -- --embedder workers-ai.');
if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) throw new Error('Commit first: a replay names the engine commit it came from.');
const engineCommit = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim();

const FINAL = new Set(['COMPLETED', 'CANCELED', 'FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT']);

const client: TriggerClient = {
  trigger: (payload, options) => tasks.trigger<typeof permitRun>('permit-run', payload, options),
  retrieve: async (id) => {
    const run = await runs.retrieve(id);
    return { finished: FINAL.has(run.status), status: run.status, metadata: (run.metadata ?? {}) as { events?: unknown[]; approvalToken?: string } };
  },
  completeToken: async (token, output) => {
    await wait.completeToken(token, output);
  },
};

console.log(`Recording ${scenario} from engine ${engineCommit}…`);
const triggered: string[] = [];
const traced: TriggerClient = {
  ...client,
  trigger: async (payload, options) => {
    const handle = await client.trigger(payload, options);
    triggered.push(`${payload.input.run} ${handle.id}`);
    return handle;
  },
};
const file = await recordScenario(scenario, { client: traced, engineCommit });
console.log(`trigger.dev runs:\n  ${[...new Set(triggered)].slice(0, 5).join('\n  ')}${triggered.length > 5 ? `\n  … ${triggered.length} in all` : ''}`);
const out = outFile ?? `${site!.replace(/\/$/, '')}/app/ai-platform/_lib/replays/${scenario}.json`;
writeFileSync(out, serialize(file));
console.log(`${out}: ${file.events.length} events, recorded ${file.recordedAt}.`);
