import type { ReplayFile, RunEvent, ScenarioId } from './events/events';
import { scrubEvent } from './events/scrub';
import { SCENARIO_RUNS, type PlannedRun } from './permit/scenarios.ts';
import { Emitter, Sink } from './sdk/emitter.ts';
import type { Clock } from './sdk/types.ts';

// Records a scenario as a replay (engine spec E9). The recorder plays the
// platform API:
// - it accepts each run and puts it on its city's queue (those events are
//   its own);
// - it triggers the run on trigger.dev, with the city as the concurrency key;
// - it completes the approval after the scenario's wait;
// - it waits for every run to end, then merges each run's events from its
//   metadata with its own.
// The trigger.dev client is passed in, so a test can run the recorder
// against the in-memory runtime.

export type RunStatus = { finished: boolean; status: string; metadata: { events?: unknown[]; approvalToken?: string } };

export interface TriggerClient {
  trigger(payload: { input: PlannedRun['input']; scenarioStartedAt: number; acceptAt: number }, options: { concurrencyKey: string; idempotencyKey: string }): Promise<{ id: string }>;
  retrieve(runId: string): Promise<RunStatus>;
  completeToken(tokenId: string, output: { decision: 'approve' | 'reject' }): Promise<void>;
}

export type RecordOptions = {
  client: TriggerClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  // A run that hasn't ended by then is a failed recording, not a replay.
  timeoutMs?: number;
  engineCommit: string;
};

class FixedClock implements Clock {
  t: number;
  constructor(t: number) {
    this.t = t;
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

type Tracked = { planned: PlannedRun; id: string; acceptedAt: number; approved: boolean; done?: RunStatus };

export async function recordScenario(scenario: ScenarioId, options: RecordOptions): Promise<ReplayFile> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const sink = new Sink();
  const started = now();
  const planned = [...SCENARIO_RUNS[scenario]()].sort((a, b) => a.acceptAt - b.acceptAt);
  const tracked: Tracked[] = [];

  for (const run of planned) {
    const wait = started + run.acceptAt - now();
    if (wait > 0) await sleep(wait);
    const acceptedAt = now() - started;
    const handle = await options.client.trigger(
      { input: run.input, scenarioStartedAt: started, acceptAt: run.acceptAt },
      { concurrencyKey: run.input.tenant, idempotencyKey: run.input.run },
    );
    tracked.push({ planned: run, id: handle.id, acceptedAt, approved: false });
    if (run.faults.duplicate) {
      // At-least-once delivery: the same job again, same idempotency key.
      // trigger.dev returns the original run instead of a second one.
      await sleep(1500);
      const again = await options.client.trigger(
        { input: run.input, scenarioStartedAt: started, acceptAt: run.acceptAt },
        { concurrencyKey: run.input.tenant, idempotencyKey: run.input.run },
      );
      const emit = new Emitter(sink, run.input.run, run.input.tenant, new FixedClock(now() - started));
      emit.log('warn', 'The same job was delivered again.');
      if (again.id === handle.id) {
        emit.emit('step.skipped', { step: 'intake', why: 'idempotent' });
        emit.audit('duplicate.ignored', `key ${run.input.run}`, 'system');
        emit.log('info', `trigger.dev found the idempotency key ${run.input.run} already used and returned the original run.`);
      }
    }
  }

  // Wait for every run; complete each approval after the scenario's wait.
  const deadline = now() + timeoutMs;
  const tokenSeen = new Map<string, number>();
  while (tracked.some((run) => !run.done)) {
    if (now() > deadline) throw new Error(`Runs still going after ${timeoutMs / 60_000} min: ${tracked.filter((run) => !run.done).map((run) => run.planned.input.run).join(', ')}`);
    for (const run of tracked.filter((each) => !each.done)) {
      const status = await options.client.retrieve(run.id);
      const token = status.metadata.approvalToken;
      if (token && !run.approved) {
        if (!tokenSeen.has(run.id)) tokenSeen.set(run.id, now());
        const waitMs = run.planned.faults.approval?.waitMs ?? 9000;
        if (now() - tokenSeen.get(run.id)! >= waitMs) {
          await options.client.completeToken(token, { decision: run.planned.faults.approval?.decision ?? 'approve' });
          run.approved = true;
        }
      }
      if (status.finished) run.done = status;
    }
    if (tracked.some((run) => !run.done)) await sleep(pollMs);
  }

  // The recorder's own events: each run accepted and queued, with its
  // position in its city's queue when it arrived.
  const dequeuedAt = (run: Tracked) =>
    (run.done!.metadata.events ?? []).map((event) => event as RunEvent).find((event) => event.type === 'queue.dequeued')?.at ?? Number.POSITIVE_INFINITY;
  for (const run of tracked) {
    const { input } = run.planned;
    const emit = new Emitter(sink, input.run, input.tenant, new FixedClock(run.acceptedAt));
    emit.emit('run.accepted', { scenario: input.scenario, application: input.application });
    emit.audit('run.accepted', input.application);
    emit.emit('run.state', { to: 'queued' });
    emit.audit('run.state_changed', 'queued');
    const position = 1 + tracked.filter((other) => other !== run && other.planned.input.tenant === input.tenant && other.acceptedAt <= run.acceptedAt && dequeuedAt(other) > run.acceptedAt).length;
    emit.emit('queue.enqueued', { position, depth: position });
  }

  // Each run's own events, scrubbed again as the site's live route does.
  let dropped = 0;
  for (const run of tracked) {
    for (const raw of run.done!.metadata.events ?? []) {
      const event = scrubEvent({ ...(raw as object), seq: 0 });
      if (!event) {
        dropped += 1;
        continue;
      }
      const { seq: _seq, ...pending } = event;
      sink.push(pending as Omit<RunEvent, 'seq'>);
    }
  }
  if (dropped) throw new Error(`${dropped} event(s) failed the scrubber: not a replay.`);
  return sink.file(scenario, 'recorded', { recordedAt: new Date(started).toISOString(), engineCommit: options.engineCommit });
}

// One event per line, as the site's fixtures are written.
export const serialize = (file: ReplayFile): string => {
  const { events, ...head } = file;
  const top = JSON.stringify(head).slice(0, -1);
  return `${top},"events":[\n${events.map((event) => JSON.stringify(event)).join(',\n')}\n]}\n`;
};
