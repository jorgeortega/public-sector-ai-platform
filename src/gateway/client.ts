import { ALLOWED, FALLBACKS, MODELS, RUN_KEY, TEAMS, type ModelName, type Tenant } from './config.ts';

// The engine's side of the gateway: make sure the two cities' teams exist,
// make a key for each run, call a model, delete the key. Plain fetch; the
// master key stays with the engine. Errors keep LiteLLM's own type
// (`budget_exceeded` is the one the `budget` scenario shows).

// `fetch` is replaceable for tests; it only ever gets a URL string and an init.
export type Gateway = { baseUrl: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> };
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
  }
}

async function call(gateway: Gateway, path: string, key: string, body: unknown): Promise<Response> {
  const response = await (gateway.fetch ?? fetch)(`${gateway.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;
  const text = await response.text();
  let type = 'error';
  let message = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
    type = parsed.error?.type ?? type;
    message = parsed.error?.message ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  // LiteLLM reports a spent budget in the message as well as the type.
  if (/budget has been exceeded|exceeded budget/i.test(message)) type = 'budget_exceeded';
  throw new GatewayError(response.status, type, message);
}

// Creates the two teams, or updates them to the budgets in config.ts.
export async function ensureTeams(gateway: Gateway, masterKey: string): Promise<Tenant[]> {
  const models = ALLOWED;
  for (const [teamId, team] of Object.entries(TEAMS)) {
    const body = { team_id: teamId, team_alias: team.alias, max_budget: team.maxBudget, budget_duration: team.budgetDuration, models };
    try {
      await call(gateway, '/team/new', masterKey, body);
    } catch (error) {
      if (!(error instanceof GatewayError) || !/already exists/i.test(error.message)) throw error;
      await call(gateway, '/team/update', masterKey, body);
    }
  }
  return Object.keys(TEAMS) as Tenant[];
}

// A key for one run, in its city's team, with the run's own budget.
export async function createRunKey(gateway: Gateway, masterKey: string, { tenant, run, maxBudget = RUN_KEY.maxBudget }: { tenant: Tenant; run: string; maxBudget?: number }): Promise<string> {
  const response = await call(gateway, '/key/generate', masterKey, {
    team_id: tenant,
    key_alias: run,
    max_budget: maxBudget,
    duration: RUN_KEY.duration,
    models: ALLOWED,
    metadata: { run },
  });
  const { key } = (await response.json()) as { key: string };
  return key;
}

export async function deleteKey(gateway: Gateway, masterKey: string, key: string): Promise<void> {
  await call(gateway, '/key/delete', masterKey, { keys: [key] });
}

// What the `llm.request` event shows of a key: its last four letters or digits.
export const keyTail = (key: string) => key.replace(/[^A-Za-z0-9]/g, '').slice(-4);

export type ChatResult = {
  content: string;
  model: ModelName;
  fallbackFrom?: ModelName;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  ms: number;
};

const asModel = (name: string): ModelName => (Object.keys(MODELS).find((model) => name === model || name.endsWith(`/${model}`) || name.includes(model)) ?? name) as ModelName;

export async function chat(gateway: Gateway, key: string, { model, messages, maxTokens = 1500 }: { model: ModelName; messages: Message[]; maxTokens?: number }): Promise<ChatResult> {
  const started = Date.now();
  const response = await call(gateway, '/v1/chat/completions', key, { model, messages, max_tokens: maxTokens });
  const body = (await response.json()) as { model: string; choices: { message: { content: string | null } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
  const fallbacks = Number(response.headers.get('x-litellm-attempted-fallbacks') ?? 0);
  const served = fallbacks > 0 ? (FALLBACKS[model]?.[fallbacks - 1] ?? asModel(body.model)) : model;
  return {
    content: body.choices[0]?.message.content ?? '',
    model: served,
    ...(fallbacks > 0 && { fallbackFrom: asModel(model) }),
    inTokens: body.usage.prompt_tokens,
    outTokens: body.usage.completion_tokens,
    costUsd: Number(response.headers.get('x-litellm-response-cost') ?? 0),
    ms: Date.now() - started,
  };
}
