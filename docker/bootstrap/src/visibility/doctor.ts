import { readFile as readFileText, stat as statFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseCompanyPolicy, parseIndex, policyPaths, readPolicyState, restrictedPeople, VISIBILITY_DIR, type PolicyFs, type VisibilityIndex, type VisibilityMode,
} from "@kyoube/visibility";
import type { Check } from "../commands/doctor.js";
import { createCoreClient, type CompanyMember } from "../core-api.js";
import { readVisibilityModes } from "./modes-db.js";

/**
 * Work-object visibility (docs/groups.md) for `kyoube doctor`. The Groups page writes policy
 * files and the core decides from them, failing closed; this is the operator's only view of a
 * closed state. Where the image ships the decision module and the core files the standing patches
 * change (docker/Dockerfile checks the same counts at build).
 */
export const VISIBILITY_MODULE_PATH = "/opt/kyoube/visibility/decide.mjs";
export const VISIBILITY_MARKER = "kyoube-visibility";
export const VISIBILITY_PATCHED: ReadonlyArray<{ path: string; count: number }> = [
  { path: "/app/server/dist/services/authorization.js", count: 1 },
  { path: "/app/server/dist/realtime/live-events-ws.js", count: 1 },
  { path: "/app/server/dist/routes/issues.js", count: 5 },
  { path: "/app/server/dist/app.js", count: 1 },
];
/** The kyoube.apps worker rewrites every policy file at least every five minutes. */
export const VISIBILITY_STALE_MS = 15 * 60_000;
/** The core's switches that make its agent-on-behalf-of-a-person check log-only. */
export const SHADOW_ENV_KEYS = ["PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW"] as const;

const MODULE_EXPORTS = ["decideBoard", "liveEventFilter", "filterSearchResults", "routeGate", "coreLookups"] as const;
const REWRITE_HINT = "the kyoube.apps worker rewrites the policy files every five minutes; if this stays, the app log says why (visibility policy write failed)";
const REFUSED = "so the core refuses this company's covered reads to everyone but its owners and admins";

export interface VisibilityCheckInput {
  env: NodeJS.ProcessEnv;
  /** The policy directory. The doctor passes VISIBILITY_DIR, the one the core reads. */
  dir: string;
  /** Every company's mode from the kyoube database; null when it could not be read. */
  dbModes: Map<string, VisibilityMode> | null;
  /** From the core's `/api/health`; null when it did not answer. */
  deploymentMode: string | null;
  /** A company's active people; null when the core would not say. */
  members: (companyId: string) => Promise<CompanyMember[] | null>;
  now: number;
  /** The instance home the plugin writes the files under; warned about when the core reads elsewhere. */
  home?: string;
  importModule?: (file: string) => Promise<unknown>;
  readText?: (file: string) => Promise<string | null>;
  readFile?: (file: string) => Promise<string>;
  stat?: (file: string) => Promise<{ mtimeMs: number }>;
}

type IndexRead = { state: "missing" } | { state: "unreadable"; reason: string } | { state: "read"; index: VisibilityIndex };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFileText(file, "utf8");
  } catch {
    return null;
  }
}

async function readIndex(file: string, fs: PolicyFs): Promise<IndexRead> {
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (error) {
    return isMissing(error) ? { state: "missing" } : { state: "unreadable", reason: errorMessage(error) };
  }
  const index = parseIndex(text);
  return index === null ? { state: "unreadable", reason: "not a valid index" } : { state: "read", index };
}

async function moduleProblem(importModule: (file: string) => Promise<unknown>): Promise<string | null> {
  try {
    const module = ((await importModule(VISIBILITY_MODULE_PATH)) ?? {}) as Record<string, unknown>;
    const missing = MODULE_EXPORTS.filter((name) => typeof module[name] !== "function");
    return missing.length === 0 ? null : `${VISIBILITY_MODULE_PATH} has no ${missing.join(", ")}; rebuild the image`;
  } catch (error) {
    return `${VISIBILITY_MODULE_PATH} does not load (${errorMessage(error)}): every company refuses covered reads to everyone but its owners and admins; rebuild the image`;
  }
}

async function markerProblem(readText: (file: string) => Promise<string | null>): Promise<string | null> {
  const wrong: string[] = [];
  for (const { path: file, count } of VISIBILITY_PATCHED) {
    const found = ((await readText(file)) ?? "").split(VISIBILITY_MARKER).length - 1;
    if (found !== count) wrong.push(`${file} has ${plural(found, `${VISIBILITY_MARKER} marker`, `${VISIBILITY_MARKER} markers`)}, expected ${count}`);
  }
  if (wrong.length === 0) return null;
  return `${wrong.join(", ")}: the core patches did not apply as built, so need-to-know is not reliably enforced; rebuild the image`;
}

function shadowProblem(env: NodeJS.ProcessEnv): string | null {
  const [modeKey, shadowKey] = SHADOW_ENV_KEYS;
  const set: string[] = [];
  if (env[modeKey]?.trim().toLowerCase() === "shadow") set.push(`${modeKey}=shadow`);
  if (env[shadowKey]?.trim()) set.push(shadowKey);
  if (set.length === 0) return null;
  const them = set.length === 1 ? "it" : "them";
  return `${set.join(" and ")} set: the core then only logs an agent run that reaches past what the person it works for may see, instead of refusing it; remove ${them} from the environment and restart the app`;
}

function authProblem(deploymentMode: string | null): string | null {
  if (deploymentMode === "authenticated") return null;
  if (deploymentMode === null) return "the core did not report its deployment mode (see the core line), so need-to-know cannot be confirmed to run with sign-in";
  return `deployment mode is ${deploymentMode}, not authenticated: without sign-in everyone is the local board and sees everything; set PAPERCLIP_DEPLOYMENT_MODE=authenticated (docker-compose.yml does, unless an override changes it)`;
}

/**
 * One `visibility` line for the instance, then one `visibility <companyId>` line per company that
 * is need-to-know in the database or the index. The module and the patches must be in the image
 * whatever the modes; shadow mode and sign-in matter only once a company is need-to-know.
 */
export async function visibilityChecks(input: VisibilityCheckInput): Promise<Check[]> {
  const importModule = input.importModule ?? ((file: string) => import(pathToFileURL(file).href));
  const readText = input.readText ?? readOptional;
  const fs: PolicyFs = { readFile: input.readFile ?? ((file) => readFileText(file, "utf8")), stat: input.stat ?? statFile };
  const paths = policyPaths(input.dir);
  const index = await readIndex(paths.index, fs);

  const needToKnow = new Set<string>();
  for (const [companyId, mode] of input.dbModes ?? []) if (mode === "need_to_know") needToKnow.add(companyId);
  if (index.state === "read") {
    for (const [companyId, entry] of Object.entries(index.index.companies)) if (entry.mode === "need_to_know") needToKnow.add(companyId);
  }
  const companies = [...needToKnow].sort();
  const anyNeedToKnow = companies.length > 0;

  const fails = [
    await moduleProblem(importModule),
    await markerProblem(readText),
    index.state === "unreadable"
      ? `${paths.index} is unreadable (${index.reason}): the core refuses covered reads in every company to everyone but its owners and admins; ${REWRITE_HINT}`
      : null,
    anyNeedToKnow ? shadowProblem(input.env) : null,
    anyNeedToKnow ? authProblem(input.deploymentMode) : null,
  ].filter((problem): problem is string => problem !== null);
  const warnings: string[] = [];
  if (input.dbModes === null) warnings.push("database unreadable; index trusted");
  if (input.home !== undefined && path.posix.join(input.home, "kyoube", "visibility") !== VISIBILITY_DIR) {
    warnings.push(`home is ${input.home}; the core reads ${VISIBILITY_DIR}`);
  }

  const summary = anyNeedToKnow ? `need-to-know in ${plural(companies.length, "company", "companies")}` : "open everywhere";
  const overall: Check = fails.length > 0
    ? { name: "visibility", ok: false, detail: [...fails, ...warnings].join(" — ") }
    : warnings.length > 0
      ? { name: "visibility", ok: true, warn: true, detail: [summary, ...warnings].join(" — ") }
      : { name: "visibility", ok: true, detail: summary };

  const checks: Check[] = [overall];
  for (const companyId of companies) checks.push(await companyCheck(companyId, input, index, fs));
  return checks;
}

async function companyCheck(companyId: string, input: VisibilityCheckInput, index: IndexRead, fs: PolicyFs): Promise<Check> {
  const name = `visibility ${companyId}`;
  const paths = policyPaths(input.dir);

  // With the index unreadable there is nothing to compare; the visibility line already fails.
  if (input.dbModes !== null && index.state !== "unreadable") {
    const inDb = input.dbModes.get(companyId);
    const inIndex = index.state === "read" && Object.hasOwn(index.index.companies, companyId) ? index.index.companies[companyId]?.mode : undefined;
    if (inDb === "need_to_know" && inIndex !== "need_to_know") {
      const says = index.state === "missing" ? "does not exist" : inIndex === undefined ? "does not list it" : "says open";
      return { name, ok: false, detail: `the kyoube database says need-to-know but ${paths.index} ${says}, so the core shows this company's work to everyone; ${REWRITE_HINT}` };
    }
    if (inIndex === "need_to_know" && inDb !== "need_to_know") {
      const says = inDb === undefined ? "does not list it" : "says open";
      return { name, ok: false, detail: `${paths.index} says need-to-know but the kyoube database ${says}, so the core still holds this company's work back; ${REWRITE_HINT}` };
    }
  }

  let file: string;
  try {
    file = paths.company(companyId);
  } catch {
    return { name, ok: false, detail: `${companyId} is not a company id, ${REFUSED}; ${REWRITE_HINT}` };
  }
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (error) {
    return { name, ok: false, detail: `${file} ${isMissing(error) ? "is missing" : `cannot be read (${errorMessage(error)})`}, ${REFUSED}; ${REWRITE_HINT}` };
  }
  const policy = parseCompanyPolicy(text, companyId);
  if (policy === null) return { name, ok: false, detail: `${file} is not a valid policy for this company, ${REFUSED}; ${REWRITE_HINT}` };

  let people: CompanyMember[] | null;
  try {
    people = await input.members(companyId);
  } catch {
    people = null;
  }
  // Counted against what the core reads now, so a closed policy counts everyone it holds back.
  const restricted = people === null ? "restricted count unavailable" : `${restrictedPeople(await readPolicyState(companyId, { dir: input.dir, fs }), people).length} restricted`;
  const counts = `${policy.seesAll.length} sees all, ${plural(Object.keys(policy.projects).length, "project", "projects")}, ${restricted}`;
  if (!(input.now - Date.parse(policy.writtenAt) <= VISIBILITY_STALE_MS)) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `${counts} — written ${policy.writtenAt}, more than 15 minutes ago: the kyoube.apps worker rewrites it every five minutes, so check the plugins line and the app log (visibility policy write failed)`,
    };
  }
  return { name, ok: true, detail: counts };
}

export interface VisibilityDoctorDeps {
  readModes?: (url: string) => Promise<Map<string, VisibilityMode>>;
  importModule?: (file: string) => Promise<unknown>;
  readText?: (file: string) => Promise<string | null>;
  readFile?: (file: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * The doctor's lines: the modes from the kyoube database (unreadable is a warning, never a
 * failure), the policy from the directory the core reads, and each company's people from the core
 * when there is a board key.
 */
export async function visibilityDoctorChecks(
  env: NodeJS.ProcessEnv,
  config: { home: string; dataDatabaseUrl: string; paperclipApiUrl: string },
  deploymentMode: string | null,
  apiKey: string | null,
  deps: VisibilityDoctorDeps = {},
): Promise<Check[]> {
  const readModes = deps.readModes ?? readVisibilityModes;
  let dbModes: Map<string, VisibilityMode> | null;
  try {
    dbModes = await readModes(config.dataDatabaseUrl);
  } catch {
    dbModes = null;
  }
  const client = apiKey ? createCoreClient({ apiBase: config.paperclipApiUrl, apiKey, fetchImpl: deps.fetchImpl }) : null;
  const members = async (companyId: string) => {
    if (!client) return null;
    try {
      return await client.listMembers(companyId);
    } catch {
      return null;
    }
  };
  return visibilityChecks({
    env,
    dir: VISIBILITY_DIR,
    dbModes,
    deploymentMode,
    members,
    now: Date.now(),
    home: config.home,
    importModule: deps.importModule,
    readText: deps.readText,
    readFile: deps.readFile,
  });
}
