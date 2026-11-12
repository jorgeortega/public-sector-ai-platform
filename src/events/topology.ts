// The platform's boxes and the lines between them: one list, read by the
// reducer (replay.ts) and by the diagram. Spec
// docs/superpowers/specs/2026-11-12-ai-platform-run-events.md, "The topology".
//
// Shared with the engine repo (public-sector-ai-platform) as a copy, kept
// equal by SCHEMA_HASH in events.ts. Events never name an edge: the reducer
// looks it up from the event's type, so the engine can't draw a line that
// isn't here.

export const NODES = [
  { id: 'client', label: 'Permit office app', backedBy: 'The visitor’s controls' },
  { id: 'api', label: 'Platform API', backedBy: 'The site route that answers 202' },
  { id: 'queue', label: 'Tenant queues', backedBy: 'trigger.dev queues with concurrency keys' },
  { id: 'worker', label: 'Workers', backedBy: 'trigger.dev runs' },
  { id: 'state', label: 'Run state', backedBy: 'trigger.dev checkpoints and our idempotency keys' },
  { id: 'rag', label: 'Code search', backedBy: 'An in-memory hybrid index (BM25 and vectors)' },
  { id: 'llm-gateway', label: 'LLM gateway', backedBy: 'The LiteLLM proxy' },
  { id: 'models', label: 'Models', backedBy: 'Claude Haiku 5.5, with gpt-oss-120b as its fallback' },
  { id: 'registry', label: 'State business registry', backedBy: 'A fictional outside API that fails on purpose' },
  { id: 'approval', label: 'Human approval', backedBy: 'A trigger.dev waitpoint' },
  { id: 'dlq', label: 'Dead letter', backedBy: 'Failed runs waiting for a person' },
  { id: 'reports', label: 'Decision reports', backedBy: 'The final report of each run' },
  { id: 'audit', label: 'Audit log', backedBy: 'Every audited event, append-only' },
] as const;

export type NodeId = (typeof NODES)[number]['id'];

const edge = <F extends NodeId, T extends NodeId>(from: F, to: T) => ({ id: `${from}->${to}` as const, from, to });

export const EDGES = [
  edge('client', 'api'),
  edge('api', 'queue'),
  edge('queue', 'worker'),
  edge('worker', 'state'),
  edge('worker', 'rag'),
  edge('worker', 'llm-gateway'),
  edge('llm-gateway', 'models'),
  edge('worker', 'registry'),
  edge('worker', 'approval'),
  edge('client', 'approval'),
  edge('worker', 'dlq'),
  edge('worker', 'reports'),
] as const;

export type EdgeId = (typeof EDGES)[number]['id'];
