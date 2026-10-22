import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { keptMemberIds } from "../../src/groups/api-routes.js";
import { GroupService } from "../../src/groups/service.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
const ROLES: Record<string, string> = { owner: "owner", admin: "admin", op: "operator" };
const user = (id: string) => ({ kind: "user" as const, id, runId: null });
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let unlocked = true;
let groups: GroupService;
let appId = "";

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/group-service.spec.ts", "src/db/migrate.ts")));
  groups = new GroupService({
    pool: db.pool, resolveUserRole: async (_c, id) => ROLES[id] ?? null, licence: { unlocked: async () => unlocked },
    listProjectIds: async () => new Set(), listMembers: async () => [],
  });
  await ensureCompany(db.pool, C);
  appId = (await db.pool.query<{ id: string }>("INSERT INTO kyoube_meta.apps (company_id, slug, name, status, latest_version) VALUES ($1, 'refunds', 'Refunds', 'published', 1) RETURNING id", [C])).rows[0]!.id;
});
afterAll(async () => { await db.close(); });

describe("GroupService", () => {
  it("lets only owners and admins manage groups", async () => {
    await expect(groups.list(C, user("op"))).rejects.toThrow("forbidden");
    await expect(groups.save(C, AGENT, { name: "X", members: [], agents: [], apps: [] })).rejects.toThrow("forbidden");
    const created = await groups.save(C, user("admin"), { name: " Sales ", dataLevel: "write", members: ["op"], agents: ["agent-9"], apps: [appId] });
    expect(created).toMatchObject({ name: "Sales", dataLevel: "write", members: ["op"] });
    expect((await groups.list(C, user("owner"))).groups.map((g) => g.name)).toEqual(["Sales"]);
  });

  it("validates names, levels and limits", async () => {
    await expect(groups.save(C, user("owner"), { name: "", members: [], agents: [], apps: [] })).rejects.toThrow("invalid");
    await expect(groups.save(C, user("owner"), { name: "x".repeat(81), members: [], agents: [], apps: [] })).rejects.toThrow("invalid");
    await expect(groups.save(C, user("owner"), { name: "None", dataLevel: "none", members: [], agents: [], apps: [] })).rejects.toThrow("invalid");
    await expect(groups.save(C, user("owner"), { name: "Bad app", members: [], agents: [], apps: ["not-a-uuid"] })).rejects.toThrow("invalid");
  });

  it("writes an audit row with ids only", async () => {
    const rows = await db.pool.query<{ operation: string; details: Record<string, unknown> }>(
      "SELECT operation, details FROM kyoube_meta.audit WHERE company_id = $1 AND operation LIKE 'group_%' ORDER BY id", [C]);
    expect(rows.rows[0]).toMatchObject({ operation: "group_create", details: { members: ["op"], agents: ["agent-9"], apps: [appId] } });
    expect(JSON.stringify(rows.rows[0]!.details)).not.toContain("Sales");
  });

  it("hides restricted apps from non-members but never from owners and admins", async () => {
    expect(await groups.hiddenApps(C, "someone-else")).toEqual(new Set([appId]));
    expect(await groups.hiddenApps(C, "op")).toEqual(new Set());
    expect(await groups.hiddenApps(C, "owner")).toEqual(new Set());
  });

  it("refuses changes without a licence but still allows delete, and enforcement continues", async () => {
    unlocked = false;
    const list = await groups.list(C, user("owner"));
    expect(list.unlocked).toBe(false);
    const sales = list.groups[0]!;
    await expect(groups.save(C, user("owner"), { name: "New", members: [], agents: [], apps: [] })).rejects.toThrow("disabled");
    await expect(groups.save(C, user("owner"), { ...sales, name: "Renamed" })).rejects.toThrow("disabled");
    expect(await groups.hiddenApps(C, "someone-else")).toEqual(new Set([appId]));
    await expect(groups.remove(C, user("owner"), sales.id)).resolves.toMatchObject({ deleted: { id: sales.id } });
    expect(await groups.hiddenApps(C, "someone-else")).toEqual(new Set());
    unlocked = true;
  });

  it("writes a group_delete audit row with ids only", async () => {
    const doomed = await groups.save(C, user("owner"), { name: "Alice's team", dataLevel: "read", members: ["op"], agents: ["agent-7"], apps: [appId] });
    await groups.remove(C, user("admin"), doomed.id);
    const rows = await db.pool.query<{ operation: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
      "SELECT operation, actor_kind, actor_id, details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'group_delete' AND details->>'groupId' = $2", [C, doomed.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ actor_kind: "user", actor_id: "admin" });
    expect(rows.rows[0]!.details).toEqual({ groupId: doomed.id, dataLevel: "read", members: ["op"], agents: ["agent-7"], apps: [appId], seesAll: false, projects: [] });
    expect(JSON.stringify(rows.rows[0]!.details)).not.toContain("Alice");
  });

  it("prunes and lists agent access for the watcher", async () => {
    await groups.save(C, user("owner"), { name: "Ops", members: ["op", "left"], agents: ["agent-1", "agent-gone"], apps: [] });
    expect(await groups.agentAccess(C, { userIds: new Set(["op"]), agentIds: new Set(["agent-1"]) })).toEqual([{ agentId: "agent-1", allowedUserIds: ["op"] }]);
  });

  it("does not prune members when the host listing of users is empty", async () => {
    const before = await groups.agentAccess(C, { userIds: new Set(["op"]), agentIds: new Set(["agent-1"]) });
    const after = await groups.agentAccess(C, { userIds: new Set(), agentIds: new Set(["agent-1"]) });
    expect(after).toEqual(before);
    expect(after).toEqual([{ agentId: "agent-1", allowedUserIds: ["op"] }]);
  });

  it("keeps suspended and pending members' groups through a prune, and drops archived and absent ones (R14)", async () => {
    const created = await groups.save(C, user("owner"), { name: "Lowered", dataLevel: "read", members: ["op", "sus", "pend", "arch", "gone"], agents: ["agent-1"], apps: [] });
    const row = (principalId: string, status: string) => ({ principalType: "user", principalId, status });
    const listing = { list: async (input: { companyId: string; includeArchived?: boolean }) => {
      expect(input).toEqual({ companyId: C, includeArchived: true });
      return [row("op", "active"), row("sus", "suspended"), row("pend", "pending"), row("arch", "archived"), { principalType: "agent", principalId: "agent-1", status: "active" }];
    } };
    const keep = await keptMemberIds(listing, C);
    expect(await groups.agentAccess(C, { userIds: keep, agentIds: new Set(["agent-1"]) })).toEqual([{ agentId: "agent-1", allowedUserIds: ["op", "pend", "sus"] }]);
    // The suspended person's lowered level is still there when they come back.
    expect(await groups.levelsForUser(C, "sus")).toEqual(["read"]);
    expect(await groups.levelsForUser(C, "arch")).toEqual([]);
    await groups.remove(C, user("owner"), created.id);
  });

  it("rejects app ids that are not this company's", async () => {
    await expect(groups.save(C, user("owner"), { name: "Stray", members: [], agents: [], apps: ["99999999-9999-4999-8999-999999999999"] })).rejects.toThrow("invalid");
    const other = "88888888-8888-4888-8888-888888888888";
    await ensureCompany(db.pool, other);
    const foreign = (await db.pool.query<{ id: string }>("INSERT INTO kyoube_meta.apps (company_id, slug, name, status, latest_version) VALUES ($1, 'x', 'X', 'published', 1) RETURNING id", [other])).rows[0]!.id;
    await expect(groups.save(C, user("owner"), { name: "Stray", members: [], agents: [], apps: [foreign] })).rejects.toThrow("invalid");
  });

  it("caps a company at 200 groups", async () => {
    for (let i = (await groups.list(C, user("owner"))).groups.length; i < 200; i += 1) {
      await groups.save(C, user("owner"), { name: `G${i}`, members: [], agents: [], apps: [] });
    }
    await expect(groups.save(C, user("owner"), { name: "One too many", members: [], agents: [], apps: [] })).rejects.toThrow("limit");
  });
});
