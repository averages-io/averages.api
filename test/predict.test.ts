// The predicted grade (src/adapt.ts projectGrade, 2026-11-09).
import { projectGrade } from "../src/adapt.ts";

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(want)}\n        actual:   ${JSON.stringify(got)}`);
}
const T0 = 1790000000;
type R = [number, number, string?];   // earned, possible, category
const entry = (rows: R[], cats?: { id: string; weight: number }[], reported?: number) => ({
  final_grade: [{ period_id: "p1", grade: reported ?? null }],
  grading_category: cats ?? [],
  period: [{ period_id: "p1", assignment: rows.map(([e, p, c], i) => ({ assignment_id: String(100 + i), grade: e, max_points: p, category_id: c ?? "", timestamp: T0 + i * 86400 })) }],
});
const run = (rows: R[], cats?: { id: string; weight: number }[], reported?: number) => projectGrade({ gradeEntry: entry(rows, cats, reported), assignments: undefined, reportedPct: reported ?? null });

console.log("basics");
check("fewer than 3 scores: none", run([[9, 10], [8, 10]]), null);
check("steady 90s: stays 90, flat", run([[9, 10], [18, 20], [45, 50], [90, 100]], undefined, 90), { predictedPct: 90, trend: "flat" });
{
  const up = run([[6, 10], [6, 10], [7, 10], [9, 10], [10, 10], [10, 10]], undefined, 80)!;
  check("getting better: predicted above the grade", [up.trend, up.predictedPct > 80], ["up", true]);
  const down = run([[10, 10], [10, 10], [9, 10], [7, 10], [6, 10], [5, 10]], undefined, 78)!;
  check("slipping: predicted below the grade", [down.trend, down.predictedPct < 78], ["down", true]);
}
{
  // a 5-point quiz zero barely matters next to 100-point tests; as equal percentages it looked like a collapse
  const r = run([[95, 100], [92, 100], [94, 100], [0, 5]], undefined, 89)!;
  check("one small zero doesn't sink it", r.predictedPct >= 88, true);
}
console.log("\ncategories and weights");
{
  const cats = [{ id: "hw", weight: 30 }, { id: "test", weight: 70 }];
  // homework always perfect, tests sliding: the 70% category drives it down
  const r = run([[10, 10, "hw"], [80, 100, "test"], [10, 10, "hw"], [72, 100, "test"], [10, 10, "hw"], [64, 100, "test"]], cats, 81)!;
  check("weighted: sliding tests pull it down", [r.trend, r.predictedPct < 81], ["down", true]);
  // a category with weight 0 (not counted by the class) doesn't move it
  const z = run([[9, 10, "hw"], [9, 10, "hw"], [9, 10, "hw"], [0, 100, "extra"]], [{ id: "hw", weight: 100 }, { id: "extra", weight: 0 }], 90)!;
  check("work in an unweighted category doesn't count", z.predictedPct, 90);
}
console.log("\nanchored to Schoology's grade");
{
  // Schoology says 93 (maybe a dropped score we can't see); steady work: the prediction keeps 93, not our 90
  const r = run([[9, 10], [9, 10], [9, 10], [9, 10]], undefined, 93)!;
  check("keeps Schoology's number when nothing's changing", r, { predictedPct: 93, trend: "flat" });
  const n = run([[9, 10], [9, 10], [9, 10]])!;
  check("no reported grade: its own", n.predictedPct, 90);
}
console.log("\nlisted work still to come");
{
  const rows: R[] = [[4, 10], [5, 10], [5, 10], [10, 10], [10, 10], [10, 10], [10, 10], [10, 10], [10, 10], [10, 10]];
  const near = run(rows, undefined, 84)!;
  const far = projectGrade({ gradeEntry: entry(rows, undefined, 84), reportedPct: 84, assignments: [{ id: "900", max_points: 200 }] })!;
  check("lots of work left: more room to move", far.predictedPct > near.predictedPct, true);
  const gone = projectGrade({ gradeEntry: entry(rows, undefined, 84), reportedPct: 84, assignments: [{ id: "900", max_points: 200, count_in_grade: "0" }, { id: "901", max_points: 50, published: "0" }] })!;
  check("work that doesn't count or isn't out yet: ignored", gone.predictedPct, near.predictedPct);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
