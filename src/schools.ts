// The schools the sign-in page lists, served by GET /config/schools?lms=schoology.
export interface School {
  name: string;
  domain: string;
  aliases?: string[];
}

export const SCHOOLS: Readonly<Record<"schoology", readonly School[]>> = {
  schoology: [
    { name: "Schoology (app.schoology.com)", domain: "app.schoology.com", aliases: ["schoology.com", "www.schoology.com"] },
  ],
};

export function schoolsFor(lms: unknown): readonly School[] | null {
  return lms === "schoology" ? SCHOOLS["schoology"] : null;
}
