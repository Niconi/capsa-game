// Stand-in for the Workers runtime module so the Durable Object can be imported
// and driven by plain Node in the tests (see test/build.mjs).
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
