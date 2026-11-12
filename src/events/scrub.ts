import { EVENT_TYPES, RunEventSchema, type RunEvent } from './events';

// What may leave the engine, and again what the live route relays: the
// strict events of events.ts, with every string redacted and cut to its cap.
// Spec docs/superpowers/specs/2026-11-12-ai-platform-run-events.md, "Shared
// with the engine".
//
// Shared with the engine repo (public-sector-ai-platform) as a copy, kept
// equal by SCHEMA_HASH in events.ts, so it imports nothing but events.ts. The
// patterns repeat app/_lib/observability/scrub.ts's `redact` and add the
// keys this lab's engine holds: Anthropic and LiteLLM (`sk-`), LangSmith
// (`lsv2_`) and trigger.dev (`tr_`).

// Our own prefixes (l10_, l10m_ …), Stripe's, then the providers'.
const TOKEN = /\b(l10[a-z]?_|sk_(?:live|test)_|rk_|whsec_|sk-ant-|sk-|lsv2_|tr_)[A-Za-z0-9_-]+/g;
const BEARER = /\bBearer\s+\S+/gi;
const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const redact = (text: string): string =>
  text
    .replace(URL_QUERY, '$1')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(TOKEN, '$1[redacted]')
    .replace(EMAIL, '[email]')
    .replace(IPV4, '[ip]');

// The caps of events.ts's free text, by field name.
const CAPS: Record<string, number> = { summary: 200, object: 80, msg: 200, text: 1200, title: 80 };

const cut = (text: string, cap: number) => (text.length <= cap ? text : `${text.slice(0, cap - 1)}…`);

const CHUNK_KEYS = ['id', 'title', 'score', 'quarantined'];

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

const clean = (value: unknown, key: string): unknown => {
  if (typeof value !== 'string') return value;
  const text = redact(value);
  const cap = CAPS[key];
  return cap === undefined ? text : cut(text, cap);
};

// Keeps only the keys the type's schema names (and a chunk's four), redacts
// and cuts every string, then parses strictly. Returns null when the event
// can't be made valid: an unknown type, an id outside its list, a secret in a
// field that has a pattern.
export function scrubEvent(input: unknown): RunEvent | null {
  if (!isRecord(input) || typeof input.type !== 'string') return null;
  const option = RunEventSchema.optionsMap.get(input.type);
  if (!option) return null;
  const kept: Raw = {};
  for (const key of Object.keys(option.shape)) {
    if (!(key in input)) continue;
    const value = input[key];
    kept[key] =
      key === 'chunks' && Array.isArray(value)
        ? value.map((chunk) =>
            isRecord(chunk) ? Object.fromEntries(CHUNK_KEYS.filter((k) => k in chunk).map((k) => [k, clean(chunk[k], k)])) : chunk,
          )
        : key === 'citations' && Array.isArray(value)
          ? value.map((citation) => clean(citation, key))
          : clean(value, key);
  }
  const parsed = RunEventSchema.safeParse(kept);
  return parsed.success ? (parsed.data as RunEvent) : null;
}

const EnvelopeOnly = RunEventSchema.optionsMap.get('log')!.pick({ v: true, seq: true, at: true, run: true, tenant: true }).strip();

// Scrubs a list. An event that has to be dropped becomes a `log` warning in
// the same place (same seq, time, run and tenant), so a replay keeps its
// order and says something was removed. When even its envelope is broken,
// it's lost. Either way it's counted.
export function scrubEvents(inputs: readonly unknown[]): { events: RunEvent[]; dropped: number } {
  const events: RunEvent[] = [];
  let dropped = 0;
  for (const input of inputs) {
    const event = scrubEvent(input);
    if (event) {
      events.push(event);
      continue;
    }
    dropped += 1;
    const envelope = isRecord(input) ? EnvelopeOnly.safeParse(input) : null;
    if (!envelope?.success) continue;
    const type = isRecord(input) && (EVENT_TYPES as readonly unknown[]).includes(input.type) ? (input.type as string) : null;
    events.push({
      ...envelope.data,
      type: 'log',
      level: 'warn',
      msg: type ? `The scrubber dropped a ${type} event.` : 'The scrubber dropped an event of an unknown type.',
    } as RunEvent);
  }
  return { events, dropped };
}
