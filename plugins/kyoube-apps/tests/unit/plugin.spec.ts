import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import type { AppServiceDeps } from "../../src/apps/service.js";
import { TaskService, type TaskServiceDeps } from "../../src/tasks/service.js";
import type { DataService, DataServiceDeps, MutationEvent } from "../../src/data/service.js";
import manifest from "../../src/manifest.js";
import { actorFromAction, createAppsPlugin } from "../../src/plugin.js";
import { createStubService } from "../stub-service.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ADMIN = { type: "user" as const, userId: "admin-1" };

const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
// Setup writes the visibility policy; tests point it here, never at /kyoubeai.
const VISIBILITY_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-visibility-"));

function apiRequest(overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  return { routeKey: "tables.list", method: "GET", path: "/tables", params: {}, query: {}, body: undefined, actor: { actorType: "user", actorId: "admin-1", userId: "admin-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

/** The other route family this worker serves (`handleAppsApiRequest`, ruling P3-R8). */
function appsApiRequest(overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  return apiRequest({ routeKey: "apps.list", path: "/apps", ...overrides });
}

async function setup(opts: { rulesTokenPath?: string; before?: (harness: ReturnType<typeof createTestHarness>) => void } = {}) {
  const harness = createTestHarness({ manifest });
  opts.before?.(harness);
  harness.seed({
    accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder", status: "idle" } as never],
    // Two companies exist before the worker starts; the skill-install tests
    // below expect both to be served without anyone pressing a button.
    companies: [{ id: COMPANY, name: "Acme" } as never, { id: OTHER_COMPANY, name: "Beta" } as never],
  });
  const stub = createStubService();
  const poolEnds: string[] = [];
  const fakePool = { query: async () => ({ rows: [{ ok: 1 }] }), end: async () => void poolEnds.push("end") };
  let serviceDeps: DataServiceDeps | null = null;
  let appDeps: AppServiceDeps | null = null;
  let taskDeps: TaskServiceDeps | null = null;
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    visibilityDir: VISIBILITY_DIR,
    createPool: () => fakePool as never,
    migrate: async () => [],
    rulesTokenPath: opts.rulesTokenPath,
    createService: (deps) => {
      serviceDeps = deps;
      return stub.service;
    },
    // The same stub records both services' calls, so an action reaching the
    // apps service shows up in `calls` exactly as a data action does.
    createAppService: (deps) => {
      appDeps = deps;
      return stub.service as never;
    },
    createTaskService: (deps) => {
      taskDeps = deps;
      return new TaskService(deps);
    },
  });
  await plugin.definition.setup(harness.ctx);
  // Setup itself calls the data service (`attach`, for the guardrail and AI columns); the tests
  // count only what the actions and reads they make reach.
  stub.calls.length = 0;
  return { harness, plugin, poolEnds, serviceDeps: serviceDeps as unknown as DataServiceDeps, appDeps: appDeps as unknown as AppServiceDeps, taskDeps: taskDeps as unknown as TaskServiceDeps, ...stub };
}

type ActionHandler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;

/**
 * Same plugin, but the action handlers are captured directly so a test can hand them a
 * `PluginPerformActionContext` the harness cannot build — the harness always injects its
 * own `companyId` option into `params.companyId` before a handler sees it, so a
 * `params.companyId` that contradicts the host's scope is only reachable from here.
 */
async function setupRaw() {
  const harness = createTestHarness({ manifest });
  const handlers = new Map<string, ActionHandler>();
  const stub = createStubService();
  const ctx = { ...harness.ctx, actions: { register: (key: string, handler: ActionHandler) => void handlers.set(key, handler) } };
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    visibilityDir: VISIBILITY_DIR,
    createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} }) as never,
    migrate: async () => [],
    createService: () => stub.service,
  });
  await plugin.definition.setup(ctx);
  stub.calls.length = 0;
  const context = (companyId: string | null): PluginPerformActionContext => ({
    actor: { type: "user", userId: "admin-1", agentId: null, runId: null, companyId },
    companyId,
  });
  return { ...stub, call: (key: string, params: Record<string, unknown>, ctxCompanyId: string | null) => handlers.get(key)!(params, context(ctxCompanyId)) };
}

// Mirrors upstream's UI_SLOT_CAPABILITIES and FEATURE_CAPABILITIES
// (server/src/services/plugin-capability-validator.ts, Paperclip 2026.831.1)
// for the slot types and features this manifest actually uses. Upstream
// re-derives the required set on every `POST /api/plugins/install` and rejects
// the whole manifest with "inconsistent capabilities" when one is missing, so a
// slot added without its capability breaks the container install — which no
// other unit test here would notice.
const SLOT_CAPABILITIES: Record<string, string> = {
  page: "ui.page.register",
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  routeSidebar: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentContextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  settingsPage: "instance.settings.register",
  companySettingsPage: "instance.settings.register",
};
const FEATURE_CAPABILITIES: Array<[keyof typeof manifest, string]> = [
  ["tools", "agent.tools.register"],
  ["jobs", "jobs.schedule"],
  ["webhooks", "webhooks.receive"],
];

describe("kyoube.apps manifest", () => {
  it("declares every capability its slots and features require", () => {
    const required = new Set<string>();
    for (const slot of manifest.ui?.slots ?? []) {
      const capability = SLOT_CAPABILITIES[slot.type];
      expect(capability, `unmapped UI slot type ${slot.type}`).toBeDefined();
      required.add(capability!);
    }
    for (const [feature, capability] of FEATURE_CAPABILITIES) {
      if (Array.isArray(manifest[feature]) && (manifest[feature] as unknown[]).length > 0) required.add(capability);
    }
    expect([...required].filter((capability) => !manifest.capabilities.includes(capability as never))).toEqual([]);
  });

  it("has no agent detail tab: core 2026.1005.0 renders plugin detail tabs only for issues, projects and workspaces (R20)", async () => {
    expect((manifest.ui?.slots ?? []).map((slot) => [slot.type, slot.id])).toEqual([
      ["page", "data-page"],
      ["sidebar", "data-nav"],
      ["companySettingsPage", "data-access"],
      ["companySettingsPage", "groups"],
      ["page", "apps-page"],
      ["sidebar", "apps-nav"],
    ]);
    expect(manifest.capabilities).not.toContain("ui.detailTab.register");
    const { harness } = await setup();
    await expect(harness.performAction("groups.agent", { agentId: "agent-1" }, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow();
  });

  it("declares the capability the automatic skill install needs", () => {
    // `ctx.events.on("company.created")`; without it the host rejects the
    // subscription at runtime, not at install time.
    expect(manifest.capabilities).toContain("events.subscribe");
  });

  it("never enumerates companies, during setup or any skill-install path", async () => {
    // The worker never enumerates companies itself: a call made outside a host-issued invocation has
    // no company scope, and the host refuses `skills.managed.reconcile` without one ("company context
    // is required"). `companies.read` is declared only so that `taskUrl` can `companies.get` the
    // invocation's own company for its issue prefix (docs/app-tasks.md).
    let listed = 0;
    const { harness, plugin } = await setup({
      before: (h) => {
        const list = h.ctx.companies.list.bind(h.ctx.companies);
        h.ctx.companies.list = async (input) => { listed++; return list(input); };
      },
    });
    await plugin.definition.onApiRequest?.(apiRequest({
      routeKey: "skills.install", method: "POST", path: "/skills/install", body: { companyId: COMPANY },
      actor: { actorType: "user", actorId: "admin-1", userId: "admin-1" }, companyId: COMPANY,
    }));
    await harness.getData("data.access", { companyId: OTHER_COMPANY, userId: "admin-1" });
    await harness.emit("company.created", { id: "33333333-3333-4333-8333-333333333333", name: "Gamma" }, { companyId: "33333333-3333-4333-8333-333333333333" });
    await harness.performAction("data.setup_company", {}, { actor: ADMIN, companyId: COMPANY });
    expect((await harness.ctx.skills.managed.get("kyoube-data", OTHER_COMPANY)).status).toBe("resolved");
    expect(listed).toBe(0);
  });

  it("declares exactly what app tasks need, and never posting comments on issues (docs/app-tasks.md)", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "issues.create", "issues.update", "issues.wakeup", "issue.comments.read", "authorization.policies.read", "companies.read",
      "agents.read", "access.members.read",
    ]));
    expect(manifest.capabilities).not.toContain("issue.comments.create");
    expect(new Set(manifest.capabilities).size).toBe(manifest.capabilities.length);
  });

  it("declares a board-only route that installs the skills into one company", () => {
    const route = manifest.apiRoutes?.find((candidate) => candidate.routeKey === "skills.install");
    expect(route).toMatchObject({ method: "POST", path: "/skills/install", auth: "board", companyResolution: { from: "body", key: "companyId" } });
  });

  it("declares api.routes.register for its scoped API routes", () => {
    expect(manifest.apiRoutes?.length ?? 0).toBeGreaterThan(0);
    expect(manifest.capabilities).toContain("api.routes.register");
  });
});

describe("kyoube.apps plugin wiring", () => {
  it("maps action actors and rejects system callers", () => {
    expect(actorFromAction({ actor: { type: "user", userId: "u1", agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY })).toEqual({ kind: "user", id: "u1", runId: null });
    expect(actorFromAction({ actor: { type: "agent", userId: null, agentId: "a1", runId: "r1", companyId: COMPANY }, companyId: COMPANY })).toEqual({ kind: "agent", id: "a1", runId: "r1" });
    expect(() => actorFromAction({ actor: { type: "system", userId: null, agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY })).toThrow("forbidden");
  });

  it("registers every tool, serves UI data, and routes actions with the actor", async () => {
    const { harness, calls } = await setup();
    await harness.executeTool("data_list_tables", {}, { companyId: COMPANY, agentId: "agent-1" });
    expect(calls.at(-1)).toMatchObject({ method: "listTables", args: [COMPANY, { kind: "agent", id: "agent-1" }] });
    const tables = await harness.getData("data.tables", { companyId: COMPANY, userId: "admin-1" });
    expect(tables).toEqual([{ name: "contacts", displayName: "Contacts", description: null, fields: [], createdAt: "", updatedAt: "" }]);
    await harness.performAction("data.create_table", { name: "deals", fields: [] }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "createTable", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, { name: "deals", displayName: undefined, description: undefined, fields: [] }] });
    await harness.performAction("data.insert", { table: "deals", rows: [{ title: "x" }] }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "insert", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "deals", [{ title: "x" }]] });
  });

  it("registers every UI data key and action", async () => {
    const { harness, calls } = await setup();
    const reads: Array<[string, Record<string, unknown>]> = [
      ["data.tables", {}],
      ["data.table", { table: "contacts" }],
      ["data.rows", { table: "contacts", limit: 10 }],
      ["data.count", { table: "contacts" }],
      ["data.access", {}],
    ];
    for (const [key, params] of reads) await harness.getData(key, { companyId: COMPANY, userId: "admin-1", ...params });
    expect(calls.map((call) => call.method)).toEqual(["listTables", "describeTable", "query", "count", "myAccess"]);
    // Ruling P2-R10: a read carries the named user as its (advisory) actor.
    expect(calls.map((call) => call.args[1])).toEqual(calls.map(() => ({ kind: "user", id: "admin-1", runId: null })));

    calls.length = 0;
    const actions: Array<[string, Record<string, unknown>]> = [
      ["data.create_table", { name: "deals", fields: [] }],
      ["data.add_field", { table: "deals", field: { name: "value", kind: "integer" } }],
      ["data.update_field", { table: "deals", field: "value", required: true }],
      ["data.remove_field", { table: "deals", field: "value" }],
      ["data.rename_table", { table: "deals", newName: "opportunities" }],
      ["data.drop_table", { table: "deals" }],
      ["data.insert", { table: "deals", rows: [{ title: "x" }] }],
      ["data.update", { table: "deals", ids: ["r1"], patch: { title: "y" } }],
      ["data.delete", { table: "deals", ids: ["r1"] }],
      ["data.sql_select", { sql: "select 1", params: [] }],
      ["data.grants", {}],
      ["data.set_agent_grant", { agentId: "agent-1", level: "write" }],
      ["data.set_settings", { defaultAgentLevel: "read", hardDelete: false }],
      ["data.setup_company", {}],
    ];
    for (const [key, params] of actions) await harness.performAction(key, params, { actor: ADMIN, companyId: COMPANY });
    expect(calls.map((call) => call.method)).toEqual([
      "createTable", "addField", "updateField", "removeField", "renameTable", "dropTable", "insert", "update", "delete", "sqlSelect",
      "getSettings", "listAgentGrants", "setAgentGrant", "setSettings", "getSettings", "scope",
    ]);
    // Levels reach the service parsed, never as raw strings from the bridge.
    expect(calls.find((call) => call.method === "setAgentGrant")?.args).toEqual([COMPANY, { kind: "user", id: "admin-1", runId: null }, "agent-1", "write"]);
    expect(calls.find((call) => call.method === "setSettings")?.args[2]).toEqual({ defaultAgentLevel: "read", hardDelete: false });
    await expect(harness.performAction("data.set_agent_grant", { agentId: "agent-1", level: "root" }, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("access level must be one of");
  });

  it("returns grants with the agent directory and reconciles the skill on setup_company", async () => {
    const { harness, calls } = await setup();
    const grants = await harness.performAction<{ agents: Array<{ id: string; name: string }> }>("data.grants", {}, { actor: ADMIN, companyId: COMPANY });
    expect(grants.agents).toEqual([{ id: "agent-1", name: "Builder", status: "idle" }]);
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["getSettings", "listAgentGrants"]));
    // (named `resolution`, not `setup`: a local `const setup` here would shadow
    // the `setup()` helper this test already called, in its own TDZ.)
    // Both managed skills are reconciled: a company that has Data set up also
    // has the Apps skill available to its agents.
    const resolution = await harness.performAction<{ data: { status: string }; apps: { status: string } }>("data.setup_company", {}, { actor: ADMIN, companyId: COMPANY });
    expect(resolution.data.status).toBeDefined();
    expect(resolution.apps.status).toBeDefined();
  });

  it("installs both skills into the route's company when the board calls skills.install", async () => {
    const { harness, plugin } = await setup();
    expect((await harness.ctx.skills.managed.get("kyoube-data", COMPANY)).status).toBe("missing");
    const response = await plugin.definition.onApiRequest?.(apiRequest({
      routeKey: "skills.install", method: "POST", path: "/skills/install", body: { companyId: COMPANY },
      // A board key reaches a plugin route as a user actor (the key's owner).
      actor: { actorType: "user", actorId: "admin-1", userId: "admin-1" }, companyId: COMPANY,
    }));
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ data: { status: expect.any(String) }, apps: { status: expect.any(String) } });
    expect((await harness.ctx.skills.managed.get("kyoube-data", COMPANY)).status).toBe("resolved");
    expect((await harness.ctx.skills.managed.get("kyoube-apps", COMPANY)).status).toBe("resolved");
    // Only the route's company: the host scopes the invocation to it.
    expect((await harness.ctx.skills.managed.get("kyoube-data", OTHER_COMPANY)).status).toBe("missing");
  });

  it("installs the skills the first time a company's access is read", async () => {
    const { harness } = await setup();
    expect((await harness.ctx.skills.managed.get("kyoube-data", COMPANY)).status).toBe("missing");
    const access = await harness.getData<{ level: string }>("data.access", { companyId: COMPANY, userId: "admin-1" });
    expect(access.level).toBe("write");
    expect((await harness.ctx.skills.managed.get("kyoube-data", COMPANY)).status).toBe("resolved");
    expect((await harness.ctx.skills.managed.get("kyoube-apps", COMPANY)).status).toBe("resolved");
  });

  it("installs the skills into a company created after the worker started", async () => {
    const { harness } = await setup();
    const created = "33333333-3333-4333-8333-333333333333";
    expect((await harness.ctx.skills.managed.get("kyoube-data", created)).status).toBe("missing");
    await harness.emit("company.created", { id: created, name: "Gamma" }, { companyId: created });
    expect((await harness.ctx.skills.managed.get("kyoube-data", created)).status).toBe("resolved");
    expect((await harness.ctx.skills.managed.get("kyoube-apps", created)).status).toBe("resolved");
  });

  it("still answers the access read when the skill install fails, and retries on the next read", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
    const managed = harness.ctx.skills.managed;
    const warnings: string[] = [];
    let storeDown = true;
    const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const ctx = {
      ...harness.ctx,
      logger: { ...harness.ctx.logger, warn: (message: string) => void warnings.push(message) },
      data: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => void dataHandlers.set(key, handler) },
      skills: { managed: { ...managed, reconcile: async (key: string, companyId: string) => { if (storeDown) throw new Error("skill store down"); return managed.reconcile(key, companyId); } } },
    };
    const plugin = createAppsPlugin({ loadKyoubeConfig: async () => KYOUBE_CONFIG, migrationsDir: "/nowhere", visibilityDir: VISIBILITY_DIR, createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} }) as never, migrate: async () => [], createService: () => createStubService().service });
    await plugin.definition.setup(ctx as never);
    const read = dataHandlers.get("data.access")!;
    expect(await read({ companyId: COMPANY, userId: "admin-1" })).toMatchObject({ level: "write" });
    expect(warnings.some((message) => message.includes("skill"))).toBe(true);
    expect((await managed.get("kyoube-data", COMPANY)).status).toBe("missing");
    storeDown = false;
    await read({ companyId: COMPANY, userId: "admin-1" });
    expect((await managed.get("kyoube-data", COMPANY)).status).toBe("resolved");
  });

  it("answers a failed skills.install route call with a 5xx and no raw error", async () => {
    const harness = createTestHarness({ manifest });
    const managed = harness.ctx.skills.managed;
    const ctx = { ...harness.ctx, skills: { managed: { ...managed, reconcile: async () => { throw new Error("pg: connection refused at 10.0.0.9"); } } } };
    const plugin = createAppsPlugin({ loadKyoubeConfig: async () => KYOUBE_CONFIG, migrationsDir: "/nowhere", visibilityDir: VISIBILITY_DIR, createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} }) as never, migrate: async () => [], createService: () => createStubService().service });
    await plugin.definition.setup(ctx as never);
    const response = await plugin.definition.onApiRequest?.(apiRequest({ routeKey: "skills.install", method: "POST", path: "/skills/install", body: { companyId: COMPANY } }));
    expect(response?.status).toBe(500);
    expect(JSON.stringify(response?.body)).not.toContain("10.0.0.9");
  });

  it("refuses the skills.install route to an agent even if the host let it through", async () => {
    const { plugin, harness } = await setup();
    const response = await plugin.definition.onApiRequest?.(apiRequest({ routeKey: "skills.install", method: "POST", path: "/skills/install", body: { companyId: COMPANY }, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" } }));
    expect(response?.status).toBe(403);
    expect((await harness.ctx.skills.managed.get("kyoube-data", COMPANY)).status).toBe("missing");
  });

  it("routes app actions and app tools", async () => {
    const { harness, calls } = await setup();
    await harness.performAction("apps.runtime", { slug: "crm" }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "runtime", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "crm", ""] });
    await harness.performAction("apps.data", { slug: "crm", method: "query", params: { table: "contacts" } }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "runtimeData", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "crm", "query", { table: "contacts" }] });
    await harness.executeTool("apps_list", {}, { companyId: COMPANY, agentId: "agent-1" });
    expect(calls.at(-1)).toMatchObject({ method: "list" });
  });

  it("registers every app action with the host's actor", async () => {
    const { harness, calls } = await setup();
    const appManifest = { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] };
    const source = "<html><body>ok</body></html>";
    const actions: Array<[string, Record<string, unknown>]> = [
      ["apps.list", {}],
      ["apps.get", { slug: "crm" }],
      ["apps.create", { manifest: appManifest, source, notes: "first" }],
      ["apps.update", { slug: "crm", manifest: appManifest, source }],
      ["apps.publish", { slug: "crm" }],
      ["apps.rollback", { slug: "crm", version: 2 }],
      ["apps.archive", { slug: "crm" }],
    ];
    for (const [key, params] of actions) await harness.performAction(key, params, { actor: ADMIN, companyId: COMPANY });
    expect(calls.map((call) => call.method)).toEqual(["list", "get", "create", "update", "publish", "rollback", "archive"]);
    expect(calls.every((call) => call.args[0] === COMPANY)).toBe(true);
    expect(calls.map((call) => call.args[1])).toEqual(calls.map(() => ({ kind: "user", id: "admin-1", runId: null })));
    // The merged runner asks for `version: "latest"` (a string); publish/rollback take numbers.
    expect(calls[1]?.args[3]).toBe("latest");
    expect(calls[2]?.args.slice(2)).toEqual([appManifest, source, "first"]);
    expect(calls[3]?.args.slice(2)).toEqual(["crm", appManifest, source, null]);
    expect(calls[5]?.args[3]).toBe(2);
  });

  it("registers the four task actions and passes each to its runtime method", async () => {
    const { harness, calls } = await setup();
    const as = { actor: ADMIN, companyId: COMPANY };
    const user = { kind: "user", id: "admin-1", runId: null };
    await harness.performAction("apps.task_start", { slug: "crm", template: "draft_reply", rowId: "r1", inputs: { tone: "formal" } }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeTaskStart", args: [COMPANY, user, "crm", "draft_reply", { rowId: "r1", inputs: { tone: "formal" } }] });
    await harness.performAction("apps.task_get", { slug: "crm", id: "issue-1" }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeTaskGet", args: [COMPANY, user, "crm", "issue-1"] });
    await harness.performAction("apps.task_list", { slug: "crm", template: "draft_reply", rowId: "r1" }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeTaskList", args: [COMPANY, user, "crm", { template: "draft_reply", rowId: "r1" }] });
    await harness.performAction("apps.task_list", { slug: "crm" }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeTaskList", args: [COMPANY, user, "crm", {}] });
    await harness.performAction("apps.task_cancel", { slug: "crm", id: "issue-1" }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeTaskCancel", args: [COMPANY, user, "crm", "issue-1"] });
    const before = calls.length;
    await expect(harness.performAction("apps.task_start", { slug: "crm" }, as)).rejects.toThrow("template is required");
    await expect(harness.performAction("apps.task_get", { slug: "crm" }, as)).rejects.toThrow("id is required");
    await expect(harness.performAction("apps.task_list", { slug: "crm", rowId: 5 }, as)).rejects.toThrow("rowId must be a string");
    expect(calls).toHaveLength(before);
  });

  it("passes tasksConfirmed from the publish and rollback actions", async () => {
    const { harness, calls } = await setup();
    const as = { actor: ADMIN, companyId: COMPANY };
    await harness.performAction("apps.publish", { slug: "crm", tasksConfirmed: true }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: false, tasksConfirmed: true }]);
    await harness.performAction("apps.rollback", { slug: "crm", version: 2, tasksConfirmed: true }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", 2, { decisionsConfirmed: false, tasksConfirmed: true }]);
    await harness.performAction("apps.publish", { slug: "crm", tasksConfirmed: "yes" }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: false }]);
  });

  it("hands the app service the task service, the agent directory and the task store", async () => {
    const { appDeps, taskDeps } = await setup();
    expect(appDeps.tasks).toBeInstanceOf(TaskService);
    expect(appDeps.taskStore).toBe(taskDeps.store);
    expect(await appDeps.agents!.list(COMPANY)).toEqual([{ id: "agent-1", name: "Builder", status: "idle" }]);
  });

  it("builds task links from the company's issue prefix, and falls back to the issue id without failing", async () => {
    const PREFIXED = "33333333-3333-4333-8333-333333333333";
    let lookups = 0;
    const { harness, taskDeps } = await setup({
      before: (h) => {
        h.seed({ companies: [{ id: PREFIXED, name: "Gamma", issuePrefix: "GAM" } as never] });
        const get = h.ctx.companies.get.bind(h.ctx.companies);
        h.ctx.companies.get = async (companyId: string) => {
          lookups++;
          if (companyId === "boom") throw new Error("host down");
          return get(companyId);
        };
      },
    });
    expect(await taskDeps.taskUrl(PREFIXED, { id: "i-1", identifier: "GAM-7" })).toBe("/GAM/issues/GAM-7");
    expect(await taskDeps.taskUrl(PREFIXED, { id: "i-2", identifier: null })).toBe("/GAM/issues/i-2");
    expect(lookups).toBe(1);
    // Seeded without a prefix, and a lookup that throws: the bare issue path, with a warning.
    expect(await taskDeps.taskUrl(COMPANY, { id: "i-3", identifier: "ACM-1" })).toBe("/issues/i-3");
    expect(await taskDeps.taskUrl("boom", { id: "i-4" })).toBe("/issues/i-4");
    const warned = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("issue prefix"));
    expect(warned.length).toBeGreaterThanOrEqual(2);
    expect(warned.some((entry) => String(entry.meta?.error).includes("host down"))).toBe(true);
  });

  it("adapts ctx.issues, the assignment preview and the agent lookup to what the task service needs", async () => {
    const seen: Record<string, unknown[]> = {};
    const { taskDeps } = await setup({
      before: (h) => {
        const spy = <T extends (...args: never[]) => unknown>(name: string, fn: T): T => ((...args: never[]) => { seen[name] = args; return fn(...args); }) as T;
        h.ctx.issues.create = spy("create", h.ctx.issues.create.bind(h.ctx.issues));
        h.ctx.issues.requestWakeup = spy("requestWakeup", h.ctx.issues.requestWakeup.bind(h.ctx.issues));
        h.ctx.issues.update = spy("update", h.ctx.issues.update.bind(h.ctx.issues));
        h.ctx.authorization.policies.previewAssignment = spy("previewAssignment", h.ctx.authorization.policies.previewAssignment.bind(h.ctx.authorization.policies));
        h.seed({
          issues: [{ id: "seeded", companyId: COMPANY, title: "t", status: "done", assigneeAgentId: "agent-1" } as never],
          issueComments: [{ id: "c1", companyId: COMPANY, issueId: "seeded", authorType: "agent", authorAgentId: "agent-1", authorUserId: null, body: "Done.", createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z" } as never],
        });
      },
    });
    const created = await taskDeps.issues.create({ companyId: COMPANY, title: "Reply", description: "Body", status: "todo", assigneeAgentId: "agent-1", actor: { actorUserId: "admin-1" } });
    expect(seen.create).toEqual([{ companyId: COMPANY, title: "Reply", description: "Body", status: "todo", assigneeAgentId: "agent-1", actor: { actorUserId: "admin-1" } }]);
    expect(seen.create![0]).not.toHaveProperty("surfaceVisibility");
    expect(created.id).toEqual(expect.any(String));
    await expect(taskDeps.issues.requestWakeup(created.id, COMPANY, { reason: "kyoube_app_task", actorUserId: "admin-1" })).resolves.toMatchObject({ queued: true });
    expect(seen.requestWakeup).toEqual([created.id, COMPANY, { reason: "kyoube_app_task", actorUserId: "admin-1" }]);
    await taskDeps.issues.update(created.id, { status: "cancelled" }, COMPANY, { actorUserId: "admin-1" });
    expect(seen.update).toEqual([created.id, { status: "cancelled" }, COMPANY, { actorUserId: "admin-1" }]);
    expect(await taskDeps.issues.listComments("seeded", COMPANY)).toEqual([
      { body: "Done.", authorType: "agent", authorAgentId: "agent-1", createdAt: "2026-10-11T10:00:00.000Z", deletedAt: null },
    ]);
    expect(await taskDeps.previewAssignment(COMPANY, "admin-1", "agent-1")).toMatchObject({ allowed: true, explanation: expect.any(String) });
    expect(seen.previewAssignment).toEqual([{ companyId: COMPANY, actor: { type: "board", userId: "admin-1", companyIds: [COMPANY] }, target: { assigneeAgentId: "agent-1" } }]);
    expect(await taskDeps.agent(COMPANY, "agent-1")).toMatchObject({ id: "agent-1", name: "Builder", status: "idle" });
    expect(await taskDeps.agent(COMPANY, "nobody")).toBeNull();
  });

  // M1: `notes` is stored free text, so the action validates it (the tool
  // schema already does) instead of casting whatever arrives to a string.
  it("validates the notes on app write actions", async () => {
    const { harness, calls } = await setup();
    const appManifest = { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] };
    const source = "<html><body>ok</body></html>";
    const as = { actor: ADMIN, companyId: COMPANY };
    await expect(harness.performAction("apps.create", { manifest: appManifest, source, notes: 7 }, as)).rejects.toThrow("notes must be a string");
    await expect(harness.performAction("apps.update", { slug: "crm", manifest: appManifest, source, notes: "x".repeat(2001) }, as)).rejects.toThrow("2000");
    expect(calls).toHaveLength(0);
    // Absent and null both mean "no note"; a valid string is passed through.
    await harness.performAction("apps.create", { manifest: appManifest, source, notes: null }, as);
    expect(calls.at(-1)?.args.at(-1)).toBeNull();
    await harness.performAction("apps.update", { slug: "crm", manifest: appManifest, source, notes: "second draft" }, as);
    expect(calls.at(-1)?.args.at(-1)).toBe("second draft");
  });

  // The action layer rejects a method the runtime does not have before the
  // service is reached, so a page cannot probe AppService's surface.
  it("rejects unknown app data methods and malformed versions before the service", async () => {
    const { harness, calls } = await setup();
    await expect(harness.performAction("apps.data", { slug: "crm", method: "sqlSelect", params: {} }, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("unknown app data method");
    await expect(harness.performAction("apps.get", { slug: "crm", version: "newest" }, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("version must be an integer");
    await expect(harness.performAction("apps.rollback", { slug: "crm", version: "two" }, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("version must be an integer");
    await expect(harness.performAction("apps.runtime", {}, { actor: ADMIN, companyId: COMPANY })).rejects.toThrow("slug is required");
    expect(calls).toHaveLength(0);
  });

  it("dispatches API requests and reports health", async () => {
    const { harness, plugin, calls } = await setup();
    const response = await plugin.definition.onApiRequest?.(apiRequest());
    expect(response?.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: "listTables" });
    // Ruling P3-R8: the apps routes are served from the same closure-held
    // services, and reach the AppService rather than the data dispatcher.
    const app = await plugin.definition.onApiRequest?.(apiRequest({ routeKey: "apps.get", method: "GET", path: "/apps/:slug", params: { slug: "crm" } }));
    expect(app?.status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "get", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "crm", "latest"] });
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok" });
    expect(harness.logs.some((entry) => entry.message.includes("kyoube.apps"))).toBe(true);
  });

  // Ruling P2-R6: the host's company scope wins. A different `params.companyId`
  // is a spoofing attempt, not a fallback; the fallback applies only to a call
  // the host did not scope at all.
  it("rejects a params.companyId that contradicts the host's company scope", async () => {
    const { call, calls } = await setupRaw();
    await expect(call("data.drop_table", { companyId: OTHER_COMPANY, table: "contacts" }, COMPANY)).rejects.toThrow("companyId does not match");
    expect(calls).toHaveLength(0);
    // The matching value is still accepted (the production bridge injects exactly this).
    await expect(call("data.drop_table", { companyId: COMPANY, table: "contacts" }, COMPANY)).resolves.toBeDefined();
    expect(calls.at(-1)?.args[0]).toBe(COMPANY);
    // Unscoped by the host: params.companyId is the only source left.
    await expect(call("data.drop_table", { companyId: OTHER_COMPANY, table: "contacts" }, null)).resolves.toBeDefined();
    expect(calls.at(-1)?.args[0]).toBe(OTHER_COMPANY);
    await expect(call("data.drop_table", { table: "contacts" }, null)).rejects.toThrow("companyId is required");
  });

  // Ruling P2-R5: the service lives in the plugin instance's closure, so a
  // worker whose setup has not run (or has shut down) serves 503 rather than
  // reaching for a stale module-level singleton.
  it("serves 503 before setup and after shutdown, closing the pool once", async () => {
    const plugin = createAppsPlugin({ loadKyoubeConfig: async () => KYOUBE_CONFIG, migrationsDir: "/nowhere", visibilityDir: VISIBILITY_DIR, createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} }) as never, migrate: async () => [] });
    // One body for both route families: the same worker serves `/tables` and
    // `/apps`, and "data service not ready" was wrong about half of them.
    expect(await plugin.definition.onApiRequest?.(apiRequest())).toEqual({ status: 503, body: { error: "plugin not ready" } });
    expect(await plugin.definition.onApiRequest?.(appsApiRequest())).toEqual({ status: 503, body: { error: "plugin not ready" } });
    // Health must agree with the bridge: nothing to serve is never "ok".
    expect(await plugin.definition.onHealth?.()).toEqual({ status: "degraded", message: "kyoube.apps not ready" });

    const { plugin: live, poolEnds } = await setup();
    await live.definition.onShutdown?.();
    expect(poolEnds).toEqual(["end"]);
    expect(await live.definition.onApiRequest?.(apiRequest())).toMatchObject({ status: 503 });
    expect(await live.definition.onApiRequest?.(appsApiRequest())).toMatchObject({ status: 503, body: { error: "plugin not ready" } });
    expect(await live.definition.onHealth?.()).toMatchObject({ status: "degraded" });
  });

  it("clears the service even when the pool fails to close", async () => {
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir: VISIBILITY_DIR,
      createPool: () => ({ query: async () => ({ rows: [{ ok: 1 }] }), end: async () => { throw new Error("pool stuck"); } }) as never,
      migrate: async () => [],
      createService: () => createStubService().service,
    });
    await plugin.definition.setup(createTestHarness({ manifest }).ctx);
    await expect(plugin.definition.onShutdown?.()).rejects.toThrow("pool stuck");
    expect(await plugin.definition.onApiRequest?.(apiRequest())).toMatchObject({ status: 503 });
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "degraded" });
  });

  it("logs mutations to the activity feed without leaking row values", async () => {
    const { harness, serviceDeps } = await setup();
    const event: MutationEvent = { companyId: COMPANY, actor: { kind: "agent", id: "agent-1", runId: "run-1" }, operation: "insert", table: "contacts", summary: "inserted 2 row(s) into contacts" };
    await serviceDeps.onMutation!(event);
    expect(harness.activity).toContainEqual({
      companyId: COMPANY,
      message: "Kyoube data: inserted 2 row(s) into contacts",
      entityType: "kyoube_table",
      entityId: "contacts",
      metadata: { operation: "insert", actorKind: "agent", actorId: "agent-1", runId: "run-1" },
    });
    // Only counts and identifiers reach the feed: no rows, patch, filter or
    // audit detail payload is ever serialised into an activity entry.
    expect(JSON.stringify(harness.activity)).not.toMatch(/rows|patch|where|details|fields/);

    // Ruling P2-R23: a failed activity log is reported, never thrown at the write.
    serviceDeps.onMutationError!(new Error("bus down"), event);
    const warned = harness.logs.find((entry) => entry.level === "warn" && entry.message === "data activity log failed");
    expect(warned?.meta).toMatchObject({ companyId: COMPANY, operation: "insert" });
    expect(String(warned?.meta?.error)).toContain("bus down");
  });

  // An app lifecycle change is not a table change: it is labelled as its own
  // service and points at the app, so the feed can be read (and filtered) by
  // what actually changed rather than by which worker happened to write it.
  it("labels the app service's activity as its own, pointing at the app", async () => {
    const { harness, appDeps, service } = await setup();
    // The apps service is built on the very DataService instance the data
    // surface uses, so an app's data call resolves the caller's level once.
    expect(appDeps.data).toBe(service);
    const event: MutationEvent = { companyId: COMPANY, actor: { kind: "user", id: "admin-1", runId: null }, operation: "app_publish", table: null, entityId: "app-uuid-1", summary: "published app crm version 2" };
    await appDeps.onMutation!(event);
    expect(harness.activity).toContainEqual({
      companyId: COMPANY,
      message: "Kyoube apps: published app crm version 2",
      entityType: "kyoube_app",
      entityId: "app-uuid-1",
      metadata: { operation: "app_publish", actorKind: "user", actorId: "admin-1", runId: null },
    });
    // One line per lifecycle change: never the manifest, never the source.
    expect(JSON.stringify(harness.activity)).not.toMatch(/manifest|source|tables/);
    appDeps.onMutationError!(new Error("bus down"), event);
    const warned = harness.logs.find((entry) => entry.level === "warn" && entry.message === "apps activity log failed");
    expect(warned?.meta).toMatchObject({ companyId: COMPANY, operation: "app_publish" });
    expect(String(warned?.meta?.error)).toContain("bus down");
  });

  it("keeps the data service's own label and entity", async () => {
    const { harness, serviceDeps, appDeps } = await setup();
    // The two summarisers are the same function parameterised, not two copies:
    // a data event still reads "Kyoube data:" and still points at its table.
    await serviceDeps.onMutation!({ companyId: COMPANY, actor: { kind: "user", id: "admin-1", runId: null }, operation: "update", table: "contacts", summary: "updated 1 row(s) in contacts" });
    expect(harness.activity.at(-1)).toMatchObject({ message: "Kyoube data: updated 1 row(s) in contacts", entityType: "kyoube_table", entityId: "contacts" });
    expect(serviceDeps.onMutation).not.toBe(appDeps.onMutation);
  });

  const AI_FIELD = "33333333-3333-4333-8333-333333333333";
  const ROW_KEPT = "44444444-4444-4444-8444-444444444444";
  const ROW_GONE = "55555555-5555-4555-8555-555555555555";

  /**
   * `aiCells`: COMPANY has one AI column whose cells name `rowIds`, of which only `existing` are
   * still rows; the deletes the orphan purge makes land in `deleted`. Without it, no AI columns.
   */
  async function setupPurge(
    purgeTrash: (companyId: string) => Promise<{ droppedTables: string[]; droppedColumns: string[] }>,
    aiCells?: { rowIds: string[]; existing: string[]; deleted: unknown[][] },
  ) {
    const harness = createTestHarness({ manifest });
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM kyoube_meta.fields")) {
        return { rows: aiCells && params[0] === COMPANY ? [{ field_id: AI_FIELD, table_id: AI_FIELD, table_name: "tickets", field_name: "refund", kind: "boolean", decision: {} }] : [] };
      }
      if (sql.startsWith("SELECT row_id FROM kyoube_meta.decision_cells")) return { rows: (aiCells?.rowIds ?? []).map((id) => ({ row_id: id })) };
      if (sql.startsWith("DELETE FROM kyoube_meta.decision_cells")) {
        aiCells?.deleted.push(params);
        return { rows: [] };
      }
      return { rows: [{ company_id: COMPANY }, { company_id: OTHER_COMPANY }] };
    };
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir: VISIBILITY_DIR,
      createPool: () => ({ query, end: async () => {} }) as never,
      migrate: async () => [],
      createService: () => ({ purgeTrash, attach: () => {}, existingRowIds: async () => aiCells?.existing ?? [] }) as unknown as DataService,
    });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  it("purges every company's trash on the scheduled job", async () => {
    const purged: string[] = [];
    const harness = await setupPurge(async (companyId) => {
      purged.push(companyId);
      return companyId === COMPANY ? { droppedTables: ["old"], droppedColumns: [] } : { droppedTables: [], droppedColumns: [] };
    });
    await harness.runJob("purge-trash");
    expect(purged).toEqual([COMPANY, OTHER_COMPANY]);
    const logged = harness.logs.filter((entry) => entry.message === "purged trash");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.meta).toMatchObject({ companyId: COMPANY, droppedTables: ["old"] });
    expect(harness.logs.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("purges the AI cells of deleted rows on the same job", async () => {
    const deleted: unknown[][] = [];
    const harness = await setupPurge(async () => ({ droppedTables: [], droppedColumns: [] }), { rowIds: [ROW_KEPT, ROW_GONE], existing: [ROW_KEPT], deleted });
    await harness.runJob("purge-trash");
    expect(deleted).toEqual([[AI_FIELD, [ROW_GONE]]]);
    expect(harness.logs.filter((entry) => entry.message === "purged AI cells of deleted rows").map((entry) => entry.meta)).toEqual([{ companyId: COMPANY, cells: 1 }]);
    expect(harness.logs.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("keeps sweeping after one company's purge fails", async () => {
    const purged: string[] = [];
    const harness = await setupPurge(async (companyId) => {
      purged.push(companyId);
      if (companyId === COMPANY) throw new Error("schema locked");
      return { droppedTables: ["stale"], droppedColumns: [] };
    });
    await expect(harness.runJob("purge-trash")).resolves.toBeUndefined();
    expect(purged).toEqual([COMPANY, OTHER_COMPANY]);
    const failure = harness.logs.find((entry) => entry.level === "error" && entry.message === "purge failed");
    expect(failure?.meta).toMatchObject({ companyId: COMPANY });
    expect(String(failure?.meta?.error)).toContain("schema locked");
    expect(harness.logs.filter((entry) => entry.message === "purged trash")).toHaveLength(1);
  });

  it("declares the AI-column fill job every five minutes and registers its handler", async () => {
    expect(manifest.jobs?.find((job) => job.jobKey === "fill-ai-columns")?.schedule).toBe("*/5 * * * *");
    // The fake pool reads every company's settings as "AI columns off", so the run asks nothing.
    const harness = await setupPurge(async () => ({ droppedTables: [], droppedColumns: [] }));
    await expect(harness.runJob("fill-ai-columns")).resolves.toBeUndefined();
    expect(harness.logs.filter((entry) => entry.message === "filled AI columns")).toHaveLength(0);
  });
});

describe("kyoube.apps group routes and the rules token (ruling R18)", () => {
  it("reads the token from the configured file: the right token admits a board user who is not a member", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-plugin-token-"));
    const file = path.join(dir, "rules-token");
    writeFileSync(file, "ef".repeat(32), { mode: 0o600 });
    const { plugin } = await setup({ rulesTokenPath: file });
    const sync = (rulesToken: string) => apiRequest({
      routeKey: "groups.sync_report", method: "POST", path: "/groups/sync-report",
      body: { companyId: COMPANY, syncedAt: "2026-10-09T10:00:00.000Z", error: null, rulesToken },
      actor: { actorType: "user", actorId: "stranger", userId: "stranger" },
    });
    expect(await plugin.definition.onApiRequest!(sync("ef".repeat(31)))).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await plugin.definition.onApiRequest!(sync("ef".repeat(32)))).not.toMatchObject({ status: 403 });
  });
});

describe("kyoube.apps visibility policy (docs/groups.md)", () => {
  /** The plugin over a fake pool that answers `query`, with one admin, two projects (one archived) and no apps. */
  async function setupVisibility(query: (sql: string) => Promise<{ rows: unknown[] }>, visibilityDir = VISIBILITY_DIR) {
    const harness = createTestHarness({ manifest });
    harness.seed({
      accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
      projects: [
        { id: "p1", companyId: COMPANY, name: "Website", archivedAt: null } as never,
        { id: "p2", companyId: COMPANY, name: "Old site", archivedAt: new Date("2026-01-01") } as never,
      ],
    });
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir,
      // `connect` serves the transactions a mode change opens; every statement on it succeeds.
      createPool: () => ({ query, connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }), end: async () => {} }) as never,
      migrate: async () => [],
      createService: () => createStubService().service,
      createAppService: () => ({ list: async () => [] }) as never,
      licence: { unlocked: async () => true },
    });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  it("registers the write-visibility job and writes the policy once at setup", async () => {
    expect(manifest.jobs?.find((job) => job.jobKey === "write-visibility")).toMatchObject({ displayName: "Write the visibility policy", schedule: "*/5 * * * *" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-visibility-setup-"));
    const index = path.join(dir, "index.json");
    const harness = await setupVisibility(async (sql) => ({ rows: sql.includes("FROM kyoube_meta.companies") ? [{ company_id: COMPANY, mode: "open" }] : [] }), dir);
    expect(JSON.parse(readFileSync(index, "utf8"))).toMatchObject({ version: 1, companies: { [COMPANY]: { mode: "open" } } });
    rmSync(index);
    await harness.runJob("write-visibility");
    expect(existsSync(index)).toBe(true);
  });

  it("never fails setup, the job or a committed change when the policy cannot be written", async () => {
    const harness = await setupVisibility(async (sql) => {
      if (sql.includes("FROM kyoube_meta.companies")) throw new Error("database down");
      return { rows: [] };
    });
    await expect(harness.runJob("write-visibility")).resolves.toBeUndefined();
    const summary = await harness.performAction<{ mode: string }>("groups.set_visibility", { mode: "need_to_know" }, { actor: ADMIN, companyId: COMPANY });
    expect(summary.mode).toBe("need_to_know");
    const failures = harness.logs.filter((entry) => entry.level === "warn" && entry.message === "visibility policy write failed");
    // Setup, the job, then the change's own hook, which names the company.
    expect(failures.map((entry) => entry.meta)).toEqual([{ error: "Error: database down" }, { error: "Error: database down" }, { companyId: COMPANY, error: "Error: database down" }]);
    expect(harness.logs.some((entry) => entry.message === "data activity log failed")).toBe(false);
  });

  it("groups.options lists the company's projects", async () => {
    const harness = await setupVisibility(async () => ({ rows: [] }));
    const options = await harness.performAction<{ projects: Array<{ id: string; name: string }> }>("groups.options", {}, { actor: ADMIN, companyId: COMPANY });
    expect(options.projects).toEqual([{ id: "p1", name: "Website" }]);
  });
});
