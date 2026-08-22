/**
 * Test-only Durable Object base. Production uses cloudflare:workers.
 *
 * This file runs with bun.
 */

export class DurableObject<Env = unknown> {
  public readonly ctx: unknown;
  public readonly env: Env;

  public constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
