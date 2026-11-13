// Runs scenarios on the in-memory runtime (fake model, hash-256 index, no
// spend) and sends their traces to Langfuse, in the `local` environment, so
// they never mix with trigger.dev's `development` or `production` runs.
//
//   node --env-file=.env --import ./scripts/register.mjs scripts/trace.ts <scenario>… | all
//
// Needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL in
// .env. Prints each run's trace id.
import { execSync } from 'node:child_process';
import { createTraceId } from '@langfuse/tracing';
import { SCENARIOS, type ScenarioId } from '../src/events/events';
import { SCENARIO_RUNS } from '../src/permit/scenarios.ts';
import { runScenario } from '../src/runtime/memory.ts';
import { startLangfuse } from '../src/tracing/langfuse.ts';

const asked = process.argv.slice(2);
const scenarios = (asked.includes('all') ? [...SCENARIOS] : asked) as ScenarioId[];
if (!scenarios.length || scenarios.some((scenario) => !SCENARIOS.includes(scenario))) throw new Error(`Name scenarios (${SCENARIOS.join(', ')}) or all.`);
// The engine commit as the release, so traces can be compared across changes.
const commit = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim();
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? '-dirty' : '';
const tracing = startLangfuse({ environment: 'local', release: `${commit}${dirty}` });
if (!tracing) throw new Error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env.');

for (const scenario of scenarios) {
  // Virtual 0 a few minutes back, so every observation is in the past.
  const epoch = Date.now() - 5 * 60_000;
  await runScenario(scenario, { epoch });
  const runs = SCENARIO_RUNS[scenario]();
  const ids = await Promise.all(runs.slice(0, 3).map(async (run) => `${run.input.run} ${await createTraceId(`${scenario}-${epoch}:${run.input.run}`)}`));
  console.log(`${scenario} (session ${scenario}-${epoch}): ${runs.length} run${runs.length === 1 ? '' : 's'}\n  ${ids.join('\n  ')}${runs.length > 3 ? '\n  …' : ''}`);
}
await tracing.shutdown();
