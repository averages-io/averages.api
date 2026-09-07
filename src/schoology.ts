/**
 * Thin typed client for the Schoology REST API v1.
 *
 * Every call here is signed server-side (see oauth.ts). Nothing in this file
 * should ever be reachable from the browser without going through a route in
 * index.ts that has already resolved a valid session.
 */

import { buildAuthHeader, type Credentials } from "./oauth.ts";

export const SCHOOLOGY_BASE = "https://api.schoology.com/v1";

export class SchoologyError extends Error {
  // Declared as plain fields rather than TS parameter properties so this file
  // stays runnable under Node's type-stripping (which only removes types and
  // can't emit the assignments parameter properties imply). That's what lets
  // the test suite import this module directly, with no build step.
  status: number;
  body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "SchoologyError";
    this.status = status;
    this.body = body;
  }
}

export async function schoologyGet<T = unknown>(
  path: string,
  creds: Credentials,
  query: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(
    `${SCHOOLOGY_BASE}${path.startsWith("/") ? path : `/${path}`}`
  );
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const auth = await buildAuthHeader("GET", url.toString(), creds);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SchoologyError(
      `Schoology returned ${response.status} for ${path}`,
      response.status,
      body.slice(0, 500)
    );
  }

  return (await response.json()) as T;
}

/**
 * Schoology wraps list responses in a singular-noun key
 * (`{"section": [...]}`, `{"assignment": [...]}`), and returns a bare object
 * rather than an array when there's exactly one result. This normalizes both
 * into a plain array so callers never have to special-case either.
 */
export function listOf<T = Record<string, unknown>>(
  payload: unknown,
  key: string
): T[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

export interface SchoologyUser {
  uid?: string | number;
  id?: string | number;
  name_display?: string;
  name_first?: string;
  name_last?: string;
  primary_email?: string;
  picture_url?: string;
}

export async function getMe(creds: Credentials): Promise<SchoologyUser> {
  return schoologyGet<SchoologyUser>("/users/me", creds);
}

export async function getSections(uid: string, creds: Credentials) {
  const payload = await schoologyGet(`/users/${uid}/sections`, creds);
  return listOf(payload, "section");
}

export async function getGrades(
  uid: string,
  creds: Credentials,
  sectionId?: string
) {
  const payload = await schoologyGet(`/users/${uid}/grades`, creds, {
    section_id: sectionId,
  });
  return listOf(payload, "section");
}

export async function getAssignments(sectionId: string, creds: Credentials) {
  const payload = await schoologyGet(`/sections/${sectionId}/assignments`, creds, {
    limit: 200,
  });
  return listOf(payload, "assignment");
}

export async function getMessages(
  folder: "inbox" | "sent",
  creds: Credentials
) {
  const payload = await schoologyGet(`/messages/${folder}`, creds);
  return listOf(payload, "message");
}
