import { describe, expect, it, vi } from "vitest";
import type { AppTaskTemplate } from "../../src/apps/manifest.js";
import type { AuditEntry } from "../../src/data/audit.js";
import { DataError } from "../../src/data/errors.js";
import type { AccessLevel, DataActor } from "../../src/data/permissions.js";
import {
  LIST_LIMIT, MAX_OPEN_PER_APP, START_PER_MINUTE, TaskService, waitingReasonFor,
  type StartContext, type TaskIssues, type TaskServiceDeps,
} from "../../src/tasks/service.js";
import type { AppTaskRow, AppTaskStore } from "../../src/tasks/store.js";

const C = "11111111-1111-4111-8111-111111111111";
const OTHER_C = "22222222-2222-4222-8222-222222222222";
const APP = { id: "app-1", slug: "help-desk", name: "Help Desk", version: 3, versionId: "ver-3" };
const VIEWER: DataActor = { kind: "user", id: "viewer", runId: null };
const SECRET_VALUE = "SENTINEL-ROW-VALUE";
const SECRET_INPUT = "SENTINEL-INPUT";

const TEMPLATE: AppTaskTemplate = {
  agent: "Mailer",
  title: "Reply to {{row.subject}}",
  instructions: "Write a {{input.tone}} reply about {{row.subject}}.",
  table: "tickets",
  fields: ["subject", "reply"],
  inputs: { tone: { type: "text", maxLength: 50 } },
  writes: ["reply"],
};
const NO_TABLE: AppTaskTemplate = { agent: "Mailer", title: "Say hi", instructions: "Say hi.", table: null, fields: [], inputs: {}, writes: [] };

interface FakeIssue { id: string; identifier: string; companyId: string; status: string; assigneeAgentId: string; updatedAt: string; title?: string; description?: string }
interface FakeComment { body: string; authorType: string; authorAgentId?: string | null; createdAt: string; deletedAt?: string | null }

interface Options {
  levels?: Record<string, AccessLevel>;
  agents?: Record<string, { id: string; name: string; status: string } | null>;
  preview?: { allowed: boolean; explanation: string };
  rows?: Record<string, Record<string, unknown> | null>;
  readRow?: TaskServiceDeps["readRow"];
  roles?: Record<string, string>;
  wake?: (issueId: string) => Promise<{ queued: boolean; runId: string | null }>;
  insertFails?: unknown;
  updateFails?: boolean;
  setWaitingFails?: boolean;
}

function setup(opts: Options = {}) {
  const clock = { t: 1_000_000_000 };
  const rows = new Map<string, AppTaskRow>();
  const audits: AuditEntry[] = [];
  const issuesById = new Map<string, FakeIssue>();
  const comments = new Map<string, FakeComment[]>();
  const calls: string[] = [];
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  let next = 1;

  const store = {
    insert: vi.fn(async (row: Omit<AppTaskRow, "startedAt" | "waitingReason" | "closed">, audit: AuditEntry) => {
      calls.push("insert");
      if (opts.insertFails) throw opts.insertFails;
      const full: AppTaskRow = { ...row, startedAt: new Date(clock.t).toISOString(), waitingReason: null, closed: false };
      rows.set(row.issueId, full);
      audits.push(audit);
      return full;
    }),
    get: vi.fn(async (companyId: string, appId: string, issueId: string) => {
      const row = rows.get(issueId);
      return row && row.companyId === companyId && row.appId === appId ? { ...row } : null;
    }),
    list: vi.fn(async (companyId: string, appId: string, filter: { template?: string; rowId?: string; limit: number }) =>
      [...rows.values()]
        .filter((r) => r.companyId === companyId && r.appId === appId && (!filter.template || r.template === filter.template) && (!filter.rowId || r.rowId === filter.rowId))
        .reverse().slice(0, filter.limit).map((r) => ({ ...r }))),
    countStartedSince: vi.fn(async (companyId: string, appId: string, userId: string, sinceMs: number) =>
      [...rows.values()].filter((r) => r.companyId === companyId && r.appId === appId && r.startedBy === userId && Date.parse(r.startedAt) >= sinceMs).length),
    openRows: vi.fn(async (companyId: string, appId: string) => [...rows.values()].filter((r) => r.companyId === companyId && r.appId === appId && !r.closed).map((r) => ({ ...r }))),
    setWaitingReason: vi.fn(async (issueId: string, reason: string | null) => {
      if (opts.setWaitingFails) throw new Error("db down");
      const row = rows.get(issueId);
      if (row) row.waitingReason = reason;
    }),
    markClosed: vi.fn(async (issueId: string) => {
      const row = rows.get(issueId);
      if (row) row.closed = true;
    }),
    recordAudit: vi.fn(async (entry: AuditEntry) => { audits.push(entry); }),
  };

  const issues = {
    create: vi.fn(async (input: Parameters<TaskIssues["create"]>[0]) => {
      calls.push("create");
      const id = `issue-${next++}`;
      issuesById.set(id, { id, identifier: `HD-${next}`, companyId: input.companyId, status: input.status, assigneeAgentId: input.assigneeAgentId, updatedAt: new Date(clock.t).toISOString(), title: input.title, description: input.description });
      return { id, identifier: `HD-${next}` };
    }),
    get: vi.fn(async (issueId: string, companyId: string) => {
      const issue = issuesById.get(issueId);
      return issue && issue.companyId === companyId ? { ...issue } : null;
    }),
    update: vi.fn(async (issueId: string, patch: { status: "cancelled" }) => {
      calls.push("update");
      if (opts.updateFails) throw new Error("core refused");
      const issue = issuesById.get(issueId);
      if (issue) issue.status = patch.status;
      return issue;
    }),
    requestWakeup: vi.fn(async (issueId: string) => {
      calls.push("wake");
      return opts.wake ? opts.wake(issueId) : { queued: true, runId: "run-1" };
    }),
    listComments: vi.fn(async (issueId: string, companyId: string) => {
      const issue = issuesById.get(issueId);
      if (!issue || issue.companyId !== companyId) return [];
      return [...(comments.get(issueId) ?? [])];
    }),
  };

  const levels: Record<string, AccessLevel> = { "user:viewer": "write", "agent:agent-1": "write", ...opts.levels };
  const agents = opts.agents ?? { "agent-1": { id: "agent-1", name: "Mailer Bot", status: "active" } };
  const dataRows = opts.rows ?? { r1: { id: "r1", subject: SECRET_VALUE, reply: null } };
  const deps = {
    store: store as unknown as AppTaskStore,
    issues: issues as unknown as TaskIssues,
    previewAssignment: vi.fn(async () => opts.preview ?? { allowed: true, explanation: "allowed" }),
    agent: vi.fn(async (_companyId: string, agentId: string) => (Object.hasOwn(agents, agentId) ? agents[agentId]! : null)),
    levelFor: vi.fn(async (_companyId: string, actor: DataActor) => levels[`${actor.kind}:${actor.id}`] ?? "none"),
    readRow: vi.fn(opts.readRow ?? (async (_companyId: string, _actor: DataActor, _table: string, rowId: string) => dataRows[rowId] ?? null)),
    resolveUserRole: vi.fn(async (_companyId: string, userId: string) => opts.roles?.[userId] ?? "member"),
    taskUrl: vi.fn(async (_companyId: string, issue: { id: string; identifier?: string | null }) => `/HD/issues/${issue.identifier ?? issue.id}`),
    now: () => clock.t,
    log: (message: string, meta: Record<string, unknown>) => { logs.push({ message, meta }); },
  };
  const service = new TaskService(deps);
  return { service, deps, store, issues, rows, audits, issuesById, comments, calls, logs, clock };
}

function ctx(over: Partial<StartContext> = {}): StartContext {
  return { companyId: C, viewer: VIEWER, app: APP, templateKey: "reply", template: TEMPLATE, agentId: "agent-1", viewerLevel: "write", ...over };
}
const RAW = { rowId: "r1", inputs: { tone: "warm" } };

async function expectCode(promise: Promise<unknown>, code: string, message?: string): Promise<DataError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DataError);
  expect((error as DataError).code).toBe(code);
  if (message !== undefined) expect((error as DataError).message).toBe(`${code}: ${message}`);
  return error as DataError;
}

describe("TaskService.start refusals, in order", () => {
  it("1. refuses an agent or the system as the viewer", async () => {
    const t = setup();
    await expectCode(t.service.start(ctx({ viewer: { kind: "agent", id: "agent-1", runId: "run" } }), RAW), "forbidden", "only a person using an app can start a task");
    await expectCode(t.service.start(ctx({ viewer: { kind: "system", id: null } }), RAW), "forbidden");
    expect(t.issues.create).not.toHaveBeenCalled();
  });

  it("2. a table template needs a non-empty string rowId", async () => {
    const t = setup();
    for (const rowId of [undefined, "", 7, null]) {
      await expectCode(t.service.start(ctx(), { rowId, inputs: { tone: "warm" } }), "invalid", "this task needs a rowId");
    }
    expect(t.deps.readRow).not.toHaveBeenCalled();
    expect(t.issues.create).not.toHaveBeenCalled();
  });

  it("2. reads the row as the viewer; DataService's forbidden passes through; a missing row is not_found", async () => {
    const denied = setup({ readRow: async () => { throw new DataError("forbidden", "reading tickets requires read access (you have none)"); } });
    await expectCode(denied.service.start(ctx(), RAW), "forbidden", "reading tickets requires read access (you have none)");
    expect(denied.deps.readRow).toHaveBeenCalledWith(C, VIEWER, "tickets", "r1");
    expect(denied.issues.create).not.toHaveBeenCalled();
    const missing = setup();
    await expectCode(missing.service.start(ctx(), { rowId: "nope", inputs: { tone: "warm" } }), "not_found");
    expect(missing.issues.create).not.toHaveBeenCalled();
  });

  it("2. a template without a table refuses a rowId", async () => {
    const t = setup();
    await expectCode(t.service.start(ctx({ template: NO_TABLE }), { rowId: "r1" }), "invalid");
    expect(t.issues.create).not.toHaveBeenCalled();
  });

  it("3. writes need the viewer at write, checked after the row", async () => {
    const t = setup();
    await expectCode(t.service.start(ctx({ viewerLevel: "read" }), { inputs: { tone: "warm" } }), "invalid", "this task needs a rowId");
    await expectCode(t.service.start(ctx({ viewerLevel: "read" }), RAW), "forbidden", "You can only read Data, so you can't ask an agent to change it.");
    expect(t.issues.create).not.toHaveBeenCalled();
  });

  it("3. a read-only viewer may start a template without writes", async () => {
    const t = setup();
    const task = await t.service.start(ctx({ viewerLevel: "read", template: { ...TEMPLATE, writes: [] } }), RAW);
    expect(task.status).toBe("waiting");
  });

  it("4. inputs are validated after the writes check", async () => {
    const t = setup();
    await expectCode(t.service.start(ctx({ viewerLevel: "read" }), { rowId: "r1", inputs: {} }), "forbidden");
    await expectCode(t.service.start(ctx(), { rowId: "r1", inputs: {} }), "invalid", 'task input "tone" is required');
    await expectCode(t.service.start(ctx(), { rowId: "r1", inputs: { tone: "warm", extra: 1 } }), "invalid");
    expect(t.deps.agent).not.toHaveBeenCalled();
    expect(t.issues.create).not.toHaveBeenCalled();
  });

  it("5. a missing, terminated or pending agent is disabled, named as the template names it", async () => {
    for (const agent of [null, { id: "agent-1", name: "Mailer Bot", status: "terminated" }, { id: "agent-1", name: "Mailer Bot", status: "pending_approval" }]) {
      const t = setup({ agents: { "agent-1": agent } });
      await expectCode(t.service.start(ctx(), RAW), "disabled", "This app's agent 'Mailer' no longer exists. Ask a person to republish it.");
      expect(t.deps.previewAssignment).not.toHaveBeenCalled();
      expect(t.issues.create).not.toHaveBeenCalled();
    }
  });

  it("5. inputs are checked before the agent", async () => {
    const t = setup({ agents: {} });
    await expectCode(t.service.start(ctx(), { rowId: "r1", inputs: {} }), "invalid");
  });

  it("5. a paused agent is refused before anything is created", async () => {
    const t = setup({ agents: { "agent-1": { id: "agent-1", name: "Mailer Bot", status: "paused" } } });
    await expectCode(t.service.start(ctx(), RAW), "disabled", "Mailer Bot is paused. Try again when it has been resumed.");
    expect(t.deps.previewAssignment).not.toHaveBeenCalled();
    expect(t.issues.create).not.toHaveBeenCalled();
    expect(t.store.insert).not.toHaveBeenCalled();
  });

  it("5. writes need the agent at write", async () => {
    const t = setup({ levels: { "agent:agent-1": "read" } });
    await expectCode(t.service.start(ctx(), RAW), "forbidden", "Ask an admin to give Mailer Bot write access to Data.");
    expect(t.deps.levelFor).toHaveBeenCalledWith(C, { kind: "agent", id: "agent-1" });
    expect(t.deps.previewAssignment).not.toHaveBeenCalled();
    expect(t.issues.create).not.toHaveBeenCalled();
    const noWrites = setup({ levels: { "agent:agent-1": "none" } });
    await expect(noWrites.service.start(ctx({ template: { ...TEMPLATE, writes: [] } }), RAW)).resolves.toMatchObject({ status: "waiting" });
  });

  it("6. Review Focus 2: an assignment the core refuses is forbidden with its explanation, and nothing is created", async () => {
    const t = setup({ preview: { allowed: false, explanation: "Your group may not assign work to Mailer Bot." } });
    await expectCode(t.service.start(ctx(), RAW), "forbidden", "Your group may not assign work to Mailer Bot.");
    expect(t.deps.previewAssignment).toHaveBeenCalledWith(C, "viewer", "agent-1");
    expect(t.issues.create).not.toHaveBeenCalled();
    expect(t.store.insert).not.toHaveBeenCalled();
    expect(t.rows.size).toBe(0);
    expect(t.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("6. falls back to a plain reason when the core gives no explanation", async () => {
    const t = setup({ preview: { allowed: false, explanation: "" } });
    await expectCode(t.service.start(ctx(), RAW), "forbidden", "You can't assign work to Mailer Bot.");
  });

  it("7. assignment is checked before the limits", async () => {
    const t = setup({ preview: { allowed: false, explanation: "no" } });
    await t.service.start(ctx(), RAW).catch(() => {});
    expect(t.store.countStartedSince).not.toHaveBeenCalled();
  });
});

describe("TaskService.start limits", () => {
  it(`allows ${START_PER_MINUTE} starts a minute per viewer per app, then refuses until the minute passes`, async () => {
    const t = setup();
    for (let i = 0; i < START_PER_MINUTE; i++) {
      await t.service.start(ctx(), RAW);
      t.clock.t += 1000;
    }
    await expectCode(t.service.start(ctx(), RAW), "limit", "at most 10 tasks a minute from this app");
    expect(t.issues.create).toHaveBeenCalledTimes(10);
    expect(t.store.countStartedSince).toHaveBeenLastCalledWith(C, APP.id, "viewer", t.clock.t - 60_000);
    t.clock.t += 51_000;
    await expect(t.service.start(ctx(), RAW)).resolves.toMatchObject({ status: "waiting" });
  });

  it(`refuses at ${MAX_OPEN_PER_APP} open tasks; closed and vanished issues do not count`, async () => {
    const t = setup();
    for (let i = 0; i < MAX_OPEN_PER_APP; i++) {
      await t.service.start(ctx(), RAW);
      t.clock.t += 61_000;
    }
    await expectCode(t.service.start(ctx(), RAW), "limit", "this app already has 25 open tasks");
    expect(t.issues.create).toHaveBeenCalledTimes(25);
    t.issuesById.get("issue-1")!.status = "done";
    t.issuesById.delete("issue-2");
    await expect(t.service.start(ctx(), RAW)).resolves.toMatchObject({ status: "waiting" });
    expect(t.store.markClosed).toHaveBeenCalledWith("issue-1");
    expect(t.store.markClosed).not.toHaveBeenCalledWith("issue-2");
    expect(t.rows.get("issue-1")!.closed).toBe(true);
  });

  it("counts open tasks for this app only", async () => {
    const t = setup();
    for (let i = 0; i < MAX_OPEN_PER_APP; i++) {
      await t.service.start(ctx({ app: { ...APP, id: "app-2" } }), RAW);
      t.clock.t += 61_000;
    }
    await expect(t.service.start(ctx(), RAW)).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("TaskService.start success", () => {
  it("creates the issue as the viewer, writes the row and audit, then wakes the agent", async () => {
    const t = setup();
    const task = await t.service.start(ctx(), RAW);
    expect(t.issues.create).toHaveBeenCalledTimes(1);
    const input = t.issues.create.mock.calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(["actor", "assigneeAgentId", "companyId", "description", "status", "title"]);
    expect(input).toMatchObject({ companyId: C, status: "todo", assigneeAgentId: "agent-1", actor: { actorUserId: "viewer" }, title: `Reply to ${SECRET_VALUE}` });
    expect(input.actor).toEqual({ actorUserId: "viewer" });
    expect(input.description).toContain("## Data from the app");
    expect(input.description).toContain("Sent by the app \"Help Desk\" (help-desk, version 3, template reply).");
    expect(t.calls).toEqual(["create", "insert", "wake"]);
    expect(t.store.insert).toHaveBeenCalledWith(
      { issueId: "issue-1", companyId: C, appId: "app-1", appSlug: "help-desk", appVersion: 3, template: "reply", agentId: "agent-1", tableName: "tickets", rowId: "r1", startedBy: "viewer" },
      expect.anything(),
    );
    expect(t.audits).toEqual([{
      companyId: C, actor: VIEWER, operation: "app_task_start", table: "tickets",
      details: { app: "help-desk", appId: "app-1", version: 3, template: "reply", agentId: "agent-1", issueId: "issue-1", via: "app@help-desk@3" },
    }]);
    expect(t.issues.requestWakeup).toHaveBeenCalledWith("issue-1", C, { reason: "kyoube_app_task", actorUserId: "viewer" });
    expect(task).toEqual({
      id: "issue-1", template: "reply", rowId: "r1", status: "waiting", waitingReason: null,
      startedBy: { userId: "viewer" }, startedAt: new Date(t.clock.t).toISOString(), updatedAt: new Date(t.clock.t).toISOString(),
      result: null, url: "/HD/issues/HD-2",
    });
    expect(t.issues.get).not.toHaveBeenCalled();
    expect(t.store.setWaitingReason).not.toHaveBeenCalled();
  });

  it("the audit never carries row values or inputs", async () => {
    const t = setup();
    await t.service.start(ctx(), { rowId: "r1", inputs: { tone: SECRET_INPUT } });
    const json = JSON.stringify(t.audits);
    expect(json).not.toContain(SECRET_VALUE);
    expect(json).not.toContain(SECRET_INPUT);
    expect(json).not.toContain("Reply to");
  });

  it("starts a template without a table with no row", async () => {
    const t = setup();
    const task = await t.service.start(ctx({ template: NO_TABLE, templateKey: "hi" }), {});
    expect(task).toMatchObject({ template: "hi", rowId: null, status: "waiting" });
    expect(t.deps.readRow).not.toHaveBeenCalled();
    expect(t.store.insert.mock.calls[0]![0]).toMatchObject({ tableName: null, rowId: null });
    expect(t.audits[0]!.table).toBeNull();
  });

  it("Review Focus 3: a failed row write cancels the issue, rethrows the original error and never wakes", async () => {
    const original = new DataError("conflict", "already exists");
    const t = setup({ insertFails: original });
    const error = await t.service.start(ctx(), RAW).then(() => null, (e: unknown) => e);
    expect(error).toBe(original);
    expect(t.issues.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" }, C, { actorUserId: "viewer" });
    expect(t.issuesById.get("issue-1")!.status).toBe("cancelled");
    expect(t.issues.requestWakeup).not.toHaveBeenCalled();
    expect(t.calls).toEqual(["create", "insert", "update"]);
  });

  it("Review Focus 3: a failed cancel is logged and the original error still wins", async () => {
    const original = new Error("constraint");
    const t = setup({ insertFails: original, updateFails: true });
    const error = await t.service.start(ctx(), RAW).then(() => null, (e: unknown) => e);
    expect(error).toBe(original);
    expect(t.issues.requestWakeup).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(1);
    expect(JSON.stringify(t.logs)).toContain("issue-1");
  });

  it("a soft-skipped wake-up leaves the task waiting with the scheduling reason", async () => {
    const t = setup({ wake: async () => ({ queued: false, runId: null }) });
    const task = await t.service.start(ctx(), RAW);
    expect(task).toMatchObject({ status: "waiting", waitingReason: "The agent will pick this up when the company's scheduling allows." });
    expect(t.store.setWaitingReason).toHaveBeenCalledWith("issue-1", "The agent will pick this up when the company's scheduling allows.");
  });

  it("a refused wake-up cancels the task as the viewer, closes it, audits the cancel and fails with a mapped reason", async () => {
    const cases: Array<[string, string]> = [
      ["Agent is not invokable in its current state", "The agent is paused or not available right now."],
      ["Budget hard stop reached for agent", "The agent is over its budget."],
      ["Issue has open blockers: secret-thing", "The agent couldn't be started right now."],
    ];
    for (const [message, reason] of cases) {
      const t = setup({ wake: async () => { throw new Error(message); } });
      const error = await expectCode(t.service.start(ctx(), RAW), "disabled", `${reason} The task was cancelled; try again later.`);
      expect(error.message).not.toContain(message);
      expect(t.calls).toEqual(["create", "insert", "wake", "update"]);
      expect(t.issues.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" }, C, { actorUserId: "viewer" });
      expect(t.issuesById.get("issue-1")!.status).toBe("cancelled");
      expect(t.rows.get("issue-1")!.closed).toBe(true);
      expect(t.audits.map((a) => a.operation)).toEqual(["app_task_start", "app_task_cancel"]);
      expect(t.audits[1]).toMatchObject({ companyId: C, actor: VIEWER, table: "tickets" });
      expect(t.audits[1]!.details).toEqual({ app: "help-desk", appId: "app-1", version: 3, template: "reply", agentId: "agent-1", issueId: "issue-1", via: "app@help-desk@3", reason: "wake_refused" });
    }
  });

  it("a refused wake-up whose cancel fails is logged, left open and still fails the start", async () => {
    const t = setup({ wake: async () => { throw new Error("Agent is not invokable"); }, updateFails: true });
    await expectCode(t.service.start(ctx(), RAW), "disabled", "The agent is paused or not available right now. The task was cancelled; try again later.");
    expect(t.logs.map((l) => l.message)).toEqual(["app task issue not cancelled after its wake-up was refused"]);
    expect(t.rows.get("issue-1")!.closed).toBe(false);
    expect(t.audits.map((a) => a.operation)).toEqual(["app_task_start"]);
  });

  it("a failure to record the scheduling reason does not fail the start", async () => {
    const t = setup({ wake: async () => ({ queued: false, runId: null }), setWaitingFails: true });
    await expect(t.service.start(ctx(), RAW)).resolves.toMatchObject({ status: "waiting", waitingReason: "The agent will pick this up when the company's scheduling allows." });
  });
});

describe("waitingReasonFor", () => {
  it("maps known refusals and hides everything else", () => {
    expect(waitingReasonFor(new Error("Agent is not invokable in its current state"))).toBe("The agent is paused or not available right now.");
    expect(waitingReasonFor(new Error("over budget: monthly limit"))).toBe("The agent is over its budget.");
    expect(waitingReasonFor(new Error("Budget exceeded"))).toBe("The agent is over its budget.");
    expect(waitingReasonFor(new Error("Issue is not wakeable in status: backlog"))).toBe("The agent couldn't be started right now.");
    expect(waitingReasonFor("not a real error")).toBe("The agent couldn't be started right now.");
    expect(waitingReasonFor(null)).toBe("The agent couldn't be started right now.");
  });
});

describe("TaskService.get", () => {
  async function started(opts: Options = {}) {
    const t = setup(opts);
    const task = await t.service.start(ctx(), RAW);
    return { ...t, task };
  }

  it("Review Focus 5: another app, another company, or an unknown id is not_found without reading the issue", async () => {
    const t = await started();
    await expectCode(t.service.get(C, "app-2", t.task.id), "not_found", "no task from this app has that id");
    await expectCode(t.service.get(OTHER_C, APP.id, t.task.id), "not_found", "no task from this app has that id");
    await expectCode(t.service.get(C, APP.id, "issue-never-from-an-app"), "not_found", "no task from this app has that id");
    expect(t.issues.get).not.toHaveBeenCalled();
    expect(t.issues.listComments).not.toHaveBeenCalled();
  });

  it("an issue the core no longer returns is not_found", async () => {
    const t = await started();
    t.issuesById.delete(t.task.id);
    await expectCode(t.service.get(C, APP.id, t.task.id), "not_found");
  });

  it("maps the issue's status and reads updatedAt from it", async () => {
    const t = await started();
    const cases: Array<[string, string]> = [["backlog", "waiting"], ["todo", "waiting"], ["in_progress", "working"], ["in_review", "needs_review"], ["blocked", "blocked"], ["done", "done"], ["cancelled", "cancelled"]];
    for (const [core, mapped] of cases) {
      t.issuesById.get(t.task.id)!.status = core;
      t.issuesById.get(t.task.id)!.updatedAt = "2026-10-11T10:00:00.000Z";
      const task = await t.service.get(C, APP.id, t.task.id);
      expect(task.status).toBe(mapped);
      expect(task.updatedAt).toBe("2026-10-11T10:00:00.000Z");
      expect(task.url).toBe(t.task.url);
    }
  });

  it("result is the newest live comment by the assigned agent, only when done or needing review", async () => {
    const t = await started();
    t.comments.set(t.task.id, [
      { body: "from a user", authorType: "user", createdAt: "2026-10-11T10:05:00Z" },
      { body: "from another agent", authorType: "agent", authorAgentId: "agent-2", createdAt: "2026-10-11T10:04:00Z" },
      { body: "deleted reply", authorType: "agent", authorAgentId: "agent-1", createdAt: "2026-10-11T10:03:00Z", deletedAt: "2026-10-11T10:06:00Z" },
      { body: "older reply", authorType: "agent", authorAgentId: "agent-1", createdAt: "2026-10-11T10:01:00Z" },
      { body: "newest reply", authorType: "agent", authorAgentId: "agent-1", createdAt: "2026-10-11T10:02:00Z" },
      { body: "system note", authorType: "system", authorAgentId: "agent-1", createdAt: "2026-10-11T10:07:00Z" },
    ]);
    const issue = t.issuesById.get(t.task.id)!;
    issue.status = "in_progress";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBeNull();
    expect(t.issues.listComments).not.toHaveBeenCalled();
    issue.status = "blocked";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBeNull();
    issue.status = "in_review";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBe("newest reply");
    issue.status = "done";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBe("newest reply");
    expect(t.issues.listComments).toHaveBeenCalledWith(t.task.id, C);
    issue.status = "cancelled";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBeNull();
  });

  it("result is null without a reply and cut at 20,000 characters", async () => {
    const t = await started();
    t.issuesById.get(t.task.id)!.status = "done";
    expect((await t.service.get(C, APP.id, t.task.id)).result).toBeNull();
    t.comments.set(t.task.id, [{ body: "x".repeat(25_000), authorType: "agent", authorAgentId: "agent-1", createdAt: new Date() .toISOString() }]);
    const result = (await t.service.get(C, APP.id, t.task.id)).result!;
    expect(result).toHaveLength(20_001);
    expect(result.endsWith("…")).toBe(true);
  });

  it("marks done and cancelled tasks closed", async () => {
    const t = await started();
    t.issuesById.get(t.task.id)!.status = "in_progress";
    await t.service.get(C, APP.id, t.task.id);
    expect(t.store.markClosed).not.toHaveBeenCalled();
    t.issuesById.get(t.task.id)!.status = "done";
    await t.service.get(C, APP.id, t.task.id);
    expect(t.store.markClosed).toHaveBeenCalledWith(t.task.id);
  });

  it("shows the waiting reason only while waiting", async () => {
    const t = await started({ wake: async () => ({ queued: false, runId: null }) });
    expect((await t.service.get(C, APP.id, t.task.id)).waitingReason).toBe("The agent will pick this up when the company's scheduling allows.");
    t.issuesById.get(t.task.id)!.status = "in_progress";
    expect((await t.service.get(C, APP.id, t.task.id)).waitingReason).toBeNull();
  });

  it("never wakes the agent again: a waiting task is left to the core's scheduling", async () => {
    const t = await started({ wake: async () => ({ queued: false, runId: null }) });
    expect(t.issues.requestWakeup).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      t.clock.t += 120_000;
      expect(await t.service.get(C, APP.id, t.task.id)).toMatchObject({ status: "waiting", waitingReason: "The agent will pick this up when the company's scheduling allows." });
    }
    expect(t.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
});

describe("TaskService.list", () => {
  it(`reads at most ${LIST_LIMIT} rows newest first, passes the filter and omits vanished issues`, async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      await t.service.start(ctx(), RAW);
      t.clock.t += 1000;
    }
    t.issuesById.delete("issue-2");
    const tasks = await t.service.list(C, APP.id, { template: "reply", rowId: "r1" });
    expect(tasks.map((task) => task.id)).toEqual(["issue-3", "issue-1"]);
    expect(t.store.list).toHaveBeenCalledWith(C, APP.id, { template: "reply", rowId: "r1", limit: 50 });
    expect(await t.service.list(C, "app-2", {})).toEqual([]);
  });

  it("reads at most 10 issues at a time", async () => {
    const t = setup();
    for (let i = 0; i < 25; i++) {
      await t.service.start(ctx(), RAW);
      t.clock.t += 61_000;
    }
    let inFlight = 0;
    let most = 0;
    const realGet = t.issues.get.getMockImplementation()!;
    t.issues.get.mockImplementation(async (issueId: string, companyId: string) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return realGet(issueId, companyId);
    });
    const tasks = await t.service.list(C, APP.id, {});
    expect(tasks).toHaveLength(25);
    expect(most).toBe(10);
  });
});

describe("TaskService.cancel", () => {
  const MEMBER: DataActor = { kind: "user", id: "member", runId: null };
  const ADMIN: DataActor = { kind: "user", id: "admin", runId: null };
  const OWNER: DataActor = { kind: "user", id: "owner", runId: null };
  const CANCEL_APP = { id: APP.id, slug: APP.slug, version: 4 };

  async function started() {
    const t = setup({ roles: { admin: "admin", owner: "Owner", member: "member" } });
    const task = await t.service.start(ctx(), RAW);
    t.audits.length = 0;
    return { ...t, task };
  }

  it("the starter can cancel; the issue is cancelled as them, audited and closed", async () => {
    const t = await started();
    const task = await t.service.cancel(C, VIEWER, CANCEL_APP, t.task.id);
    expect(t.issues.update).toHaveBeenCalledWith(t.task.id, { status: "cancelled" }, C, { actorUserId: "viewer" });
    expect(t.audits).toEqual([{
      companyId: C, actor: VIEWER, operation: "app_task_cancel", table: "tickets",
      details: { app: "help-desk", appId: "app-1", version: 4, template: "reply", agentId: "agent-1", issueId: t.task.id, via: "app@help-desk@4" },
    }]);
    expect(t.store.markClosed).toHaveBeenCalledWith(t.task.id);
    expect(task).toMatchObject({ id: t.task.id, status: "cancelled", result: null, waitingReason: null, runMayContinue: false });
    expect(t.deps.resolveUserRole).not.toHaveBeenCalled();
  });

  it("an owner or admin can cancel someone else's task (role read fresh)", async () => {
    for (const actor of [ADMIN, OWNER]) {
      const t = await started();
      await expect(t.service.cancel(C, actor, CANCEL_APP, t.task.id)).resolves.toMatchObject({ status: "cancelled" });
      expect(t.deps.resolveUserRole).toHaveBeenCalledWith(C, actor.id, true);
      expect(t.audits[0]!.actor).toEqual(actor);
    }
  });

  it("another member and any agent are forbidden", async () => {
    const t = await started();
    await expectCode(t.service.cancel(C, MEMBER, CANCEL_APP, t.task.id), "forbidden", "only the person who started this task or a company admin can cancel it");
    await expectCode(t.service.cancel(C, { kind: "agent", id: "agent-1", runId: "run" }, CANCEL_APP, t.task.id), "forbidden");
    expect(t.issues.update).not.toHaveBeenCalled();
    expect(t.audits).toHaveLength(0);
  });

  it("Review Focus 5: another app, another company or an unknown id is not_found", async () => {
    const t = await started();
    await expectCode(t.service.cancel(C, VIEWER, { ...CANCEL_APP, id: "app-2" }, t.task.id), "not_found");
    await expectCode(t.service.cancel(OTHER_C, VIEWER, CANCEL_APP, t.task.id), "not_found");
    await expectCode(t.service.cancel(C, VIEWER, CANCEL_APP, "issue-never-from-an-app"), "not_found");
    expect(t.issues.get).not.toHaveBeenCalled();
    expect(t.issues.update).not.toHaveBeenCalled();
  });

  it("a done or cancelled task is a conflict", async () => {
    for (const status of ["done", "cancelled"]) {
      const t = await started();
      t.issuesById.get(t.task.id)!.status = status;
      await expectCode(t.service.cancel(C, VIEWER, CANCEL_APP, t.task.id), "conflict");
      expect(t.issues.update).not.toHaveBeenCalled();
      expect(t.audits).toHaveLength(0);
    }
  });

  it("says a run may continue when the task was working", async () => {
    const t = await started();
    t.issuesById.get(t.task.id)!.status = "in_progress";
    await expect(t.service.cancel(C, VIEWER, CANCEL_APP, t.task.id)).resolves.toMatchObject({ status: "cancelled", runMayContinue: true });
  });
});
