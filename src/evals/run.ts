import type { Recommendation } from '../permit/prompts.ts';
import { registryCall } from '../permit/registry.ts';
import { permit } from '../permit/workflow.ts';
import type { Hit } from '../rag/search.ts';
import { VirtualClock } from '../runtime/memory.ts';
import { Context, newStore } from '../sdk/context.ts';
import { Emitter, Sink } from '../sdk/emitter.ts';
import { describe as describeError, traceRun, type Trace } from '../sdk/trace.ts';
import type { RunModel, Services } from '../sdk/types.ts';
import type { Decision, GoldenCase } from './golden.ts';
import { METRICS, score, type Metric, type Observed, type Scores } from './score.ts';

// The evals' runner (spec V2, V4): the real permit workflow for each golden
// case, with whatever services it's given (the gateway, bge-m3 search and
// the Python check from scripts/evals.ts; the fake model and the hash index
// in tests). The registry answers 200 and the approval is `approve` at once:
// what's measured is the recommendation.

export type EvalServices = {
  // A model for one attempt, with a key of its own.
  model(c: GoldenCase, run: string): Promise<RunModel>;
  search: Services['search'];
  validate: Services['validate'];
};

export type Attempt = {
  case: string;
  tenant: string;
  attempt: number;
  expected: { decision: Decision; restsOn: string[]; neverCite: string[] };
  decision?: Decision;
  citations: string[];
  dropped: string[];
  // The workflow's guard turned the model's approve into refer: the
  // decision scored is the platform's, and this says the model's differed.
  guarded: boolean;
  retrieved: string[];
  extracted?: Record<string, unknown>;
  scores: Scores;
  notes: string[];
  models: string[];
  calls: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  ms: number;
  error?: string;
  traceSeed?: string;
};

export type RunOptions = {
  repeat?: number;
  concurrency?: number;
  // Set when traces go to Langfuse: one session for the whole eval run.
  sessionId?: string;
  onAttempt?: (attempt: Attempt) => void | Promise<void>;
};

const DROPPED = /^The model cited (\S+), which it may not/;
const GUARDED = /^The model recommended approve over unmet /;
// The events' run id format: `run_` and 8 to 24 lowercase letters and digits.
export const runId = (c: GoldenCase, attempt: number) => `run_ev${c.application.id.replace(/-/g, '')}${attempt}`;

export async function runAttempt(c: GoldenCase, attempt: number, services: EvalServices, sessionId?: string): Promise<Attempt> {
  const app = c.application;
  const run = runId(c, attempt);
  const clock = new VirtualClock(0);
  const sink = new Sink();
  const emit = new Emitter(sink, run, app.tenant, clock);
  const store = newStore();
  store.claims.add(`${run}:run`);
  const usage = { calls: 0, inTokens: 0, outTokens: 0, costUsd: 0, models: new Set<string>() };
  const started = Date.now();
  let error: string | undefined;
  let model: RunModel | undefined;

  const work = async (trace?: Trace) => {
    const opened = (model = await services.model(c, run));
    const counted: RunModel = {
      ...opened,
      chat: async (call) => {
        const result = await opened.chat(call);
        usage.calls += 1;
        usage.inTokens += result.inTokens;
        usage.outTokens += result.outTokens;
        usage.costUsd += result.costUsd;
        usage.models.add(result.model);
        return result;
      },
    };
    const svc: Services = {
      model: async () => counted,
      search: services.search,
      registry: registryCall({}),
      validate: services.validate,
      approval: async () => ({ decision: 'approve', by: 'visitor', waitMs: 0 }),
    };
    const ctx = new Context({ input: { run, tenant: app.tenant, scenario: 'happy', application: app.id }, emit, clock, services: svc, store, faults: {}, worker: 'w1', firstWorker: true, model: counted, ...(trace && { trace }) });
    await permit(ctx, app, {});
    return ctx.result;
  };

  const traceSeed = sessionId ? `${sessionId}:${run}` : undefined;
  try {
    if (traceSeed && sessionId) {
      await traceRun(
        {
          seed: traceSeed,
          kind: 'permit',
          run,
          tenant: app.tenant,
          scenario: 'happy',
          tags: [`eval:${app.id}`],
          sessionId,
          attempt: 1,
          input: { application: app.id, case: app.id, expected: c.decision },
          metadata: { runtime: 'evals', case: app.id, attempt },
          at: () => new Date(),
        },
        work,
        (result) => ({ output: result }),
        (thrown) => ({ output: { error: describeError(thrown) } }),
      );
    } else {
      await work();
    }
  } catch (thrown) {
    error = describeError(thrown);
  } finally {
    await model?.close().catch(() => {});
  }

  const checkpoint = <T>(step: string) => store.checkpoints.get(`${run}:${step}`) as T | undefined;
  const recommendation = checkpoint<Recommendation>('recommend');
  const hits = checkpoint<Hit[]>('retrieve') ?? [];
  const dropped = sink
    .events()
    .flatMap((event) => (event.type === 'log' ? [DROPPED.exec(event.msg)?.[1]] : []))
    .filter((id): id is string => Boolean(id));
  const guarded = sink.events().some((event) => event.type === 'log' && GUARDED.test(event.msg));
  const seen: Observed = {
    ...(recommendation && { decision: recommendation.decision }),
    citations: recommendation?.citations ?? [],
    dropped,
    retrieved: hits.map((hit) => hit.id),
    ...(checkpoint('extract') !== undefined && { extracted: checkpoint<Record<string, unknown>>('extract') }),
  };
  const { scores, notes } = score(c, seen);
  return {
    case: app.id,
    tenant: app.tenant,
    attempt,
    expected: { decision: c.decision, restsOn: c.restsOn, neverCite: c.neverCite },
    ...seen,
    guarded,
    scores,
    notes: error ? [error, ...notes] : notes,
    models: [...usage.models],
    calls: usage.calls,
    inTokens: usage.inTokens,
    outTokens: usage.outTokens,
    costUsd: Math.round(usage.costUsd * 1e7) / 1e7,
    ms: Date.now() - started,
    ...(error && { error }),
    ...(traceSeed && { traceSeed }),
  };
}

// Every case `repeat` times, `concurrency` at once, in case order.
export async function runEvals(cases: readonly GoldenCase[], services: EvalServices, options: RunOptions = {}): Promise<Attempt[]> {
  const { repeat = 3, concurrency = 3 } = options;
  const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, n) => ({ c, attempt: n + 1 })));
  const results: Attempt[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (let job = next++; job < jobs.length; job = next++) {
      const { c, attempt } = jobs[job]!;
      results[job] = await runAttempt(c, attempt, services, options.sessionId);
      await options.onAttempt?.(results[job]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

export type Summary = {
  attempts: number;
  cases: number;
  metrics: { id: Metric; pass: number; total: number }[];
  // Cases that passed the decision on some attempts and failed it on others.
  flaky: string[];
  misses: { case: string; attempt: number; metric: Metric; notes: string[] }[];
  // Attempts whose approve the workflow's guard turned into refer.
  guarded: number;
  costUsd: number;
  p50Ms: number;
  models: Record<string, number>;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

export function summarize(attempts: readonly Attempt[]): Summary {
  const metrics = METRICS.map((id) => {
    const scored = attempts.filter((a) => a.scores[id] !== null);
    return { id, pass: scored.filter((a) => a.scores[id]).length, total: scored.length };
  });
  const byCase = new Map<string, boolean[]>();
  for (const a of attempts) byCase.set(a.case, [...(byCase.get(a.case) ?? []), a.scores.decision === true]);
  const flaky = [...byCase].filter(([, passes]) => passes.some(Boolean) && !passes.every(Boolean)).map(([id]) => id);
  const misses = attempts.flatMap((a) => METRICS.filter((m) => a.scores[m] === false).map((metric) => ({ case: a.case, attempt: a.attempt, metric, notes: a.notes })));
  const models: Record<string, number> = {};
  for (const a of attempts) for (const m of a.models) models[m] = (models[m] ?? 0) + 1;
  return {
    attempts: attempts.length,
    cases: byCase.size,
    metrics,
    flaky,
    misses,
    guarded: attempts.filter((a) => a.guarded).length,
    costUsd: Math.round(attempts.reduce((sum, a) => sum + a.costUsd, 0) * 1e6) / 1e6,
    p50Ms: median(attempts.map((a) => a.ms)),
    models,
  };
}

const pct = (pass: number, total: number) => (total ? `${Math.round((pass / total) * 100)}%` : 'n/a');

export function format(summary: Summary, attempts: readonly Attempt[]): string {
  const lines = [`${summary.cases} cases, ${summary.attempts} attempts, $${summary.costUsd.toFixed(4)}, p50 ${(summary.p50Ms / 1000).toFixed(1)} s`];
  for (const m of summary.metrics) lines.push(`  ${m.id.padEnd(11)} ${String(m.pass).padStart(3)}/${String(m.total).padEnd(3)} ${pct(m.pass, m.total)}`);
  if (summary.flaky.length) lines.push(`  flaky: ${summary.flaky.join(', ')}`);
  if (summary.guarded) lines.push(`  guarded: ${summary.guarded} approve${summary.guarded === 1 ? '' : 's'} over an unmet rule turned into refer by the workflow (${attempts.filter((a) => a.guarded).map((a) => `${a.case} #${a.attempt}`).join(', ')})`);
  const missed = attempts.filter((a) => METRICS.some((m) => a.scores[m] === false));
  if (missed.length) {
    lines.push('Misses:');
    for (const a of missed) lines.push(`  ${a.case} #${a.attempt} (expected ${a.expected.decision}): ${a.notes.join('; ')}`);
  }
  return lines.join('\n');
}

// Case by case: each metric's passes before and after.
export function compare(before: readonly Attempt[], after: readonly Attempt[]): string {
  const tally = (attempts: readonly Attempt[], id: string, m: Metric) => {
    const scored = attempts.filter((a) => a.case === id && a.scores[m] !== null);
    return scored.length ? `${scored.filter((a) => a.scores[m]).length}/${scored.length}` : '-';
  };
  const ids = [...new Set([...before, ...after].map((a) => a.case))];
  const a = summarize(before);
  const b = summarize(after);
  const lines = METRICS.map((m, i) => `  ${m.padEnd(11)} ${pct(a.metrics[i]!.pass, a.metrics[i]!.total).padStart(4)} -> ${pct(b.metrics[i]!.pass, b.metrics[i]!.total)}`);
  for (const id of ids) {
    const changed = METRICS.filter((m) => tally(before, id, m) !== tally(after, id, m));
    if (changed.length) lines.push(`  ${id}: ${changed.map((m) => `${m} ${tally(before, id, m)} -> ${tally(after, id, m)}`).join(', ')}`);
  }
  return lines.join('\n');
}
