// Creates the two cities' teams on a gateway, or updates them to the
// budgets in src/gateway/config.ts. Safe to run again.
//
//   GATEWAY_URL=… LITELLM_MASTER_KEY=… node scripts/gateway-setup.ts
import { ensureTeams } from '../src/gateway/client.ts';
import { TEAMS } from '../src/gateway/config.ts';

const baseUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000';
const masterKey = process.env.LITELLM_MASTER_KEY;
if (!masterKey) throw new Error('Set LITELLM_MASTER_KEY.');

const teams = await ensureTeams({ baseUrl }, masterKey);
for (const team of teams) console.log(`${team}: $${TEAMS[team].maxBudget} every ${TEAMS[team].budgetDuration}`);
