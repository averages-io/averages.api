// Checks before an email code is sent (src/emailCode.ts): throwaways, typos of big providers, domains that get mail.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/emailCheck.test.ts
import { addressProblem, clearDomainCache, domainTakesMail, typoFix } from "../src/emailCode.ts";

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(want)}\n        actual:   ${JSON.stringify(got)}`);
}
// a fake DNS-over-HTTPS resolver: name -> { MX, A } answer counts, or "nx" for a domain that doesn't exist
const dns = (table: Record<string, { MX?: number; A?: number } | "nx">) => async (url: string) => {
  const u = new URL(url), name = u.searchParams.get("name")!, type = u.searchParams.get("type")!;
  const row = table[name];
  if (row === "nx") return Response.json({ Status: 3 });
  const n = row ? (row as any)[type] ?? 0 : 0, code = type === "MX" ? 15 : type === "A" ? 1 : 28;
  return Response.json({ Status: 0, Answer: Array.from({ length: n }, () => ({ type: code })) });
};
const down = async () => { throw new Error("offline"); };

console.log("typos");
check("gmial.com", typoFix("sam@gmial.com"), "sam@gmail.com");
check("gmail.con", typoFix("sam@gmail.con"), "sam@gmail.com");
check("hotmial.com", typoFix("sam@hotmial.com"), "sam@hotmail.com");
check("gmail.com is fine", typoFix("sam@gmail.com"), null);
check("a school domain stays", typoFix("sam@students.lausd.net"), null);
check("me.co is not forced to me.com... unless one letter off", typoFix("sam@mw.com"), "sam@me.com");

console.log("\ndomains");
clearDomainCache();
check("MX: gets mail", await domainTakesMail("school.org", dns({ "school.org": { MX: 2 } }) as any), true);
check("no MX but an address: gets mail", await domainTakesMail("tiny.org", dns({ "tiny.org": { A: 1 } }) as any), true);
check("nothing at all: no mail", await domainTakesMail("nomail.org", dns({ "nomail.org": {} }) as any), false);
check("doesn't exist: no mail", await domainTakesMail("nope.example", dns({ "nope.example": "nx" }) as any), false);
check("resolver down: never blocks", await domainTakesMail("unknown.org", down as any), null);

console.log("\nbefore a code");
clearDomainCache();
const ok = dns({ "gmail.com": { MX: 5 }, "school.org": { MX: 1 }, "gmial.com": "nx" }) as any;
check("fine", await addressProblem("sam@school.org", { fetcher: ok }), null);
check("throwaway", await addressProblem("sam@mailinator.com", { fetcher: ok }), { error: "throwaway_email" });
check("throwaway subdomain", await addressProblem("sam@x.yopmail.com", { fetcher: ok }), { error: "throwaway_email" });
check("typo: suggests", await addressProblem("sam@gmial.com", { fetcher: ok }), { error: "email_typo", suggest: "sam@gmail.com" });
check("typo sent again on purpose: then the domain decides", await addressProblem("sam@gmial.com", { force: true, fetcher: ok }), { error: "email_domain" });
check("no mail domain", await addressProblem("sam@nope.example", { fetcher: dns({ "nope.example": "nx" }) as any }), { error: "email_domain" });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
