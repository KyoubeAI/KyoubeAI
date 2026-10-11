import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAppManifest, type AppTaskTemplate } from "../../src/apps/manifest.js";
import { AppStore } from "../../src/apps/store.js";
import type { DataActor } from "../../src/data/permissions.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { TaskService, type StartContext, type TaskIssues } from "../../src/tasks/service.js";
import { AppTaskStore } from "../../src/tasks/store.js";
import { createTestDatabase } from "./setup.js";

const C = "99999999-9999-4999-8999-999999999981";
const ROW_SENTINEL = "ROW-SENTINEL-7f3a";
const INPUT_SENTINEL = "INPUT-SENTINEL-9b2c";
const VIEWER: DataActor = { kind: "user", id: "user-1", runId: null };
const TEMPLATE: AppTaskTemplate = {
  agent: "Mailer",
  title: "Reply to {{row.subject}}",
  instructions: "Write a {{input.tone}} reply.",
  table: "tickets",
  fields: ["subject", "reply"],
  inputs: { tone: { type: "text", maxLength: 50 } },
  writes: ["reply"],
};

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let store: AppTaskStore;
let app: StartContext["app"];

interface FakeIssue { id: string; status: string; title: string; description: string; assigneeAgentId: string; createdBy: string }

function fakeCore(opts: { wake?: () => Promise<{ queued: boolean; runId: string | null }>; ids?: string[] } = {}) {
  const issues = new Map<string, FakeIssue>();
  const updates: Array<{ issueId: string; status: string; actorUserId: string }> = [];
  const wakes: string[] = [];
  let n = 0;
  const core: TaskIssues = {
    async create(input) {
      const id = opts.ids?.[n] ?? `it-issue-${Date.now()}-${n}`;
      n++;
      issues.set(id, { id, status: input.status, title: input.title, description: input.description, assigneeAgentId: input.assigneeAgentId, createdBy: input.actor.actorUserId });
      return { id, identifier: `HD-${n}` };
    },
    async get(issueId) {
      const issue = issues.get(issueId);
      return issue ? { id: issue.id, identifier: "HD-1", status: issue.status, assigneeAgentId: issue.assigneeAgentId, updatedAt: new Date().toISOString() } : null;
    },
    async update(issueId, patch, _companyId, actor) {
      updates.push({ issueId, status: patch.status, actorUserId: actor.actorUserId });
      const issue = issues.get(issueId);
      if (issue) issue.status = patch.status;
      return issue;
    },
    async requestWakeup(issueId) {
      wakes.push(issueId);
      return opts.wake ? opts.wake() : { queued: true, runId: "run-1" };
    },
    async listComments() { return []; },
  };
  const service = new TaskService({
    store,
    issues: core,
    previewAssignment: async () => ({ allowed: true, explanation: "" }),
    agent: async (_companyId, agentId) => ({ id: agentId, name: "Mailer Bot", status: "active" }),
    levelFor: async () => "write",
    readRow: async (_companyId, _actor, _table, rowId) => (rowId === "r1" ? { id: "r1", subject: ROW_SENTINEL, reply: null } : null),
    resolveUserRole: async () => "member",
    taskUrl: async (_companyId, issue) => `/HD/issues/${issue.identifier ?? issue.id}`,
  });
  return { service, issues, updates, wakes };
}

function ctx(): StartContext {
  return { companyId: C, viewer: VIEWER, app, templateKey: "reply", template: TEMPLATE, agentId: "agent-1", viewerLevel: "write" };
}
const RAW = { rowId: "r1", inputs: { tone: INPUT_SENTINEL } };

const auditRows = (issueId: string) =>
  db.pool.query<{ operation: string; actor_kind: string; actor_id: string; table_name: string | null; details: Record<string, unknown> }>(
    "SELECT operation, actor_kind, actor_id, table_name, details FROM kyoube_meta.audit WHERE details->>'issueId' = $1 ORDER BY id",
    [issueId],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/task-service.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  const created = await new AppStore(db.pool).create(C, validateAppManifest({ name: "Help Desk", slug: "help-desk", tables: [{ name: "tickets", access: "readwrite" }] }), "<html></html>", VIEWER);
  app = { id: created.app.id, slug: "help-desk", name: "Help Desk", version: 1, versionId: created.version.id };
  store = new AppTaskStore(db.pool);
});
afterAll(async () => { await db.close(); });

describe("TaskService with the real store", () => {
  it("a start creates the issue as the viewer, writes the app_tasks row and an audit row with no values", async () => {
    const core = fakeCore();
    const task = await core.service.start(ctx(), RAW);
    const issue = core.issues.get(task.id)!;
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: "agent-1", createdBy: "user-1", title: `Reply to ${ROW_SENTINEL}` });
    expect(issue.description).toContain(INPUT_SENTINEL);
    expect(core.wakes).toEqual([task.id]);

    const row = await store.get(C, app.id, task.id);
    expect(row).toMatchObject({ issueId: task.id, companyId: C, appId: app.id, appSlug: "help-desk", appVersion: 1, template: "reply", agentId: "agent-1", tableName: "tickets", rowId: "r1", startedBy: "user-1", waitingReason: null, closed: false });

    const audit = await auditRows(task.id);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ operation: "app_task_start", actor_kind: "user", actor_id: "user-1", table_name: "tickets" });
    expect(audit.rows[0]!.details).toEqual({ app: "help-desk", appId: app.id, version: 1, template: "reply", agentId: "agent-1", issueId: task.id, via: "app@help-desk@1" });
    const json = JSON.stringify(audit.rows);
    expect(json).not.toContain(ROW_SENTINEL);
    expect(json).not.toContain(INPUT_SENTINEL);

    expect(await core.service.get(C, app.id, task.id)).toMatchObject({ id: task.id, status: "waiting", rowId: "r1", startedBy: { userId: "user-1" } });
  });

  it("a refused wake-up cancels the issue, closes the row and audits the start and the cancel", async () => {
    const core = fakeCore({ ids: ["it-refused"], wake: async () => { throw new Error("Agent is not invokable in its current state"); } });
    await expect(core.service.start(ctx(), RAW)).rejects.toMatchObject({ code: "disabled", message: "disabled: The agent is paused or not available right now. The task was cancelled; try again later." });
    expect(core.updates).toEqual([{ issueId: "it-refused", status: "cancelled", actorUserId: "user-1" }]);
    expect(core.issues.get("it-refused")!.status).toBe("cancelled");
    expect((await store.get(C, app.id, "it-refused"))?.closed).toBe(true);
    expect((await store.openRows(C, app.id)).map((r) => r.issueId)).not.toContain("it-refused");
    const audit = await auditRows("it-refused");
    expect(audit.rows.map((r) => r.operation)).toEqual(["app_task_start", "app_task_cancel"]);
    expect(audit.rows[1]).toMatchObject({ actor_kind: "user", actor_id: "user-1" });
    expect(audit.rows[1]!.details).toEqual({ app: "help-desk", appId: app.id, version: 1, template: "reply", agentId: "agent-1", issueId: "it-refused", via: "app@help-desk@1", reason: "wake_refused" });
  });

  it("a soft-skipped wake-up keeps the task waiting with its reason", async () => {
    const core = fakeCore({ wake: async () => ({ queued: false, runId: null }) });
    const task = await core.service.start(ctx(), RAW);
    expect(task).toMatchObject({ status: "waiting", waitingReason: "The agent will pick this up when the company's scheduling allows." });
    expect((await store.get(C, app.id, task.id))?.waitingReason).toBe("The agent will pick this up when the company's scheduling allows.");
    expect(await core.service.get(C, app.id, task.id)).toMatchObject({ status: "waiting", waitingReason: "The agent will pick this up when the company's scheduling allows." });
    expect(core.wakes).toEqual([task.id]);
  });

  it("a row write that fails (duplicate issue id) cancels the new issue and never wakes it", async () => {
    const first = fakeCore({ ids: ["it-dup"] });
    await first.service.start(ctx(), RAW);
    const second = fakeCore({ ids: ["it-dup"] });
    await expect(second.service.start(ctx(), RAW)).rejects.toThrow("conflict");
    expect(second.updates).toEqual([{ issueId: "it-dup", status: "cancelled", actorUserId: "user-1" }]);
    expect(second.wakes).toEqual([]);
    expect((await auditRows("it-dup")).rows).toHaveLength(1);
  });

  it("a cancel writes an app_task_cancel audit row and closes the task", async () => {
    const core = fakeCore();
    const task = await core.service.start(ctx(), RAW);
    const cancelled = await core.service.cancel(C, VIEWER, { id: app.id, slug: "help-desk", version: 1 }, task.id);
    expect(cancelled).toMatchObject({ status: "cancelled", runMayContinue: false });
    expect(core.updates).toEqual([{ issueId: task.id, status: "cancelled", actorUserId: "user-1" }]);
    const audit = await auditRows(task.id);
    expect(audit.rows.map((r) => r.operation)).toEqual(["app_task_start", "app_task_cancel"]);
    expect(audit.rows[1]!.details).toEqual({ app: "help-desk", appId: app.id, version: 1, template: "reply", agentId: "agent-1", issueId: task.id, via: "app@help-desk@1" });
    expect(JSON.stringify(audit.rows)).not.toContain(ROW_SENTINEL);
    expect((await store.get(C, app.id, task.id))?.closed).toBe(true);
    expect((await store.openRows(C, app.id)).map((r) => r.issueId)).not.toContain(task.id);
  });
});
