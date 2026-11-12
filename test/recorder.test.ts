import { describe, expect, it } from 'vitest';
import type { ReplayFile, RunEvent, ScenarioId } from '../src/events/events.ts';
import { recordScenario, serialize, type RunStatus, type TriggerClient } from '../src/recorder.ts';
import { runScenario } from '../src/runtime/memory.ts';

// The recorder, against a fake trigger.dev that answers with the in-memory
// runtime's runs: each run's metadata holds that run's events minus the ones
// the recorder emits itself (accepted, queued, enqueued). A recorded replay
// must then hold the same events as the in-memory one.

const OWN = new Set(['run.accepted', 'queue.enqueued']);
const isOwn = (event: RunEvent) =>
  OWN.has(event.type) ||
  (event.type === 'run.state' && event.to === 'queued') ||
  (event.type === 'audit.entry' && (event.action === 'run.accepted' || (event.action === 'run.state_changed' && event.object === 'queued')));

function fakeTrigger(memory: ReplayFile) {
  let clock = 0;
  const triggered: string[] = [];
  const completed: { token: string; decision: string }[] = [];
  const client: TriggerClient = {
    async trigger(payload) {
      triggered.push(payload.input.run);
      return { id: `fake_${payload.input.run}` };
    },
    async retrieve(runId): Promise<RunStatus> {
      const run = runId.replace(/^fake_/, '');
      const events = memory.events.filter((event) => event.run === run && !isOwn(event) && !(event.type === 'step.skipped' && event.why === 'idempotent') && !(event.type === 'audit.entry' && event.action === 'duplicate.ignored') && !(event.type === 'log' && /delivered the job again|already claimed/.test(event.msg)));
      const approval = events.some((event) => event.type === 'approval.requested');
      return { finished: clock > 60_000, status: clock > 60_000 ? 'COMPLETED' : 'EXECUTING', metadata: { events: events.map(({ seq: _seq, ...rest }) => rest), ...(approval && { approvalToken: `tok_${run}` }) } };
    },
    async completeToken(token, output) {
      completed.push({ token, decision: output.decision });
    },
  };
  const options = { client, now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 1000, engineCommit: '2a4e072' };
  return { options, triggered, completed };
}

const kinds = (events: RunEvent[]) => events.map((event) => `${event.run} ${event.type}`).sort();

describe.each(['happy', 'approval', 'flaky-registry', 'duplicate'] satisfies ScenarioId[])('recording %s', (scenario) => {
  it('makes a recorded replay with every run’s events, its own queue events, and the approval completed', async () => {
    const memory = await runScenario(scenario);
    const { options, triggered, completed } = fakeTrigger(memory);
    const recorded = await recordScenario(scenario, options);
    expect(recorded).toMatchObject({ scenario, source: 'recorded', engineCommit: '2a4e072' });
    expect(recorded.recordedAt).toMatch(/^1970-01-01T00:00:00/);
    // Same events (by run and type) as the in-memory run, the duplicate's
    // refusal now coming from trigger.dev's idempotency key.
    const memoryKinds = kinds(memory.events.filter((event) => !(event.type === 'log' && /delivered the job again|already claimed/.test(event.msg))));
    const recordedKinds = kinds(recorded.events.filter((event) => !(event.type === 'log' && /delivered again|already used/.test(event.msg))));
    expect(recordedKinds.filter((k) => !k.endsWith('queue.dequeued') && !k.endsWith('queue.enqueued'))).toEqual(
      memoryKinds.filter((k) => !k.endsWith('queue.dequeued') && !k.endsWith('queue.enqueued')),
    );
    expect(new Set(triggered)).toEqual(new Set(memory.events.filter((e) => e.type === 'run.accepted').map((e) => e.run)));
    const decisions = memory.events.flatMap((e) => (e.type === 'approval.decided' ? [e.decision] : []));
    expect(completed.map((c) => c.decision)).toEqual(decisions);
    expect(serialize(recorded).split('\n').length).toBe(recorded.events.length + 3);
  });
});

describe('the recorder', () => {
  it('gives up on a run that never ends', async () => {
    const client: TriggerClient = {
      trigger: async (payload) => ({ id: payload.input.run }),
      retrieve: async () => ({ finished: false, status: 'EXECUTING', metadata: {} }),
      completeToken: async () => {},
    };
    let clock = 0;
    await expect(recordScenario('happy', { client, now: () => clock, sleep: async (ms) => void (clock += ms), timeoutMs: 5000, engineCommit: 'abc1234' })).rejects.toThrow(/still going/);
  });

  it('refuses a run whose events fail the scrubber', async () => {
    const client: TriggerClient = {
      trigger: async (payload) => ({ id: payload.input.run }),
      retrieve: async (id) => ({ finished: true, status: 'COMPLETED', metadata: { events: [{ v: 1, at: 5, run: id, tenant: 'port-alder', type: 'model.thought' }] } }),
      completeToken: async () => {},
    };
    let clock = 0;
    await expect(recordScenario('happy', { client, now: () => clock, sleep: async (ms) => void (clock += ms), engineCommit: 'abc1234' })).rejects.toThrow(/failed the scrubber/);
  });
});
