import { parseReplay, type EventOf, type EventType, type ReplayFile, type RunEvent, type ScenarioId, type Tenant } from '../events/events';
import { scrubEvent } from '../events/scrub';
import type { Clock } from './types.ts';

// Every event leaves through here (spec E1): stamped with its run, city and
// time, scrubbed, and kept in a sink. A scenario's runs share one sink; its
// file orders their events by time and numbers them.

type Payload<T extends EventType> = Omit<EventOf<T>, 'v' | 'seq' | 'at' | 'run' | 'tenant' | 'type'>;
export type Actor = EventOf<'audit.entry'>['actor'];
type Pending = Omit<RunEvent, 'seq'>;

export class Sink {
  private readonly pending: Pending[] = [];

  push(event: Pending) {
    this.pending.push(event);
  }

  get size() {
    return this.pending.length;
  }

  events(): RunEvent[] {
    return this.pending
      .map((event, order) => ({ event, order }))
      .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
      .map(({ event: { v, ...rest } }, seq) => ({ v, seq, ...rest }) as RunEvent);
  }

  // A replay file, checked by the site's own parser.
  file(scenario: ScenarioId, source: ReplayFile['source'], extra: { recordedAt?: string; engineCommit?: string } = {}): ReplayFile {
    return parseReplay({ v: 1, scenario, source, ...extra, events: this.events() });
  }
}

export class Emitter {
  // When false, notes (audit entries, logs, budget updates) are left out:
  // only for bulk runs whose replay must stay small (the burst).
  notes = true;
  readonly run: string;
  readonly tenant: Tenant;
  private readonly sink: Sink;
  private readonly clock: Clock;

  constructor(sink: Sink, run: string, tenant: Tenant, clock: Clock) {
    this.sink = sink;
    this.run = run;
    this.tenant = tenant;
    this.clock = clock;
  }

  emit<T extends EventType>(type: T, payload: Payload<T>): void {
    if (!this.notes && (type === 'audit.entry' || type === 'log' || type === 'budget.update')) return;
    const event = scrubEvent({ v: 1, seq: 0, at: Math.round(this.clock.now()), run: this.run, tenant: this.tenant, type, ...payload });
    if (!event) throw new Error(`The engine built an invalid ${type} event.`);
    const { seq: _seq, ...pending } = event;
    this.sink.push(pending as Pending);
  }

  audit(action: EventOf<'audit.entry'>['action'], object: string, actor: Actor = 'system') {
    this.emit('audit.entry', { actor, action, object: object.slice(0, 80) });
  }

  log(level: EventOf<'log'>['level'], msg: string) {
    this.emit('log', { level, msg: msg.slice(0, 200) });
  }
}
