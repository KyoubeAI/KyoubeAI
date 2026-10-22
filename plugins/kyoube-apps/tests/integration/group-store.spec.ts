// tests/integration/group-store.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMeta } from "../../src/data/audit.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { GroupStore } from "../../src/groups/store.js";
import { createTestDatabase } from "./setup.js";

const C = "44444444-4444-4444-8444-444444444444";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let store: GroupStore;
let appA: string;
let appB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/group-store.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  const insertApp = async (slug: string) => (await db.pool.query<{ id: string }>(
    "INSERT INTO kyoube_meta.apps (company_id, slug, name, status, latest_version) VALUES ($1, $2, $2, 'published', 1) RETURNING id", [C, slug])).rows[0]!.id;
  appA = await insertApp("refunds");
  appB = await insertApp("crm");
  store = new GroupStore(db.pool);
});
afterAll(async () => { await db.close(); });

describe("GroupStore", () => {
  it("creates, reads, replaces and removes a group with its members, agents and apps", async () => {
    const created = await withMeta(db.pool, (client) => store.create(client, C, { name: "Sales", dataLevel: "write", members: ["u1", "u2"], agents: ["a1"], apps: [appA], seesAll: true, projects: ["p1", "p2"] }));
    expect(created).toMatchObject({ companyId: C, name: "Sales", dataLevel: "write", members: ["u1", "u2"], agents: ["a1"], apps: [appA], seesAll: true, projects: ["p1", "p2"] });
    expect(await store.count(C)).toBe(1);
    const replaced = await withMeta(db.pool, (client) => store.replace(client, C, created.id, { name: "Sales EU", dataLevel: null, members: ["u2"], agents: [], apps: [appA, appB], seesAll: false, projects: ["p2"] }));
    expect(replaced).toMatchObject({ name: "Sales EU", dataLevel: null, members: ["u2"], agents: [], apps: [appA, appB].sort(), seesAll: false, projects: ["p2"] });
    expect((await store.get(C, created.id))?.name).toBe("Sales EU");
    const removed = await withMeta(db.pool, (client) => store.remove(client, C, created.id));
    expect(removed?.id).toBe(created.id);
    expect(await store.list(C)).toEqual([]);
  });

  it("rejects a duplicate name regardless of case", async () => {
    await withMeta(db.pool, (client) => store.create(client, C, { name: "Support", dataLevel: null, members: [], agents: [], apps: [], seesAll: false, projects: [] }));
    await expect(withMeta(db.pool, (client) => store.create(client, C, { name: "support", dataLevel: null, members: [], agents: [], apps: [], seesAll: false, projects: [] }))).rejects.toThrow("conflict");
  });

  it("answers levels, hidden apps and agent access", async () => {
    const g1 = await withMeta(db.pool, (client) => store.create(client, C, { name: "G1", dataLevel: "read", members: ["u1"], agents: ["a1"], apps: [appA], seesAll: false, projects: [] }));
    await withMeta(db.pool, (client) => store.create(client, C, { name: "G2", dataLevel: "schema", members: ["u1", "u3"], agents: ["a1", "a2"], apps: [], seesAll: false, projects: [] }));
    expect((await store.levelsForUser(C, "u1")).sort()).toEqual(["read", "schema"]);
    expect(await store.levelsForUser(C, "u9")).toEqual([]);
    expect(await store.hiddenAppIds(C, "u1")).toEqual(new Set());
    expect(await store.hiddenAppIds(C, "u3")).toEqual(new Set([appA]));
    expect(await store.agentAccess(C)).toEqual([
      { agentId: "a1", allowedUserIds: ["u1", "u3"] },
      { agentId: "a2", allowedUserIds: ["u1", "u3"] },
    ]);
    await store.prune(C, { userIds: new Set(["u3"]), agentIds: new Set(["a2"]) });
    expect(await store.agentAccess(C)).toEqual([{ agentId: "a2", allowedUserIds: ["u3"] }]);
    expect((await store.get(C, g1.id))?.members).toEqual([]);
  });

  it("stores the last sync report", async () => {
    expect(await store.getSync(C)).toBeNull();
    await store.setSync(C, { syncedAt: "2026-10-09T10:00:00.000Z", error: null });
    expect(await store.getSync(C)).toEqual({ syncedAt: "2026-10-09T10:00:00.000Z", error: null });
  });
});
