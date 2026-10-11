// tests/integration/app-tasks.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { StartContext } from "../../src/tasks/service.js";
import { AppTaskStore } from "../../src/tasks/store.js";
import { createTestDatabase } from "./setup.js";

const C = "88888888-8888-4888-8888-888888888801";
const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
const MEMBER = { kind: "user" as const, id: "member-1", runId: null };
const OUTSIDE = { kind: "user" as const, id: "out-1", runId: null };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "member-1": "operator", "out-1": "operator" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
const NO_ACCESS = "You don't have access to this app. Ask a company admin.";
const INSTRUCTIONS = "Read the ticket and write a reply into reply_draft. Use a {{input.tone}} tone.";

const AGENTS = [
  { id: "agent-sb", name: "Support Bot", status: "idle" },
  { id: "agent-ro", name: "Reader", status: "active" },
  { id: "agent-dead", name: "Old Bot", status: "terminated" },
  { id: "agent-new", name: "New Hire", status: "pending_approval" },
  { id: "agent-t1", name: "Twin", status: "idle" },
  { id: "agent-t2", name: "twin", status: "idle" },
  // A terminated agent left behind under the same name as a live one does not make the name ambiguous.
  { id: "agent-sb-old", name: "Support Bot", status: "terminated" },
];

function template(overrides: Record<string, unknown> = {}) {
  return {
    agent: "Support Bot",
    title: "Reply to {{row.subject}}",
    instructions: INSTRUCTIONS,
    table: "tickets",
    fields: ["subject", "body", "reply_draft"],
    inputs: { tone: { type: "choice", options: ["friendly", "formal"] } },
    writes: ["reply_draft"],
    ...overrides,
  };
}

const manifest = (slug: string, tasks?: Record<string, unknown>) => ({ name: `App ${slug}`, slug, tables: [{ name: "tickets", access: "readwrite" as const }], ...(tasks ? { tasks } : {}) });

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;
let taskStore: AppTaskStore;
let restrictedId = "";
const hidden = new Set<string>();
const taskCalls: Array<{ method: string; args: unknown[] }> = [];

const fakeTasks = {
  start: async (ctx: StartContext, raw: unknown) => { taskCalls.push({ method: "start", args: [ctx, raw] }); return { id: "issue-1", status: "waiting" } as never; },
  get: async (...args: unknown[]) => { taskCalls.push({ method: "get", args }); return { id: "issue-1" } as never; },
  list: async (...args: unknown[]) => { taskCalls.push({ method: "list", args }); return [] as never; },
  cancel: async (...args: unknown[]) => { taskCalls.push({ method: "cancel", args }); return { id: "issue-1", runMayContinue: false } as never; },
};

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-tasks.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null });
  taskStore = new AppTaskStore(db.pool);
  apps = new AppService({
    pool: db.pool, data, tasks: fakeTasks, taskStore,
    agents: { list: async () => AGENTS },
    hiddenApps: async (_c, userId) => (userId === "out-1" ? hidden : new Set()),
  });
  await data.createTable(C, OWNER, { name: "tickets", fields: [{ name: "subject", kind: "text" }, { name: "body", kind: "text" }, { name: "reply_draft", kind: "text" }] });
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
  await data.setAgentGrant(C, OWNER, "agent-sb", "write");
  await data.setAgentGrant(C, OWNER, "agent-ro", "read");
});
afterAll(async () => { await db.close(); });
beforeEach(() => { taskCalls.length = 0; });

async function versionId(slug: string, version: number): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    "SELECT v.id FROM kyoube_meta.app_versions v JOIN kyoube_meta.apps a ON a.id = v.app_id WHERE a.company_id = $1 AND a.slug = $2 AND a.status <> 'archived' AND v.version = $3",
    [C, slug, version],
  );
  return result.rows[0]!.id;
}

async function published(slug: string, tasks?: Record<string, unknown>) {
  const created = await apps.create(C, OWNER, manifest(slug, tasks), SOURCE);
  await apps.publish(C, OWNER, slug, undefined, { tasksConfirmed: true });
  return created.app;
}

describe("publishing task templates (Review Focus 4)", () => {
  it("needs a person and tasksConfirmed, stores the agent ids and audits the templates", async () => {
    await apps.create(C, OWNER, manifest("t-pub", { draft_reply: template() }), SOURCE);
    await expect(apps.publish(C, AGENT, "t-pub", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("task templates") });
    await expect(apps.publish(C, OWNER, "t-pub")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("tasksConfirmed") });
    expect((await apps.publish(C, OWNER, "t-pub", undefined, { tasksConfirmed: true })).currentVersion).toBe(1);
    expect(await taskStore.getTaskAgents(await versionId("t-pub", 1))).toEqual({ draft_reply: "agent-sb" });
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_publish' AND details->>'app' = 't-pub'", [C]);
    expect(audit.rows[0]!.details).toMatchObject({ version: 1, tasks: ["draft_reply"], tasksConfirmed: true });
  });

  it("treats a change to the instructions alone as a change: forbidden for an agent, invalid without the flag", async () => {
    await published("t-instr", { draft_reply: template() });
    await apps.update(C, AGENT, "t-instr", manifest("t-instr", { draft_reply: template({ instructions: `${INSTRUCTIONS} Sign it "Support".` }) }), SOURCE);
    await expect(apps.publish(C, AGENT, "t-instr")).rejects.toMatchObject({ code: "forbidden" });
    await expect(apps.publish(C, AGENT, "t-instr", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(apps.publish(C, OWNER, "t-instr")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("tasksConfirmed") });
    expect((await apps.publish(C, OWNER, "t-instr", undefined, { tasksConfirmed: true })).currentVersion).toBe(2);
    // Rolling back to version 1 changes the instructions again: the same rule.
    await expect(apps.rollback(C, AGENT, "t-instr", 1, { tasksConfirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(apps.rollback(C, OWNER, "t-instr", 1)).rejects.toMatchObject({ code: "invalid" });
    expect((await apps.rollback(C, OWNER, "t-instr", 1, { tasksConfirmed: true })).currentVersion).toBe(1);
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_rollback' AND details->>'app' = 't-instr'", [C]);
    expect(audit.rows[0]!.details).toMatchObject({ version: 1, tasks: ["draft_reply"], tasksConfirmed: true });
  });

  it("lets an agent publish unchanged templates, and remove every template without the flag", async () => {
    await published("t-same", { draft_reply: template() });
    await apps.update(C, AGENT, "t-same", manifest("t-same", { draft_reply: template() }), SOURCE.replace("<body>", "<body><!--v2-->"));
    expect((await apps.publish(C, AGENT, "t-same")).currentVersion).toBe(2);
    expect(await taskStore.getTaskAgents(await versionId("t-same", 2))).toEqual({ draft_reply: "agent-sb" });
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_publish' AND details->>'app' = 't-same' ORDER BY id DESC LIMIT 1", [C]);
    expect(audit.rows[0]!.details).toMatchObject({ version: 2, tasks: ["draft_reply"], tasksConfirmed: false });
    await apps.update(C, AGENT, "t-same", manifest("t-same"), SOURCE);
    expect((await apps.publish(C, AGENT, "t-same")).currentVersion).toBe(3);
    expect(await taskStore.getTaskAgents(await versionId("t-same", 3))).toBeNull();
    const last = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_publish' AND details->>'app' = 't-same' ORDER BY id DESC LIMIT 1", [C]);
    expect(last.rows[0]!.details).not.toHaveProperty("tasks");
    expect(last.rows[0]!.details).not.toHaveProperty("tasksConfirmed");
  });

  it("refuses a template whose agent is missing, terminated or pending approval, naming it", async () => {
    await apps.create(C, OWNER, manifest("t-missing", { draft_reply: template({ agent: "Ghost Writer" }) }), SOURCE);
    await expect(apps.publish(C, OWNER, "t-missing", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/draft_reply.*Ghost Writer/) });
    await apps.create(C, OWNER, manifest("t-dead", { draft_reply: template({ agent: "Old Bot" }) }), SOURCE);
    await expect(apps.publish(C, OWNER, "t-dead", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("Old Bot") });
    await apps.create(C, OWNER, manifest("t-pending", { draft_reply: template({ agent: "New Hire" }) }), SOURCE);
    await expect(apps.publish(C, OWNER, "t-pending", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("New Hire") });
    expect((await apps.get(C, OWNER, "t-missing")).app.currentVersion).toBeNull();
  });

  it("matches an exact name first, then a unique case-insensitive one, and refuses an ambiguous one", async () => {
    await published("t-exact", { a: template({ agent: "Twin" }), b: template({ agent: "support bot" }) });
    expect(await taskStore.getTaskAgents(await versionId("t-exact", 1))).toEqual({ a: "agent-t1", b: "agent-sb" });
    await apps.create(C, OWNER, manifest("t-ambiguous", { a: template({ agent: "TWIN" }) }), SOURCE);
    await expect(apps.publish(C, OWNER, "t-ambiguous", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("TWIN") });
  });

  it("keeps a published version's agent id through a rename: rollback reaches the same agent", async () => {
    AGENTS.push({ id: "agent-r1", name: "Renamer", status: "idle" });
    await published("t-rename", { a: template({ agent: "Renamer" }) });
    await apps.update(C, OWNER, "t-rename", manifest("t-rename", { a: template() }), SOURCE);
    await apps.publish(C, OWNER, "t-rename", undefined, { tasksConfirmed: true });
    expect(await taskStore.getTaskAgents(await versionId("t-rename", 2))).toEqual({ a: "agent-sb" });
    AGENTS.find((agent) => agent.id === "agent-r1")!.name = "Renamed";
    expect((await apps.rollback(C, OWNER, "t-rename", 1, { tasksConfirmed: true })).currentVersion).toBe(1);
    expect(await taskStore.getTaskAgents(await versionId("t-rename", 1))).toEqual({ a: "agent-r1" });
  });

  it("carries an unchanged template's agent id forward, even when another agent now has its name", async () => {
    AGENTS.push({ id: "agent-k1", name: "Keeper", status: "idle" });
    await published("t-rebind", { a: template({ agent: "Keeper" }) });
    AGENTS.find((agent) => agent.id === "agent-k1")!.name = "Keeper Old";
    AGENTS.push({ id: "agent-k2", name: "Keeper", status: "idle" });
    // A source-only change: an agent may publish it, and the template still reaches the agent a person confirmed.
    await apps.update(C, AGENT, "t-rebind", manifest("t-rebind", { a: template({ agent: "Keeper" }) }), SOURCE.replace("<body>", "<body><!--v2-->"));
    const preview = await apps.publishPreview(C, OWNER, "t-rebind");
    expect(preview.tasks.list[0]).toMatchObject({ key: "a", agent: "Keeper Old", agentFound: true, added: false, changed: false });
    expect((await apps.publish(C, AGENT, "t-rebind")).currentVersion).toBe(2);
    expect(await taskStore.getTaskAgents(await versionId("t-rebind", 2))).toEqual({ a: "agent-k1" });
    // A changed template is looked up by name again, after a person reviewed it.
    await apps.update(C, OWNER, "t-rebind", manifest("t-rebind", { a: template({ agent: "Keeper", instructions: "Reply briefly." }) }), SOURCE);
    expect((await apps.publishPreview(C, OWNER, "t-rebind")).tasks.list[0]).toMatchObject({ agent: "Keeper", agentFound: true, changed: true });
    await apps.publish(C, OWNER, "t-rebind", undefined, { tasksConfirmed: true });
    expect(await taskStore.getTaskAgents(await versionId("t-rebind", 3))).toEqual({ a: "agent-k2" });
  });

  it("refuses a stored or carried agent id whose agent is now terminated, naming the template and agent", async () => {
    AGENTS.push({ id: "agent-d1", name: "Doomed", status: "idle" });
    await published("t-term", { a: template({ agent: "Doomed" }) });
    AGENTS.find((agent) => agent.id === "agent-d1")!.status = "terminated";
    // Another live agent taking the name does not rescue the carried id.
    AGENTS.push({ id: "agent-d2", name: "Doomed", status: "idle" });
    await apps.update(C, AGENT, "t-term", manifest("t-term", { a: template({ agent: "Doomed" }) }), SOURCE.replace("<body>", "<body><!--v2-->"));
    await expect(apps.publish(C, AGENT, "t-term")).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/"a".*Doomed.*terminated/) });
    expect((await apps.publishPreview(C, OWNER, "t-term")).tasks.list[0]).toMatchObject({ agentFound: false });
    // Republishing version 1 itself reuses its stored id, with the same answer.
    await expect(apps.publish(C, OWNER, "t-term", 1)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("terminated") });
  });

  it("refuses a template field the table does not have, at save and at publish", async () => {
    await expect(apps.create(C, OWNER, manifest("t-field", { draft_reply: template({ fields: ["subject", "nope"], writes: [] }) }), SOURCE))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/draft_reply.*nope/) });
    // A table that does not exist yet is tolerated at save, as for decision sets, and refused at publish.
    const later = { name: "App t-later", slug: "t-later", tables: [{ name: "later" }], tasks: { a: template({ table: "later", fields: ["x"], writes: [], title: "Look", instructions: "Look." }) } };
    await apps.create(C, OWNER, later, SOURCE);
    await data.createTable(C, OWNER, { name: "later", fields: [{ name: "y", kind: "text" }] });
    await expect(apps.publish(C, OWNER, "t-later", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("x") });
  });

  it("reports a failed task_agents write after the publish committed, and a retry writes it", async () => {
    await apps.create(C, OWNER, manifest("t-retry", { draft_reply: template() }), SOURCE);
    const failing = new AppService({
      pool: db.pool, data, tasks: fakeTasks,
      taskStore: { getTaskAgents: (id) => taskStore.getTaskAgents(id), setTaskAgents: async () => { throw new Error("db down"); } },
      agents: { list: async () => AGENTS },
    });
    await expect(failing.publish(C, OWNER, "t-retry", undefined, { tasksConfirmed: true })).rejects.toThrow("db down");
    expect((await apps.get(C, OWNER, "t-retry")).app.currentVersion).toBe(1);
    // The same version is now current, so retrying needs no new confirmation and rewrites the mapping.
    expect((await apps.publish(C, OWNER, "t-retry", 1)).currentVersion).toBe(1);
    expect(await taskStore.getTaskAgents(await versionId("t-retry", 1))).toEqual({ draft_reply: "agent-sb" });
  });

  it("refuses to publish templates when the installation has no task support", async () => {
    const bare = new AppService({ pool: db.pool, data });
    await bare.create(C, OWNER, manifest("t-bare", { draft_reply: template() }), SOURCE);
    await expect(bare.publish(C, OWNER, "t-bare", undefined, { tasksConfirmed: true })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("the publish preview", () => {
  it("marks added and changed templates and warns when an agent that must write can only read", async () => {
    await published("t-prev", { draft_reply: template(), summary: template({ agent: "Reader", writes: [], title: "Summarise", instructions: "Summarise it." }) });
    await apps.update(C, OWNER, "t-prev", manifest("t-prev", {
      draft_reply: template(),
      summary: template({ agent: "Reader", writes: [], title: "Summarise", instructions: "Summarise it briefly." }),
      fix: template({ agent: "Reader", title: "Fix", instructions: "Fix the subject." }),
      ghost: template({ agent: "Ghost Writer", title: "Haunt", instructions: "Boo." }),
    }), SOURCE);
    const preview = await apps.publishPreview(C, OWNER, "t-prev");
    expect(preview.tasks.changed).toBe(true);
    const byKey = Object.fromEntries(preview.tasks.list.map((entry) => [entry.key, entry]));
    expect(byKey.draft_reply).toMatchObject({ agent: "Support Bot", agentFound: true, agentCanWrite: true, added: false, changed: false });
    expect(byKey.summary).toMatchObject({ agent: "Reader", agentFound: true, agentCanWrite: null, added: false, changed: true, instructions: "Summarise it briefly." });
    expect(byKey.fix).toMatchObject({ agentFound: true, agentCanWrite: false, added: true, changed: false, table: "tickets", writes: ["reply_draft"] });
    expect(byKey.ghost).toMatchObject({ agentFound: false, agentCanWrite: null, added: true });
    expect(byKey.draft_reply!.inputs).toEqual({ tone: { type: "choice", options: ["friendly", "formal"] } });
    expect(byKey.draft_reply!.fields).toEqual(["subject", "body", "reply_draft"]);
    expect(byKey.draft_reply!.title).toBe("Reply to {{row.subject}}");
  });

  it("reports no change when the templates are the same", async () => {
    await published("t-prev-same", { draft_reply: template() });
    const preview = await apps.publishPreview(C, OWNER, "t-prev-same", 1);
    expect(preview.tasks.changed).toBe(false);
    expect(preview.tasks.list.map(({ key, added, changed }) => ({ key, added, changed }))).toEqual([{ key: "draft_reply", added: false, changed: false }]);
  });
});

describe("runtime tasks", () => {
  it("lists templates in the context without instructions or agent ids", async () => {
    await published("t-ctx", { draft_reply: template(), note: { agent: "Reader", title: "Note", instructions: "Write a note." } });
    const { context } = await apps.runtime(C, MEMBER, "t-ctx", "");
    expect(context.tasks.available).toBe(true);
    // The manifest is stored as jsonb, which keeps its own key order.
    expect([...context.tasks.templates].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "draft_reply", table: "tickets", inputs: { tone: { type: "choice", options: ["friendly", "formal"] } }, writes: ["reply_draft"] },
      { key: "note", table: null, inputs: {}, writes: [] },
    ]);
    const text = JSON.stringify(context);
    expect(text).not.toContain("Read the ticket");
    expect(text).not.toContain("agent-sb");
    expect(text).not.toContain("Support Bot");
    await published("t-ctx-none");
    expect((await apps.runtime(C, MEMBER, "t-ctx-none", "")).context.tasks).toEqual({ available: false, templates: [] });
    const bare = new AppService({ pool: db.pool, data });
    expect((await bare.runtime(C, MEMBER, "t-ctx", "")).context.tasks).toMatchObject({ available: false });
  });

  it("starts a task with the published template, its stored agent and the viewer's level", async () => {
    const app = await published("t-start", { draft_reply: template() });
    const raw = { rowId: "r1", inputs: { tone: "formal" } };
    await apps.runtimeTaskStart(C, MEMBER, "t-start", "draft_reply", raw);
    expect(taskCalls).toHaveLength(1);
    const [ctx, passed] = taskCalls[0]!.args as [StartContext, unknown];
    expect(passed).toBe(raw);
    expect(ctx).toEqual({
      companyId: C, viewer: MEMBER,
      app: { id: app.id, slug: "t-start", name: "App t-start", version: 1, versionId: await versionId("t-start", 1) },
      templateKey: "draft_reply", template: expect.objectContaining({ agent: "Support Bot", instructions: INSTRUCTIONS }), agentId: "agent-sb", viewerLevel: "write",
    });
  });

  it("refuses a hidden app before the task service is called, and every follow-up too", async () => {
    restrictedId = (await published("t-hidden", { draft_reply: template() })).id;
    hidden.add(restrictedId);
    try {
      await expect(apps.runtimeTaskStart(C, OUTSIDE, "t-hidden", "draft_reply", { rowId: "r1" })).rejects.toThrow(NO_ACCESS);
      await expect(apps.runtimeTaskGet(C, OUTSIDE, "t-hidden", "issue-1")).rejects.toMatchObject({ code: "forbidden" });
      await expect(apps.runtimeTaskList(C, OUTSIDE, "t-hidden", {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(apps.runtimeTaskCancel(C, OUTSIDE, "t-hidden", "issue-1")).rejects.toMatchObject({ code: "forbidden" });
      expect(taskCalls).toEqual([]);
    } finally { hidden.delete(restrictedId); }
  });

  it("answers not_found for an unknown template or an unpublished app, before the task service", async () => {
    await published("t-unknown", { draft_reply: template() });
    await expect(apps.runtimeTaskStart(C, MEMBER, "t-unknown", "nope", {})).rejects.toMatchObject({ code: "not_found", message: 'not_found: app "t-unknown" has no task template "nope"' });
    await expect(apps.runtimeTaskStart(C, MEMBER, "t-unknown", "constructor", {})).rejects.toMatchObject({ code: "not_found" });
    await apps.create(C, OWNER, manifest("t-draft", { draft_reply: template() }), SOURCE);
    await expect(apps.runtimeTaskStart(C, MEMBER, "t-draft", "draft_reply", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(apps.runtimeTaskList(C, MEMBER, "t-draft", {})).rejects.toMatchObject({ code: "not_found" });
    expect(taskCalls).toEqual([]);
  });

  it("answers disabled when the version has no stored agent, or the installation has no task service", async () => {
    await published("t-noagent", { draft_reply: template() });
    await taskStore.setTaskAgents(await versionId("t-noagent", 1), null);
    await expect(apps.runtimeTaskStart(C, MEMBER, "t-noagent", "draft_reply", {})).rejects.toMatchObject({ code: "disabled" });
    const bare = new AppService({ pool: db.pool, data });
    await published("t-off", { draft_reply: template() });
    await expect(bare.runtimeTaskStart(C, MEMBER, "t-off", "draft_reply", {})).rejects.toMatchObject({ code: "disabled" });
    await expect(bare.runtimeTaskList(C, MEMBER, "t-off", {})).rejects.toMatchObject({ code: "disabled" });
    expect(taskCalls).toEqual([]);
  });

  it("delegates get, list and cancel with the app's id after opening the app", async () => {
    const app = await published("t-follow", { draft_reply: template() });
    await apps.runtimeTaskGet(C, MEMBER, "t-follow", "issue-9");
    await apps.runtimeTaskList(C, MEMBER, "t-follow", { template: "draft_reply", rowId: "r1" });
    await apps.runtimeTaskCancel(C, MEMBER, "t-follow", "issue-9");
    expect(taskCalls).toEqual([
      { method: "get", args: [C, app.id, "issue-9"] },
      { method: "list", args: [C, app.id, { template: "draft_reply", rowId: "r1" }] },
      { method: "cancel", args: [C, MEMBER, { id: app.id, slug: "t-follow", version: 1 }, "issue-9"] },
    ]);
  });
});
