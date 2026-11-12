import { describe, expect, it } from 'vitest';
import { SCENARIOS, type ReplayFile, type RunEvent, type ScenarioId, type StepId } from '../src/events/events.ts';
import { scrubEvent } from '../src/events/scrub.ts';
import { APPLICATIONS } from '../src/permit/applications.ts';
import { problemsTs, validateFields } from '../src/permit/validate.ts';
import { runScenario } from '../src/runtime/memory.ts';
import { parseJson } from '../src/sdk/context.ts';
import { RecommendationSchema } from '../src/permit/prompts.ts';

// Every scenario, run by the real workflow in the in-memory runtime (the fake
// model, the real search over a hash-256 index), checked against the same
// golden facts as the site's fixtures.

const runs = new Map<ScenarioId, Promise<ReplayFile>>();
const run = (scenario: ScenarioId) => {
  if (!runs.has(scenario)) runs.set(scenario, runScenario(scenario));
  return runs.get(scenario)!;
};
const of = <T extends RunEvent['type']>(events: RunEvent[], type: T) => events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
const completed = (events: RunEvent[], runId: string) => of(events, 'step.completed').filter((e) => e.run === runId).map((e) => e.step);
const lastState = (events: RunEvent[], runId: string) => of(events, 'run.state').filter((e) => e.run === runId).at(-1)?.to;
const PERMIT_STEPS: StepId[] = ['intake', 'extract', 'retrieve', 'eligibility', 'registry', 'recommend', 'report'];

describe.each(SCENARIOS)('scenario %s', (scenario) => {
  it('makes a valid replay (the site’s parser) whose events pass the scrubber unchanged', async () => {
    const file = await run(scenario);
    expect(file.scenario).toBe(scenario);
    expect(file.events.length).toBeGreaterThan(10);
    for (const event of file.events) expect(scrubEvent(event)).toEqual(event);
    expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThan(150 * 1024);
  });
});

describe('golden facts', () => {
  it('happy: every step once, approved, and the report cites only unquarantined sections it found', async () => {
    const { events } = await run('happy');
    expect(completed(events, 'run_pa0141happy')).toEqual(PERMIT_STEPS);
    expect(lastState(events, 'run_pa0141happy')).toBe('completed');
    const [report] = of(events, 'report.written');
    expect(report?.decision).toBe('approve');
    const found = new Set(of(events, 'rag.results').flatMap((e) => e.chunks.filter((c) => !c.quarantined).map((c) => c.id)));
    expect(report!.citations.length).toBeGreaterThan(0);
    for (const id of report!.citations) expect(found.has(id)).toBe(true);
    expect(of(events, 'llm.response').map((e) => e.step)).toEqual(['extract', 'eligibility', 'recommend']);
  });

  it('crash: resumes on w7 from the checkpoint, skips three steps, and completes each step once', async () => {
    const { events } = await run('crash');
    const runId = 'run_pa0187crash';
    expect(of(events, 'worker.crashed')).toHaveLength(1);
    expect(of(events, 'worker.resumed')[0]).toMatchObject({ worker: 'w7', fromStep: 'eligibility' });
    expect(of(events, 'step.skipped').map((e) => [e.step, e.why])).toEqual([
      ['intake', 'checkpoint'],
      ['extract', 'checkpoint'],
      ['retrieve', 'checkpoint'],
    ]);
    expect(completed(events, runId)).toEqual(PERMIT_STEPS);
    expect(of(events, 'step.started').filter((e) => e.step === 'eligibility').map((e) => e.attempt)).toEqual([1, 2]);
    expect(lastState(events, runId)).toBe('completed');
  });

  it('duplicate: the second delivery is refused by the idempotency key, and nothing happens twice', async () => {
    const { events } = await run('duplicate');
    expect(of(events, 'step.skipped')).toEqual([expect.objectContaining({ step: 'intake', why: 'idempotent' })]);
    expect(of(events, 'audit.entry').filter((e) => e.action === 'duplicate.ignored')).toHaveLength(1);
    expect(completed(events, 'run_kb0032dupe')).toEqual(PERMIT_STEPS);
    expect(of(events, 'report.written')).toHaveLength(1);
  });

  it('flaky-registry: 1 s, 2 s, 4 s and recovery for one run; dead letter for the other', async () => {
    const { events } = await run('flaky-registry');
    const failed = of(events, 'step.failed').filter((e) => e.run === 'run_pa0203flaky');
    expect(failed.map((e) => [e.attempt, e.retryInMs])).toEqual([
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ]);
    expect(lastState(events, 'run_pa0203flaky')).toBe('completed');
    expect(of(events, 'dlq.sent')).toEqual([expect.objectContaining({ run: 'run_kb0091flaky', step: 'registry', code: 'http_503' })]);
    expect(lastState(events, 'run_kb0091flaky')).toBe('failed');
    expect(of(events, 'http.call').filter((e) => e.run === 'run_kb0091flaky')).toHaveLength(4);
  });

  it('provider-down: every call is served by the fallback, priced as gpt-oss-120b', async () => {
    const { events } = await run('provider-down');
    const responses = of(events, 'llm.response');
    expect(responses.length).toBe(3);
    for (const response of responses) expect(response).toMatchObject({ model: 'gpt-oss-120b', fallbackFrom: 'claude-haiku-5-5' });
    expect(lastState(events, 'run_kb0144fallback')).toBe('completed');
  });

  it('approval: parks 42 s, the reviewer rejects, and no report is written', async () => {
    const { events } = await run('approval');
    const requested = of(events, 'approval.requested')[0]!;
    const decided = of(events, 'approval.decided')[0]!;
    expect(decided).toMatchObject({ decision: 'reject', by: 'visitor' });
    expect(decided.at - requested.at).toBe(42_000);
    expect(lastState(events, 'run_pa0412approval')).toBe('rejected');
    expect(of(events, 'report.written')).toEqual([]);
  });

  it('burst: Port Alder’s queue reaches 50 while Kestrel Bay’s never passes 3, five Port Alder jobs at once, all 53 done', async () => {
    const { events } = await run('burst');
    const depth = (tenant: string) => Math.max(...of(events, 'queue.enqueued').filter((e) => e.tenant === tenant).map((e) => e.depth));
    expect(depth('port-alder')).toBe(50);
    expect(depth('kestrel-bay')).toBeLessThanOrEqual(3);
    let running = 0;
    let most = 0;
    for (const event of events) {
      if (event.type !== 'run.state' || event.tenant !== 'port-alder') continue;
      if (event.to === 'running') running += 1;
      if (event.to === 'completed') running -= 1;
      most = Math.max(most, running);
    }
    expect(most).toBe(5);
    expect(of(events, 'run.state').filter((e) => e.to === 'completed')).toHaveLength(53);
  });

  it('poisoned-doc: the note is quarantined, never cited, and the café is referred for its seats', async () => {
    const { events } = await run('poisoned-doc');
    const chunks = of(events, 'rag.results').flatMap((e) => e.chunks);
    expect(chunks.find((c) => c.id === 'kbc-note-0017')).toMatchObject({ quarantined: true });
    const [report] = of(events, 'report.written');
    expect(report?.citations).not.toContain('kbc-note-0017');
    expect(report?.decision).toBe('refer');
  });

  it('budget: the loop runs until the gateway refuses on the run’s budget', async () => {
    const { events } = await run('budget');
    expect(of(events, 'llm.refused')).toEqual([expect.objectContaining({ step: 'eligibility', why: 'budget' })]);
    expect(lastState(events, 'run_pa0350budget')).toBe('budget_exceeded');
    const updates = of(events, 'budget.update');
    expect(updates.at(-1)!.spentUsd).toBeGreaterThanOrEqual(0.0005);
    expect(updates.at(-1)!.steps).toBeLessThan(12);
  });
});

describe('the field check', () => {
  const samples = [{ business: 'Sunrise Bakery', zone: 'C-2', staff: 4 }, { business: '', zone: 'downtown', staff: -1, outdoorSeats: true }, ...APPLICATIONS.map(({ id: _id, tenant: _tenant, ...fields }) => fields)];

  it('gives the same answer in Python and in TypeScript', () => {
    for (const fields of samples) {
      const python = validateFields(fields);
      expect(python.via).toBe('python');
      expect(python.problems).toEqual(problemsTs(fields));
    }
  });

  it('falls back to TypeScript when python3 isn’t there', () => {
    expect(validateFields({ business: 'X', zone: 'C-2', staff: 1 }, 'no-such-python')).toEqual({ problems: [], via: 'typescript' });
  });
});

describe('reading the model’s answer', () => {
  it('takes the JSON object out of a reply, and says why when it doesn’t fit', () => {
    expect(parseJson('Here you go: {"decision":"approve","citations":["pac-1.04.020"],"summary":"Ok."} Thanks.', RecommendationSchema)).toMatchObject({ ok: true });
    expect(parseJson('no json here', RecommendationSchema)).toEqual({ ok: false, problem: 'no JSON object' });
    expect(parseJson('{"decision":"maybe","citations":[],"summary":""}', RecommendationSchema)).toMatchObject({ ok: false });
    expect(parseJson('{"decision": approve}', RecommendationSchema)).toMatchObject({ ok: false });
  });
});
