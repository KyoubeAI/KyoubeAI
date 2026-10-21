import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createStudioPlugin } from "../src/plugin.js";
import type { HomeSnapshot, TeamSnapshot } from "../src/model.js";

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

async function setup(clock = { now: NOW }, rulesTokenPath?: string) {
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
  const plugin = createStudioPlugin({ now: () => clock.now, rulesTokenPath });
  await plugin.definition.setup(harness.ctx);
  return { harness, clock, plugin };
}

describe("kyoube.studio worker", () => {
  it("serves the team roster for the caller's company only", async () => {
    const { harness } = await setup();
    const team = await harness.getData<TeamSnapshot>("team", { companyId: COMPANY });
    expect(team.members.map((m) => m.name)).toEqual(["Ambassador Content Agent", "AI Manager"]);
    expect(team.members[0]).toMatchObject({ state: "working", detail: "Task BAP-1", icon: "sparkles" });
  });

  it("serves Home: what needs you, the team, the week and the latest updates", async () => {
    const { harness } = await setup();
    const home = await harness.getData<HomeSnapshot>("home", { companyId: COMPANY });
    expect(home.needs.map((n) => n.kind)).toEqual(["approval", "review"]);
    expect(home.needs[0]!.title).toBe("Approval requested: New pricing page");
    expect(home.needsTotal).toBe(2);
    expect(home.doneThisWeek).toBe(1);
    expect(home.updates[0]!.identifier).toBe("BAP-1");
    expect(home.steps).toEqual({ hireAgent: true, giveTask: true, seenThrough: false });
  });

  it("serves the Workspace figures and marks owners and admins", async () => {
    const { harness } = await setup();
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "owner-1" })).toMatchObject({ agents: 2, people: 2, openTasks: 2, isAdmin: true });
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "member-1" })).toMatchObject({ isAdmin: false });
  });

  it("serves an agent's profile, with its own notes on the task it is working on", async () => {
    const { harness } = await setup();
    harness.seed({ issueComments: [
      { id: "c1", companyId: COMPANY, issueId: "i1", authorAgentId: "a1", authorUserId: null, body: "Drafted post 1 of 3", createdAt: at(5), updatedAt: at(5) },
      { id: "c2", companyId: COMPANY, issueId: "i1", authorAgentId: null, authorUserId: "owner-1", body: "Looks good", createdAt: at(4), updatedAt: at(4) },
    ] as never });
    const profile = await harness.getData<{ found: boolean; state: string; current: { task: { identifier: string }; notes: Array<{ text: string }> } }>("agent", { companyId: COMPANY, agentRef: "ambassador-content-agent" });
    expect(profile.found).toBe(true);
    expect(profile.state).toBe("working");
    expect(profile.current.task.identifier).toBe("BAP-1");
    expect(profile.current.notes.map((n) => n.text)).toEqual(["Drafted post 1 of 3"]);
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "someone-else" })).toEqual({ found: false });
    await expect(harness.getData("agent", { companyId: COMPANY })).rejects.toThrow(/agentRef is required/);
  });

  it("reads an agent's profile fresh, not from the roster's short cache", async () => {
    const { harness } = await setup();
    await harness.getData("team", { companyId: COMPANY });
    harness.seed({ agents: [agent("a3", COMPANY, "New Hire", "idle")] });
    const profile = await harness.getData<{ found: boolean }>("agent", { companyId: COMPANY, agentRef: "new-hire" });
    expect(profile.found).toBe(true);
  });

  it("refuses a call without a company", async () => {
    const { harness } = await setup();
    await expect(harness.getData("team", {})).rejects.toThrow(/companyId is required/);
  });

  it("reuses one snapshot for a few seconds, then reads again", async () => {
    const { harness, clock } = await setup();
    await harness.getData("team", { companyId: COMPANY });
    harness.seed({ agents: [agent("a3", COMPANY, "New Hire", "idle")] });
    expect((await harness.getData<TeamSnapshot>("team", { companyId: COMPANY })).total).toBe(2);
    clock.now += 10_000;
    expect((await harness.getData<TeamSnapshot>("team", { companyId: COMPANY })).total).toBe(3);
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
    const { harness, plugin } = await setup(undefined, TOKEN_PATH);
    await harness.performAction("agent.change-ask-level", { agentId: "a1", level: "any" }, asUser("owner-1"));
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: TOKEN }, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toEqual({ status: 200, body: { levels: { a1: "any" } } });
    expect(await plugin.definition.onApiRequest!(request({}))).toEqual({ status: 200, body: { levels: { a1: "any" } } });
  });

  it("refuses the route to agents, to other members, and to a wrong token", async () => {
    const { plugin } = await setup(undefined, TOKEN_PATH);
    expect(await plugin.definition.onApiRequest!(request({}, { actorType: "agent", actorId: "a1" }))).toMatchObject({ status: 403 });
    expect(await plugin.definition.onApiRequest!(request({}, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toMatchObject({ status: 403 });
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: "ef".repeat(32) }, { actorType: "user", actorId: "member-1", userId: "member-1" }))).toMatchObject({ status: 403 });
  });

  it("drops entries for agents that are gone or terminated", async () => {
    const { harness, plugin } = await setup(undefined, TOKEN_PATH);
    harness.seed({ agents: [agent("t1", COMPANY, "Retired", "terminated")] });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "ask-levels" }, { a1: "none", gone: "any", t1: "any" });
    expect(await plugin.definition.onApiRequest!(request({ rulesToken: TOKEN }))).toEqual({ status: 200, body: { levels: { a1: "none" } } });
    expect(stored(harness)).toEqual({ a1: "none" });
  });

  it("answers 404 for a route it does not own", async () => {
    const { plugin } = await setup(undefined, TOKEN_PATH);
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
