// The gateway's table: the models with their prices, the fallback between
// them, and the two cities' teams with their budgets. Both LiteLLM configs
// (gateway/config.yaml and config.local.yaml) must agree with it; a test reads
// them and checks. Spec: docs/superpowers/specs/2026-11-13-ai-platform-llm-gateway.md
// in the Latitude 10 repo.

// Read 2026-11-13: Claude Haiku 5.5 at $0.10 / M input and $0.50 / M output
// for prompts up to 100,000 tokens (platform.claude.com/docs/en/about-claude/pricing);
// gpt-oss-120b on Workers AI at $0.35 / M and $0.75 / M.
export const MODELS = {
  'claude-haiku-5-5': { input: 0.1 / 1e6, output: 0.5 / 1e6 },
  'gpt-oss-120b': { input: 0.35 / 1e6, output: 0.75 / 1e6 },
} as const;

export type ModelName = keyof typeof MODELS;

export const PRIMARY: ModelName = 'claude-haiku-5-5';
export const FALLBACKS: Record<string, ModelName[]> = { 'claude-haiku-5-5': ['gpt-oss-120b'] };

// One team per city; together they are this lab's $5 a month inside the
// `labs` workspace's $10 (the other $5 is the LangGraph lab's).
export const TEAMS = {
  'port-alder': { alias: 'Port Alder permit office', maxBudget: 2.5, budgetDuration: '30d' },
  'kestrel-bay': { alias: 'Kestrel Bay permit office', maxBudget: 2.5, budgetDuration: '30d' },
} as const;

export type Tenant = keyof typeof TEAMS;

// Each run gets its own key: a looping agent stops at its run's budget.
export const RUN_KEY = { maxBudget: 0.01, duration: '1h' } as const;

// The routes the Container's Worker forwards; everything else is a 404.
export const FORWARDED = [
  /^\/(v1\/)?chat\/completions$/,
  /^\/health\/(liveliness|readiness)$/,
  /^\/team\/(new|update|info)$/,
  /^\/key\/(generate|delete|info)$/,
];

export const isForwarded = (path: string) => FORWARDED.some((route) => route.test(path));

export const costOf = (model: ModelName, inTokens: number, outTokens: number) => inTokens * MODELS[model].input + outTokens * MODELS[model].output;
