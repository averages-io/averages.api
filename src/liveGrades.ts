// Live grades. While a signed-in page is open and on screen, the app asks GET /data/grades every few minutes.

import { adaptCourses } from "./adapt.ts";

export const LIVE_EVERY_S = 300;
export const LIVE_EVERY_PLUS_S = 120;

/** Only the fields a grade change can touch; names, colors and codes stay the bundle's. */
export interface LiveCourse {
  id: string;
  grade: string;
  pct: number;
  predicted: string;
  predictedPct: number;
  trend: "up" | "down" | "flat";
  updated: string;
}

/**
 * Each class's grade from the grades payload alone. adaptCourses wants the
 * section list too, but only for names and periods; the grade math reads
 * the grades entry, so the entries stand in for their own sections here.
 * A class with no grades entry isn't listed, which the app reads as "no
 * change" (never as "the grade went away").
 */
export function liveCourses(grades: unknown[]): LiveCourse[] {
  const list = Array.isArray(grades) ? grades : [];
  const sections = list
    .map((g: any) => ({ id: String(g?.section_id ?? g?.id ?? "") }))
    .filter((s) => s.id);
  const { COURSES } = adaptCourses(sections, list as any[]);
  return COURSES.map((c) => ({
    id: c.id,
    grade: c.grade,
    pct: c.pct,
    predicted: c.predicted,
    predictedPct: c.predictedPct,
    trend: c.trend,
    updated: c.updated,
  }));
}

export function liveEvery(plus: boolean): number {
  return plus ? LIVE_EVERY_PLUS_S : LIVE_EVERY_S;
}
