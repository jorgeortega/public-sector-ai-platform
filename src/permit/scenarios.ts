import type { ScenarioId, Tenant } from '../events/events';
import type { Faults, RunInput } from '../sdk/types.ts';

// The nine scenarios: which runs each starts, when, and with which faults.
// Faults come only from this table (spec E7). Run ids match the site's
// fixtures, so a recorded replay and its fixture line up.

export type PlannedRun = { input: RunInput; faults: Faults; acceptAt: number; kind: 'permit' | 'renewal' };

const permitRun = (scenario: ScenarioId, run: string, tenant: Tenant, application: string, faults: Faults = {}, acceptAt = 0): PlannedRun => ({
  input: { run: `run_${run}`, tenant, scenario, application },
  faults,
  acceptAt,
  kind: 'permit',
});

const renewals = (tenant: Tenant, count: number, firstAt: number, spacing: number): PlannedRun[] => {
  const city = tenant === 'port-alder' ? 'pa' : 'kb';
  return Array.from({ length: count }, (_, i) => {
    const id = String(i + 1).padStart(4, '0');
    return { input: { run: `run_${city}renewal${id}`, tenant, scenario: 'burst' as const, application: `${city}-renewal-${id}` }, faults: {}, acceptAt: firstAt + i * spacing, kind: 'renewal' as const };
  });
};

export const SCENARIO_RUNS: Record<ScenarioId, () => PlannedRun[]> = {
  happy: () => [permitRun('happy', 'pa0141happy', 'port-alder', 'pa-bakery-0141')],
  crash: () => [permitRun('crash', 'pa0187crash', 'port-alder', 'pa-foodtruck-0187', { crashIn: 'eligibility', approval: { decision: 'approve', waitMs: 7000 } })],
  'flaky-registry': () => [
    permitRun('flaky-registry', 'pa0203flaky', 'port-alder', 'pa-salon-0203', { registryFailures: 3, approval: { decision: 'approve', waitMs: 5000 } }),
    permitRun('flaky-registry', 'kb0091flaky', 'kestrel-bay', 'kb-cafe-0091', { registryFailures: 'always' }, 2500),
  ],
  duplicate: () => [permitRun('duplicate', 'kb0032dupe', 'kestrel-bay', 'kb-hardware-0032', { duplicate: true, approval: { decision: 'approve', waitMs: 6000 } })],
  approval: () => [permitRun('approval', 'pa0412approval', 'port-alder', 'pa-bakery-0412', { approval: { decision: 'reject', waitMs: 42_000 } })],
  burst: () => [...renewals('port-alder', 50, 0, 2), ...renewals('kestrel-bay', 3, 401, 1)],
  'poisoned-doc': () => [permitRun('poisoned-doc', 'kb0077poison', 'kestrel-bay', 'kb-cafe-0077', { approval: { decision: 'approve', waitMs: 6000 } })],
  budget: () => [permitRun('budget', 'pa0350budget', 'port-alder', 'pa-catering-0350', { loopEligibility: true, runBudgetUsd: 0.0005 })],
  'provider-down': () => [permitRun('provider-down', 'kb0144fallback', 'kestrel-bay', 'kb-cafe-0144', { primaryDown: true, approval: { decision: 'approve', waitMs: 6000 } })],
};

// Each city's queue runs this many at once (trigger.dev: concurrency perKey).
export const PER_CITY = 5;
