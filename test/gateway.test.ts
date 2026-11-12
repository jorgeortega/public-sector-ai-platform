import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import worker, { type Env } from '../gateway/worker.ts';
import { GatewayError, chat, createRunKey, deleteKey, ensureTeams, keyTail } from '../src/gateway/client.ts';
import { FALLBACKS, MODELS, RUN_KEY, TEAMS, costOf, isForwarded } from '../src/gateway/config.ts';

// The gateway's configs agree with src/gateway/config.ts, the Worker forwards
// only what it should, and the client reads LiteLLM's answers. The proof
// against a running LiteLLM is scripts/gateway-smoke.ts.

type ModelEntry = { model_name: string; litellm_params: Record<string, string | number> };
type Config = { model_list: ModelEntry[]; router_settings: { fallbacks: Record<string, string[]>[] }; litellm_settings: Record<string, unknown>; general_settings: Record<string, string> };

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prod = parse(read('gateway/config.yaml')) as Config;
const local = parse(read('gateway/config.local.yaml')) as Config;

describe.each([
  ['production', prod],
  ['local', local],
])('the %s config', (_, config) => {
  it('lists exactly the table’s models, at the table’s prices', () => {
    expect(config.model_list.map((entry) => entry.model_name).sort()).toEqual(Object.keys(MODELS).sort());
    for (const entry of config.model_list) {
      const price = MODELS[entry.model_name as keyof typeof MODELS];
      expect(entry.litellm_params.input_cost_per_token).toBeCloseTo(price.input, 12);
      expect(entry.litellm_params.output_cost_per_token).toBeCloseTo(price.output, 12);
    }
  });

  it('falls back as the table says, and keeps the master key and database in the environment', () => {
    expect(Object.assign({}, ...config.router_settings.fallbacks)).toEqual(FALLBACKS);
    expect(config.general_settings.master_key).toBe('os.environ/LITELLM_MASTER_KEY');
    expect(config.general_settings.database_url).toBe('os.environ/DATABASE_URL');
  });
});

describe('the production config', () => {
  it('reads every credential from the environment, and sends traces to Langfuse', () => {
    for (const entry of prod.model_list) {
      expect(String(entry.litellm_params.api_key)).toMatch(/^os\.environ\//);
      if ('api_base' in entry.litellm_params) expect(String(entry.litellm_params.api_base)).toMatch(/^os\.environ\//);
    }
    expect(prod.litellm_settings.success_callback).toEqual(['langfuse']);
  });

  it('runs the same pinned image locally as in the Container', () => {
    const image = /FROM (\S+)/.exec(read('gateway/Dockerfile'))?.[1];
    expect(image).toBe('ghcr.io/berriai/litellm-non_root:v1.106.6');
    expect(read('gateway/docker-compose.yml')).toContain(`image: ${image}`);
  });
});

describe('the budgets', () => {
  it('give the two cities this lab’s $5 a month, and each run $0.01', () => {
    expect(Object.values(TEAMS).reduce((sum, team) => sum + team.maxBudget, 0)).toBe(5);
    expect(RUN_KEY.maxBudget).toBe(0.01);
    // A typical run (three calls of about 2,500 tokens in and 250 out) is a
    // fraction of its budget.
    expect(3 * costOf('claude-haiku-5-5', 2500, 250)).toBeLessThan(RUN_KEY.maxBudget / 5);
  });
});

describe('the Worker', () => {
  it.each(['/v1/chat/completions', '/chat/completions', '/health/liveliness', '/team/new', '/key/generate', '/key/delete'])('forwards %s', (path) => {
    expect(isForwarded(path)).toBe(true);
  });

  it.each(['/ui/', '/key/list', '/spend/logs', '/model/new', '/user/new', '/v1/chat/completions/x'])('refuses %s', (path) => {
    expect(isForwarded(path)).toBe(false);
  });

  it('answers 404 itself for a route it refuses, and sends the rest to the one gateway', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const getByName = vi.fn(() => ({ fetch }));
    const env = { GATEWAY: { getByName } } as unknown as Env;
    const refused = await worker.fetch(new Request('https://gateway.example/ui/'), env);
    expect(refused.status).toBe(404);
    expect(getByName).not.toHaveBeenCalled();
    const forwarded = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', { method: 'POST' }), env);
    expect(await forwarded.text()).toBe('ok');
    expect(getByName).toHaveBeenCalledWith('gateway');
  });
});

describe('the client', () => {
  const answer = (headers: Record<string, string>, model = 'claude-haiku-5-5') =>
    new Response(JSON.stringify({ model, choices: [{ message: { content: 'Done.' } }], usage: { prompt_tokens: 2000, completion_tokens: 200 } }), { headers });

  it('reads the cost and the fallback from LiteLLM’s headers', async () => {
    const fetch = vi.fn(async () => answer({ 'x-litellm-response-cost': '0.00085', 'x-litellm-attempted-fallbacks': '1' }, 'gpt-oss-120b'));
    const result = await chat({ baseUrl: 'http://gw/', fetch }, 'sk-run', { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ content: 'Done.', model: 'gpt-oss-120b', fallbackFrom: 'claude-haiku-5-5', inTokens: 2000, outTokens: 200, costUsd: 0.00085 });
    expect(fetch).toHaveBeenCalledWith('http://gw/v1/chat/completions', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer sk-run' }) }));
  });

  it('turns a spent budget into a GatewayError of type budget_exceeded', async () => {
    const body = JSON.stringify({ error: { message: 'Budget has been exceeded! Current cost: 0.0101, Max budget: 0.01', type: 'auth_error' } });
    const fetch = vi.fn(async () => new Response(body, { status: 400 }));
    const error = await chat({ baseUrl: 'http://gw', fetch }, 'sk-run', { model: 'claude-haiku-5-5', messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status: 400, type: 'budget_exceeded' });
    const plain = vi.fn(async () => new Response('upstream down', { status: 502 }));
    await expect(chat({ baseUrl: 'http://gw', fetch: plain }, 'k', { model: 'gpt-oss-120b', messages: [] })).rejects.toMatchObject({ status: 502, type: 'error', message: 'upstream down' });
  });

  it('creates a team, or updates it when it already exists', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(new URL(url).pathname);
      return url.endsWith('/team/new') && calls.length === 1 ? new Response(JSON.stringify({ error: { message: 'Team id = port-alder already exists. Please use a different team id.' } }), { status: 400 }) : new Response('{}');
    });
    expect(await ensureTeams({ baseUrl: 'http://gw', fetch }, 'sk-master')).toEqual(['port-alder', 'kestrel-bay']);
    expect(calls).toEqual(['/team/new', '/team/update', '/team/new']);
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Database down' } }), { status: 500 }));
    await expect(ensureTeams({ baseUrl: 'http://gw', fetch: failing }, 'sk-master')).rejects.toThrow('Database down');
  });

  it('makes a run’s key in its city’s team with the run’s budget, and deletes it', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ key: 'sk-abcd-WXYZ' }));
    });
    const key = await createRunKey({ baseUrl: 'http://gw', fetch }, 'sk-master', { tenant: 'kestrel-bay', run: 'run_kb0077poison' });
    await deleteKey({ baseUrl: 'http://gw', fetch }, 'sk-master', key);
    expect(bodies[0]).toMatchObject({ team_id: 'kestrel-bay', key_alias: 'run_kb0077poison', max_budget: 0.01, duration: '1h' });
    expect(bodies[1]).toEqual({ keys: ['sk-abcd-WXYZ'] });
    expect(keyTail(key)).toBe('WXYZ');
  });
});
