import type { ScenarioId, StepId, Tenant } from '../events/events';
import type { ChatResult, Message } from '../gateway/client.ts';
import type { ModelName } from '../gateway/config.ts';
import type { Hit } from '../rag/search.ts';

// The workflow SDK's contract (spec docs/superpowers/specs/2026-11-13-ai-platform-engine.md
// in the Latitude 10 repo). A workflow sees only a Context; a runtime (in
// memory or on trigger.dev) provides the Clock and the Services.

export type RunInput = { run: string; tenant: Tenant; scenario: ScenarioId; application: string };

// The faults a scenario may inject (spec E7): from a fixed list, never from
// visitor input.
export type Faults = {
  crashIn?: StepId;
  registryFailures?: number | 'always';
  loopEligibility?: boolean;
  primaryDown?: boolean;
  duplicate?: boolean;
  approval?: { decision: 'approve' | 'reject'; waitMs: number };
  // The `budget` scenario gives its run a small key budget, so the gateway is
  // the one that refuses (spec E7).
  runBudgetUsd?: number;
};

export interface Clock {
  now(): number;
  // Waits: real time on trigger.dev, virtual time in memory.
  sleep(ms: number): Promise<void>;
  // Moves a virtual clock on by work that took `ms`; a real clock ignores it.
  pass(ms: number): void;
}

export type ModelCall = { model: ModelName; messages: Message[]; maxTokens?: number };

// One run's model access: a key of its own, made at the start and deleted at
// the end (spec E4).
export interface RunModel {
  keyTail: string;
  limitUsd: number;
  chat(call: ModelCall): Promise<ChatResult>;
  close(): Promise<void>;
}

export interface Services {
  model(input: RunInput, maxBudgetUsd: number): Promise<RunModel>;
  search(tenant: Tenant, query: string, k: number): Promise<{ hits: Hit[]; ms: number }>;
  registry(input: RunInput, attempt: number): Promise<{ status: number; ms: number }>;
  validate(fields: Record<string, unknown>): Promise<{ problems: string[]; via: 'python' | 'typescript' }>;
  approval(input: RunInput): Promise<{ decision: 'approve' | 'reject'; by: 'visitor' | 'timeout'; waitMs: number }>;
}

export type RetryPolicy = { maxAttempts: number; backoffMs: number[] };

export const NO_RETRY: RetryPolicy = { maxAttempts: 1, backoffMs: [] };
// Spec E3: 1 s, 2 s, 4 s, then give up.
export const OUTSIDE_RETRY: RetryPolicy = { maxAttempts: 4, backoffMs: [1000, 2000, 4000] };

// The engine's own limit on model calls in one run, before the gateway's
// budget has to step in (spec E4).
export const STEP_LIMIT = 12;
