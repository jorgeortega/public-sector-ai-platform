import { DurableObject } from 'cloudflare:workers';
import { isForwarded } from '../src/gateway/config.ts';

// The LLM gateway's Worker: one Durable Object, `Gateway`, owns one container
// running the LiteLLM proxy (gateway/Dockerfile). It starts the container on
// the first request, waits until LiteLLM answers its health check, forwards
// the request, and lets the container sleep after two minutes idle, so it
// costs nothing between runs. Only the OpenAI and admin routes the engine
// uses are forwarded; everything else is a 404 here, before LiteLLM sees it.
// Pattern: developers.cloudflare.com/containers/get-started (2026-11-09).

export interface Env {
  GATEWAY: DurableObjectNamespace<Gateway>;
  LITELLM_MASTER_KEY: string;
  DATABASE_URL: string;
  ANTHROPIC_API_KEY: string;
  CLOUDFLARE_AI_TOKEN: string;
  WORKERS_AI_BASE_URL: string;
}

const PORT = 4000;
const SLEEP_AFTER_MS = 2 * 60 * 1000;
const HEALTH = 'http://container/health/liveliness';
// LiteLLM checks its database schema on start. Measured on 2026-11-13: a
// cold start answers in about 60 s (the very first one, which migrated the
// tables, took about three minutes). Give it up to two minutes.
const READY_TRIES = 240;
const READY_WAIT_MS = 500;

type Container = NonNullable<DurableObjectState['container']>;

export class Gateway extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(SLEEP_AFTER_MS));
  }

  override async fetch(request: Request): Promise<Response> {
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.container().getTcpPort(PORT).fetch(forwarded);
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('This Durable Object has no container: check wrangler.jsonc');
    return container;
  }

  private async start(): Promise<void> {
    const container = this.container();
    if (!container.running) {
      const env = this.env;
      container.start({
        image: container.images.base,
        instance: 'basic',
        enableInternet: true,
        env: {
          LITELLM_MASTER_KEY: env.LITELLM_MASTER_KEY,
          DATABASE_URL: env.DATABASE_URL,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
          CLOUDFLARE_AI_TOKEN: env.CLOUDFLARE_AI_TOKEN,
          WORKERS_AI_BASE_URL: env.WORKERS_AI_BASE_URL,
        },
      });
    }
    await container.setInactivityTimeout(SLEEP_AFTER_MS);
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < READY_TRIES; attempt++) {
      try {
        const response = await port.fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await scheduler.wait(READY_WAIT_MS);
    }
    throw new Error(`LiteLLM did not become ready on port ${PORT}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!isForwarded(pathname)) return Response.json({ error: { message: 'Not found', type: 'not_found' } }, { status: 404 });
    return env.GATEWAY.getByName('gateway').fetch(request);
  },
} satisfies ExportedHandler<Env>;
