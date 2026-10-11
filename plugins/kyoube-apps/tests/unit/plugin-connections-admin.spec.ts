import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { AppService } from "../../src/apps/service.js";
import manifest from "../../src/manifest.js";
import { createAppsPlugin } from "../../src/plugin.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
const ADMIN = { type: "user" as const, userId: "admin-1" };
const MEMBER = { type: "user" as const, userId: "member-1" };
const AGENT = { type: "agent" as const, agentId: "agent-1", runId: "run-1" };

const member = (principalId: string, membershipRole: string) => ({ id: `m-${principalId}`, companyId: COMPANY, principalType: "user" as const, principalId, status: "active" as const, membershipRole, grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });

const APP_ROWS = [
  { id: "app-1", company_id: COMPANY, slug: "pay", name: "Payments", description: null, icon: null, status: "published", current_version: 1, latest_version: 1, created_at: new Date(0), updated_at: new Date(0) },
  { id: "app-2", company_id: COMPANY, slug: "secret", name: "Secret", description: null, icon: null, status: "published", current_version: 1, latest_version: 1, created_at: new Date(0), updated_at: new Date(0) },
];

/** A pool that answers only the apps store's reads. */
const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT task_agents")) return { rows: [{ task_agents: { fix: "agent-1", gone: "agent-9", plain: "agent-2" } }] };
    if (sql.includes("FROM kyoube_meta.app_versions")) {
      const tasks = { fix: { agent: "Ada", title: "t", instructions: "i", table: "tickets", fields: ["body"], inputs: {}, writes: ["body"] }, gone: { agent: "Zed", title: "t", instructions: "i", table: null, fields: [], inputs: {}, writes: [] }, plain: { agent: "Bob", title: "t", instructions: "i", table: "tickets", fields: ["body"], inputs: {}, writes: [] } };
      return { rows: [{ id: "v", version: 1, manifest: { connections: [{ name: "stripe", access: "read" }], tasks }, source: "", created_by_kind: "user", created_by_id: null, notes: null, created_at: new Date(0) }] };
    }
    if (sql.includes("FROM kyoube_meta.apps")) {
      const bySlug = params[1];
      return { rows: typeof bySlug === "string" ? APP_ROWS.filter((row) => row.slug === bySlug) : APP_ROWS };
    }
    return { rows: [] };
  },
  end: async () => {},
};

const agentRow = (id: string, name: string, status: string) => ({ id, companyId: COMPANY, name, status });
async function setup(level = "read") {
  const harness = createTestHarness({ manifest });
  harness.seed({ accessMembers: [member("admin-1", "admin"), member("member-1", "operator")], agents: [agentRow("agent-1", "Ada", "idle"), agentRow("agent-2", "Bobby", "idle"), agentRow("agent-9", "Zed", "terminated")] as never });
  const service = {
    levelFor: async (_c: string, actor: { kind: string }) => {
      if (level === "throw" || (level === "agent-throws" && actor.kind === "agent")) throw new Error("no access");
      return level === "agent-throws" ? "read" : level;
    },
    scope: async () => {}, attach: () => {}, myAccess: async () => ({ level }),
  };
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    createPool: () => pool as never,
    migrate: async () => [],
    createService: () => service as never,
    // The group filter is the real thing's job; here one app is hidden from everyone.
    createAppService: (deps) => new AppService({ ...deps, hiddenApps: async () => new Set(["app-2"]) }),
  });
  await plugin.definition.setup(harness.ctx);
  const run = (key: string, params: Record<string, unknown>, actor: typeof ADMIN | typeof MEMBER | typeof AGENT) => harness.performAction(key, params, { actor, companyId: COMPANY });
  return { harness, run };
}

describe("connections admin actions", () => {
  it("connections.status answers an admin and refuses a member, an agent and an admin demoted since", async () => {
    const { harness, run } = await setup();
    await expect(run("connections.status", {}, ADMIN)).resolves.toMatchObject({ connections: [], missing: [{ name: "stripe" }] });
    await expect(run("connections.status", {}, MEMBER)).rejects.toThrow(/owners and admins/);
    await expect(run("connections.status", {}, AGENT)).rejects.toThrow(/owners and admins/);
    harness.seed({ accessMembers: [member("admin-1", "operator")] });
    await expect(run("connections.status", {}, ADMIN)).rejects.toThrow(/owners and admins/);
  });

  it("connections.grants and connections.set_grant refuse a non-admin", async () => {
    const { run } = await setup();
    await expect(run("connections.grants", {}, ADMIN)).resolves.toMatchObject({ grants: [] });
    for (const actor of [MEMBER, AGENT]) {
      await expect(run("connections.grants", {}, actor)).rejects.toThrow(/owners and admins/);
      await expect(run("connections.set_grant", { agentId: "agent-1", connection: "crm", access: "read" }, actor)).rejects.toThrow(/owners and admins/);
    }
  });

  it("connections.set_grant rejects an unknown access value as invalid", async () => {
    const { run } = await setup();
    await expect(run("connections.set_grant", { agentId: "agent-1", connection: "crm", access: "admin" }, ADMIN)).rejects.toThrow(/access must be one of none, read, read-write/);
  });

  it("apps.uses leaves out an app the viewer's groups hide", async () => {
    const { run } = await setup();
    const uses = (await run("apps.uses", {}, MEMBER)) as Record<string, unknown>;
    expect(Object.keys(uses)).toEqual(["pay"]);
  });

  it("connections.status still answers when the admin's data level cannot read apps", async () => {
    const { run } = await setup("none");
    await expect(run("connections.status", {}, ADMIN)).resolves.toMatchObject({ connections: [], missing: [] });
  });

  it("tasks.overview lists the current version's templates with the stored agents, and refuses a member and an agent", async () => {
    const { run } = await setup("read");
    const result = (await run("tasks.overview", {}, ADMIN)) as Array<{ slug: string; templates: Array<Record<string, unknown>> }>;
    expect(result.map((row) => row.slug)).toEqual(["pay"]);
    expect(result[0]!.templates).toEqual([
      { key: "fix", agentId: "agent-1", agentName: "Ada", table: "tickets", writes: ["body"], status: "agent_cannot_write" },
      { key: "gone", agentId: "agent-9", agentName: "Zed", table: null, writes: [], status: "agent_missing" },
      { key: "plain", agentId: "agent-2", agentName: "Bobby", table: "tickets", writes: [], status: "ready" },
    ]);
    await expect(run("tasks.overview", {}, MEMBER)).rejects.toThrow(/owners and admins/);
    await expect(run("tasks.overview", {}, AGENT)).rejects.toThrow(/owners and admins/);
  });

  it("tasks.overview marks a writing template ready when its agent can write", async () => {
    const { run } = await setup("write");
    const result = (await run("tasks.overview", {}, ADMIN)) as Array<{ templates: Array<{ key: string; status: string }> }>;
    expect(result[0]!.templates.find((t) => t.key === "fix")!.status).toBe("ready");
  });

  it("tasks.overview keeps the app when one template's agent access can't be read, reporting that agent as unable to write", async () => {
    const { run } = await setup("agent-throws");
    const result = (await run("tasks.overview", {}, ADMIN)) as Array<{ slug: string; templates: Array<{ key: string; status: string }> }>;
    expect(result.map((row) => row.slug)).toEqual(["pay"]);
    expect(result[0]!.templates.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "fix", status: "agent_cannot_write" },
      { key: "gone", status: "agent_missing" },
      { key: "plain", status: "ready" },
    ]);
  });
});
