// The visibility policy files: what the app writes, what the core and the plugins read.
// No dependencies on purpose: this file is bundled into the core's dependency-free decision
// module, so every shape is checked by hand.

/** Where the app writes the policy files, inside the instance's data volume. */
export const VISIBILITY_DIR = "/kyoubeai/kyoube/visibility";
export const POLICY_VERSION = 1;

export type VisibilityMode = "open" | "need_to_know";

export function parseMode(value: unknown): VisibilityMode | null {
  return value === "open" || value === "need_to_know" ? value : null;
}

/** index.json: every company's mode, so a company that is open costs the core nothing. */
export interface VisibilityIndex {
  version: 1;
  writtenAt: string;
  companies: Record<string, { mode: VisibilityMode }>;
}

/** <companyId>.json: written only for a need-to-know company. */
export interface CompanyPolicy {
  version: 1;
  companyId: string;
  mode: "need_to_know";
  writtenAt: string;
  /** People in a group that sees every work object in the company. */
  seesAll: string[];
  /** Project id to the people whose groups include that project. */
  projects: Record<string, string[]>;
}

const ID = /^[0-9a-f-]{36}$/i;

export function policyPaths(dir: string = VISIBILITY_DIR): { dir: string; index: string; company(companyId: string): string } {
  return {
    dir,
    index: `${dir}/index.json`,
    company(companyId: string): string {
      if (!ID.test(companyId)) throw new Error("companyId is not an id");
      return `${dir}/${companyId}.json`;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseIndex(text: string): VisibilityIndex | null {
  const value = parseJson(text);
  if (!isRecord(value) || value.version !== POLICY_VERSION || typeof value.writtenAt !== "string" || !isRecord(value.companies)) return null;
  const companies: Array<[string, { mode: VisibilityMode }]> = [];
  for (const [companyId, entry] of Object.entries(value.companies)) {
    const mode = isRecord(entry) ? parseMode(entry.mode) : null;
    if (mode === null) return null;
    companies.push([companyId, { mode }]);
  }
  return { version: POLICY_VERSION, writtenAt: value.writtenAt, companies: Object.fromEntries(companies) };
}

export function parseCompanyPolicy(text: string, companyId: string): CompanyPolicy | null {
  const value = parseJson(text);
  if (!isRecord(value) || value.version !== POLICY_VERSION || value.companyId !== companyId || value.mode !== "need_to_know") return null;
  if (typeof value.writtenAt !== "string" || !isStringArray(value.seesAll) || !isRecord(value.projects)) return null;
  const projects: Array<[string, string[]]> = [];
  for (const [projectId, people] of Object.entries(value.projects)) {
    if (!isStringArray(people)) return null;
    projects.push([projectId, [...people]]);
  }
  return { version: POLICY_VERSION, companyId, mode: "need_to_know", writtenAt: value.writtenAt, seesAll: [...value.seesAll], projects: Object.fromEntries(projects) };
}

export interface CompileGroup {
  /** The group sees every work object in the company. */
  seesAll: boolean;
  /** User ids of the group's members. */
  members: string[];
  /** Project ids the group includes. */
  projects: string[];
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** Null for an open company: it has no file, and the index says it is open. */
export function compileCompanyPolicy(input: { companyId: string; mode: VisibilityMode; groups: CompileGroup[]; writtenAt: string }): CompanyPolicy | null {
  if (input.mode !== "need_to_know") return null;
  const peopleByProject = new Map<string, Set<string>>();
  for (const group of input.groups) {
    for (const projectId of group.projects) {
      const people = peopleByProject.get(projectId) ?? new Set<string>();
      for (const userId of group.members) people.add(userId);
      peopleByProject.set(projectId, people);
    }
  }
  return {
    version: POLICY_VERSION,
    companyId: input.companyId,
    mode: "need_to_know",
    writtenAt: input.writtenAt,
    seesAll: sortedUnique(input.groups.filter((group) => group.seesAll).flatMap((group) => group.members)),
    projects: Object.fromEntries(sortedUnique(peopleByProject.keys()).map((projectId) => [projectId, sortedUnique(peopleByProject.get(projectId) ?? [])])),
  };
}

export function compileIndex(companies: Array<{ companyId: string; mode: VisibilityMode }>, writtenAt: string): VisibilityIndex {
  return { version: POLICY_VERSION, writtenAt, companies: Object.fromEntries(companies.map(({ companyId, mode }) => [companyId, { mode }])) };
}
