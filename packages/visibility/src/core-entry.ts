// The decision the core imports from /opt/kyoube/visibility/decide.mjs: inside its authorization
// decision, its live-events websocket, its search route and the gate in front of its task and
// project routes. A security boundary, so it imports only its sibling modules and node built-ins
// (build.mjs bundles it with nothing external), and none of its functions ever rejects: a failure
// answers closed (the gate: passes to the core's own route, whose decision is closed) and is logged
// at most once a minute, because the core patches only catch a failure to import this file.

import { CLOSED, HIDDEN, isCoveredAction, isRestricted, MAX_ANCESTORS, projectVisible, taskVisible, type Denial, type Person, type TaskFacts } from "./decide.js";
import { stripLiveEvent } from "./live-events.js";
import { createPolicyReader, type PolicyReader } from "./loader.js";
import type { CompanyPolicy } from "./policy.js";
import { coreLookups, routeGate as createRouteGate, type RouteGateDeps } from "./route-gate.js";

export { coreLookups };

/** What the core's authorization closure hands over: its membership lookup and drizzle. */
export interface CoreHelpers {
  /** A role that is not a string counts as no role. */
  getActiveMembership(companyId: string, principalType: "user", principalId: string): Promise<Membership | null>;
  db: any;
  tables: { issues: any };
  ops: { and: any; eq: any; inArray: any; sql: any };
}

type Membership = { membershipRole?: string | null };

export type LiveEvent = { type: string; companyId: string; createdAt?: string; payload?: unknown; [key: string]: unknown };

export type SearchResult = {
  results: Array<{ id: string; type: string; artifact?: { issueId?: string | null } | null; issue?: Record<string, unknown> | null; [key: string]: unknown }>;
  countsByType?: Record<string, number>;
  [key: string]: unknown;
};

/** The facets of the core's search answer (services/company-search.js emptyFilterOptionCounts). */
export const FILTER_FACETS = ["status", "priority", "assigneeAgentId", "assigneeUserId", "projectId", "labelId", "updatedWithin"] as const;
/** The types the core counts (services/company-search.js emptySearchCounts). */
export const SEARCH_TYPES = ["issue", "comment", "document", "artifact", "agent", "project"] as const;
/** The fields of the core's search answer that describe the request, not what it found. */
const SEARCH_REQUEST_KEYS = ["query", "normalizedQuery", "scope", "sort", "limit", "offset"] as const;

/**
 * A search answer built only from `results`, which are already the person's: the request fields
 * copied, every count recomputed from the kept items (the facets from the kept tasks' own fields;
 * labels and recency are not on an item, so they stay empty), no zero-results hint and no next page,
 * since the core's figures count every match, hidden ones included.
 */
export function searchAnswer(result: SearchResult, results: SearchResult["results"]): SearchResult {
  const answer: Record<string, unknown> = {};
  for (const key of SEARCH_REQUEST_KEYS) if (Object.hasOwn(result ?? {}, key)) answer[key] = result[key];
  const countsByType: Record<string, number> = Object.fromEntries(SEARCH_TYPES.map((type) => [type, 0]));
  const filterOptionCounts: Record<string, Record<string, number>> = Object.fromEntries(FILTER_FACETS.map((facet) => [facet, {}]));
  for (const item of results) {
    countsByType[item.type] = (countsByType[item.type] ?? 0) + 1;
    if (item.type !== "issue" || typeof item.issue !== "object" || item.issue === null) continue;
    for (const facet of ["status", "priority", "assigneeAgentId", "assigneeUserId", "projectId"] as const) {
      const value = item.issue[facet];
      if (typeof value === "string" && value !== "") filterOptionCounts[facet]![value] = (filterOptionCounts[facet]![value] ?? 0) + 1;
    }
  }
  return { ...answer, results, countsByType, filterOptionCounts, zeroResults: null, hasMore: false };
}

/** How long a role, a company's parent map and a person's root set are trusted. */
const CACHE_MS = 2_000;
/** How often an open live-events socket re-decides whether its person is restricted. */
const LIVE_RECHECK_MS = 30_000;
const FAILURE_LOG_MS = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

type ParentMap = Map<string, { parentId: string | null; projectId: string | null }>;

let reader: PolicyReader = createPolicyReader();
let now: () => number = Date.now;
let lastFailureLogAt = Number.NEGATIVE_INFINITY;
const memberships = new Map<string, Cached<Membership | null>>();
const parentMaps = new Map<string, Cached<ParentMap>>();
const rootSets = new Map<string, Cached<Set<string>>>();

/** Concurrent decisions share one query; a failed one is forgotten so the next decision asks again. */
function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined && now() - hit.at < CACHE_MS) return hit.value;
  const entry: Cached<T> = { at: now(), value: load() };
  cache.set(key, entry);
  entry.value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.value;
}

function reportFailure(error: unknown): void {
  const at = now();
  if (at - lastFailureLogAt < FAILURE_LOG_MS) return;
  lastFailureLogAt = at;
  console.error("[kyoube] visibility check failed", error);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The core passes null for a field it has no value for. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** A restricted person in a need-to-know company, with what the queries need. */
interface Restricted {
  companyId: string;
  person: Person;
  policy: CompanyPolicy;
  helpers: CoreHelpers;
}

function parentMap({ companyId, helpers }: Restricted): Promise<ParentMap> {
  return cached(parentMaps, companyId, async () => {
    const { db, tables: { issues }, ops: { eq } } = helpers;
    const rows: Array<{ id: string; parentId: string | null; projectId: string | null }> = await db
      .select({ id: issues.id, parentId: issues.parentId, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    return new Map(rows.map((row) => [row.id, { parentId: row.parentId ?? null, projectId: row.projectId ?? null }]));
  });
}

/** The tasks the person is involved in directly: one of the four columns, or a project on their list. */
function roots({ companyId, person, policy, helpers }: Restricted): Promise<Set<string>> {
  return cached(rootSets, `${companyId}:${person.userId}`, async () => {
    const { db, tables: { issues }, ops: { and, eq, inArray, sql } } = helpers;
    const { userId } = person;
    const projectIds = Object.keys(policy.projects).filter((projectId) => projectVisible(policy, person, projectId));
    const rows: Array<{ id: string }> = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), sql`(${sql.join([eq(issues.createdByUserId, userId), eq(issues.assigneeUserId, userId), eq(issues.responsibleUserId, userId), eq(issues.conversationUserId, userId), ...(projectIds.length ? [inArray(issues.projectId, projectIds)] : [])], sql` OR `)})`));
    return new Set(rows.map((row) => row.id));
  });
}

/** A task the parent map does not know yet (created a moment ago), with its involvement columns. */
async function loadTask({ companyId, helpers }: Restricted, id: string): Promise<TaskFacts | null> {
  const { db, tables: { issues }, ops: { and, eq } } = helpers;
  const rows: Array<Partial<TaskFacts>> = await db
    .select({ id: issues.id, projectId: issues.projectId, parentId: issues.parentId, createdByUserId: issues.createdByUserId, assigneeUserId: issues.assigneeUserId, responsibleUserId: issues.responsibleUserId, conversationUserId: issues.conversationUserId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, id)));
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) return null;
  return {
    id,
    projectId: row.projectId ?? null,
    parentId: row.parentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    responsibleUserId: row.responsibleUserId ?? null,
    conversationUserId: row.conversationUserId ?? null,
  };
}

/**
 * A task from the parent map. The roots query has already matched the four involvement columns,
 * so a root carries the person as its creator for `involved` to count, and any other task none.
 */
function mapFacts(id: string, known: { parentId: string | null; projectId: string | null }, isRoot: boolean, userId: string): TaskFacts {
  return { id, parentId: known.parentId, projectId: known.projectId, createdByUserId: isRoot ? userId : null, assigneeUserId: null, responsibleUserId: null, conversationUserId: null };
}

/** The task and as many ancestors as `taskVisible` looks at, then the rule. */
async function visible(ctx: Restricted, issueId: unknown): Promise<boolean> {
  if (!nonEmptyString(issueId)) return false;
  const [map, rootIds] = await Promise.all([parentMap(ctx), roots(ctx)]);
  const chain: TaskFacts[] = [];
  const seen = new Set<string>();
  let id: string | null = issueId;
  while (id !== null && !seen.has(id) && chain.length <= MAX_ANCESTORS) {
    seen.add(id);
    const known = map.get(id);
    const facts: TaskFacts | null = known === undefined ? await loadTask(ctx, id) : mapFacts(id, known, rootIds.has(id), ctx.person.userId);
    if (facts === null) break;
    chain.push(facts);
    id = facts.parentId;
  }
  return taskVisible(ctx.policy, ctx.person, chain);
}

function projectOnList(ctx: Restricted, projectId: unknown): boolean {
  return projectVisible(ctx.policy, ctx.person, nonEmptyString(projectId) ? projectId : null);
}

async function restrictedDecision(ctx: Restricted, action: string, resource: Record<string, unknown>): Promise<Denial | null> {
  switch (action) {
    case "company_scope:read":
      return HIDDEN;
    case "project:read":
      return projectOnList(ctx, resource.projectId) ? null : HIDDEN;
    case "issue:read":
    case "issue:comment":
    case "issue:mutate":
      return (await visible(ctx, resource.issueId)) ? null : HIDDEN;
    case "tasks:assign":
      // Assigning an existing task depends on that task alone: a person given a task in a project
      // outside their groups sees it through involvement and may assign it. A new subtask follows
      // its parent whatever project the core gives it; a new root task needs its project, or has
      // none and is the person's own.
      if (present(resource.issueId)) return (await visible(ctx, resource.issueId)) ? null : HIDDEN;
      if (present(resource.parentIssueId)) return (await visible(ctx, resource.parentIssueId)) ? null : HIDDEN;
      if (present(resource.projectId)) return projectOnList(ctx, resource.projectId) ? null : HIDDEN;
      return null;
    default:
      // A covered action this switch does not know yet.
      return HIDDEN;
  }
}

/** The board branch of the core's authorization decision. Null means the core's own rules apply. */
export async function decideBoard(input: {
  actor: { type: string; userId?: string | null };
  action: string;
  resource: Record<string, unknown> | null | undefined;
  companyId: string | null | undefined;
  helpers: CoreHelpers;
}): Promise<Denial | null> {
  try {
    const { actor, action, companyId, helpers } = input;
    const userId = actor?.userId;
    if (actor?.type !== "board" || !nonEmptyString(userId) || !nonEmptyString(companyId) || !isCoveredAction(action)) return null;
    const state = await reader.read(companyId);
    if (state.state === "open") return null;
    const membership = await cached(memberships, `${companyId}:${userId}`, async () => helpers.getActiveMembership(companyId, "user", userId));
    if (membership === null || membership === undefined) return null;
    const role = membership.membershipRole;
    const person: Person = { userId, role: typeof role === "string" ? role : null };
    const restricted = isRestricted(state, person);
    if (restricted === false) return null;
    if (restricted === "closed" || state.state !== "need_to_know") return CLOSED;
    return await restrictedDecision({ companyId, person, policy: state.policy, helpers }, action, input.resource ?? {});
  } catch (error) {
    reportFailure(error);
    return isCoveredAction(input?.action) ? CLOSED : null;
  }
}

/** True unless the person sees everything; a failed lookup counts as restricted. */
async function liveRestricted({ companyId, userId, lookupPerson }: { companyId: string; userId: string; lookupPerson: () => Promise<{ role: string | null; instanceAdmin: boolean }> }): Promise<boolean> {
  try {
    const state = await reader.read(companyId);
    if (state.state === "open") return false;
    if (!nonEmptyString(userId)) return true;
    const found = await lookupPerson();
    return isRestricted(state, { userId, role: typeof found?.role === "string" ? found.role : null, instanceAdmin: found?.instanceAdmin === true }) !== false;
  } catch (error) {
    reportFailure(error);
    return true;
  }
}

function strippedOrNothing(event: LiveEvent): LiveEvent | null {
  try {
    return stripLiveEvent(event);
  } catch {
    return null;
  }
}

/** One socket's filter: events unchanged for a person who sees everything, stripped otherwise. */
export function liveEventFilter(input: { companyId: string; userId: string; lookupPerson: () => Promise<{ role: string | null; instanceAdmin: boolean }> }): (event: LiveEvent) => Promise<LiveEvent | null> {
  let decided: { at: number; restricted: Promise<boolean> } | null = null;
  function restricted(): Promise<boolean> {
    if (decided === null || now() - decided.at >= LIVE_RECHECK_MS) decided = { at: now(), restricted: liveRestricted(input) };
    return decided.restricted;
  }
  return async (event) => {
    try {
      return (await restricted()) ? stripLiveEvent(event) : event;
    } catch (error) {
      reportFailure(error);
      return strippedOrNothing(event);
    }
  };
}

/** Search for a restricted person: each result through the core's own decision, then recounted. */
export async function filterSearchResults(input: { companyId: string; result: SearchResult; decide: (action: string, resource: Record<string, unknown>) => Promise<{ allowed: boolean }> }): Promise<SearchResult> {
  const { companyId, result, decide } = input;
  try {
    const decisions = new Map<string, Promise<boolean>>();
    const allowed = (action: string, id: unknown, resource: (id: string) => Record<string, unknown>): Promise<boolean> => {
      if (!nonEmptyString(id)) return Promise.resolve(false);
      const key = `${action}:${id}`;
      let decision = decisions.get(key);
      if (decision === undefined) {
        decision = decide(action, resource(id)).then((answer) => answer?.allowed === true);
        decisions.set(key, decision);
      }
      return decision;
    };
    const issue = (issueId: string) => ({ type: "issue", companyId, issueId });
    const keep = await Promise.all(
      result.results.map((item) => {
        switch (item.type) {
          case "issue":
            return allowed("issue:read", item.id, issue);
          case "project":
            return allowed("project:read", item.id, (projectId) => ({ type: "project", companyId, projectId }));
          case "artifact":
            return allowed("issue:read", item.artifact?.issueId, issue);
          case "agent":
            return true;
          default:
            return false;
        }
      }),
    );
    return searchAnswer(result, result.results.filter((_, index) => keep[index] === true));
  } catch (error) {
    reportFailure(error);
    try {
      return searchAnswer(result, []);
    } catch {
      return searchAnswer({ results: [] }, []);
    }
  }
}

/** The gate in front of the core's task and project routes (route-gate.ts), logging as the rest of this file does. */
export function routeGate(deps: RouteGateDeps): ReturnType<typeof createRouteGate> {
  return createRouteGate({ report: reportFailure, ...deps });
}

/** For the tests: fresh caches, a reader on a temp dir, a fake clock. */
export const _internals = {
  reset(): void {
    reader = createPolicyReader();
    now = Date.now;
    lastFailureLogAt = Number.NEGATIVE_INFINITY;
    memberships.clear();
    parentMaps.clear();
    rootSets.clear();
  },
  setReader(next: PolicyReader): void {
    reader = next;
  },
  setNow(next: () => number): void {
    now = next;
  },
};
