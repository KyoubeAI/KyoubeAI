import { describe, expect, it } from "vitest";
import {
  canExtendPolicy, desiredGrants, isProtected, managerIds, ownTeamGrant, sameGrants, withoutProtection, withProtection, type AgentRow,
} from "../src/policy.js";

const agent = (id: string, reportsTo: string | null, status = "idle"): AgentRow => ({ id, name: id.toUpperCase(), status, reportsTo });

describe("managerIds", () => {
  it("is every agent with at least one direct report", () => {
    expect([...managerIds([agent("ceo", null), agent("cto", "ceo"), agent("dev", "cto"), agent("solo", null)])].sort()).toEqual(["ceo", "cto"]);
  });

  it("ignores terminated reports and terminated managers", () => {
    expect([...managerIds([agent("m", null), agent("r", "m", "terminated")])]).toEqual([]);
    expect([...managerIds([agent("m", null, "terminated"), agent("r", "m")])]).toEqual([]);
  });

  it("counts a report that is paused or waiting for approval", () => {
    expect([...managerIds([agent("m", null), agent("r", "m", "pending_approval")])]).toEqual(["m"]);
    expect([...managerIds([agent("m", null), agent("r", "m", "paused")])]).toEqual(["m"]);
  });

  it("ignores a reportsTo that points at no known agent", () => {
    expect([...managerIds([agent("r", "gone")])]).toEqual([]);
  });
});

describe("assignment policy", () => {
  it("adds protection and keeps every other key", () => {
    const policy = { agentVisibility: { mode: "discoverable" }, assignmentPolicy: { note: "x" } };
    expect(withProtection(policy)).toEqual({ agentVisibility: { mode: "discoverable" }, assignmentPolicy: { note: "x", mode: "protected" } });
    expect(isProtected(withProtection(null))).toBe(true);
    expect(isProtected(null)).toBe(false);
    expect(isProtected({ assignmentPolicy: { mode: "company_default" } })).toBe(false);
  });

  it("removes only what it added", () => {
    expect(withoutProtection({ assignmentPolicy: { mode: "protected" } })).toBeNull();
    expect(withoutProtection({ assignmentPolicy: { mode: "protected", note: "x" }, protectedAgent: { blockAssignment: false } }))
      .toEqual({ assignmentPolicy: { note: "x" }, protectedAgent: { blockAssignment: false } });
    expect(withoutProtection(null)).toBeNull();
  });

  it("only extends a policy the core can evaluate for assignment", () => {
    expect(canExtendPolicy(null)).toBe(true);
    expect(canExtendPolicy({ assignmentPolicy: {}, managedBy: "x", agentVisibility: {}, protectedAgent: {} })).toBe(true);
    // Core 2026.1012 evaluates its own trust sections alongside assignment policy.
    expect(canExtendPolicy({ trustPreset: "low_trust_review", trustBoundary: {}, reviewPreset: {} })).toBe(true);
    expect(canExtendPolicy({ somethingElse: true })).toBe(false);
    expect(canExtendPolicy({ assignmentPolicy: {}, somethingElse: true })).toBe(false);
  });
});

describe("desiredGrants", () => {
  const broad = { permissionKey: "tasks:assign", scope: null };
  const other = { permissionKey: "agents:create", scope: null };

  it("drops the broad assign grant and keeps every other grant", () => {
    expect(desiredGrants([broad, other], "a", false)).toEqual([other]);
  });

  it("gives a manager exactly one own-team grant", () => {
    expect(desiredGrants([broad, other, ownTeamGrant("m")], "m", true)).toEqual([other, ownTeamGrant("m")]);
    expect(ownTeamGrant("m")).toEqual({ permissionKey: "tasks:assign_scope", scope: { subtreeRootAgentId: "m" } });
  });

  it("takes the own-team grant away from a former manager", () => {
    expect(desiredGrants([ownTeamGrant("m")], "m", false)).toEqual([]);
  });

  it("keeps a scoped tasks:assign or someone else's scoped grant", () => {
    const scoped = { permissionKey: "tasks:assign", scope: { projectId: "p1" } };
    const theirs = { permissionKey: "tasks:assign_scope", scope: { subtreeRootAgentId: "m", projectId: "p1" } };
    expect(desiredGrants([scoped, theirs], "m", false)).toEqual([scoped, theirs]);
  });

  it("compares grant sets regardless of order and scope key order", () => {
    expect(sameGrants([other, { permissionKey: "x", scope: { b: 1, a: 2 } }], [{ permissionKey: "x", scope: { a: 2, b: 1 } }, other])).toBe(true);
    expect(sameGrants([other], [other, broad])).toBe(false);
  });
});
