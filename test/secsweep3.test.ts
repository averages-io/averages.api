// Security pass, 2026-11-26: every API answer carries "this is data, not a page" headers, and the newest inputs
// (dates added from a school calendar, which end up in calendar apps) can't break out of where they go.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/secsweep3.test.ts
import app from "../src/index.ts";
import { sealSession, SESSION_COOKIE } from "../src/session.ts";
import { addedDatesFrom, buildIcs } from "../src/calendar.ts";
import { resetRateLimits } from "../src/rateLimit.ts";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, note = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? "\n        " + note : ""}`); }
}

const SECRET = "secsweep3-session-secret-0123456789abcdef";
const CTX = { waitUntil() {}, passThroughOnException() {} } as any;
const outside: string[] = [];
globalThis.fetch = (async (u: any) => { outside.push(String(u?.url ?? u)); return new Response("{}", { status: 599 }); }) as any;
const ENV: any = { SESSION_SECRET: SECRET };
async function call(method: string, path: string, cookie?: string) {
  resetRateLimits();
  const h: Record<string, string> = { Origin: "https://app.averages.io" };
  if (cookie) h.Cookie = cookie;
  return app.fetch(new Request("https://api.averages.io" + path, { method, headers: h }), ENV, CTX);
}

console.log("every answer is data, never a page");
{
  const cookie = `${SESSION_COOKIE}=${await sealSession({ key: "ck", secret: "cs", uid: "4242" } as any, SECRET)}`;
  const answers = [
    ["signed out", await call("GET", "/auth/me")],
    ["not found", await call("GET", "/no-such-page")],
    ["security.txt", await call("GET", "/.well-known/security.txt")],
    ["schools list", await call("GET", "/config/schools?lms=schoology")],
    ["signed in, Schoology down", await call("GET", "/data/bundle", cookie)],
    ["preflight", await app.fetch(new Request("https://api.averages.io/sync/settings", { method: "OPTIONS", headers: { Origin: "https://app.averages.io", "Access-Control-Request-Method": "PUT" } }), ENV, CTX)],
  ] as const;
  for (const [name, res] of answers.slice(0, 5)) {
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    ok(`${name} (${res.status}): nothing runs, nothing frames it, no referrer`,
      /default-src 'none'/.test(csp) && /sandbox/.test(csp) && /frame-ancestors 'none'/.test(csp)
        && res.headers.get("X-Frame-Options") === "DENY" && res.headers.get("Referrer-Policy") === "no-referrer"
        && res.headers.get("X-Content-Type-Options") === "nosniff", `csp=${csp}`);
  }
  // CORS still answers the app as before
  ok("the app's own requests still get their CORS answer", answers[5][1].headers.get("Access-Control-Allow-Origin") === "https://app.averages.io");
}

console.log("\nan answer's own policy is kept (files shown inline need the browser's viewers)");
{
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
  ok("the default only fills in what an answer didn't set", /if \(!h\.has\("Content-Security-Policy"\)\)/.test(src));
  ok("viewResponse sets its own (no sandbox, so PDFs and video still show)", /"Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'/.test(src));
}

console.log("\ndates added from a school calendar, in the calendar link");
{
  const now = Date.UTC(2026, 10, 26, 12);
  const raw = [
    { id: "a1", date: "2026-12-01", t: "Winter break\r\nBEGIN:VEVENT\r\nSUMMARY:injected", kind: "off", desc: "x\nEND:VCALENDAR" },
    { id: "a2;\r\nX", date: "2026-12-02", t: "Fine, really; ok", kind: "event" },
    { id: "a3", date: "2026-12-03\r\nX:1", t: "Bad date" },
    { id: "a4", date: "2026-12-04", t: "x".repeat(5000), desc: "y".repeat(5000) },
  ];
  const added = addedDatesFrom(raw, now);
  ok("a made-up date is dropped", !added.some((d) => d.title === "Bad date"));
  ok("an id keeps only letters, digits, - and _", added.every((d) => /^[A-Za-z0-9_-]+$/.test(d.id)));
  ok("titles and notes are cut short", added.every((d) => d.title.length <= 120 && d.note.length <= 300));
  const ics = buildIcs([], { now, tz: "America/Los_Angeles", added });
  const lines = ics.split("\r\n");
  ok("no line starts a new event or ends the calendar early", lines.filter((l) => l === "BEGIN:VEVENT").length === added.length && lines.filter((l) => l === "END:VCALENDAR").length === 1);
  ok("no injected property line", !lines.some((l) => /^(SUMMARY:injected|X:1)/.test(l)));
  ok("every line is folded to 75 bytes", lines.every((l) => new TextEncoder().encode(l).length <= 75));
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: "d" + i, date: "2026-12-05", t: "Day " + i }));
  ok("at most 300 dates", addedDatesFrom(many, now).length === 300);
}

console.log("\nnothing reached the network");
ok("no outside calls except Schoology's (answered 599 here)", outside.every((u) => new URL(u).hostname === "api.schoology.com"), outside.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
