/**
 * Lets Node run src/index.ts for the route tests (test/google.test.ts).
 *
 * The Worker imports `cloudflare:workers` (for the Durable Object base class)
 * and `cloudflare:email` (EmailMessage, 2026-10-06), which only exist inside
 * Cloudflare's runtime. This hook answers those imports with tiny stand-ins; everything else resolves normally. Test-only:
 * nothing in src/ uses it.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/google.test.ts
 */
import { register } from "node:module";

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:email") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }"),
    };
  }
  if (specifier === "@cloudflare/containers") {
    // The real package only runs inside Cloudflare (and its files don't load in Node): a stand-in
    // whose getRandom hands back the binding's own stub, so tests can fake the container.
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export async function getRandom(ns, n) { return ns.get(ns.idFromName('converter-0')); } export function getContainer(ns, name) { return ns.get(ns.idFromName(name || 'cf-singleton-container')); }"),
    };
  }
  if (specifier === "cloudflare:workers") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"),
    };
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));
