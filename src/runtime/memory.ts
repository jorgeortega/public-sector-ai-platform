import type { ReplayFile, ScenarioId, Tenant } from '../events/events';
import { RUN_KEY } from '../gateway/config.ts';
import { application } from '../permit/applications.ts';
import { fakeRunModel } from '../permit/fake-model.ts';
import { registryCall } from '../permit/registry.ts';
import { PER_CITY, SCENARIO_RUNS, type PlannedRun } from '../permit/scenarios.ts';
import { validateFields } from '../permit/validate.ts';
import { permit, renewal, type Outcome } from '../permit/workflow.ts';
import { buildIndex, loadIndex, search, type LoadedIndex } from '../rag/search.ts';
import { readSources } from '../rag/sources.ts';
import { hashEmbed, hashEmbedder } from '../rag/vectors.ts';
import { Context, newStore, type Store } from '../sdk/context.ts';
import { Emitter, Sink } from '../sdk/emitter.ts';
import { BudgetStop, StepFailed, WorkerCrash } from '../sdk/errors.ts';
import type { Clock, RunModel, Services } from '../sdk/types.ts';

// The in-memory runtime: the same workflow, on a virtual clock, with the
// fake model and the real search over a hash-256 index built here (no
// account needed). For tests and development; never for a recorded replay
// (spec E9). It does what trigger.dev does for the workflow: a queue per city
// running PER_CITY at once, checkpoints, resume after a crash, a second
// delivery refused by an idempotency key.

export class VirtualClock implements Clock {
  t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
  pass(ms: number) {
    this.t += ms;
  }
}

let cachedIndex: Promise<LoadedIndex> | undefined;
const hashIndex = () => (cachedIndex ??= buildIndex(readSources(), hashEmbedder).then(loadIndex));

export type MemoryOptions = { python?: string; model?: (run: PlannedRun, maxBudgetUsd: number) => RunModel };

async function services(planned: PlannedRun, options: MemoryOptions): Promise<Services> {
  const index = await hashIndex();
  return {
    model: async (input, maxBudgetUsd) => (options.model ? options.model(planned, maxBudgetUsd) : fakeRunModel(input, maxBudgetUsd)),
    search: async (tenant, query, k) => ({ hits: search(index, query, { tenant, queryVector: hashEmbed(query), k }), ms: 90 }),
    registry: registryCall(planned.faults),
    validate: async (fields) => validateFields(fields, options.python),
    approval: async () => ({ decision: planned.faults.approval?.decision ?? 'approve', by: 'visitor', waitMs: planned.faults.approval?.waitMs ?? 9000 }),
  };
}

const workerName = (n: number) => `w${n}`;

// One run, start to end. Returns when it ended (virtual ms).
async function runOne(sink: Sink, planned: PlannedRun, slot: { worker: number; startAt: number; position: number }, options: MemoryOptions): Promise<number> {
  const { input, faults } = planned;
  const clock = new VirtualClock(planned.acceptAt);
  const emit = new Emitter(sink, input.run, input.tenant, clock);
  if (planned.kind === 'renewal') emit.notes = false;
  emit.emit('run.accepted', { scenario: input.scenario, application: input.application });
  emit.audit('run.accepted', input.application);
  emit.emit('run.state', { to: 'queued' });
  emit.audit('run.state_changed', 'queued');
  emit.emit('queue.enqueued', { position: slot.position, depth: slot.position });

  clock.t = Math.max(clock.t, slot.startAt);
  let worker = workerName(slot.worker);
  emit.emit('queue.dequeued', { worker: worker as never });
  emit.emit('run.state', { to: 'running' });
  emit.audit('run.state_changed', 'running', `worker:${worker}` as never);

  const store: Store = newStore();
  store.claims.add(`${input.run}:run`);
  const svc = await services(planned, options);
  const model = await svc.model(input, faults.runBudgetUsd ?? RUN_KEY.maxBudget);

  if (faults.duplicate) {
    // At-least-once delivery: the queue hands the job to a second worker
    // 1.5 s in. The run's idempotency key is taken, so it does nothing.
    const later = new VirtualClock(clock.t + 1500);
    const second = new Emitter(sink, input.run, input.tenant, later);
    second.log('warn', 'The queue did not see an acknowledgement in time and delivered the job again.');
    second.emit('queue.enqueued', { position: 1, depth: 1 });
    later.pass(40);
    second.emit('queue.dequeued', { worker: 'w5' });
    if (store.claims.has(`${input.run}:run`)) {
      second.emit('step.skipped', { step: 'intake', why: 'idempotent' });
      second.audit('duplicate.ignored', `key ${input.run}:run`, 'worker:w5');
      second.log('info', `w5 found the idempotency key ${input.run}:run already claimed by ${worker} and dropped the second delivery.`);
    }
  }

  let first = true;
  let usage = { spent: 0, calls: 0 };
  let outcome: Outcome | 'failed' | 'budget_exceeded';
  for (;;) {
    const ctx = new Context({ input, emit, clock, services: svc, store, faults, worker, firstWorker: first, model, ...usage });
    try {
      outcome = planned.kind === 'renewal' ? await renewal(ctx, input.application) : await permit(ctx, application(input.application), faults);
      break;
    } catch (error) {
      usage = ctx.usage;
      if (error instanceof WorkerCrash) {
        emit.emit('worker.crashed', { worker: worker as never });
        emit.audit('worker.crashed', worker);
        emit.log('error', `Worker ${worker} stopped answering; its lease ran out mid-step.`);
        await clock.sleep(1800);
        emit.emit('queue.enqueued', { position: 1, depth: 1 });
        emit.log('info', 'The run goes back on the queue from its last checkpoint.');
        clock.pass(40);
        worker = 'w7';
        emit.emit('queue.dequeued', { worker: 'w7' });
        emit.emit('worker.resumed', { worker: 'w7', fromStep: error.step });
        emit.audit('worker.resumed', `w7 from ${error.step}`);
        first = false;
        continue;
      }
      if (error instanceof BudgetStop) {
        outcome = 'budget_exceeded';
        break;
      }
      if (error instanceof StepFailed && error.outside) {
        emit.emit('dlq.sent', { step: error.step, code: error.code });
        emit.audit('dlq.sent', `${error.step} · ${error.code}`);
        outcome = 'failed';
        break;
      }
      if (error instanceof StepFailed) {
        outcome = 'failed';
        break;
      }
      throw error;
    }
  }
  await model.close();
  // `rejected` and `expired` were already set by the approval.
  if (outcome === 'completed' || outcome === 'failed' || outcome === 'budget_exceeded') {
    emit.emit('run.state', { to: outcome });
    emit.audit('run.state_changed', outcome);
  }
  return clock.now();
}

// A scenario's runs, scheduled on each city's queue, into one replay.
export async function runScenario(scenario: ScenarioId, options: MemoryOptions = {}): Promise<ReplayFile> {
  const sink = new Sink();
  const planned = [...SCENARIO_RUNS[scenario]()].sort((a, b) => a.acceptAt - b.acceptAt);
  // Workers: w1 to w5 for Port Alder, w6 to w10 for Kestrel Bay; a single run
  // uses the worker its fixture names.
  const free: Record<Tenant, number[]> = { 'port-alder': Array(PER_CITY).fill(-1), 'kestrel-bay': Array(PER_CITY).fill(-1) };
  const starts: { tenant: Tenant; startAt: number }[] = [];
  const firstWorker: Record<string, number> = { run_pa0141happy: 3, run_pa0187crash: 3, run_pa0203flaky: 4, run_kb0091flaky: 9, run_kb0032dupe: 2, run_pa0412approval: 2, run_kb0077poison: 6, run_pa0350budget: 5, run_kb0144fallback: 6 };
  for (const run of planned) {
    const slots = free[run.input.tenant];
    const ready = run.acceptAt + 40;
    const slot = slots.indexOf(Math.min(...slots));
    const startAt = Math.max(ready, slots[slot]! + 20, run.kind === 'renewal' ? 150 : 0);
    // Waiting ahead of it in its city's queue when it arrives, itself included.
    const position = 1 + starts.filter((s) => s.tenant === run.input.tenant && s.startAt > run.acceptAt).length;
    starts.push({ tenant: run.input.tenant, startAt });
    const offset = run.input.tenant === 'port-alder' ? 1 : PER_CITY + 1;
    const worker = firstWorker[run.input.run] ?? offset + slot;
    slots[slot] = await runOne(sink, run, { worker, startAt, position }, options);
  }
  return sink.file(scenario, 'fixture');
}
