/**
 * The schools the sign-in page lists (2026-10-06), served by
 * GET /config/schools?lms=schoology.
 *
 * Schoology: districts added over time, to make finding them easier; a
 * student can always type their district's Schoology address instead,
 * listed or not.
 *
 * The list starts empty. Add a school as { name, domain, aliases? }, where
 * `domain` is the address the school's Schoology lives at and `aliases`
 * are other addresses it also answers on.
 */
export interface School {
  name: string;
  domain: string;
  aliases?: string[];
}

export const SCHOOLS: Readonly<Record<"schoology", readonly School[]>> = {
  schoology: [],
};

export function schoolsFor(lms: unknown): readonly School[] | null {
  return lms === "schoology" ? SCHOOLS["schoology"] : null;
}
