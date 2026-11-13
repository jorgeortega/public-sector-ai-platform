import { python } from '@trigger.dev/python';
import { metadata, task, wait } from '@trigger.dev/sdk';
import type { RunEvent } from '../events/events';
import { application, letterFor } from '../permit/applications.ts';
import { registryCall } from '../permit/registry.ts';
import { PER_CITY, SCENARIO_RUNS } from '../permit/scenarios.ts';
import { problemsTs } from '../permit/validate.ts';
import { permit, renewal } from '../permit/workflow.ts';
import { chat, createRunKey, deleteKey, keyTail } from '../gateway/client.ts';
import { RUN_KEY } from '../gateway/config.ts';
import { loadIndex, search, type SavedIndex } from '../rag/search.ts';
import savedIndex from '../rag/index.json';
import { Context, newStore, type Store } from '../sdk/context.ts';
import { Emitter, Sink } from '../sdk/emitter.ts';
import { BudgetStop, StepFailed } from '../sdk/errors.ts';
import { endedBy, traceRun } from '../sdk/trace.ts';
import type { Clock, RunInput, Services } from '../sdk/types.ts';
import { environmentName, startLangfuse } from '../tracing/langfuse.ts';

// The permit workflow on trigger.dev (spec docs/superpowers/specs/
// 2026-11-13-ai-platform-engine.md): the same workflow as the in-memory
// runtime, with the real gateway, real search over the bge-m3 index, a real
// clock and a real approval waitpoint.
//
// To verify on the owner's project before recording (Task 18):
// - that run metadata (where the checkpoints and the events are kept) is
//   still there on a retried attempt, so a crash resumes from its checkpoint;
// - that concurrency `perKey` with `concurrencyKey: tenant` keeps each city at
//   PER_CITY runs at once.

type Payload = { input: RunInput; scenarioStartedAt: number; acceptAt: number };

class RealClock implements Clock {
  private readonly start: number;
  constructor(start: number) {
    this.start = start;
  }
  now() {
    return Date.now() - this.start;
  }
  async sleep(ms: number) {
    if (ms >= 5000) await wait.for({ seconds: Math.ceil(ms / 1000) });
    else await new Promise((resolve) => setTimeout(resolve, ms));
  }
  pass() {}
}

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the trigger.dev project's environment.`);
  return value;
};

// The query's bge-m3 vector, from Workers AI's OpenAI-compatible endpoint.
async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(`${env('WORKERS_AI_BASE_URL')}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('CLOUDFLARE_AI_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: '@cf/baai/bge-m3', input: [text] }),
  });
  if (!response.ok) throw new Error(`Workers AI embeddings answered ${response.status}.`);
  const body = (await response.json()) as { data: { embedding: number[] }[] };
  return body.data[0]!.embedding;
}

const saved = savedIndex as SavedIndex;

// Checkpoints and claims in the run's metadata, so a retried attempt finds them.
function metadataStore(): Store {
  const store = newStore();
  const kept = (metadata.get('store') ?? {}) as { checkpoints?: Record<string, unknown>; claims?: string[]; attempts?: Record<string, number> };
  for (const [key, value] of Object.entries(kept.checkpoints ?? {})) store.checkpoints.set(key, value);
  for (const claim of kept.claims ?? []) store.claims.add(claim);
  for (const [key, value] of Object.entries(kept.attempts ?? {})) store.attempts.set(key, value);
  const save = () =>
    metadata.set('store', JSON.parse(JSON.stringify({ checkpoints: Object.fromEntries(store.checkpoints), claims: [...store.claims], attempts: Object.fromEntries(store.attempts) })) as Parameters<typeof metadata.set>[1]);
  const set = store.checkpoints.set.bind(store.checkpoints);
  store.checkpoints.set = (key, value) => {
    const result = set(key, value);
    save();
    return result;
  };
  const add = store.claims.add.bind(store.claims);
  store.claims.add = (value) => {
    const result = add(value);
    save();
    return result;
  };
  const setAttempt = store.attempts.set.bind(store.attempts);
  store.attempts.set = (key, value) => {
    const result = setAttempt(key, value);
    save();
    return result;
  };
  return store;
}

export const permitRun = task({
  id: 'permit-run',
  // Each city's queue runs PER_CITY at once (trigger with concurrencyKey: tenant).
  concurrency: [{ perKey: PER_CITY }],
  retry: { maxAttempts: 2 },
  run: async (payload: Payload, { ctx }) => {
    if (saved.embedder === 'hash-256') throw new Error('A real run needs the bge-m3 index (rag spec R4): run npm run index -- --embedder workers-ai.');
    const { input } = payload;
    const planned = SCENARIO_RUNS[input.scenario]().find((run) => run.input.run === input.run);
    if (!planned) throw new Error(`${input.run} is not a run of ${input.scenario}.`);
    const { faults } = planned;
    const clock = new RealClock(payload.scenarioStartedAt);
    // Langfuse (spec 2026-11-13-ai-platform-tracing.md), when the project's
    // environment has its keys: the trigger.dev environment names the
    // Langfuse one, so dev runs never mix with production's.
    const tracing = startLangfuse({ environment: environmentName(ctx.environment.type), ...(ctx.deployment?.version && { release: ctx.deployment.version }) });
    // Events go to the run's metadata as they happen; the recorder and the
    // site's live route read them from there.
    const sink = new Sink();
    const push = sink.push.bind(sink);
    sink.push = (event) => {
      push(event);
      metadata.append('events', event as unknown as Omit<RunEvent, 'seq'>);
    };
    const emit = new Emitter(sink, input.run, input.tenant, clock);
    if (planned.kind === 'renewal') emit.notes = false;
    const first = ctx.attempt.number === 1;
    const worker = `w${(ctx.attempt.number % 20) + 1}`;
    if (first) {
      emit.emit('queue.dequeued', { worker: worker as never });
      emit.emit('run.state', { to: 'running' });
    } else {
      const store = metadata.get('store') as { attempts?: Record<string, number> } | undefined;
      const fromStep = Object.keys(store?.attempts ?? {}).at(-1)?.split(':')[1] ?? 'intake';
      emit.emit('worker.resumed', { worker: worker as never, fromStep: fromStep as never });
    }
    const gateway = { baseUrl: env('GATEWAY_URL') };
    const masterKey = env('LITELLM_MASTER_KEY');
    const index = loadIndex(saved);
    const maxBudget = faults.runBudgetUsd ?? RUN_KEY.maxBudget;
    const key = await createRunKey(gateway, masterKey, { tenant: input.tenant, run: input.run, maxBudget });
    const services: Services = {
      model: async () => ({ keyTail: keyTail(key), limitUsd: maxBudget, chat: (call) => chat(gateway, key, call), close: () => deleteKey(gateway, masterKey, key) }),
      search: async (tenant, query, k) => {
        const started = Date.now();
        const hits = search(index, query, { tenant, queryVector: await embedQuery(query), k });
        return { hits, ms: Date.now() - started };
      },
      registry: registryCall(faults),
      // The Python step, through the Python build extension (spec E6).
      validate: async (fields) => {
        const result = await python.runScript('./python/validate_fields.py', [JSON.stringify(fields)]);
        if (result.exitCode === 0 && result.stdout) return { problems: (JSON.parse(result.stdout) as { problems: string[] }).problems, via: 'python' };
        return { problems: problemsTs(fields), via: 'typescript' };
      },
      approval: async () => {
        // The site completes this token when the visitor decides; it expires
        // after five minutes.
        const token = await wait.createToken({ timeout: '5m', idempotencyKey: `${input.run}-approval` });
        metadata.set('approvalToken', token.id);
        // The process may be checkpointed while it waits: send what's done.
        await tracing?.flush();
        // The wait has already happened in real time, so the context sleeps 0.
        const result = await wait.forToken<{ decision: 'approve' | 'reject' }>(token);
        return result.ok ? { decision: result.output.decision, by: 'visitor', waitMs: 0 } : { decision: 'reject', by: 'timeout', waitMs: 0 };
      },
    };
    const model = await services.model(input, maxBudget);
    let context: Context | undefined;
    try {
      const sessionId = `${input.scenario}-${payload.scenarioStartedAt}`;
      const outcome = await traceRun(
        {
          // The trigger.dev run id: every attempt of this run joins one trace.
          seed: ctx.run.id,
          kind: planned.kind,
          run: input.run,
          tenant: input.tenant,
          scenario: input.scenario,
          sessionId,
          attempt: ctx.attempt.number,
          input: planned.kind === 'permit' ? { application: input.application, letter: letterFor(application(input.application)) } : { application: input.application },
          metadata: { runtime: 'trigger.dev', triggerRun: ctx.run.id, worker },
          at: () => new Date(),
        },
        async (root) => {
          // The Langfuse trace, for the site's console to link to.
          if (tracing && root.traceId) metadata.set('langfuseTraceId', root.traceId);
          context = new Context({ input, emit, clock, services, store: metadataStore(), faults, worker, firstWorker: first, model, trace: root });
          return planned.kind === 'renewal' ? await renewal(context, input.application) : await permit(context, application(input.application), faults);
        },
        (result) => ({ output: { outcome: result, ...context?.result }, metadata: { spentUsd: context?.usage.spent ?? 0, modelCalls: context?.usage.calls ?? 0 } }),
        (error) => ({ output: { outcome: endedBy(error) }, metadata: { spentUsd: context?.usage.spent ?? 0, modelCalls: context?.usage.calls ?? 0 } }),
      );
      if (outcome === 'completed') emit.emit('run.state', { to: 'completed' });
      return { outcome };
    } catch (error) {
      if (error instanceof BudgetStop) {
        emit.emit('run.state', { to: 'budget_exceeded' });
        return { outcome: 'budget_exceeded' };
      }
      if (error instanceof StepFailed && error.outside) {
        emit.emit('dlq.sent', { step: error.step, code: error.code });
        emit.emit('run.state', { to: 'failed' });
        return { outcome: 'failed' };
      }
      // A crash (the `crash` fault) or anything else: trigger.dev retries the
      // run, which resumes from the checkpoints in its metadata.
      emit.emit('worker.crashed', { worker: worker as never });
      throw error;
    } finally {
      await model.close().catch(() => {});
      await tracing?.flush().catch(() => {});
    }
  },
});
