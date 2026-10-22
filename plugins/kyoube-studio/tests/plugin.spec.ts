import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createStudioPlugin } from "../src/plugin.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-24T09:00:00Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000);

function agent(id: string, companyId: string, name: string, status: string, icon: string | null = null) {
  return { id, companyId, name, urlKey: name.toLowerCase().replace(/\s+/g, "-"), role: "general", title: null, icon, status, reportsTo: null, lastHeartbeatAt: at(10), createdAt: at(1000), updatedAt: at(5) } as never;
}
function issue(id: string, companyId: string, identifier: string, status: string, assigneeAgentId: string | null, minutesAgo: number) {
  return { id, companyId, identifier, title: `Task ${identifier}`, status, assigneeAgentId, hiddenAt: null, createdAt: at(minutesAgo + 10), updatedAt: at(minutesAgo), completedAt: status === "done" ? at(minutesAgo) : null } as never;
}

async function setup(rulesTokenPath?: string) {
  const harness = createTestHarness({ manifest });
  harness.seed({
    agents: [agent("a1", COMPANY, "Ambassador Content Agent", "running", "sparkles"), agent("a2", COMPANY, "AI Manager", "idle"), agent("x1", OTHER, "Someone Else", "running")],
    issues: [issue("i1", COMPANY, "BAP-1", "in_progress", "a1", 1), issue("i2", COMPANY, "BAP-2", "in_review", "a2", 20), issue("i3", COMPANY, "BAP-3", "done", "a2", 60), issue("x9", OTHER, "OTH-9", "in_review", "x1", 1)],
    approvals: [{ id: "ap1", companyId: COMPANY, type: "request_board_approval", status: "pending", requestedByAgentId: "a2", requestedByUserId: null, payload: { title: "New pricing page" }, decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: at(3), updatedAt: at(3) } as never],
    accessMembers: [
      { id: "m1", companyId: COMPANY, principalType: "user", principalId: "owner-1", status: "active", membershipRole: "owner", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { id: "m2", companyId: COMPANY, principalType: "user", principalId: "member-1", status: "active", membershipRole: "member", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ] as never,
  });
  const plugin = createStudioPlugin({ rulesTokenPath });
  await plugin.definition.setup(harness.ctx);
  return { harness, plugin };
}

describe("kyoube.studio worker", () => {
  it("serves the company's agents only", async () => {
    const { harness } = await setup();
    harness.seed({ agents: [agent("t1", COMPANY, "Retired", "terminated")] });
    const { agents } = await harness.getData<{ agents: Array<Record<string, unknown>> }>("agents", { companyId: COMPANY });
    expect(agents.map((row) => row.id)).toEqual(["a1", "a2"]);
    expect(agents[0]).toMatchObject({ name: "Ambassador Content Agent", urlKey: "ambassador-content-agent", icon: "sparkles", status: "running" });
  });

  it("serves the agent profile without tasks", async () => {
    const { harness } = await setup();
    const read = await harness.getData<Record<string, unknown>>("agent", { companyId: COMPANY, agentRef: "ambassador-content-agent", userId: "owner-1" });
    expect(read).toMatchObject({ found: true, agent: { id: "a1", name: "Ambassador Content Agent", status: "running" }, access: { canChangeAgents: false, canManage: true, askLevel: "line" } });
    // Its tasks, its current task and its notes are read in the browser, as the signed-in person.
    expect(Object.keys(read).sort()).toEqual(["access", "agent", "found"]);
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "someone-else" })).toEqual({ found: false, agent: null, access: null });
    await expect(harness.getData("agent", { companyId: COMPANY })).rejects.toThrow(/agentRef is required/);
  });

  it("sends an agent's skills to the browser but nothing else from its adapter configuration", async () => {
    const { harness } = await setup();
    const config = { env: { OPENAI_API_KEY: "sk-secret" }, paperclipSkillSync: { desiredSkills: ["plugin/kyoube-apps/kyoube-data"] } };
    harness.seed({ agents: [{ ...(agent("w1", COMPANY, "Writer", "idle") as object), adapterType: "pi_local", adapterConfig: config } as never] });
    const read = await harness.getData<{ agent: Record<string, unknown> }>("agent", { companyId: COMPANY, agentRef: "writer" });
    expect(read.agent).toMatchObject({ adapterType: "pi_local", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/kyoube-apps/kyoube-data"] } } });
    expect(JSON.stringify(read)).not.toContain("sk-secret");
    expect(JSON.stringify(await harness.getData("agents", { companyId: COMPANY }))).not.toContain("sk-secret");
  });

  it("serves the Workspace figures and marks owners and admins", async () => {
    const { harness } = await setup();
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "owner-1" })).toMatchObject({ agents: 2, people: 2, isAdmin: true });
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "member-1" })).toMatchObject({ isAdmin: false });
  });

  it("workspace figures have no open-task count", async () => {
    const { harness } = await setup();
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "owner-1" })).toEqual({ agents: 2, people: 2, projects: 0, isAdmin: true });
  });

  it("reads the agents fresh on every call", async () => {
    const { harness } = await setup();
    await harness.getData("agents", { companyId: COMPANY });
    harness.seed({ agents: [agent("a3", COMPANY, "New Hire", "idle")] });
    expect((await harness.getData<{ agents: unknown[] }>("agents", { companyId: COMPANY })).agents).toHaveLength(3);
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "new-hire" })).toMatchObject({ found: true });
  });

  it("refuses a call without a company", async () => {
    const { harness } = await setup();
    for (const key of ["agents", "agent", "workspace"]) await expect(harness.getData(key, {})).rejects.toThrow(/companyId is required/);
  });
});

describe("an agent's permission to change agents", () => {
  const CONFIGURE = "agents:configure";
  const grant = (principalId: string, permissionKey: string, scope: Record<string, unknown> | null = null) =>
    ({ id: `${principalId}:${permissionKey}`, companyId: COMPANY, principalType: "agent", principalId, permissionKey, scope, grantedByUserId: null, createdAt: at(100), updatedAt: at(100) }) as never;
  const asUser = (userId: string) => ({ actor: { type: "user" as const, userId }, companyId: COMPANY });
  const keys = async (harness: Awaited<ReturnType<typeof setup>>["harness"], agentId: string) =>
    (await harness.ctx.authorization.grants.list({ companyId: COMPANY, principalType: "agent", principalId: agentId })).map((row) => row.permissionKey).sort();

  it("shows on the profile whether the agent holds it, and whether the viewer may change it", async () => {
    const { harness } = await setup();
    harness.seed({ principalGrants: [grant("a2", CONFIGURE)] });
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "ai-manager", userId: "owner-1" })).toMatchObject({ access: { canChangeAgents: true, canManage: true } });
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "ambassador-content-agent", userId: "member-1" })).toMatchObject({ access: { canChangeAgents: false, canManage: false } });
  });

  it("lets an owner switch it on and off, keeping every other grant", async () => {
    const { harness } = await setup();
    harness.seed({ principalGrants: [grant("a1", "tasks:assign_scope", { subtreeRootAgentId: "a1" })] });
    expect(await harness.performAction("agent.change-access", { agentId: "a1", on: true }, asUser("owner-1"))).toEqual({ canChangeAgents: true });
    expect(await keys(harness, "a1")).toEqual([CONFIGURE, "tasks:assign_scope"]);
    expect(await harness.performAction("agent.change-access", { agentId: "a1", on: false }, asUser("owner-1"))).toEqual({ canChangeAgents: false });
    expect(await keys(harness, "a1")).toEqual(["tasks:assign_scope"]);
  });

  it("takes away a scoped grant of it too when switched off", async () => {
    const { harness } = await setup();
    harness.seed({ principalGrants: [grant("a1", CONFIGURE, { agentIds: ["a2"] })] });
    await harness.performAction("agent.change-access", { agentId: "a1", on: false }, asUser("owner-1"));
    expect(await keys(harness, "a1")).toEqual([]);
  });

  it("refuses anyone but a company owner or admin, and agents", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("agent.change-access", { agentId: "a1", on: true }, asUser("member-1"))).rejects.toThrow(/owners and admins/);
    await expect(harness.performAction("agent.change-access", { agentId: "a1", on: true }, { actor: { type: "agent", agentId: "a2" }, companyId: COMPANY })).rejects.toThrow(/owners and admins/);
    await expect(harness.performAction("agent.change-access", { agentId: "a1", on: true }, { actor: { type: "user", userId: "owner-1" } })).rejects.toThrow(/company/);
    expect(await keys(harness, "a1")).toEqual([]);
  });

  it("refuses an agent of another company, and one waiting for approval", async () => {
    const { harness } = await setup();
    harness.seed({ agents: [agent("p1", COMPANY, "Pending Hire", "pending_approval")] });
    await expect(harness.performAction("agent.change-access", { agentId: "x1", on: true }, asUser("owner-1"))).rejects.toThrow(/not found/);
    await expect(harness.performAction("agent.change-access", { agentId: "p1", on: true }, asUser("owner-1"))).rejects.toThrow(/approved/);
  });

  it("declares the capabilities it uses", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["authorization.grants.read", "authorization.grants.write"]));
    // Tasks, approvals and comments are read in the browser as the signed-in person, so the core scopes them.
    for (const gone of ["issues.read", "approvals.read", "issue.comments.read"]) expect(manifest.capabilities).not.toContain(gone);
  });
});

describe("an agent's ask level", () => {
  const TOKEN = "cd".repeat(32);
  const TOKEN_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-studio-token-"));
  const TOKEN_PATH = path.join(TOKEN_DIR, "rules-token");
  writeFileSync(TOKEN_PATH, `${TOKEN}\n`, { mode: 0o600 });
  const asUser = (userId: string) => ({ actor: { type: "user" as const, userId }, companyId: COMPANY });
  const stored = (harness: Awaited<ReturnType<typeof setup>>["harness"]) => harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "ask-levels" });
  const request = (body: Record<string, unknown>, actor: Record<string, unknown> = { actorType: "user", actorId: "owner-1", userId: "owner-1" }) => ({
    routeKey: "ask-levels.list", method: "POST", path: "/ask-levels", params: {}, query: {}, headers: {},
    body: { companyId: COMPANY, ...body }, actor, companyId: COMPANY,
  }) as never;

  it("shows line until someone sets it, and the level once set", async () => {
    const { harness } = await setup();
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "ai-manager", userId: "owner-1" })).toMatchObject({ access: { askLevel: "line" } });
    expect(await harness.performAction("agent.change-ask-level", { agentId: "a2", level: "none" }, asUser("owner-1"))).toEqual({ askLevel: "none" });
    expect(stored(harness)).toEqual({ a2: "none" });
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "ai-manager", userId: "member-1" })).toMatchObject({ access: { askLevel: "none", canManage: false } });
  });

  it("removes the entry when set back to line", async () => {
    const { harness } = await setup();
    await harness.performAction("agent.change-ask-level", { agentId: "a2", level: "any" }, asUser("owner-1"));
    await harness.performAction("agent.change-ask-level", { agentId: "a2", level: "line" }, asUser("owner-1"));
    expect(stored(harness)).toEqual({});
  });

  it("refuses anyone but a company owner or admin, agents, and unknown levels", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("agent.change-ask-level", { agentId: "a2", level: "none" }, asUser("member-1"))).rejects.toThrow(/owners and admins/);
    await expect(harness.performAction("agent.change-ask-level", { agentId: "a2", level: "none" }, { actor: { type: "agent", agentId: "a1" }, companyId: COMPANY })).rejects.toThrow(/owners and admins/);
    await expect(harness.performAction("agent.change-ask-level", { agentId: "a2", level: "everyone" }, asUser("owner-1"))).rejects.toThrow(/none, line or any/);
    expect(stored(harness)).toBeUndefined();
  });

  it("refuses an agent of another company, one waiting for approval, and a built-in agent", async () => {
    const { harness } = await setup();
    harness.seed({ agents: [agent("p1", COMPANY, "Pending Hire", "pending_approval"), { ...(agent("b1", COMPANY, "Reflection Coach", "idle") as object), metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } } } as never] });
    await expect(harness.performAction("agent.change-ask-level", { agentId: "x1", level: "none" }, asUser("owner-1"))).rejects.toThrow(/not found/);
    await expect(harness.performAction("agent.change-ask-level", { agentId: "p1", level: "none" }, asUser("owner-1"))).rejects.toThrow(/approved/);
    await expect(harness.performAction("agent.change-ask-level", { agentId: "b1", level: "none" }, asUser("owner-1"))).rejects.toThrow(/Built-in agents/);
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "reflection-coach", userId: "owner-1" })).toMatchObject({ access: { askLevel: null } });
  });

  it("lets owners set the level of an agent that gave itself a marker the core would not read", async () => {
    const { harness } = await setup();
    harness.seed({ agents: [{ ...(agent("f1", COMPANY, "Forger", "idle") as object), metadata: { paperclipBuiltInAgent: { key: "reflection-coach" } } } as never] });
    await harness.performAction("agent.change-ask-level", { agentId: "f1", level: "none" }, asUser("owner-1"));
    expect(stored(harness)).toEqual({ f1: "none" });
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "forger", userId: "owner-1" })).toMatchObject({ access: { askLevel: "none" } });
  });

  it("gives the loop the map through its route, with the rules token or an owner", async () => {
    const { harness, plugin } = await setup(TOKEN_PATH);
    await harness.performAction("agent.change-ask-level", { agentId: "a1", level: "any" }, asUser("owner-1"));
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: TOKEN }, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toEqual({ status: 200, body: { levels: { a1: "any" } } });
    expect(await plugin.definition.onApiRequest!(request({}))).toEqual({ status: 200, body: { levels: { a1: "any" } } });
  });

  it("refuses the route to agents, to other members, and to a wrong token", async () => {
    const { plugin } = await setup(TOKEN_PATH);
    expect(await plugin.definition.onApiRequest!(request({}, { actorType: "agent", actorId: "a1" }))).toMatchObject({ status: 403 });
    expect(await plugin.definition.onApiRequest!(request({}, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toMatchObject({ status: 403 });
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: "ef".repeat(32) }, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toMatchObject({ status: 403 });
  });

  it("drops entries for agents that are gone or terminated", async () => {
    const { harness, plugin } = await setup(TOKEN_PATH);
    harness.seed({ agents: [agent("t1", COMPANY, "Retired", "terminated")] });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "ask-levels" }, { a1: "none", gone: "any", t1: "any" });
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: TOKEN }))).toEqual({ status: 200, body: { levels: { a1: "none" } } });
    expect(stored(harness)).toEqual({ a1: "none" });
  });

  it("answers 404 for a route it does not own", async () => {
    const { plugin } = await setup(TOKEN_PATH);
    expect(await plugin.definition.onApiRequest!({ ...(request({ rulesToken: TOKEN }) as object), routeKey: "other" } as never)).toMatchObject({ status: 404 });
  });

  it("declares the route and the capabilities it uses", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["api.routes.register", "plugin.state.read", "plugin.state.write"]));
    expect(manifest.apiRoutes?.map((route) => [route.routeKey, route.method, route.path, route.auth, route.companyResolution])).toEqual([
      ["ask-levels.list", "POST", "/ask-levels", "board", { from: "body", key: "companyId" }],
    ]);
    // The host refuses to install a plugin whose routeKey breaks its manifest schema
    // (pluginApiRouteDeclarationSchema in @paperclipai/shared): no capitals.
    for (const route of manifest.apiRoutes ?? []) expect(route.routeKey).toMatch(/^[a-z0-9][a-z0-9._:-]*$/);
  });
});
