import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScenarioId } from '../src/events/events';
import { runScenario } from '../src/runtime/memory.ts';
import { NO_TRACE, STEP_NAMES, TRACE_NAMES, traceRun } from '../src/sdk/trace.ts';
import { startLangfuse, type Tracing } from '../src/tracing/langfuse.ts';

// What the engine sends Langfuse (spec 2026-11-13-ai-platform-tracing.md),
// read off the spans the real LangfuseSpanProcessor exports, with an
// in-memory exporter in place of Langfuse's.

const exporter = new InMemorySpanExporter();
let tracing: Tracing;

beforeAll(() => {
  tracing = startLangfuse({ environment: 'test', exporter })!;
});
afterAll(async () => {
  await tracing.shutdown();
});
beforeEach(() => exporter.reset());

const A = {
  type: 'langfuse.observation.type',
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  level: 'langfuse.observation.level',
  status: 'langfuse.observation.status_message',
  model: 'langfuse.observation.model.name',
  usage: 'langfuse.observation.usage_details',
  cost: 'langfuse.observation.cost_details',
  traceName: 'langfuse.trace.name',
  tags: 'langfuse.trace.tags',
  session: 'session.id',
  environment: 'langfuse.environment',
  appRoot: 'langfuse.internal.is_app_root',
};

async function spansOf(scenario: ScenarioId): Promise<ReadableSpan[]> {
  await runScenario(scenario, { epoch: Date.UTC(2026, 10, 13, 12) });
  await tracing.flush();
  return exporter.getFinishedSpans();
}

const attr = (span: ReadableSpan, key: string) => span.attributes[key];
const json = (span: ReadableSpan, key: string) => JSON.parse(String(attr(span, key) ?? 'null')) as unknown;
const ofType = (spans: ReadableSpan[], type: string) => spans.filter((span) => attr(span, A.type) === type);
const named = (spans: ReadableSpan[], name: string) => spans.filter((span) => span.name === name);
const roots = (spans: ReadableSpan[]) => spans.filter((span) => attr(span, A.appRoot) === true);
const parentOf = (spans: ReadableSpan[], span: ReadableSpan) => spans.find((each) => each.spanContext().spanId === span.parentSpanContext?.spanId);

// Every name an observation may have: names are an API, so none carries a
// run id, a model or a count.
const NAMES = new Set([
  ...Object.values(TRACE_NAMES),
  ...Object.values(STEP_NAMES),
  'read-application-letter',
  'judge-eligibility',
  'draft-recommendation',
  'compare-with-last-year',
  'search-city-code',
  'quarantine-instructions',
  'validate-fields',
  'check-business-registry',
  'await-human-approval',
  'skip-checkpointed-step',
  'drop-duplicate-delivery',
]);

describe('a happy run', () => {
  let spans: ReadableSpan[];
  beforeAll(async () => {
    exporter.reset();
    spans = await spansOf('happy');
  });

  it('is one trace with one root, the run, typed as an agent', () => {
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    const [root] = roots(spans);
    expect(roots(spans)).toHaveLength(1);
    expect(root!.name).toBe('review-permit-application');
    expect(attr(root!, A.type)).toBe('agent');
  });

  it("carries the run's city, scenario, session and environment on every observation", () => {
    for (const span of spans) {
      expect(attr(span, A.tags)).toEqual(['city:port-alder', 'scenario:happy', 'kind:permit']);
      expect(attr(span, A.traceName)).toBe('review-permit-application');
      expect(String(attr(span, A.session))).toMatch(/^happy-\d+$/);
      expect(attr(span, A.environment)).toBe('test');
    }
  });

  it("has the letter as the trace's input and the decision as its output", () => {
    const [root] = roots(spans);
    const input = json(root!, A.input) as { application: string; letter: string };
    expect(input.application).toBe('pa-bakery-0141');
    expect(input.letter).toContain('Dear permit office');
    const output = json(root!, A.output) as { outcome: string; decision: string; citations: string[] };
    expect(output.outcome).toBe('completed');
    expect(['approve', 'deny', 'refer']).toContain(output.decision);
    expect(output.citations.length).toBeGreaterThan(0);
  });

  it('nests a span per step under the run, in order', () => {
    const steps = spans.filter((span) => Object.values(STEP_NAMES).includes(span.name)).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    expect(steps.map((span) => span.name)).toEqual(Object.values(STEP_NAMES));
    for (const step of steps) expect(parentOf(spans, step)?.name).toBe('review-permit-application');
  });

  it('records every model call as its own generation, with model, tokens and the cost the gateway charged', () => {
    const generations = ofType(spans, 'generation');
    expect(generations.map((span) => span.name)).toEqual(['read-application-letter', 'judge-eligibility', 'draft-recommendation']);
    for (const generation of generations) {
      expect(attr(generation, A.model)).toBe('claude-haiku-5-5');
      const usage = json(generation, A.usage) as { input: number; output: number };
      expect(usage.input).toBeGreaterThan(0);
      expect(usage.output).toBeGreaterThan(0);
      const cost = json(generation, A.cost) as { input: number; output: number; total: number };
      expect(cost.total).toBeCloseTo(cost.input + cost.output, 9);
      const input = json(generation, A.input) as { role: string; content: string }[];
      expect(input.map((message) => message.role)).toEqual(['system', 'user']);
      expect(json(generation, A.output)).toMatchObject({ role: 'assistant' });
    }
    // Each under the step that made it.
    expect(parentOf(spans, generations[0]!)?.name).toBe('extract-fields');
    expect(parentOf(spans, generations[1]!)?.name).toBe('check-eligibility');
  });

  it('types search as a retriever, the screen as a guardrail, the checks as tools, as siblings in their step', () => {
    const [retriever] = ofType(spans, 'retriever');
    expect(retriever!.name).toBe('search-city-code');
    expect(parentOf(spans, retriever!)?.name).toBe('retrieve-code-sections');
    const chunks = json(retriever!, A.output) as { id: string; text: string; quarantined: boolean }[];
    expect(chunks.length).toBe(5);
    expect(chunks[0]!.text.length).toBeGreaterThan(0);
    const [guardrail] = ofType(spans, 'guardrail');
    expect(guardrail!.name).toBe('quarantine-instructions');
    expect(parentOf(spans, guardrail!)?.name).toBe('retrieve-code-sections');
    expect(ofType(spans, 'tool').map((span) => span.name).sort()).toEqual(['check-business-registry', 'validate-fields']);
  });

  it('shows the human approval as a wait under the run', () => {
    const [approval] = named(spans, 'await-human-approval');
    expect(parentOf(spans, approval!)?.name).toBe('review-permit-application');
    expect(json(approval!, A.output)).toEqual({ decision: 'approve', by: 'visitor' });
  });

  it('uses only the fixed names', () => {
    for (const span of spans) expect(NAMES, span.name).toContain(span.name);
  });
});

describe('a rejected run', () => {
  it("ends with the recommendation the person rejected, and who decided, as the trace's output", async () => {
    const spans = await spansOf('approval');
    const output = json(roots(spans)[0]!, A.output) as { outcome: string; recommendation: { decision: string }; approval: unknown };
    expect(output.outcome).toBe('rejected');
    expect(output.recommendation.decision).toMatch(/approve|deny|refer/);
    expect(output.approval).toEqual({ decision: 'reject', by: 'visitor' });
    expect(json(named(spans, 'await-human-approval')[0]!, A.input)).toEqual(output.recommendation);
  });
});

describe('the failure scenarios', () => {
  it('crash: both attempts in one trace; the first ends in an error, the second skips its checkpoints', async () => {
    const spans = await spansOf('crash');
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    const [first, second] = roots(spans).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    expect(attr(first!, A.level)).toBe('ERROR');
    expect(attr(first!, A.status)).toBe('worker crashed in eligibility');
    expect(json(first!, A.output)).toEqual({ outcome: 'crashed' });
    expect(json(second!, A.output)).toMatchObject({ outcome: 'completed' });
    const skipped = named(spans, 'skip-checkpointed-step');
    expect(skipped.map((span) => (span.attributes['langfuse.observation.metadata.step'] as string).replaceAll('"', ''))).toEqual(['intake', 'extract', 'retrieve']);
    expect(skipped.every((span) => parentOf(spans, span) === second)).toBe(true);
  });

  it('poisoned-doc: the guardrail warns and names the quarantined section', async () => {
    const spans = await spansOf('poisoned-doc');
    const [guardrail] = named(spans, 'quarantine-instructions');
    expect(attr(guardrail!, A.level)).toBe('WARNING');
    const output = json(guardrail!, A.output) as { quarantined: { id: string; reasons: string[] }[] };
    expect(output.quarantined.length).toBeGreaterThan(0);
    expect(output.quarantined[0]!.reasons.length).toBeGreaterThan(0);
  });

  it('budget: the refused call is a failed generation, and the run ends budget_exceeded', async () => {
    const spans = await spansOf('budget');
    const generations = ofType(spans, 'generation');
    const refused = generations.at(-1)!;
    expect(attr(refused, A.level)).toBe('ERROR');
    expect(String(attr(refused, A.status))).toMatch(/refused/);
    expect(generations.filter((span) => span.name === 'judge-eligibility').length).toBeGreaterThan(1);
    expect(json(roots(spans)[0]!, A.output)).toEqual({ outcome: 'budget_exceeded' });
  });

  it('flaky-registry: each attempt is its own tool call, the failed ones in error, and the hopeless run is a dead letter', async () => {
    const spans = await spansOf('flaky-registry');
    const calls = named(spans, 'check-business-registry');
    expect(calls.filter((span) => attr(span, A.level) === 'ERROR').length).toBeGreaterThanOrEqual(3);
    const retried = named(spans, 'verify-registration').filter((span) => attr(span, A.level) === 'WARNING');
    expect(retried.length).toBeGreaterThan(0);
    expect(String(attr(retried[0]!, A.status))).toMatch(/attempt \d in \d s/);
    const outcomes = roots(spans).map((root) => (json(root, A.output) as { outcome: string }).outcome);
    expect(outcomes.sort()).toEqual(['completed', 'dead_letter']);
  });

  it('provider-down: the generation names the model that answered and warns of the fallback', async () => {
    const spans = await spansOf('provider-down');
    const [generation] = ofType(spans, 'generation');
    expect(attr(generation!, A.model)).toBe('gpt-oss-120b');
    expect(attr(generation!, A.level)).toBe('WARNING');
  });

  it('duplicate: the second delivery is an event in the run it would have repeated', async () => {
    const spans = await spansOf('duplicate');
    expect(roots(spans)).toHaveLength(1);
    expect(named(spans, 'drop-duplicate-delivery')).toHaveLength(1);
  });

  it('burst: one trace per renewal, all in one session', async () => {
    const spans = await spansOf('burst');
    const runs = roots(spans);
    expect(runs).toHaveLength(53);
    expect(new Set(runs.map((root) => root.spanContext().traceId)).size).toBe(53);
    expect(new Set(runs.map((root) => attr(root, A.session))).size).toBe(1);
    expect(runs.every((root) => root.name === 'renew-permit')).toBe(true);
  });
});

describe('what leaves', () => {
  it('redacts keys, tokens and emails before export', async () => {
    const options = { seed: 'mask', kind: 'permit' as const, run: 'run_mask', tenant: 'port-alder' as const, scenario: 'happy' as const, sessionId: 'mask', attempt: 1, metadata: {}, at: () => new Date() };
    await traceRun({ ...options, input: { note: 'key sk-ant-api03-abcdef, mail jo@example.com' } }, async () => 'ok', () => ({ output: 'Bearer abc.def' }));
    await tracing.flush();
    const [root] = exporter.getFinishedSpans();
    expect(String(attr(root!, A.input))).not.toMatch(/abcdef|jo@example/);
    expect(String(attr(root!, A.input))).toContain('sk-ant-[redacted]');
    expect(String(attr(root!, A.output))).not.toContain('abc.def');
  });

  it('does nothing without a parent', () => {
    expect(NO_TRACE.child('x', 'span')).toBe(NO_TRACE);
  });
});
