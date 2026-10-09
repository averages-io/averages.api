/**
 * Flagship switches (2026-10-08): src/flags.ts and the Worker's use of it.
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/flags.test.ts
 */
import worker from "../src/index.ts";
import { withFlags, FLAG_VARS } from "../src/flags.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const pick = (e: any) => Object.values(FLAG_VARS).map((k) => e[k]);

const base = { CANVA_EXPORT_ENABLED: "1", CANVA_FOLDERS_ENABLED: "0", SCHOOLS_VERIFY_EMAIL: "1", OTHER: "x" };
check("no FLAGS binding: env itself", (await withFlags(base)) === base, true);

const asked: [string, boolean][] = [];
const flags = (answers: Record<string, any>) => ({ getBooleanValue: async (k: string, d: boolean) => { asked.push([k, d]); if (answers[k] instanceof Error) throw answers[k]; return k in answers ? answers[k] : d; } });
let e: any = await withFlags({ ...base, FLAGS: flags({ "canva-folders": true, "schools-verify-email": false }) });
check("Flagship answers replace the vars", pick(e), ["1", "1", "0"]);
check("defaults passed are the vars", asked.map(([k, d]) => `${k}=${d}`).sort(), ["canva-export=true", "canva-folders=false", "schools-verify-email=true"]);
check("other env kept, bindings kept", [e.OTHER, typeof e.FLAGS.getBooleanValue], ["x", "function"]);
e = await withFlags({ ...base, FLAGS: flags({ "canva-export": new Error("down") }) });
check("an error: the var", pick(e), ["1", "0", "1"]);
e = await withFlags({ ...base, FLAGS: { getBooleanValue: () => new Promise<boolean>(() => {}) } }, 30);
check("too slow: the vars", pick(e), ["1", "0", "1"]);
e = await withFlags({ ...base, FLAGS: { getBooleanValue: async () => "yes" as any } });
check("not a boolean: the var", pick(e), ["1", "0", "1"]);

// Through the Worker: the school form's verify switch flipped by Flagship.
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const ENV: any = { SESSION_SECRET: "x", SCHOOLS: {}, SCHOOLS_MAIL: { send: async () => ({}) }, SCHOOLS_VERIFY_EMAIL: "0" };
const cfg = async (env: any) => (await (await worker.fetch(new Request("https://api.averages.io/config/apply"), env, CTX)).json() as any).verifyEmail;
check("worker: var off, no Flagship → off", await cfg(ENV), false);
check("worker: Flagship turns it on", await cfg({ ...ENV, FLAGS: flags({ "schools-verify-email": true }) }), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
