import { createTraceId, propagateAttributes, startObservation, type LangfuseGenerationAttributes, type LangfuseObservation, type LangfuseObservationType } from '@langfuse/tracing';
import type { ScenarioId, StepId, Tenant } from '../events/events';
import { BudgetStop, FatalError, RetryableError, StepFailed, WorkerCrash } from './errors.ts';

// The engine's Langfuse tracing (spec docs/superpowers/specs/
// 2026-11-13-ai-platform-tracing.md in the Latitude 10 repo): one trace per
// run, an observation per step, model call, search, check and tool call,
// each of its most specific type, nested where it happened. The workflow
// never sees this; the SDK's methods trace themselves, as they emit their
// own events.
//
// Times come from the run's clock, so a run on the in-memory runtime's
// virtual clock shows the durations its replay shows.
//
// Without a configured provider (src/tracing/langfuse.ts) every call is a
// no-op: the tests and the site's fixtures run untraced.

export type TraceAttributes = LangfuseGenerationAttributes;

// Observation names are an API (Langfuse's best practices): verb first, no
// run ids, no model names. Dashboards and evaluators find steps by these.
export const STEP_NAMES: Record<StepId, string> = {
  intake: 'receive-application',
  extract: 'extract-fields',
  retrieve: 'retrieve-code-sections',
  eligibility: 'check-eligibility',
  registry: 'verify-registration',
  recommend: 'recommend-decision',
  report: 'write-report',
};

export const TRACE_NAMES = { permit: 'review-permit-application', renewal: 'renew-permit' } as const;

export class Trace {
  private readonly observation: LangfuseObservation | undefined;
  private readonly at: () => Date;

  constructor(observation: LangfuseObservation | undefined, at: () => Date) {
    this.observation = observation;
    this.at = at;
  }

  get traceId(): string | undefined {
    return this.observation?.traceId;
  }

  // A child of this observation, started now on the run's clock. (The
  // observation's own startObservation drops startTime, so this calls the
  // top-level one with the parent made explicit; nothing depends on which
  // span OpenTelemetry thinks is active.)
  child(name: string, type: LangfuseObservationType, attributes: TraceAttributes = {}): Trace {
    if (!this.observation) return this;
    const child = startObservation(name, attributes, { asType: type as 'span', parentSpanContext: this.observation.otelSpan.spanContext(), startTime: this.at() });
    return new Trace(child, this.at);
  }

  update(attributes: TraceAttributes): this {
    // Every type but `event` (which ends as it starts) can be updated.
    if (this.observation && this.observation.type !== 'event') (this.observation as Exclude<LangfuseObservation, { type: 'event' }> & { update(attributes: TraceAttributes): unknown }).update(attributes);
    return this;
  }

  end(attributes?: TraceAttributes): void {
    if (attributes) this.update(attributes);
    this.observation?.end(this.at());
  }

  // A point in time: a delivery dropped, a checkpoint used. `time` when it
  // happened on another clock than this run's.
  event(name: string, attributes: TraceAttributes = {}, time?: Date): void {
    if (!this.observation) return;
    startObservation(name, attributes, { asType: 'event', parentSpanContext: this.observation.otelSpan.spanContext(), startTime: time ?? this.at() });
  }

  // Ends this observation as failed, with the reason a reader needs.
  fail(error: unknown, attributes: TraceAttributes = {}): void {
    this.end({ level: 'ERROR', statusMessage: describe(error), ...attributes });
  }

  // Runs `work` inside a child, ending it with `done`'s attributes or as
  // failed.
  async within<T>(name: string, type: LangfuseObservationType, attributes: TraceAttributes, work: (trace: Trace) => Promise<T>, done: (value: T) => TraceAttributes = () => ({})): Promise<T> {
    const trace = this.child(name, type, attributes);
    try {
      const value = await work(trace);
      trace.end(done(value));
      return value;
    } catch (error) {
      trace.fail(error);
      throw error;
    }
  }
}

export const NO_TRACE = new Trace(undefined, () => new Date());

// What every observation of a run carries, and the trace's own attributes.
export type RunTraceOptions = {
  // Unique to this execution of the run, the same on every attempt: the
  // trigger.dev run id, or the scenario's start in memory. A crashed run's
  // second attempt joins its first attempt's trace.
  seed: string;
  kind: keyof typeof TRACE_NAMES;
  run: string;
  tenant: Tenant;
  scenario: ScenarioId;
  // One scenario execution is one session: its runs, side by side.
  sessionId: string;
  attempt: number;
  input: unknown;
  metadata: Record<string, string | number | boolean>;
  at: () => Date;
};

// Runs `work` as one attempt of a run: the root observation (an agent, so
// the run draws as its own node in Langfuse's agent graph), with the run's
// tags and session propagated to everything below it. `output` gives the
// root's output, which is the trace's output; `failed` gives it when the
// attempt ends by throwing (a crash, a spent budget, a dead letter).
export async function traceRun<T>(options: RunTraceOptions, work: (root: Trace) => Promise<T>, output: (value: T) => TraceAttributes, failed: (error: unknown) => TraceAttributes = () => ({})): Promise<T> {
  const traceId = await createTraceId(options.seed);
  const parentSpanId = (await createTraceId(`${options.seed}:parent`)).slice(0, 16);
  const tags = [`city:${options.tenant}`, `scenario:${options.scenario}`, `kind:${options.kind}`];
  const metadata = { run: options.run, ...options.metadata };
  return propagateAttributes({ traceName: TRACE_NAMES[options.kind], sessionId: options.sessionId, tags, metadata }, async () => {
    // The parent is a W3C context that names the trace (the Langfuse docs'
    // deterministic-id pattern); it is never exported, so Langfuse marks
    // this observation the trace's root.
    const observation = startObservation(
      TRACE_NAMES[options.kind],
      { input: options.input, metadata: { ...metadata, attempt: options.attempt } },
      { asType: 'agent', parentSpanContext: { traceId, spanId: parentSpanId, traceFlags: 1 }, startTime: options.at() },
    );
    const root = new Trace(observation, options.at);
    try {
      const value = await work(root);
      root.end(output(value));
      return value;
    } catch (error) {
      root.fail(error, failed(error));
      throw error;
    }
  });
}

// How an attempt that threw ended, as the runtimes end it.
export function endedBy(error: unknown): 'crashed' | 'budget_exceeded' | 'dead_letter' | 'failed' {
  if (error instanceof WorkerCrash) return 'crashed';
  if (error instanceof BudgetStop) return 'budget_exceeded';
  if (error instanceof StepFailed && error.outside) return 'dead_letter';
  return 'failed';
}

export function describe(error: unknown): string {
  if (error instanceof WorkerCrash) return `worker crashed in ${error.step}`;
  if (error instanceof BudgetStop) return error.why === 'budget' ? 'the gateway refused: run budget spent' : 'the run reached its model-call limit';
  if (error instanceof StepFailed) return `${error.step} gave up (${error.code})`;
  if (error instanceof RetryableError || error instanceof FatalError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
