import { z } from 'zod';

// Everything that can happen in a run of the permit desk: the engine writes
// these events, a replay file stores them, the live route relays them, and
// the diagram and console draw from them. Spec
// docs/superpowers/specs/2026-11-12-ai-platform-run-events.md.
//
// Shared with the engine repo (public-sector-ai-platform) as a copy, kept
// equal by SCHEMA_HASH. Every object is strict: a field the schema doesn't
// name is refused, so a prompt or a retrieved passage can't ride along. Free
// text exists in four places only, each capped.

export const SCHEMA_VERSION = 1;

// SHA-256 of the three shared files (this one without this line, topology.ts
// and scrub.ts). tests/ai-platform-events.test.ts checks it against the
// files here, and the engine repo checks its copies against the same value:
// when a shared file changes, update it here and copy all three.
export const SCHEMA_HASH = '6b9aab1eb86db4d3de3ede7fc42ea048ab1eda29644a5fd7734a502f3b2818b6';

export const SCENARIOS = ['happy', 'crash', 'flaky-registry', 'duplicate', 'approval', 'burst', 'poisoned-doc', 'budget', 'provider-down'] as const;
// The seven steps. The approval is the waitpoint between `recommend` and
// `report`, not a step.
export const STEPS = ['intake', 'extract', 'retrieve', 'eligibility', 'registry', 'recommend', 'report'] as const;
// Two fictional cities' permit offices.
export const TENANTS = ['port-alder', 'kestrel-bay'] as const;
// The LiteLLM model names: Claude first, Workers AI as its fallback.
export const MODELS = ['claude-haiku-5-5', 'gpt-oss-120b'] as const;
export const RUN_STATES = ['queued', 'running', 'waiting', 'completed', 'failed', 'budget_exceeded', 'rejected', 'expired'] as const;
export const ERROR_CODES = ['timeout', 'http_429', 'http_500', 'http_503', 'worker_lost', 'provider_down', 'validation', 'budget'] as const;
export const AUDIT_ACTIONS = [
  'run.accepted',
  'run.state_changed',
  'step.completed',
  'step.retried',
  'step.skipped',
  'duplicate.ignored',
  'worker.crashed',
  'worker.resumed',
  'dlq.sent',
  'llm.called',
  'llm.refused',
  'chunk.quarantined',
  'approval.requested',
  'approval.decided',
  'budget.exceeded',
  'report.written',
] as const;

export type ScenarioId = (typeof SCENARIOS)[number];
export type StepId = (typeof STEPS)[number];
export type Tenant = (typeof TENANTS)[number];
export type ModelId = (typeof MODELS)[number];
export type RunState = (typeof RUN_STATES)[number];

const count = z.number().int().nonnegative();
const ms = z.number().nonnegative().finite();
const usd = z.number().nonnegative().finite();
const worker = z.string().regex(/^w([1-9]|1[0-9]|20)$/);
// Municipal code sections and chunk ids, such as `pac-5.12.040`.
const sectionId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/);
const step = z.enum(STEPS);

const envelope = z.object({
  v: z.literal(SCHEMA_VERSION),
  seq: count,
  at: ms,
  run: z.string().regex(/^run_[a-z0-9]{8,24}$/),
  tenant: z.enum(TENANTS),
});

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  envelope.extend({ type: z.literal(type), ...shape }).strict();

const chunk = z
  .object({
    id: sectionId,
    title: z.string().min(1).max(80),
    score: z.number().nonnegative().finite(),
    quarantined: z.boolean(),
  })
  .strict();

export const RunEventSchema = z.discriminatedUnion('type', [
  // Run
  ev('run.accepted', { scenario: z.enum(SCENARIOS), application: z.string().regex(/^[a-z0-9-]{3,40}$/) }),
  ev('run.state', { to: z.enum(RUN_STATES) }),
  // Queue
  ev('queue.enqueued', { position: count, depth: count }),
  ev('queue.dequeued', { worker }),
  // Steps
  ev('step.started', { step, attempt: count.min(1) }),
  ev('step.completed', { step, ms, summary: z.string().max(200) }),
  ev('step.failed', { step, attempt: count.min(1), retryable: z.boolean(), code: z.enum(ERROR_CODES), retryInMs: ms.optional() }),
  ev('step.skipped', { step, why: z.enum(['checkpoint', 'idempotent']) }),
  ev('step.checkpointed', { step }),
  // Failures
  ev('worker.crashed', { worker }),
  ev('worker.resumed', { worker, fromStep: step }),
  ev('dlq.sent', { step, code: z.enum(ERROR_CODES) }),
  // Gateway
  ev('gateway.waking', { ms }),
  ev('llm.request', { step, model: z.enum(MODELS), key: z.string().regex(/^[A-Za-z0-9]{4}$/) }),
  ev('llm.response', { step, model: z.enum(MODELS), inTokens: count, outTokens: count, costUsd: usd, ms, fallbackFrom: z.enum(MODELS).optional() }),
  ev('llm.refused', { step, why: z.enum(['budget', 'rate_limit', 'provider_down']) }),
  // RAG
  ev('rag.results', { step, chunks: z.array(chunk).max(8) }),
  // Outside
  ev('http.call', { target: z.literal('registry'), status: z.number().int().min(100).max(599), ms }),
  // People
  ev('approval.requested', { expiresInMs: ms }),
  ev('approval.decided', { decision: z.enum(['approve', 'reject']), by: z.enum(['visitor', 'timeout']) }),
  // Money
  ev('budget.update', { spentUsd: usd, limitUsd: usd, steps: count, stepLimit: count }),
  // Record
  ev('audit.entry', {
    actor: z.union([z.enum(['system', 'gateway', 'visitor']), z.string().regex(/^worker:w([1-9]|1[0-9]|20)$/)]),
    action: z.enum(AUDIT_ACTIONS),
    object: z.string().max(80),
  }),
  ev('log', { level: z.enum(['debug', 'info', 'warn', 'error']), msg: z.string().max(200) }),
  // Output
  ev('report.written', { decision: z.enum(['approve', 'deny', 'refer']), citations: z.array(sectionId).max(6), text: z.string().max(1200) }),
]);

// The site's tsconfig isn't `strict`, and without `strictNullChecks` zod's
// z.infer makes every field optional. Exact puts back which fields are
// required, so a RunEvent narrows on `type` and its fields can be read
// without guards.
type OptionalKey = 'retryInMs' | 'fallbackFrom' | 'recordedAt' | 'engineCommit';
type Flat<T> = { [K in keyof T]: T[K] };
type Exact<T> = T extends readonly (infer U)[]
  ? Exact<U>[]
  : T extends object
    ? Flat<{ [K in Exclude<keyof T, OptionalKey>]-?: Exact<T[K]> } & { [K in Extract<keyof T, OptionalKey>]?: Exact<T[K]> }>
    : T;

export type RunEvent = Exact<z.infer<typeof RunEventSchema>>;
export type EventType = RunEvent['type'];

// Parses one event, throwing a ZodError when it isn't valid.
export const parseEvent = (input: unknown): RunEvent => RunEventSchema.parse(input) as RunEvent;
export type EventOf<T extends EventType> = Extract<RunEvent, { type: T }>;

export const EVENT_TYPES = RunEventSchema.options.map((option) => option.shape.type.value) as EventType[];

// Notes fill the console and the meter, and are drawn with the beat before
// them: they take no screen time of their own (pace.ts).
export const NOTE_TYPES = ['audit.entry', 'log', 'budget.update'] as const satisfies readonly EventType[];

export const isNote = (event: RunEvent): boolean => (NOTE_TYPES as readonly string[]).includes(event.type);

export const ReplayFileSchema = z
  .object({
    v: z.literal(SCHEMA_VERSION),
    scenario: z.enum(SCENARIOS),
    // A fixture is hand-written (by the builder in tests/helpers); the page
    // labels it "sample data" and the lab can't be published with one.
    source: z.enum(['recorded', 'fixture']),
    recordedAt: z.string().datetime({ offset: true }).optional(),
    engineCommit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
    events: z.array(RunEventSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (file.source === 'recorded') {
      if (!file.recordedAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recordedAt'], message: 'recordedAt is required on a recorded file' });
      if (!file.engineCommit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['engineCommit'], message: 'engineCommit is required on a recorded file' });
    }
    // seq strictly rises (with gaps where the scrubber dropped an event);
    // at never falls.
    // Written to pass strict index checks too: the engine repo copies this file.
    file.events.forEach((event, i) => {
      const before = i === 0 ? undefined : file.events[i - 1];
      if (!before) return;
      if (event.seq <= before.seq) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', i, 'seq'], message: `seq must rise: ${event.seq} after ${before.seq}` });
      if (event.at < before.at) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', i, 'at'], message: `at must not fall: ${event.at} after ${before.at}` });
    });
  });

export type ReplayFile = Exact<z.infer<typeof ReplayFileSchema>>;

// Throws a ZodError naming the path of every problem.
export const parseReplay = (input: unknown): ReplayFile => ReplayFileSchema.parse(input) as ReplayFile;
