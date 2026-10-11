import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAppManifest } from "../../src/apps/manifest.js";
import { AppStore } from "../../src/apps/store.js";
import type { AuditEntry } from "../../src/data/audit.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { AppTaskStore, type AppTaskRow } from "../../src/tasks/store.js";
import { createTestDatabase } from "./setup.js";

const C = "99999999-9999-4999-8999-999999999991";
const OTHER = "99999999-9999-4999-8999-999999999992";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let store: AppTaskStore;
let appId: string;
let otherAppId: string;
let versionId: string;
const by: { kind: "user"; id: string } = { kind: "user", id: "user-1" };

function base(issueId: string, extra: Partial<Omit<AppTaskRow, "startedAt" | "waitingReason" | "closed">> = {}): Omit<AppTaskRow, "startedAt" | "waitingReason" | "closed"> {
  return { issueId, companyId: C, appId, appSlug: "crm", appVersion: 1, template: "summarise", agentId: "agent-1", tableName: "contacts", rowId: "r1", startedBy: "user-1", ...extra };
}
function auditFor(issueId: string): AuditEntry {
  return { companyId: C, actor: by, operation: "app_task_start", table: "contacts", details: { app: "crm", appId, version: 1, template: "summarise", agentId: "agent-1", issueId, via: "app@crm@1" } };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-task-store.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  await ensureCompany(db.pool, OTHER);
  const apps = new AppStore(db.pool);
  const crm = await apps.create(C, validateAppManifest({ name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] }), "<html></html>", by);
  appId = crm.app.id;
  versionId = crm.version.id;
  otherAppId = (await apps.create(C, validateAppManifest({ name: "Other", slug: "other", tables: [] }), "<html></html>", by)).app.id;
  store = new AppTaskStore(db.pool);
});
afterAll(async () => { await db.close(); });

const auditRows = (issueId: string) =>
  db.pool.query<{ operation: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
    "SELECT operation, actor_kind, actor_id, details FROM kyoube_meta.audit WHERE details->>'issueId' = $1",
    [issueId],
  );

describe("AppTaskStore", () => {
  it("insert writes the task row and its audit row", async () => {
    const row = await store.insert(base("i-1"), auditFor("i-1"));
    expect(row).toMatchObject({ issueId: "i-1", companyId: C, appId, appSlug: "crm", appVersion: 1, template: "summarise", agentId: "agent-1", tableName: "contacts", rowId: "r1", startedBy: "user-1", waitingReason: null, closed: false });
    expect(typeof row.startedAt).toBe("string");
    const audit = await auditRows("i-1");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ operation: "app_task_start", actor_kind: "user", actor_id: "user-1" });
    expect(audit.rows[0]!.details).toMatchObject({ app: "crm", appId, version: 1, template: "summarise", agentId: "agent-1", issueId: "i-1", via: "app@crm@1" });
  });

  it("accepts a task with no table or row", async () => {
    const row = await store.insert(base("i-norow", { tableName: null, rowId: null }), auditFor("i-norow"));
    expect(row).toMatchObject({ tableName: null, rowId: null });
  });

  it("an audit row that fails rolls the task row back", async () => {
    const bad: AuditEntry = { ...auditFor("i-bad"), operation: null as unknown as string };
    await expect(store.insert(base("i-bad"), bad)).rejects.toBeTruthy();
    expect(await store.get(C, appId, "i-bad")).toBeNull();
  });

  it("maps a duplicate issue id to conflict", async () => {
    await expect(store.insert(base("i-1"), auditFor("i-1"))).rejects.toThrow("conflict");
  });

  it("get is scoped to company and app", async () => {
    expect((await store.get(C, appId, "i-1"))?.issueId).toBe("i-1");
    expect(await store.get(C, otherAppId, "i-1")).toBeNull();
    expect(await store.get(OTHER, appId, "i-1")).toBeNull();
    expect(await store.get(C, appId, "missing")).toBeNull();
  });

  it("list filters by template and row, newest first, with a limit", async () => {
    await store.insert(base("l-1", { template: "alpha", rowId: "ra" }), auditFor("l-1"));
    await sleep(15);
    await store.insert(base("l-2", { template: "beta", rowId: "ra" }), auditFor("l-2"));
    await sleep(15);
    await store.insert(base("l-3", { template: "alpha", rowId: "rb" }), auditFor("l-3"));
    await store.insert(base("l-other", { appId: otherAppId, template: "alpha", rowId: "ra" }), auditFor("l-other"));
    const ids = (rows: AppTaskRow[]) => rows.map((r) => r.issueId);
    expect(ids(await store.list(C, appId, { template: "alpha", limit: 10 }))).toEqual(["l-3", "l-1"]);
    expect(ids(await store.list(C, appId, { rowId: "ra", limit: 10 }))).toEqual(["l-2", "l-1"]);
    expect(ids(await store.list(C, appId, { template: "alpha", rowId: "ra", limit: 10 }))).toEqual(["l-1"]);
    expect(ids(await store.list(C, appId, { limit: 2 }))).toEqual(["l-3", "l-2"]);
    expect(ids(await store.list(C, otherAppId, { limit: 10 }))).toEqual(["l-other"]);
  });

  it("countStartedSince counts one viewer's starts on one app since a time", async () => {
    await store.insert(base("c-old", { startedBy: "counter" }), auditFor("c-old"));
    await db.pool.query("UPDATE kyoube_meta.app_tasks SET started_at = now() - interval '5 minutes' WHERE issue_id = 'c-old'");
    await store.insert(base("c-new1", { startedBy: "counter" }), auditFor("c-new1"));
    await store.insert(base("c-new2", { startedBy: "counter" }), auditFor("c-new2"));
    await store.insert(base("c-else", { startedBy: "someone-else" }), auditFor("c-else"));
    await store.insert(base("c-app", { startedBy: "counter", appId: otherAppId }), auditFor("c-app"));
    expect(await store.countStartedSince(C, appId, "counter", Date.now() - 60_000)).toBe(2);
    expect(await store.countStartedSince(C, appId, "counter", Date.now() - 600_000)).toBe(3);
    expect(await store.countStartedSince(C, appId, "counter", Date.now() + 60_000)).toBe(0);
  });

  it("openRows excludes closed rows; setWaitingReason and markClosed update the row", async () => {
    await store.insert(base("o-1", { template: "open" }), auditFor("o-1"));
    await store.insert(base("o-2", { template: "open" }), auditFor("o-2"));
    await store.setWaitingReason("o-1", "no run yet");
    expect((await store.get(C, appId, "o-1"))?.waitingReason).toBe("no run yet");
    await store.setWaitingReason("o-1", null);
    expect((await store.get(C, appId, "o-1"))?.waitingReason).toBeNull();
    await store.markClosed("o-2");
    expect((await store.get(C, appId, "o-2"))?.closed).toBe(true);
    const open = (await store.openRows(C, appId)).map((r) => r.issueId);
    expect(open).toContain("o-1");
    expect(open).not.toContain("o-2");
    expect((await store.openRows(OTHER, appId))).toEqual([]);
  });

  it("recordAudit writes a standalone audit row", async () => {
    await store.recordAudit({ ...auditFor("a-cancel"), operation: "app_task_cancel" });
    const audit = await auditRows("a-cancel");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ operation: "app_task_cancel", actor_kind: "user", actor_id: "user-1" });
  });

  it("task agents round-trip, including null", async () => {
    expect(await store.getTaskAgents(versionId)).toBeNull();
    await store.setTaskAgents(versionId, { summarise: "agent-1", triage: "agent-2" });
    expect(await store.getTaskAgents(versionId)).toEqual({ summarise: "agent-1", triage: "agent-2" });
    await store.setTaskAgents(versionId, null);
    expect(await store.getTaskAgents(versionId)).toBeNull();
    expect(await store.getTaskAgents("99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});
