import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAppManifest } from "../../src/apps/manifest.js";
import { AppStore } from "../../src/apps/store.js";
import type { AuditEntry } from "../../src/data/audit.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let store: AppStore;
const by = { kind: "agent", id: "agent-1" };
const manifest = validateAppManifest({ name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] });

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-store.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  store = new AppStore(db.pool);
});
afterAll(async () => { await db.close(); });

describe("AppStore", () => {
  it("creates drafts, adds versions, publishes, and rolls back", async () => {
    const created = await store.create(C, manifest, "<html>v1</html>", by, "first");
    expect(created.app).toMatchObject({ slug: "crm", status: "draft", currentVersion: null, latestVersion: 1 });
    expect(created.version).toMatchObject({ version: 1, source: "<html>v1</html>", notes: "first", createdByKind: "agent" });
    await expect(store.create(C, manifest, "<html>dup</html>", by)).rejects.toThrow("conflict");
    const v2 = await store.addVersion(C, "crm", manifest, "<html>v2</html>", by);
    // `addVersion` answers with the app row as well, so a caller building an
    // audit row does not have to read it back.
    expect(v2.version.version).toBe(2);
    expect(v2.app).toMatchObject({ id: created.app.id, latestVersion: 2, currentVersion: null });
    expect(await store.getVersion(C, "crm", "current")).toBeNull();
    expect((await store.getVersion(C, "crm", "latest"))?.version).toBe(2);
    const published = await store.setCurrent(C, "crm", 2);
    expect(published).toMatchObject({ status: "published", currentVersion: 2 });
    expect((await store.getVersion(C, "crm", "current"))?.source).toBe("<html>v2</html>");
    await store.setCurrent(C, "crm", 1);
    expect((await store.getVersion(C, "crm", "current"))?.version).toBe(1);
    await expect(store.setCurrent(C, "crm", 9)).rejects.toThrow("not_found");
  });
  it("lists and archives", async () => {
    expect((await store.list(C)).map((app) => app.slug)).toEqual(["crm"]);
    await store.setStatus(C, "crm", "archived");
    expect(await store.list(C)).toEqual([]);
    expect((await store.list(C, { includeArchived: true }))[0]?.status).toBe("archived");
    expect(await store.get("88888888-8888-4888-8888-888888888888", "crm")).toBeNull();
  });
  it("reuses an archived app's slug for a new app (ruling P3-R10)", async () => {
    const archived = (await store.list(C, { includeArchived: true })).find((app) => app.slug === "crm" && app.status === "archived")!;
    expect(await store.get(C, "crm")).toBeNull();
    const recreated = await store.create(C, manifest, "<html>v1-again</html>", by);
    expect(recreated.app).toMatchObject({ slug: "crm", status: "draft", currentVersion: null, latestVersion: 1 });
    expect(recreated.app.id).not.toBe(archived.id);
    expect(await store.get(C, "crm")).toMatchObject({ id: recreated.app.id, status: "draft" });
    const live = await store.list(C);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: recreated.app.id, status: "draft" });
    const all = await store.list(C, { includeArchived: true });
    expect(all.map((app) => app.id).sort()).toEqual([archived.id, recreated.app.id].sort());
  });
  // The gallery reads its name, description and icon off the app row, so
  // whatever is on that row is what every viewer sees — including viewers who
  // cannot see drafts at all. Writing a draft's manifest onto it published the
  // rename without publishing the version it came from.
  it("shows a new name in the gallery only once the version carrying it is published", async () => {
    const v1 = validateAppManifest({ name: "Orders", slug: "orders", icon: "📦", description: "Open orders", tables: [] });
    const created = await store.create(C, v1, "<html>v1</html>", by);
    expect(created.app).toMatchObject({ name: "Orders", icon: "📦", description: "Open orders" });

    const renamed = validateAppManifest({ name: "Order Book", slug: "orders", icon: "📕", description: "Everything", tables: [] });
    await store.addVersion(C, "orders", renamed, "<html>v2</html>", by);
    // Still the published metadata — the draft's is only in the version row.
    const gallery = (await store.list(C)).find((app) => app.slug === "orders");
    expect(gallery).toMatchObject({ name: "Orders", icon: "📦", description: "Open orders", latestVersion: 2, currentVersion: null });
    expect((await store.getVersion(C, "orders", 2))?.manifest.name).toBe("Order Book");

    const published = await store.setCurrent(C, "orders", 2);
    expect(published).toMatchObject({ name: "Order Book", icon: "📕", description: "Everything", currentVersion: 2 });
    // ...and a rollback takes the metadata back with it.
    expect(await store.setCurrent(C, "orders", 1)).toMatchObject({ name: "Orders", icon: "📦", description: "Open orders", currentVersion: 1 });
  });

  // Ruling P4-R12, extended to app lifecycle changes (P4-R28): the audit row is
  // written on the store's own client, inside the transaction that makes the
  // change, so a change is never committed unrecorded — and a record never
  // outlives a change that rolled back.
  it("writes each lifecycle audit row inside the change's own transaction", async () => {
    const entry = (operation: string): AuditEntry => ({ companyId: C, actor: { kind: "agent", id: "agent-1", runId: null }, operation, table: null, details: { app: "audited" } });
    const created = await store.create(C, validateAppManifest({ name: "Audited", slug: "audited", tables: [] }), "<html>v1</html>", by, null, () => entry("app_create"));
    const rows = await db.pool.query<{ operation: string }>("SELECT operation FROM kyoube_meta.audit WHERE company_id = $1 AND details->>'app' = 'audited' ORDER BY id", [C]);
    expect(rows.rows.map((row) => row.operation)).toEqual(["app_create"]);

    // A row Postgres refuses — `operation` is NOT NULL — is the failure that
    // matters: the INSERT fails after the change, on the same client.
    const broken = () => ({ ...entry("x"), operation: null as unknown as string });
    await expect(store.addVersion(C, "audited", validateAppManifest({ name: "Audited", slug: "audited", tables: [] }), "<html>v2</html>", by, null, broken)).rejects.toThrow();
    expect((await store.get(C, "audited"))?.latestVersion).toBe(1);
    expect(await store.getVersion(C, "audited", 2)).toBeNull();

    await expect(store.setStatus(C, "audited", "archived", broken)).rejects.toThrow();
    expect((await store.get(C, "audited"))?.status).toBe("draft");

    await store.setCurrent(C, "audited", 1, () => entry("app_publish"));
    await expect(store.setCurrent(C, "audited", 1, broken)).rejects.toThrow();

    // Only the two changes that committed left a row, and only they happened.
    const after = await db.pool.query<{ operation: string }>("SELECT operation FROM kyoube_meta.audit WHERE company_id = $1 AND details->>'app' = 'audited' ORDER BY id", [C]);
    expect(after.rows.map((row) => row.operation)).toEqual(["app_create", "app_publish"]);
    expect(await store.get(C, "audited")).toMatchObject({ status: "published", currentVersion: 1, latestVersion: 1 });

    // A plan that throws rolls the change back the same way.
    await expect(store.setStatus(C, "audited", "archived", () => { throw new Error("audit exploded"); })).rejects.toThrow("audit exploded");
    expect((await store.get(C, "audited"))?.status).toBe("published");
  });

  it("writes a version's task agents in the publish's own transaction", async () => {
    const entry = (operation: string): AuditEntry => ({ companyId: C, actor: { kind: "user", id: "u1", runId: null }, operation, table: null, details: { app: "mapped" } });
    const created = await store.create(C, validateAppManifest({ name: "Mapped", slug: "mapped", tables: [] }), "<html>v1</html>", by);
    const agents = async () => (await db.pool.query<{ task_agents: unknown }>("SELECT task_agents FROM kyoube_meta.app_versions WHERE id = $1", [created.version.id])).rows[0]!.task_agents;
    // An audit row Postgres refuses rolls the mapping back with the publish.
    await expect(store.setCurrent(C, "mapped", 1, () => ({ ...entry("x"), operation: null as unknown as string }), { a: "agent-1" })).rejects.toThrow();
    expect(await agents()).toBeNull();
    expect((await store.get(C, "mapped"))?.currentVersion).toBeNull();
    await store.setCurrent(C, "mapped", 1, () => entry("app_publish"), { a: "agent-1" });
    expect(await agents()).toEqual({ a: "agent-1" });
    // Omitted, the mapping is left alone; null clears it.
    await store.setCurrent(C, "mapped", 1);
    expect(await agents()).toEqual({ a: "agent-1" });
    await store.setCurrent(C, "mapped", 1, undefined, null);
    expect(await agents()).toBeNull();
  });
});
