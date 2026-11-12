// Proves the gateway locally, against `docker compose -f gateway/docker-compose.yml up`
// (LiteLLM, Postgres and the fake upstream; no provider and no money):
//   1. the two cities' teams exist with their budgets;
//   2. a run's key works and each call reports its cost;
//   3. when the primary model fails, the call falls back and says so;
//   4. once the run's $0.01 is spent, the gateway refuses the next call.
//
//   node scripts/gateway-smoke.ts
import { strict as assert } from 'node:assert';
import { GatewayError, chat, createRunKey, deleteKey, ensureTeams, keyTail } from '../src/gateway/client.ts';
import { RUN_KEY, costOf } from '../src/gateway/config.ts';

const gateway = { baseUrl: process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000' };
const masterKey = process.env.LITELLM_MASTER_KEY ?? 'sk-local-master-key';

async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${gateway.baseUrl}/health/liveliness`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('The local gateway did not come up.');
}

const ask = (text: string) => [{ role: 'user' as const, content: text }];
const usd = (n: number) => `$${n.toFixed(6)}`;

await ready();
console.log('gateway up');

const teams = await ensureTeams(gateway, masterKey);
assert.deepEqual(teams, ['port-alder', 'kestrel-bay']);
console.log('1. teams:', teams.join(', '));

const key = await createRunKey(gateway, masterKey, { tenant: 'port-alder', run: `run_smoke${Date.now()}` });
const first = await chat(gateway, key, { model: 'claude-haiku-5-5', messages: ask('tokens:2000/200 Extract the fields.') });
assert.equal(first.model, 'claude-haiku-5-5');
assert.equal(first.fallbackFrom, undefined);
assert.ok(Math.abs(first.costUsd - costOf('claude-haiku-5-5', 2000, 200)) < 1e-9, `cost ${first.costUsd}`);
console.log(`2. key …${keyTail(key)}: claude-haiku-5-5, ${first.inTokens}/${first.outTokens} tokens, ${usd(first.costUsd)}`);

const fell = await chat(gateway, key, { model: 'claude-haiku-5-5', messages: ask('tokens:2000/200 fail-primary') });
assert.equal(fell.model, 'gpt-oss-120b');
assert.equal(fell.fallbackFrom, 'claude-haiku-5-5');
assert.ok(Math.abs(fell.costUsd - costOf('gpt-oss-120b', 2000, 200)) < 1e-9, `fallback cost ${fell.costUsd}`);
console.log(`3. fallback: claude-haiku-5-5 → ${fell.model}, ${usd(fell.costUsd)}`);

// Spend the rest of the run's budget, then expect a refusal.
let spent = first.costUsd + fell.costUsd;
let refused: GatewayError | undefined;
for (let i = 0; i < 20 && !refused; i++) {
  try {
    const result = await chat(gateway, key, { model: 'claude-haiku-5-5', messages: ask('tokens:30000/3000 Read the whole code again.') });
    spent += result.costUsd;
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    refused = error;
  }
}
assert.ok(refused, 'the gateway never refused');
assert.equal(refused.type, 'budget_exceeded');
assert.ok(spent >= RUN_KEY.maxBudget, `refused at ${spent}, before the budget`);
console.log(`4. refused at ${usd(spent)} of $${RUN_KEY.maxBudget}: ${refused.status} ${refused.type}`);

await deleteKey(gateway, masterKey, key);
console.log('key deleted; all four checks passed');
