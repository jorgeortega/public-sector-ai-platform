import type { z } from 'zod';
import type { StepId } from '../events/events';
import { GatewayError, type Message } from '../gateway/client.ts';
import type { ModelName } from '../gateway/config.ts';
import { toEventChunks, type Hit } from '../rag/search.ts';
import { BudgetStop, FatalError, RetryableError, StepFailed, WorkerCrash, type ErrorCode } from './errors.ts';
import type { Actor, Emitter } from './emitter.ts';
import { NO_RETRY, STEP_LIMIT, type Clock, type Faults, type RetryPolicy, type RunInput, type RunModel, type Services } from './types.ts';

// What a workflow is given. Every method emits its own events (spec E1), so a
// workflow is just its logic: steps, model calls, searches, outside calls and
// an approval.

// A run's durable state: step results by `${run}:${step}` and the side effects
// it has claimed. In memory these are maps; on trigger.dev, child-task
// idempotency keys.
export type Store = { checkpoints: Map<string, unknown>; claims: Set<string>; attempts: Map<string, number> };

export const newStore = (): Store => ({ checkpoints: new Map(), claims: new Set(), attempts: new Map() });

type StepOptions = { retry?: RetryPolicy; outside?: boolean };

export class Context {
  readonly input: RunInput;
  readonly emit: Emitter;
  readonly clock: Clock;
  readonly worker: string;
  private readonly services: Services;
  private readonly store: Store;
  private readonly faults: Faults;
  private readonly firstWorker: boolean;
  private readonly model: RunModel;
  private current: StepId | undefined;
  private spent = 0;
  private calls = 0;

  constructor(options: { input: RunInput; emit: Emitter; clock: Clock; services: Services; store: Store; faults: Faults; worker: string; firstWorker: boolean; model: RunModel; spent?: number; calls?: number }) {
    this.input = options.input;
    this.emit = options.emit;
    this.clock = options.clock;
    this.services = options.services;
    this.store = options.store;
    this.faults = options.faults;
    this.worker = options.worker;
    this.firstWorker = options.firstWorker;
    this.model = options.model;
    this.spent = options.spent ?? 0;
    this.calls = options.calls ?? 0;
  }

  get workerActor(): Actor {
    return `worker:${this.worker}` as Actor;
  }

  get usage() {
    return { spent: this.spent, calls: this.calls };
  }

  // A durable step: skipped if its checkpoint exists, retried by its policy,
  // checkpointed when done.
  async step<T>(id: StepId, run: (attempt: number) => Promise<{ value: T; summary: string }>, options: StepOptions = {}): Promise<T> {
    const key = `${this.input.run}:${id}`;
    if (this.store.checkpoints.has(key)) {
      this.emit.emit('step.skipped', { step: id, why: 'checkpoint' });
      this.emit.audit('step.skipped', `${id} (checkpoint)`, this.workerActor);
      return this.store.checkpoints.get(key) as T;
    }
    const retry = options.retry ?? NO_RETRY;
    // Attempts count across workers: a step a crash cut short starts again as
    // attempt 2.
    const first = (this.store.attempts.get(key) ?? 0) + 1;
    for (let attempt = first; ; attempt++) {
      this.store.attempts.set(key, attempt);
      this.emit.emit('step.started', { step: id, attempt });
      this.current = id;
      const started = this.clock.now();
      try {
        const { value, summary } = await run(attempt);
        this.emit.emit('step.completed', { step: id, ms: Math.round(this.clock.now() - started), summary: summary.slice(0, 200) });
        this.emit.audit('step.completed', id, this.workerActor);
        this.clock.pass(5);
        this.emit.emit('step.checkpointed', { step: id });
        this.store.checkpoints.set(key, value);
        return value;
      } catch (error) {
        if (error instanceof WorkerCrash) throw error;
        if (error instanceof BudgetStop) {
          this.emit.emit('step.failed', { step: id, attempt, retryable: false, code: 'budget' });
          throw error;
        }
        const code: ErrorCode = error instanceof RetryableError || error instanceof FatalError ? error.code : 'validation';
        const retryable = error instanceof RetryableError && attempt - first + 1 < retry.maxAttempts;
        if (retryable) {
          const wait = retry.backoffMs[attempt - first] ?? retry.backoffMs.at(-1) ?? 1000;
          this.emit.emit('step.failed', { step: id, attempt, retryable: true, code, retryInMs: wait });
          this.emit.audit('step.retried', `${id}, attempt ${attempt + 1} in ${wait / 1000} s`, this.workerActor);
          this.emit.log('warn', `${id} failed (${code}); retrying in ${wait / 1000} s.`);
          await this.clock.sleep(wait);
          continue;
        }
        this.emit.emit('step.failed', { step: id, attempt, retryable: false, code });
        this.emit.log('error', `${id} failed (${code}) after ${attempt} attempt${attempt === 1 ? '' : 's'}; giving up.`);
        throw new StepFailed(id, code, options.outside ?? false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // A model call through the gateway with the run's key (spec E4), its answer
  // parsed by a schema with one retry (spec E5).
  async llm<S extends z.ZodTypeAny>(messages: Message[], schema: S, options: { maxTokens?: number } = {}): Promise<z.output<S>> {
    for (let tries = 1; ; tries++) {
      const content = await this.chat(messages, options.maxTokens);
      const parsed = parseJson(content, schema);
      if (parsed.ok) return parsed.value;
      this.emit.log('warn', `The model's answer didn't match the expected shape (${parsed.problem.slice(0, 120)}).`);
      if (tries >= 2) throw new FatalError('validation', `The model's answer didn't match the expected shape twice.`);
    }
  }

  private async chat(messages: Message[], maxTokens?: number): Promise<string> {
    const step = this.current!;
    if (this.calls >= STEP_LIMIT) {
      this.emit.log('error', `This run reached its limit of ${STEP_LIMIT} model calls.`);
      this.emit.audit('budget.exceeded', `${STEP_LIMIT} model calls`, 'system');
      throw new BudgetStop('step_limit', `The run reached ${STEP_LIMIT} model calls.`);
    }
    const model: ModelName = 'claude-haiku-5-5';
    this.emit.emit('llm.request', { step, model, key: this.model.keyTail });
    if (this.faults.crashIn === step && this.firstWorker) {
      this.clock.pass(620);
      throw new WorkerCrash(step);
    }
    try {
      const result = await this.model.chat({ model: this.faults.primaryDown ? ('claude-haiku-5-5-down' as ModelName) : model, messages, maxTokens });
      this.clock.pass(result.ms);
      this.calls += 1;
      this.spent = Math.round((this.spent + result.costUsd) * 1e7) / 1e7;
      if (result.fallbackFrom) this.emit.log('warn', `${result.fallbackFrom} failed; the gateway fell back to ${result.model}.`);
      this.emit.emit('llm.response', {
        step,
        model: result.model,
        inTokens: result.inTokens,
        outTokens: result.outTokens,
        costUsd: result.costUsd,
        ms: Math.round(result.ms),
        ...(result.fallbackFrom && { fallbackFrom: 'claude-haiku-5-5' as const }),
      });
      this.emit.audit('llm.called', `${step} · ${result.model}`, 'gateway');
      this.emit.emit('budget.update', { spentUsd: this.spent, limitUsd: this.model.limitUsd, steps: this.calls, stepLimit: STEP_LIMIT });
      return result.content;
    } catch (error) {
      if (error instanceof GatewayError && error.type === 'budget_exceeded') {
        this.clock.pass(30);
        this.emit.emit('llm.refused', { step, why: 'budget' });
        this.emit.audit('llm.refused', `${step} · budget`, 'gateway');
        this.emit.log('error', `The gateway refused the call: this run has spent $${this.spent.toFixed(4)} of $${this.model.limitUsd.toFixed(2)}.`);
        this.emit.audit('budget.exceeded', `$${this.spent.toFixed(4)} of $${this.model.limitUsd.toFixed(2)}`, 'system');
        throw new BudgetStop('budget', error.message);
      }
      if (error instanceof GatewayError) throw new RetryableError(error.status === 429 ? 'http_429' : error.status >= 500 ? 'http_500' : 'provider_down', error.message);
      throw error;
    }
  }

  // Search the run's own city's code (rag spec R3).
  async search(query: string, k = 5): Promise<Hit[]> {
    const step = this.current!;
    const { hits, ms } = await this.services.search(this.input.tenant, query, k);
    this.clock.pass(ms);
    this.emit.emit('rag.results', { step, chunks: toEventChunks(hits) });
    for (const hit of hits.filter((each) => each.quarantined)) {
      this.emit.audit('chunk.quarantined', hit.id, this.workerActor);
      this.emit.log('warn', `Chunk ${hit.id} gives instructions; it was quarantined and kept out of the prompt.`);
    }
    return hits;
  }

  // An outside API call; a 5xx or 429 is retryable.
  async registry(attempt: number): Promise<void> {
    const { status, ms } = await this.services.registry(this.input, attempt);
    this.clock.pass(ms);
    this.emit.emit('http.call', { target: 'registry', status, ms: Math.round(ms) });
    if (status === 429) throw new RetryableError('http_429', 'The registry is rate limiting.');
    if (status >= 500) throw new RetryableError(status === 503 ? 'http_503' : 'http_500', `The registry answered ${status}.`);
  }

  // The Python check of the extracted fields (spec E6).
  async validate(fields: Record<string, unknown>): Promise<string[]> {
    const { problems, via } = await this.services.validate(fields);
    if (via === 'typescript') this.emit.log('info', 'python3 is not available here; the fields were checked by the TypeScript copy of the rules.');
    for (const problem of problems) this.emit.log('warn', `Field check: ${problem}`);
    return problems;
  }

  // Runs a side effect once per run, under an idempotency key (spec E2).
  claim(key: string): boolean {
    const full = `${this.input.run}:${key}`;
    if (this.store.claims.has(full)) return false;
    this.store.claims.add(full);
    return true;
  }

  // The human approval: the run parks, a person decides.
  async approval(): Promise<'approve' | 'reject'> {
    this.emit.emit('approval.requested', { expiresInMs: 300_000 });
    this.emit.audit('approval.requested', 'recommendation', this.workerActor);
    this.emit.emit('run.state', { to: 'waiting' });
    this.emit.audit('run.state_changed', 'waiting', 'system');
    const { decision, by, waitMs } = await this.services.approval(this.input);
    await this.clock.sleep(waitMs);
    this.emit.emit('approval.decided', { decision, by });
    this.emit.audit('approval.decided', decision, by === 'visitor' ? 'visitor' : 'system');
    const to = decision === 'approve' ? 'running' : by === 'timeout' ? 'expired' : 'rejected';
    this.emit.emit('run.state', { to });
    this.emit.audit('run.state_changed', to, decision === 'approve' ? this.workerActor : 'system');
    return decision;
  }
}

// The model's answer as JSON: the first {...} block, parsed and checked.
export function parseJson<S extends z.ZodTypeAny>(content: string, schema: S): { ok: true; value: z.output<S> } | { ok: false; problem: string } {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, problem: 'no JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : 'invalid JSON' };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data as z.output<S> } : { ok: false, problem: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
}
