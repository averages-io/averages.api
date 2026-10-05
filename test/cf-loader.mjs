/**
 * Lets Node run src/index.ts for the route tests (test/google.test.ts).
 *
 * The Worker imports `cloudflare:workers` (for the Durable Object base class),
 * which only exists inside Cloudflare's runtime. This hook answers that one
 * import with a tiny stand-in; everything else resolves normally. Test-only:
 * nothing in src/ uses it.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/google.test.ts
 */
import { register } from "node:module";

const hooks = `
export async function resolve(specifier, context, next) {
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
