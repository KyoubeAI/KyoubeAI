import { describe, expect, it } from "vitest";
import { reconcileGuard, revertGuard, selfTest, type GuardPort, type GuardRecord } from "../src/guard.js";
import { isProtected, ownTeamGrant, type AgentRow, type Grant, type Policy } from "../src/policy.js";

const C = "11111111-1111-4111-8111-111111111111";
const BROAD: Grant = { permissionKey: "tasks:assign", scope: null };
const agent = (id: string, reportsTo: string | null, status = "idle"): AgentRow => ({ id, name: id.toUpperCase(), status, reportsTo });
const CONFIGURE: Grant = { permissionKey: "agents:configure", scope: null };
const SKILLS: Grant = { permissionKey: "skills:create", scope: null };

/**
 * An in-memory core. `previewAssign` follows core's rule for a protected target
 * (server/src/services/authorization.ts, 2026.916.1): the actor needs the broad
 * grant, or an own-team grant whose subtree holds the target.
 */
class FakeCore implements GuardPort {
  policies = new Map<string, Policy>();
  grants = new Map<string, Grant[]>();
  record: GuardRecord = { protected: [], scoped: [], broadRemoved: [], changeGranted: {} };
  writes: string[] = [];
  failing = new Set<string>();
  /** A core that quietly stopped honouring policy writes. */
  ignorePolicyWrites = false;

  constructor(public agents: AgentRow[]) {
    for (const row of agents) this.grants.set(row.id, [BROAD]);
  }

  private fail(key: string) {
    if (this.failing.has(key)) throw new Error(`refused ${key}`);
  }

  async listAgents() { return this.agents.map((row) => ({ ...row })); }
  async getPolicy(_companyId: string, id: string) { return structuredClone(this.policies.get(id) ?? null); }
  async setPolicy(_companyId: string, id: string, policy: Policy) {
    this.fail(`setPolicy:${id}`);
    this.writes.push(`policy ${id}`);
    if (!this.ignorePolicyWrites) this.policies.set(id, structuredClone(policy));
  }
  async listGrants(_companyId: string, id: string) { return structuredClone(this.grants.get(id) ?? []); }
  async setGrants(_companyId: string, id: string, grants: Grant[]) {
    this.fail(`setGrants:${id}`);
    this.writes.push(`grants ${id}`);
    this.grants.set(id, structuredClone(grants));
  }
  async readRecord() { return structuredClone(this.record); }
  async writeRecord(_companyId: string, record: GuardRecord) {
    this.fail("writeRecord");
    this.record = structuredClone(record);
  }
  async previewAssign(_companyId: string, actor: string, target: string) {
    if (!isProtected(this.policies.get(target) ?? null)) return { allowed: true, reason: "allow_simple_company_member" };
    const held = this.grants.get(actor) ?? [];
    if (held.some((grant) => grant.permissionKey === "tasks:assign" && grant.scope === null)) return { allowed: true, reason: "allow_grant" };
    const inSubtree = (root: string, id: string) => {
      let current: string | null | undefined = id;
      for (let hops = 0; current && hops < 50; hops += 1) {
        if (current === root) return true;
        current = this.agents.find((row) => row.id === current)?.reportsTo;
      }
      return false;
    };
    const covered = held.some((grant) => {
      const root = grant.permissionKey === "tasks:assign_scope" && grant.scope ? grant.scope.subtreeRootAgentId : undefined;
      return typeof root === "string" && inSubtree(root, target);
    });
    return covered ? { allowed: true, reason: "allow_scoped_grant" } : { allowed: false, reason: "deny_restricted_assignment_policy" };
  }
}

const org = () => new FakeCore([agent("ceo", null), agent("cto", "ceo"), agent("dev", "cto"), agent("solo", null)]);

describe("reconcileGuard", () => {
  it("protects managers, gives each its own-team grant and takes the broad grant from everyone", async () => {
    const core = org();
    const report = await reconcileGuard(core, C);
    expect(report.managers).toEqual(["ceo", "cto"]);
    expect(isProtected(core.policies.get("ceo") ?? null)).toBe(true);
    expect(isProtected(core.policies.get("cto") ?? null)).toBe(true);
    expect(core.policies.has("dev")).toBe(false);
    expect(core.grants.get("cto")).toEqual([ownTeamGrant("cto")]);
    expect(core.grants.get("dev")).toEqual([]);
    expect(core.record).toEqual({ protected: ["ceo", "cto"], scoped: ["ceo", "cto"], broadRemoved: ["ceo", "cto", "dev", "solo"], changeGranted: {} });
    expect(report.updated).toEqual(["ceo", "cto", "dev", "solo"]);
    expect(report.failures).toEqual([]);
    expect(report.selfTest).toEqual({ status: "pass", detail: "CTO cannot assign to CEO; CEO can assign to CTO" });
  });

  it("makes no writes on a second pass", async () => {
    const core = org();
    await reconcileGuard(core, C);
    const writes = core.writes.length;
    const report = await reconcileGuard(core, C);
    expect(core.writes.length).toBe(writes);
    expect(report.updated).toEqual([]);
  });

  it("keeps every other policy key and every other grant", async () => {
    const core = org();
    core.policies.set("cto", { agentVisibility: { mode: "discoverable" } });
    core.grants.set("cto", [BROAD, { permissionKey: "agents:create", scope: null }]);
    await reconcileGuard(core, C);
    expect(core.policies.get("cto")).toEqual({ agentVisibility: { mode: "discoverable" }, assignmentPolicy: { mode: "protected" } });
    expect(core.grants.get("cto")).toEqual([{ permissionKey: "agents:create", scope: null }, ownTeamGrant("cto")]);
  });

  it("skips a manager whose policy the core cannot evaluate, and still fixes its grants", async () => {
    const core = org();
    core.policies.set("cto", { somethingElse: true });
    const report = await reconcileGuard(core, C);
    expect(report.skipped).toEqual([{ agentId: "cto", name: "CTO", reason: "has an authorization policy KyoubeAI does not change" }]);
    expect(core.policies.get("cto")).toEqual({ somethingElse: true });
    expect(core.grants.get("cto")).toEqual([ownTeamGrant("cto")]);
    expect(core.record.protected).toEqual(["ceo"]);
  });

  it("protects a low-trust manager: core 2026.1012 evaluates its trust policy together with assignment policy", async () => {
    const core = org();
    core.policies.set("cto", { trustPreset: "low_trust_review" });
    const report = await reconcileGuard(core, C);
    expect(report.skipped).toEqual([]);
    expect(core.policies.get("cto")).toEqual({ trustPreset: "low_trust_review", assignmentPolicy: { mode: "protected" } });
    expect(core.record.protected).toEqual(["ceo", "cto"]);
  });

  it("leaves an agent waiting for approval alone and says why", async () => {
    const core = new FakeCore([agent("m", null), agent("new", "m", "pending_approval")]);
    const report = await reconcileGuard(core, C);
    expect(report.skipped).toEqual([{ agentId: "new", name: "NEW", reason: "waiting for approval; core freezes its permissions until then" }]);
    expect(core.grants.get("new")).toEqual([BROAD]);
    expect(report.managers).toEqual(["m"]);
  });

  it("unprotects a former manager it protected, but not one someone else protected", async () => {
    const core = org();
    core.policies.set("solo", { assignmentPolicy: { mode: "protected" } });
    await reconcileGuard(core, C);
    core.agents = core.agents.map((row) => (row.id === "dev" ? { ...row, status: "terminated" } : row));
    await reconcileGuard(core, C);
    expect(core.policies.get("cto")).toBeNull();
    expect(core.grants.get("cto")).toEqual([]);
    expect(core.record.protected).toEqual(["ceo"]);
    expect(core.record.scoped).toEqual(["ceo"]);
    expect(isProtected(core.policies.get("solo") ?? null)).toBe(true);
  });

  it("goes on after one agent fails, and the record still names it", async () => {
    const core = org();
    core.failing.add("setPolicy:ceo");
    const report = await reconcileGuard(core, C);
    expect(report.failures).toEqual([{ agentId: "ceo", name: "CEO", step: "policy", error: "refused setPolicy:ceo" }]);
    expect(isProtected(core.policies.get("cto") ?? null)).toBe(true);
    expect(core.record.protected).toContain("ceo");
    core.failing.clear();
    await reconcileGuard(core, C);
    expect(isProtected(core.policies.get("ceo") ?? null)).toBe(true);
  });

  it("changes nothing for an agent when the record cannot be written first", async () => {
    const core = org();
    core.failing.add("writeRecord");
    const report = await reconcileGuard(core, C);
    expect(core.writes).toEqual([]);
    expect(report.failures.every((failure) => failure.step === "record")).toBe(true);
  });

  it("reports a failed self-test when protection does not hold on this core", async () => {
    const core = org();
    core.ignorePolicyWrites = true;
    const report = await reconcileGuard(core, C);
    expect(report.selfTest.status).toBe("fail");
    expect(report.selfTest.detail).toContain("CTO can still assign to its manager CEO");
  });

  it("calls the self-test not applicable without an active manager and report", async () => {
    const report = await reconcileGuard(new FakeCore([agent("solo", null), agent("x", "solo", "paused")]), C);
    expect(report.selfTest.status).toBe("not_applicable");
  });

  it("does not add a manager to scoped if it already has its own-team grant", async () => {
    const core = org();
    core.grants.set("cto", [BROAD, ownTeamGrant("cto")]);
    const report = await reconcileGuard(core, C);
    expect(core.record.scoped).toEqual(["ceo"]);
    expect(core.grants.get("cto")).toEqual([ownTeamGrant("cto")]);
    await revertGuard(core, C);
    const reverted = core.grants.get("cto") ?? [];
    expect(reverted).toContainEqual(BROAD);
    expect(reverted).toContainEqual(ownTeamGrant("cto"));
    expect(reverted.length).toBe(2);
  });

  it("preserves a non-manager's own-team grant if the guardrail never added it", async () => {
    const core = org();
    core.grants.set("dev", [BROAD, ownTeamGrant("dev")]);
    const report = await reconcileGuard(core, C);
    expect(core.record.scoped).toEqual(["ceo", "cto"]);
    expect(core.grants.get("dev")).toEqual([ownTeamGrant("dev")]);
    expect(core.record.broadRemoved).toContain("dev");
  });

  it("excludes skipped managers from self-test and falls back to an eligible pair", async () => {
    const core = new FakeCore([
      agent("a-mgr", null),
      agent("b-rep", "a-mgr"),
      agent("m2", null),
      agent("r2", "m2"),
    ]);
    core.policies.set("a-mgr", { somethingElse: true });
    const report = await reconcileGuard(core, C);
    expect(report.skipped).toEqual([{ agentId: "a-mgr", name: "A-MGR", reason: "has an authorization policy KyoubeAI does not change" }]);
    expect(report.selfTest.status).toBe("pass");
    expect(report.selfTest.detail).toBe("R2 cannot assign to M2; M2 can assign to R2");
    const unexcluded = await selfTest(core, C, core.agents, new Set());
    expect(unexcluded.status).toBe("fail");
  });

  it("never unprotects an agent a group still needs", async () => {
    const fake = new FakeCore([agent("boss", null), agent("a", "boss")]);
    await reconcileGuard(fake, C);
    expect(isProtected(fake.policies.get("boss") ?? null)).toBe(true);
    fake.agents = [agent("boss", null), agent("a", null)]; // boss is no longer a manager
    await reconcileGuard(fake, C, new Set(["boss"]));
    expect(isProtected(fake.policies.get("boss") ?? null)).toBe(true);
    expect(fake.record.protected).toContain("boss");
    await reconcileGuard(fake, C, new Set());
    expect(isProtected(fake.policies.get("boss") ?? null)).toBe(false);
  });
});

describe("revertGuard", () => {
  it("undoes exactly what the record lists and empties it", async () => {
    const core = org();
    core.grants.set("dev", [BROAD, { permissionKey: "agents:create", scope: null }]);
    await reconcileGuard(core, C);
    const report = await revertGuard(core, C);
    expect(report).toEqual({ reverted: ["ceo", "cto", "dev", "solo"], failures: [] });
    expect(core.policies.get("ceo")).toBeNull();
    expect(core.policies.get("cto")).toBeNull();
    expect(core.grants.get("cto")).toEqual([BROAD]);
    expect(core.grants.get("dev")).toEqual([{ permissionKey: "agents:create", scope: null }, BROAD]);
    expect(core.record).toEqual({ protected: [], scoped: [], broadRemoved: [], changeGranted: {} });
  });

  it("leaves a protection it did not set", async () => {
    const core = org();
    core.policies.set("solo", { assignmentPolicy: { mode: "protected" } });
    await reconcileGuard(core, C);
    await revertGuard(core, C);
    expect(isProtected(core.policies.get("solo") ?? null)).toBe(true);
  });

  it("keeps an agent a group still needs protected, but forgets it", async () => {
    const core = org();
    await reconcileGuard(core, C);
    const report = await revertGuard(core, C, new Set(["cto"]));
    expect(report.failures).toEqual([]);
    expect(report.reverted).toContain("cto");
    expect(isProtected(core.policies.get("cto") ?? null)).toBe(true);
    expect(core.policies.get("ceo")).toBeNull();
    expect(core.grants.get("cto")).toEqual([BROAD]);
    expect(core.record).toEqual({ protected: [], scoped: [], broadRemoved: [], changeGranted: {} });
  });

  it("drops a deleted agent from the record without a failure", async () => {
    const core = org();
    core.record = { protected: ["gone"], scoped: [], broadRemoved: ["gone"], changeGranted: { gone: ["agents:configure"] } };
    const report = await revertGuard(core, C);
    expect(report.failures).toEqual([]);
    expect(core.record).toEqual({ protected: [], scoped: [], broadRemoved: [], changeGranted: {} });
  });

  it("keeps an agent it could not revert in the record", async () => {
    const core = org();
    await reconcileGuard(core, C);
    core.failing.add("setGrants:dev");
    const report = await revertGuard(core, C);
    expect(report.failures).toEqual([{ agentId: "dev", name: "DEV", step: "grants", error: "refused setGrants:dev" }]);
    expect(core.record).toEqual({ protected: [], scoped: [], broadRemoved: ["dev"], changeGranted: {} });
  });
});

describe("the top agent's change grants", () => {
  const company = () => new FakeCore([agent("top", null), agent("cto", "top"), agent("dev", "cto")]);

  it("gives the one agent that reports to nobody what core gives its root CEO, once", async () => {
    const core = company();
    const report = await reconcileGuard(core, C);
    expect(core.grants.get("top")).toEqual(expect.arrayContaining([CONFIGURE, SKILLS, ownTeamGrant("top")]));
    expect(core.grants.get("top")).toHaveLength(3);
    expect(core.grants.get("cto")).toEqual([ownTeamGrant("cto")]);
    expect(core.grants.get("dev")).toEqual([]);
    expect(core.record.changeGranted).toEqual({ top: ["agents:configure", "skills:create"] });
    expect(report.updated).toContain("top");
    const writes = core.writes.length;
    await reconcileGuard(core, C);
    expect(core.writes.length).toBe(writes);
  });

  it("never gives them back once a person has taken them away", async () => {
    const core = company();
    await reconcileGuard(core, C);
    core.grants.set("top", (core.grants.get("top") ?? []).filter((grant) => grant.permissionKey !== "agents:configure"));
    await reconcileGuard(core, C);
    expect(core.grants.get("top")?.some((grant) => grant.permissionKey === "agents:configure")).toBe(false);
  });

  it("adds only what the agent lacks, and records only that", async () => {
    const core = company();
    core.grants.set("top", [BROAD, CONFIGURE]);
    await reconcileGuard(core, C);
    expect(core.grants.get("top")).toEqual(expect.arrayContaining([CONFIGURE, SKILLS]));
    expect(core.record.changeGranted).toEqual({ top: ["skills:create"] });
  });

  it("remembers an agent that already had both, so taking them away later sticks", async () => {
    const core = company();
    core.grants.set("top", [BROAD, CONFIGURE, SKILLS]);
    await reconcileGuard(core, C);
    expect(core.record.changeGranted).toEqual({ top: [] });
    core.grants.set("top", [ownTeamGrant("top")]);
    await reconcileGuard(core, C);
    expect(core.grants.get("top")).toEqual([ownTeamGrant("top")]);
  });

  it("gives them to nobody when more than one agent reports to nobody, as core does", async () => {
    const core = org();
    await reconcileGuard(core, C);
    expect(core.record.changeGranted).toEqual({});
    expect([...core.grants.values()].flat().some((grant) => grant.permissionKey === "agents:configure")).toBe(false);
  });

  it("does not count a built-in agent or one waiting for approval as a second top agent", async () => {
    const core = new FakeCore([agent("top", null), { ...agent("coach", null), builtIn: true }, agent("new", null, "pending_approval")]);
    await reconcileGuard(core, C);
    expect(core.record.changeGranted).toEqual({ top: ["agents:configure", "skills:create"] });
    expect(core.grants.get("coach")).toEqual([]);
    expect(core.grants.get("new")).toEqual([BROAD]);
  });

  it("gives nothing to a top agent waiting for approval", async () => {
    const core = new FakeCore([agent("top", null, "pending_approval"), agent("dev", "top")]);
    await reconcileGuard(core, C);
    expect(core.record.changeGranted).toEqual({});
    expect(core.grants.get("top")).toEqual([BROAD]);
  });

  it("revert takes back exactly the grants it added", async () => {
    const core = company();
    core.grants.set("top", [BROAD, CONFIGURE]);
    await reconcileGuard(core, C);
    const report = await revertGuard(core, C);
    expect(report.failures).toEqual([]);
    expect(core.grants.get("top")).toEqual(expect.arrayContaining([BROAD, CONFIGURE]));
    expect(core.grants.get("top")).toHaveLength(2);
    expect(core.record.changeGranted).toEqual({});
  });
});
