import { describe, expect, it } from "vitest";
import { CLOSED, HIDDEN, involved, isCoveredAction, isRestricted, MAX_ANCESTORS, MESSAGES, projectVisible, restrictedPeople, taskVisible, type CompanyPolicy, type PolicyState, type TaskFacts } from "../src/index.js";

const policy: CompanyPolicy = { version: 1, companyId: "c", mode: "need_to_know", writtenAt: "x", seesAll: ["boss"], projects: { p1: ["ann"], p2: ["bob"] } };
const open: PolicyState = { state: "open" };
const ntk: PolicyState = { state: "need_to_know", policy };
const closed: PolicyState = { state: "closed", reason: "index unreadable" };
const task = (id: string, over: Partial<TaskFacts> = {}): TaskFacts => ({ id, projectId: null, parentId: null, createdByUserId: null, assigneeUserId: null, responsibleUserId: null, conversationUserId: null, ...over });

describe("isRestricted", () => {
  it("restricts operators and viewers in need-to-know, never owners, admins or instance admins", () => {
    expect(isRestricted(ntk, { userId: "ann", role: "operator" })).toBe(true);
    expect(isRestricted(ntk, { userId: "ann", role: "viewer" })).toBe(true);
    expect(isRestricted(ntk, { userId: "ann", role: "Owner" })).toBe(false);
    expect(isRestricted(ntk, { userId: "ann", role: "admin" })).toBe(false);
    expect(isRestricted(ntk, { userId: "ann", role: "operator", instanceAdmin: true })).toBe(false);
  });
  it("restricts nobody in an open company", () => {
    expect(isRestricted(open, { userId: "ann", role: "viewer" })).toBe(false);
  });
  it("sees-all wins over any other group", () => {
    expect(isRestricted(ntk, { userId: "boss", role: "operator" })).toBe(false);
  });
  it("is closed for a non-manager when the policy cannot be read, and open for a manager", () => {
    expect(isRestricted(closed, { userId: "ann", role: "operator" })).toBe("closed");
    expect(isRestricted(closed, { userId: "ann", role: "admin" })).toBe(false);
  });
  it("treats a missing role as restricted", () => {
    expect(isRestricted(ntk, { userId: "ann", role: null })).toBe(true);
  });
});

describe("projectVisible and involved", () => {
  it("shows a project only to the people its groups list", () => {
    expect(projectVisible(policy, { userId: "ann", role: "operator" }, "p1")).toBe(true);
    expect(projectVisible(policy, { userId: "ann", role: "operator" }, "p2")).toBe(false);
    expect(projectVisible(policy, { userId: "ann", role: "operator" }, null)).toBe(false);
    expect(projectVisible(policy, { userId: "ann", role: "operator" }, "p9")).toBe(false);
  });
  it("counts each of the four involvement columns and the project", () => {
    const ann = { userId: "ann", role: "operator" };
    for (const key of ["createdByUserId", "assigneeUserId", "responsibleUserId", "conversationUserId"] as const) {
      expect(involved(policy, ann, task("t", { [key]: "ann" }))).toBe(true);
      expect(involved(policy, ann, task("t", { [key]: "bob" }))).toBe(false);
    }
    expect(involved(policy, ann, task("t", { projectId: "p1" }))).toBe(true);
    expect(involved(policy, ann, task("t", { projectId: "p2", createdByUserId: "bob" }))).toBe(false);
  });
});

describe("taskVisible", () => {
  const ann = { userId: "ann", role: "operator" };
  it("shows a task the person is involved in, and every task beneath it", () => {
    const root = task("r", { createdByUserId: "ann", projectId: "p2" });
    const child = task("c", { parentId: "r", projectId: "p2" });
    const grandchild = task("g", { parentId: "c", projectId: "p2", createdByUserId: "bob" });
    expect(taskVisible(policy, ann, [root])).toBe(true);
    expect(taskVisible(policy, ann, [child, root])).toBe(true);
    expect(taskVisible(policy, ann, [grandchild, child, root])).toBe(true);
    expect(taskVisible(policy, ann, [grandchild, child])).toBe(false);
  });
  it("hides a task in a hidden project with no involvement, and a project-less task of someone else", () => {
    expect(taskVisible(policy, ann, [task("t", { projectId: "p2", createdByUserId: "bob" })])).toBe(false);
    expect(taskVisible(policy, ann, [task("t", { createdByUserId: "bob" })])).toBe(false);
  });
  it("stops at twenty levels and on a cycle, denying", () => {
    const chain: TaskFacts[] = [];
    for (let i = 0; i <= MAX_ANCESTORS + 1; i += 1) chain.push(task(`t${i}`, { parentId: `t${i + 1}` }));
    chain[MAX_ANCESTORS + 1] = task(`t${MAX_ANCESTORS + 1}`, { createdByUserId: "ann" }); // one past the limit
    expect(taskVisible(policy, ann, chain)).toBe(false);
    chain[MAX_ANCESTORS] = task(`t${MAX_ANCESTORS}`, { createdByUserId: "ann" }); // exactly at the limit
    expect(taskVisible(policy, ann, chain)).toBe(true);
    const a = task("a", { parentId: "b" });
    const b = task("b", { parentId: "a" });
    expect(taskVisible(policy, ann, [a, b, a, b, a, b])).toBe(false);
  });
});

describe("covered actions, messages and restrictedPeople", () => {
  it("names exactly the six covered actions", () => {
    for (const action of ["issue:read", "issue:comment", "issue:mutate", "project:read", "company_scope:read", "tasks:assign"]) expect(isCoveredAction(action)).toBe(true);
    for (const action of ["agent:read", "issue:delete", "secrets:propose", ""]) expect(isCoveredAction(action)).toBe(false);
  });
  it("carries the two messages and denials", () => {
    expect(HIDDEN).toEqual({ reason: "deny_kyoube_visibility", explanation: MESSAGES.hidden });
    expect(CLOSED).toEqual({ reason: "deny_kyoube_visibility_unavailable", explanation: MESSAGES.closed });
  });
  it("lists the restricted members in order, counting closed as restricted", () => {
    const members = [{ userId: "own", role: "owner" }, { userId: "ann", role: "operator" }, { userId: "boss", role: "operator" }, { userId: "vic", role: "viewer" }];
    expect(restrictedPeople(ntk, members).map((m) => m.userId)).toEqual(["ann", "vic"]);
    expect(restrictedPeople(open, members)).toEqual([]);
    expect(restrictedPeople(closed, members).map((m) => m.userId)).toEqual(["ann", "boss", "vic"]);
  });
});
