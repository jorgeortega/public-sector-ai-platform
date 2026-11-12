import type { Faults, RunInput } from '../sdk/types.ts';

// The state business registry: fictional, in process, with real latency and a
// failure plan per scenario (spec E8). A failing call times out after 3 s
// with a 503.
export function registryCall(faults: Faults) {
  return async (_input: RunInput, attempt: number): Promise<{ status: number; ms: number }> => {
    const failures = faults.registryFailures;
    if (failures === 'always' || (typeof failures === 'number' && attempt <= failures)) return { status: 503, ms: 3000 };
    return { status: 200, ms: 41 };
  };
}
