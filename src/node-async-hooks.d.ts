// The one piece of Node this Worker uses (nodejs_compat): src/timing.ts keeps each request's timings with it.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
