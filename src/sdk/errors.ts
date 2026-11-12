import type { StepId } from '../events/events';

// What can stop a step, and so a run. The runtime turns each into the run's
// end state: crash → resume elsewhere; budget → budget_exceeded; a failed
// outside step → dead letter; anything else → failed.

type Code = 'timeout' | 'http_429' | 'http_500' | 'http_503' | 'worker_lost' | 'provider_down' | 'validation' | 'budget';

// Worth another try after a pause: timeouts, 429, 5xx.
export class RetryableError extends Error {
  readonly code: Code;
  constructor(code: Code, message: string) {
    super(message);
    this.name = 'RetryableError';
    this.code = code;
  }
}

// Not worth another try.
export class FatalError extends Error {
  readonly code: Code;
  constructor(code: Code, message: string) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
  }
}

// The worker died in the middle of a step (a fault the `crash` scenario injects).
export class WorkerCrash extends Error {
  readonly step: StepId;
  constructor(step: StepId) {
    super(`The worker crashed during ${step}.`);
    this.name = 'WorkerCrash';
    this.step = step;
  }
}

// The run's budget or step limit is spent.
export class BudgetStop extends Error {
  readonly why: 'budget' | 'step_limit';
  constructor(why: 'budget' | 'step_limit', message: string) {
    super(message);
    this.name = 'BudgetStop';
    this.why = why;
  }
}

// A step gave up. `outside` steps (an outside API) send the run to the
// dead-letter queue for a person.
export class StepFailed extends Error {
  readonly step: StepId;
  readonly code: Code;
  readonly outside: boolean;
  constructor(step: StepId, code: Code, outside: boolean, message: string) {
    super(message);
    this.name = 'StepFailed';
    this.step = step;
    this.code = code;
    this.outside = outside;
  }
}

export type ErrorCode = Code;
