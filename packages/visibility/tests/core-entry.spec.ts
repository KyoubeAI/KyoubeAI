import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileCompanyPolicy, compileIndex, createPolicyReader, writePolicyFiles } from "../src/index.js";
import { decideBoard, filterSearchResults, liveEventFilter, _internals } from "../dist/decide.mjs";

const C = "11111111-1111-4111-8111-111111111111";
const board = (userId: string) => ({ type: "board", userId });
// tasks: r (ann created, no project) <- c <- g ; h in hidden project p2 by bob ; v in visible project p1 by bob
const TASKS = [
  { id: "r", parentId: null, projectId: null, createdByUserId: "ann", assigneeUserId: null, responsibleUserId: null, conversationUserId: null },
  { id: "c", parentId: "r", projectId: null, createdByUserId: "agent", assigneeUserId: null, responsibleUserId: "ann", conversationUserId: null },
  { id: "g", parentId: "c", projectId: "p2", createdByUserId: "bob", assigneeUserId: null, responsibleUserId: null, conversationUserId: null },
  { id: "h", parentId: null, projectId: "p2", createdByUserId: "bob", assigneeUserId: null, responsibleUserId: null, conversationUserId: null },
  { id: "v", parentId: null, projectId: "p1", createdByUserId: "bob", assigneeUserId: null, responsibleUserId: null, conversationUserId: null },
];
function helpers(roles: Record<string, string | null>, omitFromMap: string[] = []) {
  const queries: string[] = [];
  const db = { select: (cols: Record<string, unknown>) => ({ from: () => ({ where: async (cond: unknown) => {
    const keys = Object.keys(cols).sort().join(",");
    queries.push(keys);
    if (keys === "id,parentId,projectId") return TASKS.filter((t) => !omitFromMap.includes(t.id)).map(({ id, parentId, projectId }) => ({ id, parentId, projectId }));
    if (keys === "id") { const userId = JSON.stringify(cond).includes("ann") ? "ann" : "bob"; return TASKS.filter((t) => [t.createdByUserId, t.assigneeUserId, t.responsibleUserId, t.conversationUserId].includes(userId) || (userId === "ann" && t.projectId === "p1")).map((t) => ({ id: t.id })); }
    const ids = [...JSON.stringify(cond).matchAll(/"v":"([^"]+)"/g)].map((m) => m[1]);
    return TASKS.filter((t) => ids.includes(t.id));
  } }) }) };
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), { join: (parts: unknown[], sep: unknown) => ({ parts, sep }) });
  return { queries, helpers: { getActiveMembership: async (_c: string, _t: string, userId: string) => (userId in roles ? { membershipRole: roles[userId] } : null), db, tables: { issues: { id: "id", parentId: "parentId", projectId: "projectId", companyId: "companyId", createdByUserId: "createdByUserId", assigneeUserId: "assigneeUserId", responsibleUserId: "responsibleUserId", conversationUserId: "conversationUserId" } }, ops: { and: (...c: unknown[]) => c, eq: (col: unknown, v: unknown) => ({ col, v }), inArray: (col: unknown, v: unknown) => ({ col, in: v }), sql } } };
}
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
  _internals.reset();
  _internals.setReader(createPolicyReader({ dir, checkMs: 0 }));
  await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "x"), companies: [compileCompanyPolicy({ companyId: C, mode: "need_to_know", groups: [{ seesAll: true, members: ["boss"], projects: [] }, { seesAll: false, members: ["ann"], projects: ["p1"] }], writtenAt: "x" })!] });
});
// The failure paths log; keep the run quiet and let the tests that care look at the calls.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("decideBoard", () => {
  const roles = { ann: "operator", bob: "operator", boss: "operator", own: "owner" };
  const decide = (userId: string, action: string, resource: Record<string, unknown>) => decideBoard({ actor: board(userId), action, resource, companyId: C, helpers: helpers(roles).helpers });
  it("has no opinion for agents, uncovered actions, owners and sees-all people", async () => {
    expect(await decideBoard({ actor: { type: "agent" }, action: "issue:read", resource: { issueId: "h" }, companyId: C, helpers: helpers(roles).helpers })).toBeNull();
    expect(await decide("ann", "agent:read", {})).toBeNull();
    expect(await decide("own", "company_scope:read", {})).toBeNull();
    expect(await decide("boss", "issue:read", { issueId: "h" })).toBeNull();
    expect(await decideBoard({ actor: board("ann"), action: "issue:read", resource: {}, companyId: null, helpers: helpers(roles).helpers })).toBeNull();
  });
  it("denies company scope and hidden projects, allows listed ones", async () => {
    expect(await decide("ann", "company_scope:read", {})).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(await decide("ann", "project:read", { projectId: "p1" })).toBeNull();
    expect(await decide("ann", "project:read", { projectId: "p2" })).toMatchObject({ reason: "deny_kyoube_visibility" });
  });
  it("shows own tasks and their subtree, tasks in listed projects, and hides the rest", async () => {
    for (const id of ["r", "c", "g", "v"]) expect(await decide("ann", "issue:read", { issueId: id })).toBeNull();
    expect(await decide("ann", "issue:read", { issueId: "h" })).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(await decide("ann", "issue:comment", { issueId: "h" })).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(await decide("ann", "issue:read", {})).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(await decide("bob", "issue:read", { issueId: "h" })).toBeNull();
    expect(await decide("bob", "issue:read", { issueId: "r" })).toMatchObject({ reason: "deny_kyoube_visibility" });
  });
  it("lets a restricted person create a root task, a subtask under a visible task, and refuses hidden parents or projects", async () => {
    expect(await decide("ann", "tasks:assign", { issueId: null, parentIssueId: null, projectId: null })).toBeNull();
    expect(await decide("ann", "tasks:assign", { issueId: null, parentIssueId: "g", projectId: "p2" })).toBeNull(); // a subtask under a visible task, whatever its project
    expect(await decide("ann", "tasks:assign", { issueId: null, parentIssueId: "g", projectId: null })).toBeNull();
    expect(await decide("ann", "tasks:assign", { issueId: null, parentIssueId: "h", projectId: null })).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(await decide("ann", "tasks:assign", { issueId: null, parentIssueId: null, projectId: "p1" })).toBeNull();
    expect(await decide("ann", "tasks:assign", { issueId: "h", parentIssueId: null, projectId: null })).toMatchObject({ reason: "deny_kyoube_visibility" });
  });
  it("judges a task missing from the map by loading it", async () => {
    // "r" is left out of the parent map (as a task created a moment ago would be); the one-row load answers for it.
    const h = helpers(roles, ["r"]);
    expect(await decideBoard({ actor: board("ann"), action: "issue:read", resource: { issueId: "r" }, companyId: C, helpers: h.helpers })).toBeNull();
    expect(await decideBoard({ actor: board("bob"), action: "issue:read", resource: { issueId: "r" }, companyId: C, helpers: h.helpers })).toMatchObject({ reason: "deny_kyoube_visibility" });
    expect(h.queries.filter((q) => q.includes("createdByUserId")).length).toBeGreaterThanOrEqual(1);
  });
  it("is closed for operators and open for admins when the company file is gone", async () => {
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "y"), companies: [] });
    const h = helpers({ ann: "operator", adm: "admin" });
    expect(await decideBoard({ actor: board("ann"), action: "issue:read", resource: { issueId: "r" }, companyId: C, helpers: h.helpers })).toMatchObject({ reason: "deny_kyoube_visibility_unavailable" });
    expect(await decideBoard({ actor: board("adm"), action: "issue:read", resource: { issueId: "r" }, companyId: C, helpers: h.helpers })).toBeNull();
  });
  it("re-reads the role after two seconds", async () => {
    let now = 0;
    _internals.setNow(() => now);
    const roles2: Record<string, string | null> = { ann: "admin" };
    const h = helpers(roles2);
    expect(await decideBoard({ actor: board("ann"), action: "company_scope:read", resource: {}, companyId: C, helpers: h.helpers })).toBeNull();
    roles2.ann = "operator";
    expect(await decideBoard({ actor: board("ann"), action: "company_scope:read", resource: {}, companyId: C, helpers: h.helpers })).toBeNull();
    now = 2_001;
    expect(await decideBoard({ actor: board("ann"), action: "company_scope:read", resource: {}, companyId: C, helpers: h.helpers })).toMatchObject({ reason: "deny_kyoube_visibility" });
  });
  it("runs the parent map and roots queries once per two seconds, not per decision", async () => {
    const h = helpers(roles);
    for (const id of ["r", "c", "g", "h", "v"]) await decideBoard({ actor: board("ann"), action: "issue:read", resource: { issueId: id }, companyId: C, helpers: h.helpers });
    expect(h.queries.filter((q) => q === "id,parentId,projectId")).toHaveLength(1);
    expect(h.queries.filter((q) => q === "id")).toHaveLength(1);
  });
  it("never throws: a failing helper is closed for a covered action and no opinion for an uncovered one, logged once a minute", async () => {
    let now = 0;
    _internals.setNow(() => now);
    const h = helpers(roles).helpers;
    const brokenDb = { ...h, db: { select: () => { throw new Error("db down"); } } };
    const brokenMembership = { ...h, getActiveMembership: async () => { throw new Error("db down"); } };
    expect(await decideBoard({ actor: board("ann"), action: "company_scope:read", resource: {}, companyId: C, helpers: brokenMembership })).toEqual({ reason: "deny_kyoube_visibility_unavailable", explanation: expect.any(String) });
    expect(await decideBoard({ actor: board("ann"), action: "agent:read", resource: {}, companyId: C, helpers: brokenMembership })).toBeNull();
    expect(await decideBoard({ actor: board("ann"), action: "issue:read", resource: { issueId: "r" }, companyId: C, helpers: brokenDb })).toMatchObject({ reason: "deny_kyoube_visibility_unavailable" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[kyoube] visibility check failed", expect.any(Error));
    now = 60_000;
    expect(await decideBoard({ actor: board("ann"), action: "issue:mutate", resource: { issueId: "r" }, companyId: C, helpers: brokenDb })).toMatchObject({ reason: "deny_kyoube_visibility_unavailable" });
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe("liveEventFilter", () => {
  it("passes events through for managers and sees-all people, strips them for restricted people, and strips when the lookup fails", async () => {
    const event = { type: "activity.logged", companyId: C, payload: { entityType: "issue", entityId: "i", details: { title: "secret" } } };
    const pass = liveEventFilter({ companyId: C, userId: "boss", lookupPerson: async () => ({ role: "operator", instanceAdmin: false }) });
    expect(await pass(event)).toBe(event);
    const admin = liveEventFilter({ companyId: C, userId: "x", lookupPerson: async () => ({ role: null, instanceAdmin: true }) });
    expect(await admin(event)).toBe(event);
    const strip = liveEventFilter({ companyId: C, userId: "ann", lookupPerson: async () => ({ role: "operator", instanceAdmin: false }) });
    expect(JSON.stringify(await strip(event))).not.toContain("secret");
    expect((await strip(event))!.payload).toMatchObject({ entityType: "issue", entityId: "i", details: {} });
    const broken = liveEventFilter({ companyId: C, userId: "ann", lookupPerson: async () => { throw new Error("db down"); } });
    expect(JSON.stringify(await broken(event))).not.toContain("secret");
  });
  it("re-checks the person every thirty seconds", async () => {
    let now = 0;
    _internals.setNow(() => now);
    let role = "admin";
    let lookups = 0;
    const filter = liveEventFilter({ companyId: C, userId: "ann", lookupPerson: async () => { lookups += 1; return { role, instanceAdmin: false }; } });
    const event = { type: "activity.logged", companyId: C, payload: { details: { title: "secret" } } };
    expect(await filter(event)).toBe(event);
    role = "operator";
    expect(await filter(event)).toBe(event);
    expect(lookups).toBe(1);
    now = 30_001;
    expect(JSON.stringify(await filter(event))).not.toContain("secret");
    expect(lookups).toBe(2);
  });
});

describe("filterSearchResults", () => {
  it("keeps visible tasks and projects, artifacts of visible tasks, every agent, and recounts", async () => {
    const allowed = new Set(["issue:read:r", "project:read:p1"]);
    const calls: string[] = [];
    const decide = async (action: string, resource: Record<string, unknown>) => { const id = String(resource.issueId ?? resource.projectId); calls.push(`${action}:${id}`); return { allowed: allowed.has(`${action}:${id}`) }; };
    const result = { query: "q", results: [
      { id: "r", type: "issue" }, { id: "h", type: "issue" }, { id: "p1", type: "project" }, { id: "p2", type: "project" },
      { id: "art1", type: "artifact", artifact: { issueId: "r" } }, { id: "art2", type: "artifact", artifact: { issueId: "h" } }, { id: "art3", type: "artifact", artifact: null },
      { id: "a1", type: "agent" }, { id: "x", type: "unknown" },
    ], countsByType: { issue: 2, project: 2, artifact: 3, agent: 1 } };
    const filtered = await filterSearchResults({ companyId: C, result, decide });
    expect(filtered.results.map((r) => r.id)).toEqual(["r", "p1", "art1", "a1"]);
    expect(filtered.countsByType).toEqual({ issue: 1, project: 1, artifact: 1, agent: 1 });
    expect(filtered.query).toBe("q");
    expect(calls.filter((c) => c === "issue:read:r")).toHaveLength(1); // memoised across the task and its artifact
  });
  it("never throws: a failing decision returns no results at all", async () => {
    const decide = async () => { throw new Error("db down"); };
    const result = { query: "q", results: [{ id: "a1", type: "agent" }, { id: "r", type: "issue" }], countsByType: { agent: 1, issue: 1 } };
    expect(await filterSearchResults({ companyId: C, result, decide })).toEqual({ query: "q", results: [], countsByType: {} });
    expect(console.error).toHaveBeenCalledWith("[kyoube] visibility check failed", expect.any(Error));
  });
});
