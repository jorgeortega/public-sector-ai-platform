// Stands in for the `cloudflare:workers` module in Node tests of gateway/worker.ts.
export class DurableObject<Env = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
