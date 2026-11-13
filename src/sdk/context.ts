import type { z } from 'zod';
import type { StepId } from '../events/events';
import { GatewayError, type ChatResult, type Message } from '../gateway/client.ts';
import { MODELS, type ModelName } from '../gateway/config.ts';
import { toEventChunks, type Hit } from '../rag/search.ts';
import { BudgetStop, FatalError, RetryableError, StepFailed, WorkerCrash, type ErrorCode } from './errors.ts';
import type { Actor, Emitter } from './emitter.ts';
import { NO_TRACE, STEP_NAMES, type Trace, type TraceAttributes } from './trace.ts';
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
  // The run's root observation, and the step running now (Langfuse).
  private readonly trace: Trace;
  private stepTrace: Trace = NO_TRACE;
  private written: { decision: string; citations: string[]; text: string } | undefined;
  private shown: unknown;
  private decided: { decision: 'approve' | 'reject'; by: 'visitor' | 'timeout' } | undefined;

  constructor(options: { input: RunInput; emit: Emitter; clock: Clock; services: Services; store: Store; faults: Faults; worker: string; firstWorker: boolean; model: RunModel; spent?: number; calls?: number; trace?: Trace }) {
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
    this.trace = options.trace ?? NO_TRACE;
  }

  get workerActor(): Actor {
    return `worker:${this.worker}` as Actor;
  }

  get usage() {
    return { spent: this.spent, calls: this.calls };
  }

  // How the run ended, for the trace's output: the report once written;
  // before that, what the person was shown and what they decided.
  get result() {
    if (this.written) return { ...this.written, ...(this.decided && { approval: this.decided }) };
    return { ...(this.shown !== undefined && { recommendation: this.shown }), ...(this.decided && { approval: this.decided }) };
  }

  // A durable step: skipped if its checkpoint exists, retried by its policy,
  // checkpointed when done.
  async step<T>(id: StepId, run: (attempt: number) => Promise<{ value: T; summary: string }>, options: StepOptions = {}): Promise<T> {
    const key = `${this.input.run}:${id}`;
    if (this.store.checkpoints.has(key)) {
      this.emit.emit('step.skipped', { step: id, why: 'checkpoint' });
      this.emit.audit('step.skipped', `${id} (checkpoint)`, this.workerActor);
      this.trace.event('skip-checkpointed-step', { metadata: { step: id } });
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
      const trace = (this.stepTrace = this.trace.child(STEP_NAMES[id], 'span', { metadata: { step: id, attempt, worker: this.worker } }));
      try {
        const { value, summary } = await run(attempt);
        trace.end({ output: summary });
        this.emit.emit('step.completed', { step: id, ms: Math.round(this.clock.now() - started), summary: summary.slice(0, 200) });
        this.emit.audit('step.completed', id, this.workerActor);
        this.clock.pass(5);
        this.emit.emit('step.checkpointed', { step: id });
        this.store.checkpoints.set(key, value);
        return value;
      } catch (error) {
        if (error instanceof WorkerCrash || error instanceof BudgetStop) trace.fail(error);
        if (error instanceof WorkerCrash) throw error;
        if (error instanceof BudgetStop) {
          this.emit.emit('step.failed', { step: id, attempt, retryable: false, code: 'budget' });
          throw error;
        }
        const code: ErrorCode = error instanceof RetryableError || error instanceof FatalError ? error.code : 'validation';
        const retryable = error instanceof RetryableError && attempt - first + 1 < retry.maxAttempts;
        if (retryable) {
          const wait = retry.backoffMs[attempt - first] ?? retry.backoffMs.at(-1) ?? 1000;
          trace.end({ level: 'WARNING', statusMessage: `${code}; attempt ${attempt + 1} in ${wait / 1000} s`, metadata: { step: id, attempt, worker: this.worker, retryInMs: wait } });
          this.emit.emit('step.failed', { step: id, attempt, retryable: true, code, retryInMs: wait });
          this.emit.audit('step.retried', `${id}, attempt ${attempt + 1} in ${wait / 1000} s`, this.workerActor);
          this.emit.log('warn', `${id} failed (${code}); retrying in ${wait / 1000} s.`);
          await this.clock.sleep(wait);
          continue;
        }
        this.emit.emit('step.failed', { step: id, attempt, retryable: false, code });
        trace.fail(error, { statusMessage: `${code} after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${error instanceof Error ? error.message : String(error)}` });
        this.emit.log('error', `${id} failed (${code}) after ${attempt} attempt${attempt === 1 ? '' : 's'}; giving up.`);
        throw new StepFailed(id, code, options.outside ?? false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // A model call through the gateway with the run's key (spec E4), its answer
  // parsed by a schema with one retry (spec E5). `name` says what the call
  // is for: it names the call's generation in Langfuse.
  async llm<S extends z.ZodTypeAny>(messages: Message[], schema: S, options: { name?: string; maxTokens?: number } = {}): Promise<z.output<S>> {
    for (let tries = 1; ; tries++) {
      const { content, generation } = await this.chat(options.name ?? 'generate-answer', messages, tries, options.maxTokens);
      const parsed = parseJson(content, schema);
      if (parsed.ok) {
        generation.end();
        return parsed.value;
      }
      generation.end({ level: 'WARNING', statusMessage: `The answer didn't match the expected shape: ${parsed.problem.slice(0, 200)}` });
      this.emit.log('warn', `The model's answer didn't match the expected shape (${parsed.problem.slice(0, 120)}).`);
      if (tries >= 2) throw new FatalError('validation', `The model's answer didn't match the expected shape twice.`);
    }
  }

  private async chat(name: string, messages: Message[], tries: number, maxTokens?: number): Promise<{ content: string; generation: Trace }> {
    const step = this.current!;
    if (this.calls >= STEP_LIMIT) {
      this.emit.log('error', `This run reached its limit of ${STEP_LIMIT} model calls.`);
      this.emit.audit('budget.exceeded', `${STEP_LIMIT} model calls`, 'system');
      throw new BudgetStop('step_limit', `The run reached ${STEP_LIMIT} model calls.`);
    }
    const model: ModelName = 'claude-haiku-5-5';
    // One generation per model call, with what the model was shown (Langfuse
    // best practice: never one generation for a loop).
    const generation = this.stepTrace.child(name, 'generation', {
      input: messages,
      model,
      modelParameters: { max_tokens: maxTokens ?? 1500 },
      metadata: { step, call: this.calls + 1, try: tries, key: this.model.keyTail },
    });
    this.emit.emit('llm.request', { step, model, key: this.model.keyTail });
    if (this.faults.crashIn === step && this.firstWorker) {
      this.clock.pass(620);
      const crash = new WorkerCrash(step);
      generation.fail(crash);
      throw crash;
    }
    try {
      const result = await this.model.chat({ model: this.faults.primaryDown ? ('claude-haiku-5-5-down' as ModelName) : model, messages, maxTokens });
      this.clock.pass(result.ms);
      this.calls += 1;
      this.spent = Math.round((this.spent + result.costUsd) * 1e7) / 1e7;
      generation.update(generationResult(result, { spentUsd: this.spent, limitUsd: this.model.limitUsd, calls: this.calls }));
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
      return { content: result.content, generation };
    } catch (error) {
      if (error instanceof GatewayError && error.type === 'budget_exceeded') {
        this.clock.pass(30);
        generation.fail(error, { statusMessage: `The gateway refused the call: $${this.spent.toFixed(4)} of $${this.model.limitUsd.toFixed(4)} spent`, metadata: { step, spentUsd: this.spent, limitUsd: this.model.limitUsd, refusedBy: 'gateway' } });
        this.emit.emit('llm.refused', { step, why: 'budget' });
        this.emit.audit('llm.refused', `${step} · budget`, 'gateway');
        this.emit.log('error', `The gateway refused the call: this run has spent $${this.spent.toFixed(4)} of $${this.model.limitUsd.toFixed(2)}.`);
        this.emit.audit('budget.exceeded', `$${this.spent.toFixed(4)} of $${this.model.limitUsd.toFixed(2)}`, 'system');
        throw new BudgetStop('budget', error.message);
      }
      generation.fail(error);
      if (error instanceof GatewayError) throw new RetryableError(error.status === 429 ? 'http_429' : error.status >= 500 ? 'http_500' : 'provider_down', error.message);
      throw error;
    }
  }

  // Search the run's own city's code (rag spec R3).
  async search(query: string, k = 5): Promise<Hit[]> {
    const step = this.current!;
    const retriever = this.stepTrace.child('search-city-code', 'retriever', { input: { query, k }, metadata: { tenant: this.input.tenant, method: 'bm25 + vectors, fused by RRF' } });
    const { hits, ms } = await this.services.search(this.input.tenant, query, k).catch((error: unknown) => {
      retriever.fail(error);
      throw error;
    });
    this.clock.pass(ms);
    retriever.end({ output: hits.map(({ id, section, title, score, quarantined, text }) => ({ id, section, title, score: Math.round(score * 1e4) / 1e4, quarantined, text })), metadata: { tenant: this.input.tenant, ms: Math.round(ms), returned: hits.length } });
    // The screen that keeps instructions in the code out of the prompt (rag
    // spec R5), as the guardrail it is.
    const flagged = hits.filter((hit) => hit.quarantined);
    this.stepTrace
      .child('quarantine-instructions', 'guardrail', { input: hits.map((hit) => hit.id) })
      .end({
        output: { quarantined: flagged.map(({ id, reasons }) => ({ id, reasons })), passed: hits.length - flagged.length },
        ...(flagged.length && { level: 'WARNING' as const, statusMessage: `${flagged.length} section${flagged.length === 1 ? '' : 's'} kept out of the prompt` }),
      });
    this.emit.emit('rag.results', { step, chunks: toEventChunks(hits) });
    for (const hit of hits.filter((each) => each.quarantined)) {
      this.emit.audit('chunk.quarantined', hit.id, this.workerActor);
      this.emit.log('warn', `Chunk ${hit.id} gives instructions; it was quarantined and kept out of the prompt.`);
    }
    return hits;
  }

  // An outside API call; a 5xx or 429 is retryable.
  async registry(attempt: number): Promise<void> {
    const tool = this.stepTrace.child('check-business-registry', 'tool', { input: { application: this.input.application }, metadata: { attempt } });
    const { status, ms } = await this.services.registry(this.input, attempt);
    this.clock.pass(ms);
    tool.end({ output: { status }, metadata: { attempt, ms: Math.round(ms) }, ...(status >= 400 && { level: 'ERROR' as const, statusMessage: `The registry answered ${status}` }) });
    this.emit.emit('http.call', { target: 'registry', status, ms: Math.round(ms) });
    if (status === 429) throw new RetryableError('http_429', 'The registry is rate limiting.');
    if (status >= 500) throw new RetryableError(status === 503 ? 'http_503' : 'http_500', `The registry answered ${status}.`);
  }

  // The Python check of the extracted fields (spec E6).
  async validate(fields: Record<string, unknown>): Promise<string[]> {
    const { problems, via } = await this.stepTrace.within(
      'validate-fields',
      'tool',
      { input: fields },
      () => this.services.validate(fields),
      (result) => ({ output: { problems: result.problems }, metadata: { via: result.via }, ...(result.problems.length && { level: 'WARNING' as const, statusMessage: `${result.problems.length} field${result.problems.length === 1 ? '' : 's'} need a person` }) }),
    );
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

  // The decision report (claim it first: it is written once per run).
  writeReport(report: { decision: 'approve' | 'deny' | 'refer'; citations: string[]; text: string }): void {
    this.written = report;
    this.emit.emit('report.written', { decision: report.decision, citations: report.citations.slice(0, 6), text: report.text.slice(0, 1200) });
  }

  // The human approval: the run parks, a person decides on `shown` (what
  // the person sees: the recommendation).
  async approval(shown?: unknown): Promise<'approve' | 'reject'> {
    this.emit.emit('approval.requested', { expiresInMs: 300_000 });
    this.emit.audit('approval.requested', 'recommendation', this.workerActor);
    this.emit.emit('run.state', { to: 'waiting' });
    this.emit.audit('run.state_changed', 'waiting', 'system');
    this.shown = shown;
    const wait = this.trace.child('await-human-approval', 'span', { input: shown, metadata: { expiresInMs: 300_000 } });
    const { decision, by, waitMs } = await this.services.approval(this.input);
    await this.clock.sleep(waitMs);
    this.decided = { decision, by };
    wait.end({ output: { decision, by }, ...(by === 'timeout' && { level: 'WARNING' as const, statusMessage: 'Nobody decided within five minutes' }) });
    this.emit.emit('approval.decided', { decision, by });
    this.emit.audit('approval.decided', decision, by === 'visitor' ? 'visitor' : 'system');
    const to = decision === 'approve' ? 'running' : by === 'timeout' ? 'expired' : 'rejected';
    this.emit.emit('run.state', { to });
    this.emit.audit('run.state_changed', to, decision === 'approve' ? this.workerActor : 'system');
    return decision;
  }
}

// A gateway answer as a generation's attributes: the model that answered,
// tokens, and the cost the gateway charged the run's key.
function generationResult(result: ChatResult, budget: { spentUsd: number; limitUsd: number; calls: number }): TraceAttributes {
  const price = MODELS[result.model] as { input: number; output: number } | undefined;
  return {
    model: result.model,
    output: { role: 'assistant', content: result.content },
    usageDetails: { input: result.inTokens, output: result.outTokens },
    costDetails: price ? { input: result.inTokens * price.input, output: result.outTokens * price.output, total: result.costUsd } : ({ total: result.costUsd } as Record<string, number>),
    metadata: { ms: Math.round(result.ms), ...budget, ...(result.fallbackFrom && { fallbackFrom: result.fallbackFrom }) },
    ...(result.fallbackFrom && { level: 'WARNING' as const, statusMessage: `${result.fallbackFrom} failed; the gateway fell back to ${result.model}` }),
  };
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
