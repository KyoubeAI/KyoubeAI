import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreLookups, routeGate, _internals } from "../dist/decide.mjs";

const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const T_UUID = "33333333-3333-4333-8333-333333333333";
const P_UUID = "44444444-4444-4444-8444-444444444444";
const person = { type: "board", userId: "ann" };

function issue(id: string, companyId = C, extra: Record<string, unknown> = {}) {
  return { id, companyId, projectId: "p1", parentId: "parent", assigneeAgentId: null, assigneeUserId: "bob", status: "todo", ...extra };
}

/** An express-like response and next that record what the gate did. */
function exchange() {
  const sent: Array<{ status: number; body: unknown }> = [];
  let status = 200;
  const res = { status: (code: number) => { status = code; return { json: (body: unknown) => { sent.push({ status, body }); return res; } }; } };
  const next = vi.fn();
  return { res, next, sent };
}

/** A gate over fake lookups, answering each decision from `answer`, recording what it was asked. */
function gateWith(options: { issues?: Array<ReturnType<typeof issue>>; projects?: Array<{ id: string; companyId: string }>; answer?: (input: { action: string; resource: Record<string, unknown> }) => unknown; findIssues?: () => Promise<never> }) {
  const asked: Array<{ actor: unknown; action: string; resource: Record<string, unknown>; scope?: unknown }> = [];
  const lookups: Array<[string, string, string | null]> = [];
  const gate = routeGate({
    decide: async (input: { actor: unknown; action: string; resource: Record<string, unknown>; scope?: unknown }) => {
      asked.push(input);
      return (options.answer ?? (() => ({ allowed: true, reason: "allow_company_member" })))(input) as never;
    },
    findIssues: options.findIssues ?? (async (ref: string) => { lookups.push(["issue", ref, null]); return options.issues ?? []; }),
    findProjects: async (ref: string, companyId: string | null) => { lookups.push(["project", ref, companyId]); return options.projects ?? []; },
  });
  return { gate, asked, lookups };
}

const hiddenFor = (reason: string) => () => ({ allowed: false, reason, explanation: "no" });

beforeEach(() => {
  _internals.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("routeGate", () => {
  it("answers the core's not-found for a board actor's visibility denial and stops", async () => {
    for (const reason of ["deny_kyoube_visibility", "deny_kyoube_visibility_unavailable"]) {
      const { gate, asked } = gateWith({ issues: [issue(T_UUID)], answer: hiddenFor(reason) });
      const { res, next, sent } = exchange();
      await gate("issue", { actor: person, params: { kyoubeRef: T_UUID }, query: {} }, res, next);
      expect(sent, reason).toEqual([{ status: 404, body: { error: "Issue not found" } }]);
      expect(next).not.toHaveBeenCalled();
      // The core's own issue:read question, as routes/issues.js asks it.
      expect(asked).toEqual([{
        actor: person,
        action: "issue:read",
        resource: { type: "issue", companyId: C, issueId: T_UUID, projectId: "p1", parentIssueId: "parent", assigneeAgentId: null, assigneeUserId: "bob", status: "todo" },
        scope: { issueId: T_UUID, projectId: "p1", parentIssueId: "parent", assigneeAgentId: null, assigneeUserId: "bob" },
      }]);
    }
    const { gate, asked } = gateWith({ projects: [{ id: P_UUID, companyId: C }], answer: hiddenFor("deny_kyoube_visibility") });
    const { res, next, sent } = exchange();
    await gate("project", { actor: person, params: { kyoubeRef: P_UUID }, query: {} }, res, next);
    expect(sent).toEqual([{ status: 404, body: { error: "Project not found" } }]);
    expect(next).not.toHaveBeenCalled();
    expect(asked).toEqual([{ actor: person, action: "project:read", resource: { type: "project", companyId: C, projectId: P_UUID } }]);
  });

  it("passes every other denial and an allow on to the core's route", async () => {
    for (const answer of [hiddenFor("deny_company_boundary"), hiddenFor("deny_missing_grant"), () => ({ allowed: true, reason: "allow_company_member" }), () => null, () => ({ allowed: false })]) {
      const { gate } = gateWith({ issues: [issue(T_UUID)], answer });
      const { res, next, sent } = exchange();
      await gate("issue", { actor: person, params: { kyoubeRef: T_UUID } }, res, next);
      expect(sent).toEqual([]);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves agents and other actors to the core without a lookup", async () => {
    for (const actor of [{ type: "agent", agentId: "a1" }, { type: "none" }, undefined, null]) {
      const { gate, lookups, asked } = gateWith({ issues: [issue(T_UUID)], answer: hiddenFor("deny_kyoube_visibility") });
      const { res, next, sent } = exchange();
      await gate("issue", { actor: actor as never, params: { kyoubeRef: T_UUID } }, res, next);
      expect(sent).toEqual([]);
      expect(next).toHaveBeenCalledTimes(1);
      expect(lookups).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it("passes an unknown or missing ref on, so the core answers it", async () => {
    const { gate, asked } = gateWith({ issues: [], answer: hiddenFor("deny_kyoube_visibility") });
    for (const params of [{ kyoubeRef: "PAP-404" }, { kyoubeRef: "  " }, {}, undefined]) {
      const { res, next, sent } = exchange();
      await gate("issue", { actor: person, params }, res, next);
      expect(sent).toEqual([]);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(asked).toEqual([]);
  });

  it("refuses when any task a ref names is hidden, as an identifier may name one in each company", async () => {
    const { gate, lookups, asked } = gateWith({
      issues: [issue("t-c", C), issue("t-d", D)],
      answer: ({ resource }) => (resource.companyId === D ? { allowed: false, reason: "deny_kyoube_visibility" } : { allowed: true }),
    });
    const { res, next, sent } = exchange();
    await gate("issue", { actor: person, params: { kyoubeRef: " pap-17 " } }, res, next);
    expect(lookups).toEqual([["issue", "pap-17", null]]);
    expect(asked.map(({ resource }) => resource.issueId)).toEqual(["t-c", "t-d"]);
    expect(sent).toEqual([{ status: 404, body: { error: "Issue not found" } }]);
    expect(next).not.toHaveBeenCalled();
  });

  it("looks a project shortname up in the company the route or the query names", async () => {
    const { gate, lookups } = gateWith({ projects: [] });
    await gate("project", { actor: person, params: { kyoubeRef: "secret" }, query: { companyId: C } }, exchange().res, vi.fn());
    await gate("project", { actor: person, params: { kyoubeRef: "secret", kyoubeCompanyId: D }, query: { companyId: C } }, exchange().res, vi.fn());
    await gate("project", { actor: person, params: { kyoubeRef: "secret" }, query: { companyId: ["x"] } }, exchange().res, vi.fn());
    expect(lookups).toEqual([["project", "secret", C], ["project", "secret", D], ["project", "secret", null]]);
  });

  it("never fails the request: a failing lookup or decision goes on to the core, logged once a minute", async () => {
    const failing = [
      gateWith({ findIssues: async () => { throw new Error("db down"); } }).gate,
      gateWith({ issues: [issue(T_UUID)], answer: () => { throw new Error("decide down"); } }).gate,
    ];
    for (const gate of failing) {
      const { res, next, sent } = exchange();
      await expect(gate("issue", { actor: person, params: { kyoubeRef: T_UUID } }, res, next)).resolves.toBeUndefined();
      expect(sent).toEqual([]);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[kyoube] visibility check failed", expect.any(Error));
  });
});

describe("coreLookups", () => {
  /** A drizzle stand-in that records each select's columns and condition. */
  function fakeDb(rows: unknown[]) {
    const queries: Array<{ columns: string[]; table: unknown; where: unknown }> = [];
    const db = { select: (columns: Record<string, unknown>) => ({ from: (table: unknown) => ({ where: async (where: unknown) => { queries.push({ columns: Object.keys(columns), table, where }); return rows; } }) }) };
    return { db, queries };
  }
  const tables = {
    issues: { id: "issues.id", identifier: "issues.identifier", companyId: "issues.companyId", projectId: "issues.projectId", parentId: "issues.parentId", assigneeAgentId: "issues.assigneeAgentId", assigneeUserId: "issues.assigneeUserId", status: "issues.status" },
    projects: { id: "projects.id", companyId: "projects.companyId" },
  };
  const ops = { eq: (column: unknown, value: unknown) => ({ eq: [column, value] }) };

  it("finds a task by id, or by its identifier upper-cased, with the columns the decision needs", async () => {
    const { db, queries } = fakeDb([issue(T_UUID)]);
    const { findIssues } = coreLookups({ db, tables, ops });
    expect(await findIssues(T_UUID)).toEqual([issue(T_UUID)]);
    await findIssues("pap-17");
    expect(queries.map(({ table, where }) => [table, where])).toEqual([[tables.issues, { eq: ["issues.id", T_UUID] }], [tables.issues, { eq: ["issues.identifier", "PAP-17"] }]]);
    expect(queries[0]!.columns.sort()).toEqual(["assigneeAgentId", "assigneeUserId", "companyId", "id", "parentId", "projectId", "status"]);
  });

  it("finds a project by id, or by shortname through the core's resolver in a named company", async () => {
    const { db, queries } = fakeDb([{ id: P_UUID, companyId: C }]);
    const resolved: Array<[string, string]> = [];
    const resolveProjectReference = async (companyId: string, reference: string) => {
      resolved.push([companyId, reference]);
      if (reference === "twins") return { project: null, ambiguous: true };
      return reference === "secret" ? { project: { id: P_UUID, companyId, urlKey: "secret" }, ambiguous: false } : { project: null, ambiguous: false };
    };
    const { findProjects } = coreLookups({ db, tables, ops, resolveProjectReference });
    expect(await findProjects(P_UUID, null)).toEqual([{ id: P_UUID, companyId: C }]);
    expect(queries.map(({ table, where }) => [table, where])).toEqual([[tables.projects, { eq: ["projects.id", P_UUID] }]]);
    expect(await findProjects("secret", C)).toEqual([{ id: P_UUID, companyId: C }]);
    expect(await findProjects("twins", C)).toEqual([]);
    expect(await findProjects("nothing", C)).toEqual([]);
    // Without a company the core does not resolve a shortname either.
    expect(await findProjects("secret", null)).toEqual([]);
    expect(resolved).toEqual([[C, "secret"], [C, "twins"], [C, "nothing"]]);
    expect(await coreLookups({ db, tables, ops }).findProjects("secret", C)).toEqual([]);
  });
});
