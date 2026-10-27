/**
 * Live grades (2026-10-27, Martin: "can it be the refresh animation that we
 * already made that's on the landing page, the scrolling numbers").
 *
 * While a signed-in page is open and on screen, the app asks GET /data/grades
 * every few minutes. When a class's grade moved, the number rolls to the new
 * one like the landing page's tiles (public/js/averages-live.js).
 *
 * Kept as light as a check can be: ONE Schoology call (/users/{uid}/grades),
 * none of the bundle's sections, assignments or inbox. Every check uses the
 * student's own Schoology access, and Schoology's rate limit is unpublished
 * and shared by a whole school, so a check that runs this often has to be
 * cheap. The app only asks for the full bundle when something changed.
 *
 * How often: the API decides and says so in `next` (seconds). 5 minutes, or
 * 2 minutes with Averages Plus. While billing is off every Plus perk is free,
 * so everyone gets 2 minutes then. Off with the `live-grades` switch.
 */

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
