import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { context } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { redact } from '../events/scrub';

// Langfuse for the engine (spec docs/superpowers/specs/
// 2026-11-13-ai-platform-tracing.md in the Latitude 10 repo).
//
// - Its own TracerProvider, never the global one (Langfuse docs, "Isolated
//   TracerProvider"): trigger.dev runs its own OpenTelemetry, and neither
//   should see the other's spans. src/sdk/trace.ts names every parent
//   explicitly, so the shared context can't cross-link them.
// - Every input, output and metadata value goes through the scrubber's
//   `redact` (keys, bearer tokens, emails, IPs, query strings) before it
//   leaves. The data is fictional; this is for the day it isn't.
// - Spans go in batches, flushed at the end of each run and before the
//   approval wait (a task's process can be frozen there). Not `immediate`:
//   it sends each span as its own request, and the OTLP exporter drops what
//   is past 30 in flight, which a fast run passes.
//
// Off (returns undefined) without LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY,
// unless a test hands it an exporter. LANGFUSE_BASE_URL picks the region.

export type Tracing = { flush(): Promise<void>; shutdown(): Promise<void> };

let started: Tracing | undefined;

export function startLangfuse(options: { environment: string; release?: string; exporter?: SpanExporter }): Tracing | undefined {
  if (started) return started;
  if (!options.exporter && !(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)) return undefined;
  // Trace attributes (tags, session) reach child observations through the
  // context, which needs a context manager: trigger.dev has one; a script
  // or a test gets this one. A second registration is refused, not applied.
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();
  const processor = new LangfuseSpanProcessor({
    environment: options.environment,
    ...(options.release && { release: options.release }),
    ...(options.exporter && { exporter: options.exporter }),
    mask: ({ data }) => (typeof data === 'string' ? redact(data) : data),
  });
  const provider = new NodeTracerProvider({ resource: resourceFromAttributes({ 'service.name': 'permit-desk-engine' }), spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  started = {
    flush: () => processor.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      setLangfuseTracerProvider(null);
      started = undefined;
    },
  };
  return started;
}

// Langfuse environment names: lowercase, at most 40 characters, not
// starting with "langfuse".
export const environmentName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40);
